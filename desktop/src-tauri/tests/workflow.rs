//! End-to-end journeys through the real stack — real model, real SQLite, real
//! files — driven through `Service`, the same object the Tauri commands and the
//! `gavia://` scheme call. This is the contract `src/services/` relies on.

mod common;

use common::*;
use gavia_lib::config::Config;
use gavia_lib::service::{DetectRequest, SaveRequest, Service};
use gavia_lib::storage;

fn service(dir: &std::path::Path) -> Service {
    let config = Config::default();
    let service = Service::new(storage::open(dir).unwrap(), config.clone());
    service.set_model(Ok(fresh_detector(&config)));
    service
}

fn detect_request(name: &str) -> DetectRequest {
    DetectRequest {
        file_name: Some(name.into()),
        content_type: Some("image/jpeg".into()),
        tiling: None,
    }
}

/// What `saveResult` in the UI sends back: the reviewer's copy of the result.
fn save_request(result: &gavia_lib::service::DetectionResult) -> SaveRequest {
    serde_json::from_value(serde_json::json!({
        "id": result.id,
        "fileName": result.file_name,
        "detections": result.detections,
        "processingTime": result.processing_time,
        "imageWidth": result.image_width,
        "imageHeight": result.image_height,
        "modelName": result.model_name,
        "tilesProcessed": result.tiles_processed,
    }))
    .unwrap()
}

#[test]
fn check_keep_browse_and_delete() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path());
    let bytes = jpeg(1600, 1200);

    // Check: nothing is written, and there is no URL yet.
    let checked = service.detect(&detect_request("lake.jpg"), &bytes).unwrap();
    assert!(!checked.saved);
    assert_eq!(checked.image_url, "");
    assert_eq!(checked.file_name, "lake.jpg");
    assert_eq!(checked.file_size, bytes.len() as u64);
    assert_eq!((checked.image_width, checked.image_height), (1600, 1200));
    assert_eq!(service.list(None, None).unwrap().len(), 0);

    // Keep: what is stored is exactly what the reviewer looked at.
    let kept = service.save(&save_request(&checked), &bytes).unwrap();
    assert!(kept.saved);
    assert_eq!(kept.id, checked.id);
    assert_eq!(kept.detections.len(), checked.detections.len());
    assert!(
        kept.image_url
            .ends_with(&format!("/results/{}/image", kept.id))
    );
    assert!(
        kept.thumbnail_url
            .ends_with(&format!("/results/{}/thumb", kept.id))
    );

    // Browse: listed, fetchable, and the images are served.
    let history = service.list(None, None).unwrap();
    assert_eq!(history, vec![kept.clone()]);
    assert_eq!(service.get(&kept.id).unwrap(), kept);
    let (original, content_type) = service
        .asset(&format!("/results/{}/image", kept.id))
        .unwrap();
    assert_eq!((original, content_type), (bytes.clone(), "image/jpeg"));
    let (thumb, content_type) = service
        .asset(&format!("/results/{}/thumb", kept.id))
        .unwrap();
    assert_eq!(content_type, "image/webp");
    assert!(thumb.len() < bytes.len());

    // Delete.
    assert_eq!(service.delete(&kept.id).unwrap().deleted, 1);
    assert_eq!(service.get(&kept.id).unwrap_err().code, "NOT_FOUND");
    assert_eq!(
        service
            .asset(&format!("/results/{}/image", kept.id))
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
}

#[test]
fn history_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = jpeg(800, 600);
    let kept = {
        let service = service(dir.path());
        let checked = service.detect(&detect_request("a.jpg"), &bytes).unwrap();
        service.save(&save_request(&checked), &bytes).unwrap()
    };
    let reopened = Service::new(storage::open(dir.path()).unwrap(), Config::default());
    assert_eq!(reopened.list(None, None).unwrap(), vec![kept]);
}

#[test]
fn saving_twice_is_refused_and_keeps_the_first() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path());
    let bytes = jpeg(640, 480);
    let checked = service.detect(&detect_request("a.jpg"), &bytes).unwrap();
    service.save(&save_request(&checked), &bytes).unwrap();

    let other = jpeg(700, 500);
    assert_eq!(
        service
            .save(&save_request(&checked), &other)
            .unwrap_err()
            .code,
        "ALREADY_SAVED"
    );
    assert_eq!(
        service
            .asset(&format!("/results/{}/image", checked.id))
            .unwrap()
            .0,
        bytes
    );
}

