//! End-to-end journeys through the real stack — real model, real SQLite, real
//! files — driven through `Service`, the same object the Tauri commands and the
//! `gavia://` scheme call. This is the contract `src/services/` relies on.

mod common;

use common::*;
use gavia_lib::config::Config;
use gavia_lib::service::{CallRequest, DetectRequest, SaveRequest, Service};
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
    assert_eq!(info.name, "Loonet 1.0");
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

fn call_request(name: &str, content_type: &str) -> CallRequest {
    CallRequest {
        file_name: Some(name.into()),
        content_type: Some(content_type.into()),
    }
}

fn listening_service(dir: &std::path::Path) -> Service {
    let service = Service::new(storage::open(dir).unwrap(), Config::default());
    service.set_call_model(gavia_lib::calls::CallDetector::load(
        &call_model_path(),
        Some(2),
    ));
    service
}

#[test]
fn listen_to_a_recording_and_write_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let service = listening_service(dir.path());
    let bytes = audio_fixture("loon.mp3");

    let heard = service
        .detect_calls(&call_request("lake.mp3", "audio/mpeg"), &bytes)
        .unwrap();
    assert_eq!(heard.file_name, "lake.mp3");
    assert_eq!(heard.file_size, bytes.len() as u64);
    assert_eq!((heard.sample_rate, heard.channels), (48_000, 1));
    assert_eq!(heard.label, "Loon call");
    assert_eq!(heard.model_name, "looncall 1.0");
    assert_eq!(heard.threshold, 0.5);
    let starts: Vec<f64> = heard.windows.iter().map(|w| w.start).collect();
    assert_eq!(starts, vec![0.0, 3.0, 6.0]);
    assert!((heard.windows[2].end - heard.duration).abs() < 1e-9);
    assert!(
        heard
            .windows
            .iter()
            .all(|w| w.confidence >= heard.threshold)
    );
    assert_eq!(heard.id.len(), 32);

    // The wire shape is camelCase, as src/types/calls.ts expects.
    let wire = serde_json::to_value(&heard).unwrap();
    for key in [
        "fileName",
        "fileSize",
        "sampleRate",
        "modelName",
        "processingTime",
    ] {
        assert!(wire.get(key).is_some(), "{key}");
    }
    // Listening, like checking a photo, keeps nothing.
    assert_eq!(service.list(None, None).unwrap().len(), 0);
}

#[test]
fn recordings_the_ui_should_explain_are_refused_with_their_codes() {
    let dir = tempfile::tempdir().unwrap();
    let service = listening_service(dir.path());
    let cases = [
        (
            call_request("photo.jpg", "image/jpeg"),
            b"\xFF\xD8\xFF".to_vec(),
            "UNSUPPORTED_FORMAT",
        ),
        (
            call_request("notes.mp3", "audio/mpeg"),
            b"just some text".to_vec(),
            "UNSUPPORTED_FORMAT",
        ),
        (
            call_request("empty.wav", ""),
            Vec::new(),
            "UNSUPPORTED_FORMAT",
        ),
        (
            call_request("cut.flac", "audio/flac"),
            b"fLaC\0\0\0\x22".to_vec(),
            "DECODE_FAILED",
        ),
    ];
    for (request, bytes, code) in cases {
        let error = service.detect_calls(&request, &bytes).unwrap_err();
        assert_eq!(
            error.code, code,
            "{:?}: {}",
            request.file_name, error.message
        );
    }

    let config = Config {
        max_audio_bytes: 1024,
        ..Config::default()
    };
    let small = Service::new(storage::open(dir.path()).unwrap(), config);
    let error = small
        .detect_calls(
            &call_request("long.mp3", "audio/mpeg"),
            &audio_fixture("loon.mp3"),
        )
        .unwrap_err();
    assert_eq!(error.code, "RECORDING_TOO_LARGE");

    let config = Config {
        max_audio_seconds: 2.0,
        ..Config::default()
    };
    let short = Service::new(storage::open(dir.path()).unwrap(), config);
    short.set_call_model(gavia_lib::calls::CallDetector::load(
        &call_model_path(),
        Some(1),
    ));
    let error = short
        .detect_calls(
            &call_request("long.mp3", "audio/mpeg"),
            &audio_fixture("loon.mp3"),
        )
        .unwrap_err();
    assert_eq!(error.code, "RECORDING_TOO_LARGE");
}

#[test]
fn without_a_call_model_photos_still_work() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path());
    service.set_call_model(Err("missing".into()));
    let error = service
        .detect_calls(
            &call_request("lake.mp3", "audio/mpeg"),
            &audio_fixture("loon.mp3"),
        )
        .unwrap_err();
    assert_eq!(error.code, "MODEL_UNAVAILABLE");
    assert!(error.message.contains("call"));
    assert!(
        service
            .detect(&detect_request("lake.jpg"), &jpeg(640, 480))
            .is_ok()
    );
}
