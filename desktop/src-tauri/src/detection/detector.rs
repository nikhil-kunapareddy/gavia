//! The ONNX Runtime detector: one session, loaded once, reused for every image.

use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::TensorRef;

use super::loader::{self, LoadError, Rgb};
use super::model::ModelInfo;
use super::postprocess::{self, RawDetection};
use super::preprocess::{self, TilePlan, TileSettings};

/// One detected object, in the coordinate system the UI draws in.
#[derive(Debug, Clone, PartialEq)]
pub struct Prediction {
    pub label: String,
    pub confidence: f64,
    /// Percentages of the source image, 0-100.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone)]
pub struct Outcome {
    pub predictions: Vec<Prediction>,
    /// The source image as the user supplied it, after EXIF rotation — not
    /// whatever reduced-scale decode was used internally. Getting this wrong
    /// once produced boxes that looked right and measured wrong.
    pub image_width: u32,
    pub image_height: u32,
    pub tiles_processed: usize,
    pub duration_seconds: f64,
}

/// Per-call overrides; `None` means "use the model's defaults".
#[derive(Debug, Clone, Copy, Default)]
pub struct DetectOptions {
    pub confidence_threshold: Option<f64>,
    pub iou_threshold: Option<f64>,
    pub tiling: Option<bool>,
}

struct Engine {
    session: Session,
    /// One input buffer reused across tiles, so peak memory is one tile's
    /// worth regardless of tile count. Lives behind the same lock as the
    /// session, so a caller finishes with each tile before the next is written.
    buffer: Vec<f32>,
}

/// Wraps an ONNX Runtime session with the pre- and post-processing it needs.
///
/// Inference is serialised behind a lock: on a single-user desktop app there is
/// no throughput to gain from parallel runs, and serialising keeps peak memory
/// flat however many checks pile up.
///
/// Tiling defaults to **off**, which is a measured decision. Tiling exists for
/// small-object imagery, but on the loonnet_v1 photographs 64% of labelled
/// loons are *larger* than a 640px tile (median longest side 1077px, 41% of the
/// frame), so tiles see fragments of a bird and precision collapses:
///
/// ```text
/// single pass    P 0.906  R 0.879  AP@0.5 0.892
/// tiled          P 0.074  R 0.364  AP@0.5 0.231
/// tiled + full   P 0.154  R 0.849  AP@0.5 0.629
/// ```
///
/// Turn it on for genuine top-down drone frames and re-run
/// `cargo run --release --example evaluate` to confirm it helps that data.
pub struct Detector {
    engine: Mutex<Engine>,
    input_name: String,
    info: ModelInfo,
    tiles: TileSettings,
}

impl Detector {
    /// Load `model_path` and its `.json` metadata, then run one warm-up pass.
    pub fn load(
        model_path: &Path,
        threads: Option<usize>,
        tiles: TileSettings,
    ) -> Result<Self, String> {
        let info = ModelInfo::load(&model_path.with_extension("json"))?;
        if !model_path.exists() {
            return Err(format!("Model file not found: {}", model_path.display()));
        }

        let configure = || -> ort::Result<Session> {
            let threads = threads.unwrap_or_else(default_thread_count);
            Session::builder()?
                .with_optimization_level(GraphOptimizationLevel::All)?
                .with_intra_threads(threads)?
                // Serialised inference means the parallel executor buys nothing.
                .with_inter_threads(1)?
                .with_memory_pattern(true)?
                .commit_from_file(model_path)
        };
        let session = configure().map_err(|e| format!("Could not load model: {e}"))?;

        if session.inputs().len() != 1 {
            return Err(format!(
                "Expected a single model input, found {}.",
                session.inputs().len()
            ));
        }
        let input_name = session.inputs()[0].name().to_string();
        let size = info.input_size as usize;

        let detector = Self {
            engine: Mutex::new(Engine {
                session,
                buffer: vec![0.0; 3 * size * size],
            }),
            input_name,
            info,
            tiles,
        };
        detector.warm_up()?;
        Ok(detector)
    }

    pub fn info(&self) -> &ModelInfo {
        &self.info
    }

    pub fn tiling_enabled(&self) -> bool {
        self.tiles.enabled
    }

    pub fn provider(&self) -> &'static str {
        "CPUExecutionProvider"
    }

    /// ORT defers allocation and kernel selection to the first run, roughly a
    /// second on this model, which the user would otherwise pay on first check.
    fn warm_up(&self) -> Result<(), String> {
        let started = Instant::now();
        let mut engine = self.lock();
        let Engine { session, buffer } = &mut *engine;
        buffer.fill(0.0);
        run(session, &self.input_name, buffer, self.info.input_size)?;
        log::info!(
            "model {} warmed up in {:.3}s",
            self.info.name,
            started.elapsed().as_secs_f64()
        );
        Ok(())
    }