#[test]
fn clear_empties_the_history() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path());
    let bytes = jpeg(640, 480);
    for _ in 0..3 {
        let checked = service.detect(&detect_request("a.jpg"), &bytes).unwrap();
        service.save(&save_request(&checked), &bytes).unwrap();
    }
    assert_eq!(service.clear().unwrap().deleted, 3);
    assert!(service.list(None, None).unwrap().is_empty());
    assert_eq!(service.clear().unwrap().deleted, 0);
}

#[test]
fn rejects_what_the_ui_should_explain() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path());

    let gif = DetectRequest {
        content_type: Some("image/gif".into()),
        ..detect_request("a.gif")
    };
    assert_eq!(
        service.detect(&gif, b"GIF89a").unwrap_err().code,
        "UNSUPPORTED_FORMAT"
    );
    assert_eq!(
        service
            .detect(&detect_request("e.jpg"), b"")
            .unwrap_err()
            .code,
        "UNSUPPORTED_FORMAT"
    );
    assert_eq!(
        service
            .detect(&detect_request("x.jpg"), b"not an image at all")
            .unwrap_err()
            .code,
        "DECODE_FAILED"
    );

    let huge = vec![0xFFu8; 21 * 1024 * 1024];
    let error = service
        .detect(&detect_request("big.jpg"), &huge)
        .unwrap_err();
    assert_eq!((error.code, error.status), ("IMAGE_TOO_LARGE", 413));
}

#[test]
fn a_malformed_save_is_invalid_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path());
    let bytes = jpeg(640, 480);
    let mut checked = service.detect(&detect_request("a.jpg"), &bytes).unwrap();
    checked.id = "../../escape".into();
    assert_eq!(
        service
            .save(&save_request(&checked), &bytes)
            .unwrap_err()
            .code,
        "INVALID_REQUEST"
    );
    assert!(service.list(None, None).unwrap().is_empty());
    assert_eq!(
        service.list(Some(0), None).unwrap_err().code,
        "INVALID_REQUEST"
    );
}

#[test]
fn without_a_model_history_still_works() {
    let dir = tempfile::tempdir().unwrap();
    let service = Service::new(storage::open(dir.path()).unwrap(), Config::default());
    assert_eq!(service.health().status, "starting");
    service.set_model(Err("missing".into()));

    assert_eq!(service.health().status, "degraded");
    assert_eq!(
        service
            .detect(&detect_request("a.jpg"), &jpeg(64, 64))
            .unwrap_err()
            .code,
        "MODEL_UNAVAILABLE"
    );
    assert_eq!(service.model_info().unwrap_err().code, "MODEL_UNAVAILABLE");
    assert!(service.list(None, None).unwrap().is_empty());
}

#[test]
fn a_check_during_startup_waits_for_the_model() {
    let dir = tempfile::tempdir().unwrap();
    let service = std::sync::Arc::new(Service::new(
        storage::open(dir.path()).unwrap(),
        Config::default(),
    ));
    let waiting = {
        let service = service.clone();
        std::thread::spawn(move || service.detect(&detect_request("a.jpg"), &jpeg(64, 64)))
    };
    std::thread::sleep(std::time::Duration::from_millis(50));
    service.set_model(Ok(fresh_detector(&Config::default())));
    assert!(waiting.join().unwrap().is_ok());
    assert_eq!(service.health().status, "ok");
}

#[test]
fn model_info_reports_the_loaded_weights() {
    let dir = tempfile::tempdir().unwrap();
    let info = service(dir.path()).model_info().unwrap();
    assert_eq!(info.name, "loon_v1");
    assert_eq!(info.classes, vec!["common loon"]);
    assert_eq!(info.provider, "CPUExecutionProvider");
    assert!(!info.tiling_enabled);
    assert_eq!(info.sha256.len(), 64);
}

#[test]
fn unknown_asset_paths_are_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path());
    for path in [
        "/",
        "/results",
        "/results/x",
        "/results/x/image/extra",
        "/other/x/image",
        "/results/x/raw",
    ] {
        assert_eq!(service.asset(path).unwrap_err().code, "NOT_FOUND", "{path}");
    }
}
