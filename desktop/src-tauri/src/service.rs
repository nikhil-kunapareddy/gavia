//! What the UI can ask for, independent of how it asks.
//!
//! `commands.rs` adapts these methods to Tauri's `invoke`, and `protocol.rs`
//! serves stored images from them over `gavia://`. Keeping the contract here,
//! free of Tauri types, is what lets `tests/` drive the real stack — real
//! model, real SQLite, real files — without a webview.
//!
//! The wire types are camelCase to match `src/types/detection.ts` exactly. The
//! UI consumes them without a mapping layer, so the two definitions must agree.

use std::sync::{Arc, Condvar, Mutex};

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::detection::loader;
use crate::detection::{DetectError, DetectOptions, Detector};
use crate::error::ApiError;
use crate::platform;
use crate::storage::{NewResult, Repository, SaveError, StoredDetection, StoredResult};

/// Content types the uploader may claim. The bytes are sniffed regardless;
/// this only turns away an obviously wrong file with a clearer message.
const ACCEPTED_CONTENT_TYPES: [&str; 3] = ["image/jpeg", "image/png", "image/webp"];

/// Position and size as percentages of the image, 0-100, so the overlay does
/// not care what size the image is rendered at.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoundingBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub id: String,
    pub label: String,
    pub confidence: f64,
    pub bounding_box: BoundingBox,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionResult {
    pub id: String,
    /// Empty until saved: nothing is stored until the reviewer keeps it, so the
    /// check page shows its own object URL in the meantime.
    pub image_url: String,
    pub thumbnail_url: String,
    pub file_name: String,
    pub file_size: u64,
    pub detections: Vec<Detection>,
    /// Seconds of inference.
    pub processing_time: f64,
    pub timestamp: String,
    pub image_width: u32,
    pub image_height: u32,
    pub model_name: String,
    pub tiles_processed: u32,
    pub saved: bool,
}

/// Metadata that travels with the bytes of a `detect` call.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectRequest {
    pub file_name: Option<String>,
    pub content_type: Option<String>,
    /// Override tiled inference. Off by default: it helps only when birds are
    /// small relative to the frame.
    pub tiling: Option<bool>,
}

/// The client's copy of a result, handed back to be committed.
///
/// Takes the detections rather than recomputing them, so what is saved is
/// exactly what the reviewer looked at when they decided.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub id: String,
    pub file_name: String,
    pub detections: Vec<Detection>,
    pub processing_time: f64,
    pub image_width: u32,
    pub image_height: u32,
    pub model_name: String,
    pub tiles_processed: u32,
}

