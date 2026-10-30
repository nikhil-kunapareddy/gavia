//! `scipy.signal.resample`, the way the `birdnet` package changes sample rate.
//!
//! It is Fourier resampling of each window on its own: transform, keep or
//! zero-pad the spectrum to the new length, transform back. Not what an audio
//! engineer would pick, but it is what looncall's training audio went through
//! whenever a recording wasn't already 48 kHz, so it is what Gavia does too.
//! Arithmetic is `f32` throughout, as SciPy's is for `float32` input.

use std::sync::Arc;

use realfft::num_complex::Complex32;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};

/// Holds FFT plans between windows: every full window of a recording has the
/// same length, and planning is the expensive part for awkward lengths.
pub struct Resampler {
    planner: RealFftPlanner<f32>,
    forward: Option<Arc<dyn RealToComplex<f32>>>,
    inverse: Option<Arc<dyn ComplexToReal<f32>>>,
    input: Vec<f32>,
    spectrum: Vec<Complex32>,
    output_spectrum: Vec<Complex32>,
}

impl Default for Resampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Resampler {
    pub fn new() -> Self {
        Self {
            planner: RealFftPlanner::new(),
            forward: None,
            inverse: None,
            input: Vec::new(),
            spectrum: Vec::new(),
            output_spectrum: Vec::new(),
        }
    }

    /// `x` resampled to `out.len()` samples, written into `out`.
    pub fn resample(&mut self, x: &[f32], out: &mut [f32]) {
        let (n, num) = (x.len(), out.len());
        if n == num {
            out.copy_from_slice(x);
            return;
        }
        if n == 0 || num == 0 {
            out.fill(0.0);
            return;
        }

        let forward = match &self.forward {
            Some(plan) if plan.len() == n => plan.clone(),
            _ => self
                .forward
                .insert(self.planner.plan_fft_forward(n))
                .clone(),
        };
        let inverse = match &self.inverse {
            Some(plan) if plan.len() == num => plan.clone(),
            _ => self
                .inverse
                .insert(self.planner.plan_fft_inverse(num))
                .clone(),
        };

        self.input.clear();
        self.input.extend_from_slice(x);
        self.spectrum.resize(n / 2 + 1, Complex32::default());
        // Lengths match the plan by construction, so this cannot fail.
        if forward
            .process(&mut self.input, &mut self.spectrum)
            .is_err()
        {
            out.fill(0.0);
            return;
        }

        // Keep the bins both lengths share; an unpaired bin at m/2 is doubled
        // going down and halved going up, as SciPy does.
        let m = n.min(num);
        let kept = m / 2 + 1;
        if m % 2 == 0 {
            self.spectrum[m / 2] *= if num < n { 2.0 } else { 0.5 };
        }
        let s_fac = (n as f64 / num as f64) as f32;
        self.output_spectrum.clear();
        self.output_spectrum
            .resize(num / 2 + 1, Complex32::default());
        for (o, s) in self.output_spectrum.iter_mut().zip(&self.spectrum[..kept]) {
            *o = s / s_fac;
        }
        // The inverse reads only the real part of DC and, for even lengths, of
        // the Nyquist bin, as pocketfft's does.
        self.output_spectrum[0].im = 0.0;
        if num % 2 == 0 {
            self.output_spectrum[num / 2].im = 0.0;
        }
        if inverse.process(&mut self.output_spectrum, out).is_err() {
            out.fill(0.0);
            return;
        }
        let scale = 1.0 / num as f32;
        out.iter_mut().for_each(|v| *v *= scale);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const X10: [f32; 10] = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 4.0, 3.0, 2.0, 1.0];
    const X9: [f32; 9] = [0.5, -1.0, 2.0, 0.25, 3.0, -2.0, 1.0, 0.0, 1.5];

    fn resampled(x: &[f32], num: usize) -> Vec<f32> {
        let mut out = vec![0.0; num];
        Resampler::new().resample(x, &mut out);
        out
    }

    fn assert_close(got: &[f32], want: &[f64]) {
        assert_eq!(got.len(), want.len());
        for (g, w) in got.iter().zip(want) {
            assert!((f64::from(*g) - w).abs() < 2e-6, "{got:?} vs {want:?}");
        }
    }

    // Expected values are scipy 1.17.1's `signal.resample` on float32 input.
    #[test]
    fn matches_scipy_going_down() {
        assert_close(
            &resampled(&X10, 7),
            &[
                0.1,
                1.469457745552063,
                2.7755324840545654,
                4.455010414123535,
                4.455010414123535,
                2.7755324840545654,
                1.469457745552063,
            ],
        );
        assert_close(
            &resampled(&X10, 8),
            &[
                0.1,
                1.2350890636444092,
                2.5,
                3.764910936355591,
                4.9,
                3.764910936355591,
                2.5,
                1.2350890636444092,
            ],
        );
        assert_close(
            &resampled(&X9, 6),
            &[
                0.2531353235244751,
                0.11233234405517578,
                1.858027696609497,
                0.40174609422683716,
                -0.3611629903316498,
                1.2359216213226318,
            ],
        );
        assert_close(
            &resampled(&X9, 5),
            &[
                0.2531353235244751,
                0.5009871125221252,
                1.6680212020874023,
                -0.5392763018608093,
                1.033799409866333,
            ],
        );
    }

    #[test]
    fn matches_scipy_going_up() {
        assert_close(
            &resampled(&X10, 13),
            &[
                0.0,
                0.6834954023361206,
                1.594869613647461,
                2.299095869064331,
                3.0692169666290283,
                3.805570602416992,
                4.7977519035339355,
                4.7977519035339355,
                3.805570602416992,
                3.0692169666290283,
                2.299095869064331,
                1.594869613647461,
                0.6834954023361206,
            ],
        );
        assert_close(
            &resampled(&X10, 16),
            &[
                0.0,
                0.48633241653442383,
                1.3057997226715088,
                1.8884220123291016,
                2.5,
                3.1115779876708984,
                3.694200277328491,
                4.513667583465576,
                5.0,
                4.513667583465576,
                3.694200277328491,
                3.1115779876708984,
                2.5,
                1.8884220123291016,
                1.3057997226715088,
                0.48633241653442383,
            ],
        );
        assert_close(
            &resampled(&X9, 12),
            &[
                0.5,
                -1.7983243465423584,
                1.4734952449798584,
                1.306138515472412,
                0.25,
                2.970956802368164,
                0.6486108303070068,
                -2.178346872329712,
                1.0,
                0.8660426139831543,
                -0.37210604548454285,
                2.33353328704834,
            ],
        );
    }

    #[test]
    fn same_length_is_a_copy_and_plans_are_reused() {
        assert_eq!(resampled(&X10, 10), X10.to_vec());
        let mut resampler = Resampler::new();
        let mut a = vec![0.0; 13];
        let mut b = vec![0.0; 13];
        resampler.resample(&X10, &mut a);
        resampler.resample(&X10, &mut b);
        assert_eq!(a, b);
    }

    #[test]
    fn a_44_1_khz_tone_lands_on_the_same_tone_at_48_khz() {
        let tone = |rate: f32, n: usize| -> Vec<f32> {
            (0..n)
                .map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / rate).sin())
                .collect()
        };
        let got = resampled(&tone(44_100.0, 4410), 4800);
        let want = tone(48_000.0, 4800);
        // Away from the edges, where the periodic extension wraps around.
        let worst = got[200..4600]
            .iter()
            .zip(&want[200..4600])
            .map(|(g, w)| (g - w).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 1e-3, "{worst}");
    }
}
