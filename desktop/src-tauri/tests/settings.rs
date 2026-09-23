//! Settings through `Service`: choosing where history lives and which model
//! runs. These move real files between real folders, so they use temporary
//! directories for everything, including the "default" location.

mod common;

use std::path::{Path, PathBuf};

use common::*;
use gavia_lib::config::Config;
use gavia_lib::service::{DetectRequest, Library, SaveRequest, Service};

struct Fixture {
    _root: tempfile::TempDir,
    root: PathBuf,
    service: Service,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().to_path_buf();
        let service = open(&path);
        Self {
            _root: root,
            root: path,
            service,
        }
    }

    fn default_dir(&self) -> PathBuf {
        self.root.join("default")
    }
}

fn library(root: &Path) -> Library {
    Library {
        settings_file: root.join("config/settings.json"),
        bundled_models: Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models"),
        default_data_dir: root.join("default"),
        env_data_dir: None,
    }
}

/// Opens the app's Service the way `lib.rs` does, model included.
fn open(root: &Path) -> Service {
    let service = Service::open(library(root), Config::default()).unwrap();
    service.load_selected_model();
    service
}

fn save_one(service: &Service) -> String {
    let bytes = jpeg(640, 480);
    let request = DetectRequest {
        file_name: Some("a.jpg".into()),
        ..Default::default()
    };
    let checked = service.detect(&request, &bytes).unwrap();
    let save: SaveRequest = serde_json::from_value(serde_json::json!({
        "id": checked.id, "fileName": "a.jpg", "detections": checked.detections,
        "processingTime": checked.processing_time, "imageWidth": checked.image_width,
        "imageHeight": checked.image_height, "modelName": checked.model_name,
        "tilesProcessed": checked.tiles_processed,
    }))
    .unwrap();
    service.save(&save, &bytes).unwrap().id
}

#[test]
fn starts_in_the_default_location_with_the_bundled_model() {
    let f = Fixture::new();
    let view = f.service.settings().unwrap();
    assert!(view.is_default_data_dir);
    assert!(!view.data_dir_locked);
    assert_eq!(PathBuf::from(&view.data_dir), f.default_dir());
    assert_eq!(view.model, "loon_v1");
    assert_eq!(view.models.len(), 1);
    assert_eq!(view.model_status, "ok");
    assert_eq!(view.saved_checks, 0);
    assert!(view.models_dir.ends_with("models"));
}

#[test]
fn moving_to_an_empty_folder_carries_history_along() {
    let f = Fixture::new();
    let id = save_one(&f.service);
    let target = f.root.join("elsewhere");

    let view = f.service.set_data_dir(Some(target.clone())).unwrap();

    assert_eq!(PathBuf::from(&view.data_dir), target);
    assert!(!view.is_default_data_dir);
    assert_eq!(view.saved_checks, 1);
    assert!(target.join("gavia.db").exists());
    assert!(target.join(format!("images/{id}.jpg")).exists());
    assert!(
        !f.default_dir().join("gavia.db").exists(),
        "the original is removed once moved"
    );
    // Still usable, and images are served from the new place.
    assert_eq!(f.service.get(&id).unwrap().id, id);
    assert_eq!(
        f.service.asset(&format!("/results/{id}/image")).unwrap().1,
        "image/jpeg"
    );
}

#[test]
fn the_choice_survives_a_restart() {
    let f = Fixture::new();
    save_one(&f.service);
    let target = f.root.join("elsewhere");
    f.service.set_data_dir(Some(target.clone())).unwrap();

    let reopened = open(&f.root);
    let view = reopened.settings().unwrap();
    assert_eq!(PathBuf::from(&view.data_dir), target);
    assert_eq!(view.saved_checks, 1);
}

#[test]
fn a_folder_with_other_files_gets_a_gavia_folder_inside() {
    let f = Fixture::new();
    let documents = f.root.join("Documents");
    std::fs::create_dir_all(&documents).unwrap();
    std::fs::write(documents.join("thesis.docx"), b"mine").unwrap();

    let view = f.service.set_data_dir(Some(documents.clone())).unwrap();

    assert_eq!(PathBuf::from(&view.data_dir), documents.join("Gavia"));
    assert!(documents.join("thesis.docx").exists());
}