impl SaveRequest {
    /// Every rule the Python schema enforced. `id` matters most: it becomes a
    /// filename, and refusing separators and dots keeps `images/<id>.jpg`
    /// inside the data directory.
    fn problems(&self) -> Vec<&'static str> {
        let mut problems = Vec::new();
        let chars = |s: &str| s.chars().count();
        if !(1..=64).contains(&self.id.len())
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            problems.push("id");
        }
        if !(1..=512).contains(&chars(&self.file_name)) {
            problems.push("fileName");
        }
        if self.detections.len() > 1000 {
            problems.push("detections");
        }
        for d in &self.detections {
            let b = &d.bounding_box;
            if !(0.0..=1.0).contains(&d.confidence)
                || ![b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite())
            {
                problems.push("detections.confidence");
            }
        }
        if !(self.processing_time >= 0.0 && self.processing_time.is_finite()) {
            problems.push("processingTime");
        }
        if self.image_width == 0 {
            problems.push("imageWidth");
        }
        if self.image_height == 0 {
            problems.push("imageHeight");
        }
        if !(1..=128).contains(&chars(&self.model_name)) {
            problems.push("modelName");
        }
        if self.tiles_processed < 1 {
            problems.push("tilesProcessed");
        }
        problems
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelResponse {
    pub name: String,
    pub architecture: String,
    pub classes: Vec<String>,
    pub input_size: u32,
    pub confidence_threshold: f64,
    pub iou_threshold: f64,
    pub tiling_enabled: bool,
    pub provider: String,
    pub metrics: std::collections::BTreeMap<String, f64>,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthResponse {
    /// `starting` while the model loads, `ok` once it can detect, `degraded`
    /// if it failed to load — history still works then.
    pub status: &'static str,
    pub service: &'static str,
    pub version: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Deleted {
    pub deleted: usize,
}

enum Slot {
    Loading,
    Ready(Arc<Detector>),
    Failed,
}

/// The model loads on a background thread so the window appears at once.
/// A check requested before it is ready waits rather than failing.
struct ModelSlot {
    state: Mutex<Slot>,
    ready: Condvar,
}

pub struct Service {
    model: ModelSlot,
    repository: Repository,
    config: Config,
}

impl Service {
    pub fn new(repository: Repository, config: Config) -> Self {
        Self {
            model: ModelSlot {
                state: Mutex::new(Slot::Loading),
                ready: Condvar::new(),
            },
            repository,
            config,
        }
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Hand over the outcome of loading the model. A failure leaves the app
    /// running in a degraded state rather than refusing to start.
    pub fn set_model(&self, loaded: Result<Detector, String>) {
        let slot = match loaded {
            Ok(detector) => Slot::Ready(Arc::new(detector)),
            Err(error) => {
                log::error!("model failed to load: {error}");
                Slot::Failed
            }
        };
        *self.lock_model() = slot;
        self.model.ready.notify_all();
    }

    fn lock_model(&self) -> std::sync::MutexGuard<'_, Slot> {
        self.model.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn detector(&self) -> Result<Arc<Detector>, ApiError> {
        let mut state = self.lock_model();
        while matches!(*state, Slot::Loading) {
            state = self
                .model
                .ready
                .wait(state)
                .unwrap_or_else(|p| p.into_inner());
        }
        match &*state {
            Slot::Ready(detector) => Ok(detector.clone()),
            _ => Err(ApiError::model_unavailable()),
        }
    }

    pub fn health(&self) -> HealthResponse {
        let status = match &*self.lock_model() {
            Slot::Loading => "starting",
            Slot::Ready(_) => "ok",
            Slot::Failed => "degraded",
        };
        HealthResponse {
            status,
            service: "Gavia",
            version: env!("CARGO_PKG_VERSION"),
        }
    }

    pub fn model_info(&self) -> Result<ModelResponse, ApiError> {
        let detector = self.detector()?;
        let info = detector.info();
        Ok(ModelResponse {
            name: info.name.clone(),
            architecture: info.architecture.clone(),
            classes: info.classes.clone(),
            input_size: info.input_size,
            confidence_threshold: self
                .config
                .confidence_threshold
                .unwrap_or(info.confidence_threshold),
            iou_threshold: self.config.iou_threshold.unwrap_or(info.iou_threshold),
            tiling_enabled: detector.tiling_enabled(),
            provider: detector.provider().into(),
            metrics: info.metrics.clone(),
            sha256: info.sha256.clone(),
        })
    }

    /// Detect loons in one photograph.
    ///
    /// Deliberately does **not** persist. A reviewer looks at a result and
    /// decides whether it is worth keeping; writing every check to disk would
    /// fill their history with images they had already dismissed.
    pub fn detect(
        &self,
        request: &DetectRequest,
        bytes: &[u8],
    ) -> Result<DetectionResult, ApiError> {
        if let Some(content_type) = request.content_type.as_deref().filter(|c| !c.is_empty())
            && !ACCEPTED_CONTENT_TYPES.contains(&content_type)
        {
            return Err(ApiError::unsupported_format(format!(
                "{content_type} is not supported. Upload a JPG, PNG, or WEBP image."
            )));
        }
        self.check_upload(bytes)?;
        loader::sniff(bytes)?;

        let detector = self.detector()?;
        let options = DetectOptions {
            confidence_threshold: self.config.confidence_threshold,
            iou_threshold: self.config.iou_threshold,
            tiling: request.tiling,
        };
        let outcome = detector.detect(bytes, options).map_err(|e| match e {
            DetectError::Load(e) => ApiError::from(e),
            DetectError::Inference(e) => ApiError::internal(e),
        })?;

        let id = uuid::Uuid::new_v4().simple().to_string();
        log::info!(
            "detection {id}: {} found, {} tile(s), {:.1}ms, {} pixels",
            outcome.predictions.len(),
            outcome.tiles_processed,
            outcome.duration_seconds * 1000.0,
            u64::from(outcome.image_width) * u64::from(outcome.image_height),
        );

        Ok(DetectionResult {
            detections: outcome
                .predictions
                .iter()
                .enumerate()
                .map(|(i, p)| Detection {
                    id: format!("{id}-{i}"),
                    label: p.label.clone(),
                    confidence: p.confidence,
                    bounding_box: BoundingBox {
                        x: p.x,
                        y: p.y,
                        width: p.width,
                        height: p.height,
                    },
                })
                .collect(),
            image_url: String::new(),
            thumbnail_url: String::new(),
            file_name: request
                .file_name
                .clone()
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "upload".into()),
            file_size: bytes.len() as u64,
            processing_time: (outcome.duration_seconds * 1000.0).round() / 1000.0,
            timestamp: chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S+00:00")
                .to_string(),
            image_width: outcome.image_width,
            image_height: outcome.image_height,
            model_name: detector.info().name.clone(),
            tiles_processed: outcome.tiles_processed as u32,
            saved: false,
            id,
        })
    }

    /// Commit a result the reviewer chose to keep, with the image re-sent.
    ///
    /// No server-side staging between `detect` and `save` means nothing to
    /// expire or clean up after a crash.
    pub fn save(&self, request: &SaveRequest, bytes: &[u8]) -> Result<DetectionResult, ApiError> {
        let problems = request.problems();
        if !problems.is_empty() {
            return Err(ApiError::invalid_request(format!(
                "Malformed result payload: {} problem(s) ({}).",
                problems.len(),
                problems.join(", ")
            )));
        }
        self.check_upload(bytes)?;
        let format = loader::sniff(bytes)?;

        let stored = self
            .repository
            .save(NewResult {
                id: &request.id,
                file_name: &request.file_name,
                bytes,
                format,
                image_width: request.image_width,
                image_height: request.image_height,
                processing_time: request.processing_time,
                model_name: &request.model_name,
                tiles_processed: request.tiles_processed,
                detections: request
                    .detections
                    .iter()
                    .map(|d| StoredDetection {
                        label: d.label.clone(),
                        confidence: d.confidence,
                        x: d.bounding_box.x,
                        y: d.bounding_box.y,
                        width: d.bounding_box.width,
                        height: d.bounding_box.height,
                    })
                    .collect(),
            })
            .map_err(|e| match e {
                // The primary key is the arbiter rather than a prior SELECT,
                // which would leave a window for two saves of the same result.
                SaveError::Duplicate => ApiError::already_saved(),
                SaveError::Database(e) => ApiError::internal(e),
                SaveError::Io(e) => ApiError::internal(e),
            })?;
        Ok(to_wire(&stored))
    }

    pub fn list(
        &self,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Vec<DetectionResult>, ApiError> {
        let limit = limit.unwrap_or(200);
        if !(1..=1000).contains(&limit) {
            return Err(ApiError::invalid_request(
                "limit must be between 1 and 1000.",
            ));
        }
        Ok(self
            .repository
            .list(limit, offset.unwrap_or(0))?
            .iter()
            .map(to_wire)
            .collect())
    }

    pub fn get(&self, id: &str) -> Result<DetectionResult, ApiError> {
        self.repository
            .get(id)?
            .map(|stored| to_wire(&stored))
            .ok_or_else(|| ApiError::not_found("No saved result with that id."))
    }

    pub fn delete(&self, id: &str) -> Result<Deleted, ApiError> {
        if self.repository.delete(id)? {
            Ok(Deleted { deleted: 1 })
        } else {
            Err(ApiError::not_found("No saved result with that id."))
        }
    }

    pub fn clear(&self) -> Result<Deleted, ApiError> {
        Ok(Deleted {
            deleted: self.repository.clear()?,
        })
    }

    /// Bytes and content type for `results/<id>/image` or `results/<id>/thumb`.
    pub fn asset(&self, path: &str) -> Result<(Vec<u8>, &'static str), ApiError> {
        let not_found = || ApiError::not_found("No saved result with that id.");
        let mut parts = path.trim_matches('/').split('/');
        let (Some("results"), Some(id), Some(kind), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(not_found());
        };
        let stored = self.repository.get(id)?.ok_or_else(not_found)?;

        if kind == "thumb" {
            match std::fs::read(self.repository.thumb_path(id)) {
                Ok(bytes) => return Ok((bytes, "image/webp")),
                // Thumbnailing is best-effort at save time, so fall back to
                // the original rather than showing a broken image.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        } else if kind != "image" {
            return Err(not_found());
        }

        let bytes = std::fs::read(self.repository.image_path(id, &stored.image_ext))
            .map_err(|_| ApiError::not_found("The image for that result is missing from disk."))?;
        Ok((bytes, media_type(&stored.image_ext)))
    }

    fn check_upload(&self, bytes: &[u8]) -> Result<(), ApiError> {
        if bytes.len() as u64 > self.config.max_upload_bytes {
            return Err(ApiError::image_too_large(format!(
                "This image is too large. Please choose an image smaller than {} MB.",
                self.config.max_upload_bytes / (1024 * 1024)
            )));
        }
        Ok(())
    }
}

fn media_type(extension: &str) -> &'static str {
    match extension {
        ".jpg" => "image/jpeg",
        ".png" => "image/png",
        ".webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

/// A stored row in the wire format. Detection ids derive from position, so
/// re-fetching a result gives the same ids and React keys stay put.
fn to_wire(stored: &StoredResult) -> DetectionResult {
    let base = format!("{}/results/{}", platform::ASSET_ORIGIN, stored.id);
    DetectionResult {
        id: stored.id.clone(),
        image_url: format!("{base}/image"),
        thumbnail_url: format!("{base}/thumb"),
        file_name: stored.file_name.clone(),
        file_size: stored.file_size,
        detections: stored
            .detections
            .iter()
            .enumerate()
            .map(|(i, d)| Detection {
                id: format!("{}-{i}", stored.id),
                label: d.label.clone(),
                confidence: d.confidence,
                bounding_box: BoundingBox {
                    x: d.x,
                    y: d.y,
                    width: d.width,
                    height: d.height,
                },
            })
            .collect(),
        processing_time: stored.processing_time,
        timestamp: stored.created_at.clone(),
        image_width: stored.image_width,
        image_height: stored.image_height,
        model_name: stored.model_name.clone(),
        tiles_processed: stored.tiles_processed,
        saved: true,
    }
}

/// Split a raw `invoke` body into its JSON metadata and the image bytes.
///
/// Layout: a little-endian `u32` length, that many bytes of UTF-8 JSON, then
/// the file. One framing for both upload commands, and no 20MB image ever
/// passes through a JSON encoder.
pub fn unframe<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<(T, &[u8]), ApiError> {
    let malformed = || ApiError::invalid_request("Malformed request body.");
    let (length, rest) = body.split_first_chunk::<4>().ok_or_else(malformed)?;
    let length = u32::from_le_bytes(*length) as usize;
    if rest.len() < length {
        return Err(malformed());
    }
    let (json, bytes) = rest.split_at(length);
    let meta = serde_json::from_slice(json).map_err(|e| {
        ApiError::invalid_request(format!("Malformed result payload: 1 problem(s) ({e})."))
    })?;
    Ok((meta, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(meta: &serde_json::Value, bytes: &[u8]) -> Vec<u8> {
        let json = serde_json::to_vec(meta).unwrap();
        let mut out = (json.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(&json);
        out.extend_from_slice(bytes);
        out
    }

    fn request() -> SaveRequest {
        serde_json::from_value(serde_json::json!({
            "id": "abc_123-x", "fileName": "loon.jpg", "detections": [],
            "processingTime": 0.1, "imageWidth": 10, "imageHeight": 10,
            "modelName": "loon_v1", "tilesProcessed": 1
        }))
        .unwrap()
    }

    #[test]
    fn unframes_metadata_and_bytes() {
        let body = frame(&serde_json::json!({"fileName": "a.jpg"}), b"IMAGE");
        let (meta, bytes): (DetectRequest, _) = unframe(&body).unwrap();
        assert_eq!(meta.file_name.as_deref(), Some("a.jpg"));
        assert_eq!(bytes, b"IMAGE");
    }

    #[test]
    fn rejects_truncated_frames() {
        assert_eq!(
            unframe::<DetectRequest>(b"\x01").unwrap_err().code,
            "INVALID_REQUEST"
        );
        assert_eq!(
            unframe::<DetectRequest>(b"\xFF\0\0\0{}").unwrap_err().code,
            "INVALID_REQUEST"
        );
        assert_eq!(
            unframe::<DetectRequest>(&frame(&serde_json::json!([1]), b""))
                .unwrap_err()
                .code,
            "INVALID_REQUEST"
        );
    }

    #[test]
    fn a_valid_save_request_has_no_problems() {
        assert!(request().problems().is_empty());
    }

    #[test]
    fn ids_that_could_escape_the_data_directory_are_refused() {
        for id in ["../etc", "a/b", "a.b", "", &"x".repeat(65), "a b"] {
            let mut r = request();
            r.id = id.to_string();
            assert_eq!(r.problems(), vec!["id"], "{id:?}");
        }
    }

    #[test]
    fn every_field_rule_is_enforced() {
        let mut r = request();
        r.file_name.clear();
        r.processing_time = -1.0;
        r.image_width = 0;
        r.image_height = 0;
        r.model_name = "m".repeat(129);
        r.tiles_processed = 0;
        r.detections = vec![Detection {
            id: "d".into(),
            label: "Loon".into(),
            confidence: 1.5,
            bounding_box: BoundingBox {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
        }];
        assert_eq!(r.problems().len(), 7);
    }

    #[test]
    fn media_types_follow_the_stored_extension() {
        assert_eq!(media_type(".jpg"), "image/jpeg");
        assert_eq!(media_type(".webp"), "image/webp");
        assert_eq!(media_type(".exe"), "application/octet-stream");
    }
}
