//! What `calls/<name>.json` says about the call model.
//!
//! Written by `scripts/export_looncall.py` beside the `.onnx`, like the image
//! model's metadata: window length, sample rate and threshold live with the
//! weights, so a retrained head is a two-file drop-in.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq)]
pub struct CallModelInfo {
    pub name: String,
    pub architecture: String,
    /// What a window above the threshold is called in the UI, e.g. `Loon call`.
    pub label: String,
    pub input_name: String,
    pub output_name: String,
    pub sample_rate: u32,
    pub window_seconds: f64,
    pub threshold: f64,
    pub metrics: BTreeMap<String, f64>,
    pub sha256: String,
    pub license: String,
}

impl CallModelInfo {
    /// Samples in one window at the model's rate: 144,000 for 3 s at 48 kHz.
    pub fn window_samples(&self) -> usize {
        (self.window_seconds * f64::from(self.sample_rate)).round_ties_even() as usize
    }

    pub fn load(metadata_path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(metadata_path).map_err(|e| {
            format!(
                "Call model metadata not found at {}: {e}",
                metadata_path.display()
            )
        })?;
        Self::parse(&text)
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let raw: Raw = serde_json::from_str(text)
            .map_err(|e| format!("Call model metadata is invalid: {e}"))?;
        if raw.input.sample_rate == 0
            || !raw.input.window_seconds.is_finite()
            || raw.input.window_seconds <= 0.0
        {
            return Err("Call model metadata needs a sample rate and a window length.".into());
        }
        if !(0.0..=1.0).contains(&raw.defaults.threshold) {
            return Err("Call model threshold must be between 0 and 1.".into());
        }
        Ok(Self {
            name: raw.name,
            architecture: raw.architecture.unwrap_or_else(|| "unknown".into()),
            label: raw.display_label.unwrap_or_else(|| "Call".into()),
            input_name: raw.input.name,
            output_name: raw.output.name,
            sample_rate: raw.input.sample_rate,
            window_seconds: raw.input.window_seconds,
            threshold: raw.defaults.threshold,
            // The metrics block mixes numbers with a free-text note.
            metrics: raw
                .metrics
                .unwrap_or_default()
                .into_iter()
                .filter_map(|(k, v)| v.as_f64().map(|n| (k, n)))
                .collect(),
            sha256: raw.sha256.unwrap_or_default(),
            license: raw.license.map(|l| l.spdx).unwrap_or_default(),
        })
    }
}

#[derive(Deserialize)]
struct Raw {
    name: String,
    architecture: Option<String>,
    display_label: Option<String>,
    input: RawInput,
    output: RawOutput,
    defaults: RawDefaults,
    metrics: Option<BTreeMap<String, serde_json::Value>>,
    sha256: Option<String>,
    license: Option<RawLicense>,
}

#[derive(Deserialize)]
struct RawInput {
    name: String,
    sample_rate: u32,
    window_seconds: f64,
}

#[derive(Deserialize)]
struct RawOutput {
    name: String,
}

#[derive(Deserialize)]
struct RawDefaults {
    threshold: f64,
}

#[derive(Deserialize)]
struct RawLicense {
    spdx: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shipped() -> CallModelInfo {
        CallModelInfo::load(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/calls/looncall_v1.json"),
        )
        .unwrap()
    }

    #[test]
    fn reads_the_shipped_metadata() {
        let info = shipped();
        assert_eq!((info.sample_rate, info.window_seconds), (48_000, 3.0));
        assert_eq!(info.window_samples(), 144_000);
        assert_eq!(info.threshold, 0.5);
        assert_eq!(
            (info.input_name.as_str(), info.output_name.as_str()),
            ("audio", "p_loon")
        );
        assert_eq!(info.label, "Loon call");
        assert_eq!(info.license, "CC-BY-NC-SA-4.0");
        assert_eq!(info.sha256.len(), 64);
        assert!(info.metrics.contains_key("recall"));
        assert!(!info.metrics.contains_key("note"));
    }

    #[test]
    fn bad_metadata_is_an_error_not_a_panic() {
        assert!(CallModelInfo::parse("{}").is_err());
        assert!(CallModelInfo::parse("not json").is_err());
        let zero_rate = r#"{"name":"x","input":{"name":"a","sample_rate":0,"window_seconds":3},"output":{"name":"p"},"defaults":{"threshold":0.5}}"#;
        assert!(CallModelInfo::parse(zero_rate).is_err());
        let bad_threshold = r#"{"name":"x","input":{"name":"a","sample_rate":48000,"window_seconds":3},"output":{"name":"p"},"defaults":{"threshold":2}}"#;
        assert!(CallModelInfo::parse(bad_threshold).is_err());
    }
}
