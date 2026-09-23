//! Settings, each overridable by an environment variable.
//!
//! There is no settings screen: these exist for benchmarking and for trying the
//! model on unusual imagery, and an environment variable is the right amount
//! of ceremony for that.

use crate::detection::preprocess::TileSettings;

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    /// ONNX Runtime intra-op threads. `None` picks a count that leaves the
    /// machine responsive; pin it only when benchmarking.
    pub inference_threads: Option<usize>,
    /// `None` defers to the model's JSON, so a retrained model can ship its
    /// own thresholds without a code change.
    pub confidence_threshold: Option<f64>,
    pub iou_threshold: Option<f64>,
    pub tiles: TileSettings,
    /// Matches the uploader's own limit, so both give the same answer.
    pub max_upload_bytes: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            inference_threads: None,
            confidence_threshold: None,
            iou_threshold: None,
            tiles: TileSettings::default(),
            max_upload_bytes: 20 * 1024 * 1024,
        }
    }
}

impl Config {
    pub fn from_env() -> Self {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Unparseable values fall back to the default with a warning rather than
    /// stopping the app from starting.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let defaults = Self::default();
        let get = |key: &str| {
            lookup(key)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };

        fn parse<T: std::str::FromStr>(key: &str, value: Option<String>) -> Option<T> {
            let value = value?;
            match value.parse() {
                Ok(parsed) => Some(parsed),
                Err(_) => {
                    log::warn!("ignoring {key}={value}: not a valid value");
                    None
                }
            }
        }
        let flag = |key: &str| {
            get(key).and_then(|v| match v.to_ascii_lowercase().as_str() {
                "1" | "true" | "yes" | "on" => Some(true),
                "0" | "false" | "no" | "off" => Some(false),
                _ => {
                    log::warn!("ignoring {key}={v}: expected true or false");
                    None
                }
            })
        };
        let unit = |key: &str| parse::<f64>(key, get(key)).filter(|v| (0.0..=1.0).contains(v));

        Self {
            inference_threads: parse::<usize>(
                "GAVIA_INFERENCE_THREADS",
                get("GAVIA_INFERENCE_THREADS"),
            )
            .filter(|&n| n > 0),
            confidence_threshold: unit("GAVIA_CONFIDENCE_THRESHOLD"),
            iou_threshold: unit("GAVIA_IOU_THRESHOLD"),
            tiles: TileSettings {
                enabled: flag("GAVIA_TILING").unwrap_or(defaults.tiles.enabled),
                threshold: parse("GAVIA_TILE_THRESHOLD", get("GAVIA_TILE_THRESHOLD"))
                    .unwrap_or(defaults.tiles.threshold),
                overlap: unit("GAVIA_TILE_OVERLAP")
                    .filter(|&v| v < 1.0)
                    .unwrap_or(defaults.tiles.overlap),
                max_tiles: parse("GAVIA_MAX_TILES", get("GAVIA_MAX_TILES"))
                    .filter(|&n: &usize| n > 0)
                    .unwrap_or(defaults.tiles.max_tiles),
            },
            max_upload_bytes: defaults.max_upload_bytes,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn with(pairs: &[(&str, &str)]) -> Config {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|key| map.get(key).cloned())
    }

    #[test]
    fn defaults_match_the_measured_choices() {
        let config = with(&[]);
        assert_eq!(config, Config::default());
        assert!(!config.tiles.enabled, "tiling stays off unless measured");
        assert_eq!(config.max_upload_bytes, 20 * 1024 * 1024);
    }

    #[test]
    fn reads_overrides() {
        let config = with(&[
            ("GAVIA_TILING", "true"),
            ("GAVIA_INFERENCE_THREADS", "2"),
            ("GAVIA_CONFIDENCE_THRESHOLD", "0.4"),
            ("GAVIA_IOU_THRESHOLD", "0.5"),
            ("GAVIA_MAX_TILES", "16"),
        ]);
        assert!(config.tiles.enabled);
        assert_eq!(config.inference_threads, Some(2));
        assert_eq!(config.confidence_threshold, Some(0.4));
        assert_eq!(config.iou_threshold, Some(0.5));
        assert_eq!(config.tiles.max_tiles, 16);
    }

    #[test]
    fn bad_values_fall_back_to_defaults() {
        let config = with(&[
            ("GAVIA_TILING", "sometimes"),
            ("GAVIA_INFERENCE_THREADS", "0"),
            ("GAVIA_CONFIDENCE_THRESHOLD", "7"),
            ("GAVIA_TILE_OVERLAP", "1"),
            ("GAVIA_MAX_TILES", "lots"),
        ]);
        assert_eq!(config, Config::default());
    }

    #[test]
    fn blank_values_are_unset() {
        assert_eq!(with(&[("GAVIA_TILING", "  ")]), Config::default());
    }
}
