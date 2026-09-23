//! Which detection models are available to choose from.
//!
//! A model is an `.onnx` file with a `.json` of the same name beside it (see
//! `resources/models/loon_v1.json`). Gavia offers the ones bundled with the app
//! plus any dropped into the `models/` folder inside the storage location, so a
//! retrained model can be tried without rebuilding anything.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::detection::ModelInfo;

/// The model used when nothing else has been chosen.
pub const DEFAULT_MODEL: &str = "loon_v1";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    /// The file stem, e.g. `loon_v1`. Unique across both folders.
    pub id: String,
    pub name: String,
    pub architecture: String,
    pub classes: Vec<String>,
    pub metrics: BTreeMap<String, f64>,
    /// False for models shipped with the app, true for ones the user added.
    pub custom: bool,
    #[serde(skip)]
    pub path: PathBuf,
}

/// Every usable model, bundled ones first, each group sorted by id. A custom
/// model whose id clashes with a bundled one is skipped: the bundled model is
/// what the id promises.
pub fn discover(bundled: &Path, custom: &Path) -> Vec<ModelEntry> {
    let mut found = scan(bundled, false);
    for entry in scan(custom, true) {
        if found.iter().any(|f| f.id == entry.id) {
            log::warn!(
                "ignoring custom model {}: a bundled model has that name",
                entry.id
            );
        } else {
            found.push(entry);
        }
    }
    found
}

fn scan(dir: &Path, custom: bool) -> Vec<ModelEntry> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<ModelEntry> = read
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "onnx"))
        .filter_map(|path| {
            let id = path.file_stem()?.to_str()?.to_string();
            match ModelInfo::load(&path.with_extension("json")) {
                Ok(info) => Some(ModelEntry {
                    id,
                    name: info.name,
                    architecture: info.architecture,
                    classes: info.classes,
                    metrics: info.metrics,
                    custom,
                    path,
                }),
                Err(e) => {
                    log::warn!("skipping model {}: {e}", path.display());
                    None
                }
            }
        })
        .collect();
    entries.sort_by(|a, b| a.id.cmp(&b.id));
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundled() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models")
    }

    fn add_model(dir: &Path, id: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(format!("{id}.onnx")), b"weights").unwrap();
        std::fs::copy(
            bundled().join("loon_v1.json"),
            dir.join(format!("{id}.json")),
        )
        .unwrap();
    }

    #[test]
    fn finds_the_bundled_model() {
        let models = discover(&bundled(), Path::new("/nonexistent"));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, DEFAULT_MODEL);
        assert!(!models[0].custom);
        assert!(models[0].metrics.contains_key("precision"));
    }

    #[test]
    fn adds_custom_models_after_bundled_ones() {
        let dir = tempfile::tempdir().unwrap();
        add_model(dir.path(), "zz_retrained");
        add_model(dir.path(), "aa_retrained");
        let ids: Vec<_> = discover(&bundled(), dir.path())
            .into_iter()
            .map(|m| (m.id, m.custom))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("loon_v1".into(), false),
                ("aa_retrained".into(), true),
                ("zz_retrained".into(), true)
            ]
        );
    }

    #[test]
    fn skips_models_without_metadata_and_name_clashes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("orphan.onnx"), b"weights").unwrap();
        add_model(dir.path(), DEFAULT_MODEL);
        assert_eq!(discover(&bundled(), dir.path()).len(), 1);
    }
}
