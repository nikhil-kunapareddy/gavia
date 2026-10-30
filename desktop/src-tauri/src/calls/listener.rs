//! The call model's ONNX Runtime session, and a recording's trip through it.

use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::TensorRef;

use super::decode::{AudioError, Recording};
use super::model::CallModelInfo;
use super::windows::{Span, Windower};
use crate::detection::detector::default_thread_count;

/// Windows per forward pass. Batching roughly halves the time per window; past
/// eight there is little left to gain, and the buffer is 576 KB per window.
pub const BATCH: usize = 8;

/// One window and how likely it is to hold a loon call.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowScore {
    /// Seconds into the recording.
    pub start: f64,
    pub end: f64,
    pub probability: f64,
}

#[derive(Debug, Clone)]
pub struct Heard {
    /// Every window, in order.
    pub windows: Vec<WindowScore>,
    /// Seconds of audio decoded.
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub channels: u16,
    /// Seconds spent decoding and listening.
    pub processing_seconds: f64,
}

#[derive(Debug, thiserror::Error)]
pub enum ListenError {
    #[error(transparent)]
    Audio(#[from] AudioError),
    #[error("inference failed: {0}")]
    Inference(String),
}

struct Engine {
    session: Session,
    /// `BATCH` windows back to back, reused for every batch.
    buffer: Vec<f32>,
}

/// Scores recordings with looncall. Like the image detector, inference is
/// serialised: one recording at a time holds the session and its buffer.
pub struct CallDetector {
    engine: Mutex<Engine>,
    info: CallModelInfo,
}

impl CallDetector {
    /// Load `model_path` and its `.json` metadata, then run one warm-up batch.
    pub fn load(model_path: &Path, threads: Option<usize>) -> Result<Self, String> {
        let info = CallModelInfo::load(&model_path.with_extension("json"))?;
        if !model_path.exists() {
            return Err(format!(
                "Call model file not found: {}",
                model_path.display()
            ));
        }
        let configure = || -> ort::Result<Session> {
            Session::builder()?
                .with_optimization_level(GraphOptimizationLevel::All)?
                .with_intra_threads(threads.unwrap_or_else(default_thread_count))?
                .with_inter_threads(1)?
                .commit_from_file(model_path)
        };
        let session = configure().map_err(|e| format!("Could not load call model: {e}"))?;
        let has = |names: Vec<&str>, name: &str| names.contains(&name);
        if !has(
            session.inputs().iter().map(|i| i.name()).collect(),
            &info.input_name,
        ) || !has(
            session.outputs().iter().map(|o| o.name()).collect(),
            &info.output_name,
        ) {
            return Err(format!(
                "The call model does not have the input {} and output {} its metadata names.",
                info.input_name, info.output_name
            ));
        }

        let detector = Self {
            engine: Mutex::new(Engine {
                session,
                buffer: vec![0.0; BATCH * info.window_samples()],
            }),
            info,
        };
        detector.warm_up()?;
        Ok(detector)
    }

    pub fn info(&self) -> &CallModelInfo {
        &self.info
    }

    /// The first run allocates and picks kernels; pay for it at load time.
    fn warm_up(&self) -> Result<(), String> {
        let started = Instant::now();
        let mut engine = self.lock();
        let Engine { session, buffer } = &mut *engine;
        buffer.fill(0.0);
        self.run(session, buffer, BATCH)?;
        log::info!(
            "call model {} warmed up in {:.3}s",
            self.info.name,
            started.elapsed().as_secs_f64()
        );
        Ok(())
    }

    /// Score every window of one encoded recording. Blocking and CPU-bound;
    /// decoding and inference interleave, so memory stays flat however long
    /// the recording is.
    pub fn listen(&self, bytes: &[u8], max_seconds: f64) -> Result<Heard, ListenError> {
        let started = Instant::now();
        let mut recording = Recording::open(bytes, max_seconds)?;
        let rate = recording.sample_rate();
        let mut windower = Windower::new(rate, self.info.sample_rate, self.info.window_seconds);
        let size = self.info.window_samples();

        // Held for the whole recording, so the buffer is this call's alone.
        let mut engine = self.lock();
        let Engine { session, buffer } = &mut *engine;
        let mut spans = Vec::new();
        let mut windows = Vec::new();

        let mut flush =
            |spans: &mut Vec<_>, buffer: &mut [f32]| -> Result<(), ListenError> {
                if spans.is_empty() {
                    return Ok(());
                }
                let scores = self
                    .run(session, buffer, spans.len())
                    .map_err(ListenError::Inference)?;
                windows.extend(spans.drain(..).zip(scores).map(
                    |(span, probability): (Span, f32)| WindowScore {
                        start: span.start,
                        end: span.end,
                        probability: f64::from(probability),
                    },
                ));
                Ok(())
            };

        while let Some(samples) = recording.next_samples()? {
            windower.push(samples);
            loop {
                let slot = &mut buffer[spans.len() * size..(spans.len() + 1) * size];
                let Some(span) = windower.next_full(slot) else {
                    break;
                };
                spans.push(span);
                if spans.len() == BATCH {
                    flush(&mut spans, buffer)?;
                }
            }
        }
        let slot = &mut buffer[spans.len() * size..(spans.len() + 1) * size];
        if let Some(span) = windower.finish(slot) {
            spans.push(span);
        }
        flush(&mut spans, buffer)?;

        if windows.is_empty() {
            return Err(AudioError::Decode("This recording has no audio in it.".into()).into());
        }
        Ok(Heard {
            windows,
            duration_seconds: recording.frames() as f64 / f64::from(rate),
            sample_rate: rate,
            channels: u16::try_from(recording.channels()).unwrap_or(u16::MAX),
            processing_seconds: started.elapsed().as_secs_f64(),
        })
    }

    /// One forward pass over the first `count` windows of `buffer`.
    fn run(&self, session: &mut Session, buffer: &[f32], count: usize) -> Result<Vec<f32>, String> {
        let size = self.info.window_samples();
        let input = TensorRef::from_array_view(([count, size], &buffer[..count * size]))
            .map_err(|e| e.to_string())?;
        let outputs = session
            .run(ort::inputs![self.info.input_name.as_str() => input])
            .map_err(|e| e.to_string())?;
        let (shape, data) = outputs[self.info.output_name.as_str()]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        if data.len() != count {
            return Err(format!("unexpected call model output shape {shape:?}"));
        }
        Ok(data.to_vec())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Engine> {
        // The buffer is overwritten from scratch for every batch, so a panic
        // mid-inference leaves nothing inconsistent behind.
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