    /// Find every loon in one encoded image. Blocking and CPU-bound.
    pub fn detect(&self, bytes: &[u8], options: DetectOptions) -> Result<Outcome, DetectError> {
        let conf = options
            .confidence_threshold
            .unwrap_or(self.info.confidence_threshold);
        let iou = options.iou_threshold.unwrap_or(self.info.iou_threshold);
        let tiles = TileSettings {
            enabled: options.tiling.unwrap_or(self.tiles.enabled),
            ..self.tiles
        };
        let size = self.info.input_size;
        let started = Instant::now();

        // Planning from header dimensions decides the decode strategy: a small
        // image can be drafted down during decode, a tiled one needs every pixel.
        let (original_width, original_height) = loader::read_dimensions(bytes)?;
        let mut plan = preprocess::plan_tiles(original_width, original_height, size, &tiles);
        let image = loader::open_image(bytes, if plan.is_tiled() { None } else { Some(size) })?;

        // Coordinate maths uses the decoded size; everything reported describes
        // the image the user uploaded. They differ by a constant factor, which
        // percentages divide out.
        let (width, height) = (image.width, image.height);
        if !plan.is_tiled() {
            plan = preprocess::plan_tiles(width, height, size, &tiles);
        }

        let found = self.run_tiles(&image, &plan, conf)?;
        drop(image);

        let kept = postprocess::non_max_suppression(&found, iou, self.info.max_detections);
        let mut kept = postprocess::clamp_to_image(kept, width, height);
        kept.sort_by(|a, b| b.score.total_cmp(&a.score));

        let predictions = kept
            .iter()
            .map(|d| {
                let (x, y, w, h) = postprocess::to_percentages(d, width, height);
                Prediction {
                    label: self.info.label_for(d.class_id),
                    confidence: d.score,
                    x,
                    y,
                    width: w,
                    height: h,
                }
            })
            .collect();

        Ok(Outcome {
            predictions,
            image_width: original_width,
            image_height: original_height,
            tiles_processed: plan.tiles.len(),
            duration_seconds: started.elapsed().as_secs_f64(),
        })
    }

    fn run_tiles(
        &self,
        image: &Rgb,
        plan: &TilePlan,
        conf: f64,
    ) -> Result<Vec<RawDetection>, DetectError> {
        let size = self.info.input_size;
        let mut found = Vec::new();
        // Held across the whole image so the shared buffer cannot be
        // overwritten by another check mid-iteration.
        let mut engine = self.lock();
        let Engine { session, buffer } = &mut *engine;

        for &tile in &plan.tiles {
            let [left, top, ..] = tile;
            let cropped;
            let source = if plan.is_tiled() {
                cropped = preprocess::crop(image, tile);
                &cropped
            } else {
                image
            };
            let mut geometry = preprocess::letterbox(source, size, buffer);
            geometry.origin_x = left;
            geometry.origin_y = top;

            let (rows, anchors, output) =
                run(session, &self.input_name, buffer, size).map_err(DetectError::Inference)?;
            found.extend(postprocess::decode(&output, rows, anchors, &geometry, conf));
        }
        Ok(found)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Engine> {
        // A panic mid-inference leaves nothing inconsistent: the buffer is
        // overwritten from scratch on every tile.
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DetectError {
    #[error(transparent)]
    Load(#[from] LoadError),
    #[error("inference failed: {0}")]
    Inference(String),
}

/// One forward pass. Returns `(rows, anchors, data)` of the `(1, rows, anchors)` output.
fn run(
    session: &mut Session,
    input_name: &str,
    buffer: &[f32],
    size: u32,
) -> Result<(usize, usize, Vec<f32>), String> {
    let side = size as usize;
    let input =
        TensorRef::from_array_view(([1usize, 3, side, side], buffer)).map_err(|e| e.to_string())?;
    let outputs = session
        .run(ort::inputs![input_name => input])
        .map_err(|e| e.to_string())?;
    let (shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;
    if shape.len() != 3 || shape[0] != 1 {
        return Err(format!("unexpected model output shape {shape:?}"));
    }
    Ok((shape[1] as usize, shape[2] as usize, data.to_vec()))
}

/// Performance cores, roughly, leaving the machine usable. `available_parallelism`
/// counts efficiency cores too on Apple silicon, which slow a compute-bound
/// graph down rather than up.
pub fn default_thread_count() -> usize {
    let total = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    if total > 4 {
        (total - 2).clamp(1, 8)
    } else {
        total.saturating_sub(1).max(1)
    }
}

#[cfg(test)]
mod tests {
    use super::default_thread_count;

    #[test]
    fn thread_count_leaves_the_machine_usable() {
        let n = default_thread_count();
        assert!((1..=8).contains(&n));
    }
}
