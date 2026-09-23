//! The few choices Gavia remembers between launches, in `settings.json` in the
//! app's config directory.
//!
//! The theme is not here: the UI keeps it in `localStorage`, so it can be
//! applied before the first paint instead of flashing light on a dark desktop.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Where history lives. `None` means the platform default.
    pub data_dir: Option<PathBuf>,
    /// The chosen model's id (its file stem). `None` means the bundled default.
    pub model: Option<String>,
}

impl Settings {
    /// A missing file is a first launch; an unreadable one is logged and
    /// ignored rather than stopping the app from starting.
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                log::warn!("ignoring unreadable {}: {e}", path.display());
                Self::default()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(e) => {
                log::warn!("could not read {}: {e}", path.display());
                Self::default()
            }
        }
    }

    /// Written to a temporary file and renamed into place, so a crash mid-write
    /// never leaves a half-written file behind.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp: PathBuf = path.with_extension("json.tmp");
        std::fs::write(&temp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(&temp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/settings.json");
        let settings = Settings {
            data_dir: Some("/tmp/x".into()),
            model: Some("loon_v2".into()),
        };
        settings.save(&path).unwrap();
        assert_eq!(Settings::load(&path), settings);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn missing_or_corrupt_files_mean_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(Settings::load(&path), Settings::default());
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(Settings::load(&path), Settings::default());
    }

    #[test]
    fn unknown_and_missing_fields_are_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"model":"a","future":1}"#).unwrap();
        assert_eq!(Settings::load(&path).model.as_deref(), Some("a"));
    }
}
