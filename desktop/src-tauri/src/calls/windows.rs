//! Cutting a recording into the model's windows, the way `birdnet` cuts them.
//!
//! Windows are back to back from the first sample, `round(3 s × rate)` source
//! samples each. Each is resampled on its own to 48 kHz (see `resample`), and
//! the last, usually short, is padded with silence to a full window.

use super::resample::Resampler;

/// Where a window sits in the recording, in seconds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Span {
    pub start: f64,
    pub end: f64,
}

pub struct Windower {
    source_rate: u32,
    model_rate: u32,
    /// Source samples per window.
    segment: usize,
    pending: Vec<f32>,
    /// Source samples already handed out as windows.
    taken: u64,
    resampler: Resampler,
}

impl Windower {
    pub fn new(source_rate: u32, model_rate: u32, window_seconds: f64) -> Self {
        let segment = (window_seconds * f64::from(source_rate)).round_ties_even() as usize;
        Self {
            source_rate,
            model_rate,
            segment: segment.max(1),
            pending: Vec::with_capacity(segment),
            taken: 0,
            resampler: Resampler::new(),
        }
    }

    pub fn push(&mut self, samples: &[f32]) {
        self.pending.extend_from_slice(samples);
    }

    /// The next full window, written into `out` (one window at the model's
    /// rate); `None` until enough samples have been pushed.
    pub fn next_full(&mut self, out: &mut [f32]) -> Option<Span> {
        if self.pending.len() < self.segment {
            return None;
        }
        let span = self.emit(self.segment, out);
        self.pending.drain(..self.segment);
        Some(span)
    }

    /// Whatever is left once the recording has ended, padded with silence.
    pub fn finish(&mut self, out: &mut [f32]) -> Option<Span> {
        if self.pending.is_empty() {
            return None;
        }
        let span = self.emit(self.pending.len(), out);
        self.pending.clear();
        Some(span)
    }

    fn emit(&mut self, len: usize, out: &mut [f32]) -> Span {
        let samples = &self.pending[..len];
        let target = if self.source_rate == self.model_rate {
            len
        } else {
            // round(len / rate * model_rate), as birdnet computes it.
            let seconds = len as f64 / f64::from(self.source_rate);
            (seconds * f64::from(self.model_rate)).round_ties_even() as usize
        }
        .min(out.len());
        self.resampler.resample(samples, &mut out[..target]);
        out[target..].fill(0.0);

        let rate = f64::from(self.source_rate);
        let start = self.taken as f64 / rate;
        self.taken += len as u64;
        Span {
            start,
            end: self.taken as f64 / rate,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: usize = 144_000;

    fn cut(rate: u32, samples: &[f32]) -> Vec<(Span, Vec<f32>)> {
        let mut windower = Windower::new(rate, 48_000, 3.0);
        let mut out = Vec::new();
        let mut buffer = vec![f32::NAN; WINDOW];
        // In uneven chunks, the way packets arrive.
        for chunk in samples.chunks(1_153) {
            windower.push(chunk);
            while let Some(span) = windower.next_full(&mut buffer) {
                out.push((span, buffer.clone()));
            }
        }
        if let Some(span) = windower.finish(&mut buffer) {
            out.push((span, buffer.clone()));
        }
        out
    }

    #[test]
    fn cuts_48_khz_audio_back_to_back_and_pads_the_last_window() {
        let samples: Vec<f32> = (0..WINDOW * 2 + 24_000).map(|i| (i % 7) as f32).collect();
        let windows = cut(48_000, &samples);
        let spans: Vec<(f64, f64)> = windows.iter().map(|(s, _)| (s.start, s.end)).collect();
        assert_eq!(spans, vec![(0.0, 3.0), (3.0, 6.0), (6.0, 6.5)]);
        assert_eq!(windows[1].1[..], samples[WINDOW..2 * WINDOW]);
        let last = &windows[2].1;
        assert_eq!(last[..24_000], samples[2 * WINDOW..]);
        assert!(last[24_000..].iter().all(|&v| v == 0.0));
    }

    #[test]
    fn other_rates_become_full_48_khz_windows() {
        // 4.5 s at 44.1 kHz: one 3 s window (132,300 samples) and a 1.5 s one.
        let samples = vec![0.25f32; 198_450];
        let windows = cut(44_100, &samples);
        assert_eq!(windows.len(), 2);
        assert_eq!((windows[0].0.start, windows[0].0.end), (0.0, 3.0));
        assert_eq!((windows[1].0.start, windows[1].0.end), (3.0, 4.5));
        // A constant stays constant through Fourier resampling.
        assert!(windows[0].1.iter().all(|v| (v - 0.25).abs() < 1e-5));
        let tail = &windows[1].1;
        assert!(tail[..72_000].iter().all(|v| (v - 0.25).abs() < 1e-5));
        assert!(tail[72_000..].iter().all(|&v| v == 0.0));
    }

    #[test]
    fn a_recording_shorter_than_a_window_is_one_padded_window() {
        let windows = cut(16_000, &[0.5; 800]);
        assert_eq!(windows.len(), 1);
        assert_eq!((windows[0].0.start, windows[0].0.end), (0.0, 0.05));
        assert!(windows[0].1[2_400..].iter().all(|&v| v == 0.0));
    }

    #[test]
    fn nothing_in_nothing_out() {
        assert!(cut(48_000, &[]).is_empty());
    }
}