#[test]
fn choosing_an_existing_history_switches_to_it_without_moving() {
    let f = Fixture::new();
    save_one(&f.service);
    // A second library somewhere else, with two checks of its own.
    let other = f.root.join("other");
    {
        let other_service =
            Service::new(gavia_lib::storage::open(&other).unwrap(), Config::default());
        other_service.set_model(Ok(fresh_detector(&Config::default())));
        save_one(&other_service);
        save_one(&other_service);
    }

    let view = f.service.set_data_dir(Some(other.clone())).unwrap();

    assert_eq!(view.saved_checks, 2);
    assert!(
        f.default_dir().join("gavia.db").exists(),
        "the first history is left where it was"
    );
}

#[test]
fn reset_returns_to_the_default() {
    let f = Fixture::new();
    save_one(&f.service);
    f.service
        .set_data_dir(Some(f.root.join("elsewhere")))
        .unwrap();

    let view = f.service.set_data_dir(None).unwrap();

    assert!(view.is_default_data_dir);
    assert_eq!(view.saved_checks, 1);
    assert!(!f.root.join("elsewhere/gavia.db").exists());
}

#[test]
fn refuses_relative_paths_and_folders_inside_the_current_one() {
    let f = Fixture::new();
    save_one(&f.service);
    let relative = f
        .service
        .set_data_dir(Some("relative/dir".into()))
        .unwrap_err();
    assert_eq!(relative.code, "INVALID_REQUEST");
    let inside = f
        .service
        .set_data_dir(Some(f.default_dir().join("images/nested")))
        .unwrap_err();
    assert_eq!(inside.code, "INVALID_REQUEST");
    assert_eq!(f.service.settings().unwrap().saved_checks, 1);
}

#[test]
fn the_location_is_locked_when_set_by_the_environment() {
    let root = tempfile::tempdir().unwrap();
    let mut lib = library(root.path());
    lib.env_data_dir = Some(root.path().join("from-env"));
    let service = Service::open(lib, Config::default()).unwrap();

    let view = service.settings().unwrap();
    assert!(view.data_dir_locked);
    assert!(view.data_dir.ends_with("from-env"));
    assert_eq!(
        service
            .set_data_dir(Some(root.path().join("x")))
            .unwrap_err()
            .code,
        "INVALID_REQUEST"
    );
}

#[test]
fn custom_models_can_be_chosen_and_the_choice_is_remembered() {
    let f = Fixture::new();
    let models = f.default_dir().join("models");
    std::fs::create_dir_all(&models).unwrap();
    let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models");
    std::fs::copy(
        bundled.join("loon_v1.onnx"),
        models.join("loon_retrained.onnx"),
    )
    .unwrap();
    std::fs::copy(
        bundled.join("loon_v1.json"),
        models.join("loon_retrained.json"),
    )
    .unwrap();

    let view = f.service.select_model("loon_retrained").unwrap();
    assert_eq!(view.model, "loon_retrained");
    assert_eq!(view.model_status, "starting");
    f.service.load_selected_model();
    assert_eq!(f.service.settings().unwrap().model_status, "ok");

    let reopened = open(&f.root);
    let view = reopened.settings().unwrap();
    assert_eq!(view.model, "loon_retrained");
    assert!(
        view.models
            .iter()
            .any(|m| m.id == "loon_retrained" && m.custom)
    );
}

#[test]
fn an_unknown_model_is_refused_and_a_vanished_one_falls_back() {
    let f = Fixture::new();
    assert_eq!(
        f.service.select_model("nope").unwrap_err().code,
        "NOT_FOUND"
    );

    std::fs::create_dir_all(f.root.join("config")).unwrap();
    std::fs::write(
        f.root.join("config/settings.json"),
        r#"{"model":"deleted_one"}"#,
    )
    .unwrap();
    let reopened = open(&f.root);
    let view = reopened.settings().unwrap();
    assert_eq!(view.model, "loon_v1");
    assert_eq!(view.model_status, "ok");
}
