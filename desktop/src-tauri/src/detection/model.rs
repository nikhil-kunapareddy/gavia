//! What `models/<name>.json` says about the loaded weights.
//!
//! Thresholds and class names live beside the model rather than in code, so
//! swapping in a retrained model is a two-file drop-in.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq)]
pub struct ModelInfo {
    pub name: String,
    pub architecture: String,
    pub classes: Vec<String>,
    pub display_labels: BTreeMap<String, String>,
    pub input_size: u32,
    pub confidence_threshold: f64,
    pub iou_threshold: f64,
    pub max_detections: usize,
    pub metrics: BTreeMap<String, f64>,
    pub sha256: String,
}

impl ModelInfo {
    /// Human-facing label, e.g. `common loon` becomes `Loon`.
    pub fn label_for(&self, class_id: usize) -> String {
        match self.classes.get(class_id) {
            Some(raw) => self.display_labels.get(raw).unwrap_or(raw).clone(),
            None => "Unknown".into(),
        }
    }

    pub fn load(metadata_path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(metadata_path).map_err(|e| {
            format!(
                "Model metadata not found at {}: {e}",
                metadata_path.display()
            )
        })?;
        Self::parse(&text)
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let raw: Raw =
            serde_json::from_str(text).map_err(|e| format!("Model metadata is invalid: {e}"))?;
        let input_size = raw
            .input
            .shape
            .get(2)
            .copied()
            .ok_or("Model metadata is missing input.shape[2]")?;
        Ok(Self {
            name: raw.name,
            architecture: raw.architecture.unwrap_or_else(|| "unknown".into()),
            classes: raw.classes,
            display_labels: raw.display_labels.unwrap_or_default(),
            input_size,
            confidence_threshold: raw.defaults.confidence_threshold,
            iou_threshold: raw.defaults.iou_threshold,
            max_detections: raw.defaults.max_detections,
            // The metrics block mixes numbers with a free-text note.
            metrics: raw
                .metrics
                .unwrap_or_default()
                .into_iter()
                .filter_map(|(k, v)| v.as_f64().map(|n| (k, n)))
                .collect(),
            sha256: raw.sha256.unwrap_or_default(),
        })
    }
}

#[derive(Deserialize)]
struct Raw {
    name: String,
    architecture: Option<String>,
    classes: Vec<String>,
    display_labels: Option<BTreeMap<String, String>>,
    input: RawInput,
    defaults: RawDefaults,
    metrics: Option<BTreeMap<String, serde_json::Value>>,
    sha256: Option<String>,
}

#[derive(Deserialize)]
struct RawInput {
    shape: Vec<u32>,
}

#[derive(Deserialize)]
struct RawDefaults {
    confidence_threshold: f64,
    iou_threshold: f64,
    max_detections: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shipped() -> ModelInfo {
        ModelInfo::load(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models/loon_v1.json"),
        )
        .unwrap()
    }

    #[test]
    fn reads_the_shipped_metadata() {
        let info = shipped();
        assert_eq!(info.input_size, 640);
        assert_eq!(info.confidence_threshold, 0.25);
        assert_eq!(info.iou_threshold, 0.45);
        assert_eq!(info.max_detections, 300);
        assert_eq!(info.classes, vec!["common loon"]);
        assert_eq!(info.sha256.len(), 64);
    }

    #[test]
    fn keeps_only_numeric_metrics() {
        let info = shipped();
        assert!(info.metrics.contains_key("precision"));
        assert!(!info.metrics.contains_key("note"));
    }

    #[test]
    fn labels_use_display_names_and_tolerate_unknown_ids() {
        let info = shipped();
        assert_eq!(info.label_for(0), "Loon");
        assert_eq!(info.label_for(7), "Unknown");
    }

    #[test]
    fn missing_fields_are_an_error_not_a_panic() {
        assert!(ModelInfo::parse("{}").is_err());
        assert!(ModelInfo::parse("not json").is_err());
        let no_shape = r#"{"name":"x","classes":[],"input":{"shape":[1]},"defaults":{"confidence_threshold":0.1,"iou_threshold":0.1,"max_detections":1}}"#;
        assert!(ModelInfo::parse(no_shape).is_err());
    }
}
