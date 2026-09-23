//! Every `#[tauri::command]` the UI can `invoke`.
//!
//! Thin on purpose: each one unpacks its arguments, moves the work off the
//! async runtime, and calls [`Service`]. Adding one is four steps — write it
//! here, register it in `lib.rs`, wrap it in `src/services/`, and teach the
//! fakes in `src/dev/browserPreview.ts` and `App.workflow.test.tsx` to answer.

use std::sync::Arc;

use tauri::State;
use tauri::ipc::{InvokeBody, Request};

use crate::error::ApiError;
use crate::service::{
    Deleted, DetectRequest, DetectionResult, HealthResponse, ModelResponse, SaveRequest, Service,
    unframe,
};

type Result<T> = std::result::Result<T, ApiError>;

/// Run blocking work (inference, SQLite, disk) on a worker thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(ApiError::internal)?
}

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(_) => Err(ApiError::invalid_request(
            "Expected the image as a binary body.",
        )),
    }
}

#[tauri::command]
pub async fn health(service: State<'_, Arc<Service>>) -> Result<HealthResponse> {
    Ok(service.health())
}

#[tauri::command]
pub async fn model_info(service: State<'_, Arc<Service>>) -> Result<ModelResponse> {
    let service = service.inner().clone();
    blocking(move || service.model_info()).await
}

/// Body: framed `DetectRequest` JSON plus the image. See [`unframe`].
#[tauri::command]
pub async fn detect(
    request: Request<'_>,
    service: State<'_, Arc<Service>>,
) -> Result<DetectionResult> {
    let body = raw_body(&request)?;
    let service = service.inner().clone();
    blocking(move || {
        let (meta, bytes): (DetectRequest, _) = unframe(&body)?;
        service.detect(&meta, bytes)
    })
    .await
}

/// Body: framed `SaveRequest` JSON plus the image, re-sent by the client.
#[tauri::command]
pub async fn save_result(
    request: Request<'_>,
    service: State<'_, Arc<Service>>,
) -> Result<DetectionResult> {
    let body = raw_body(&request)?;
    let service = service.inner().clone();
    blocking(move || {
        let (meta, bytes): (SaveRequest, _) = unframe(&body)?;
        service.save(&meta, bytes)
    })
    .await
}

#[tauri::command]
pub async fn list_results(
    service: State<'_, Arc<Service>>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<DetectionResult>> {
    let service = service.inner().clone();
    blocking(move || service.list(limit, offset)).await
}

#[tauri::command]
pub async fn get_result(service: State<'_, Arc<Service>>, id: String) -> Result<DetectionResult> {
    let service = service.inner().clone();
    blocking(move || service.get(&id)).await
}

#[tauri::command]
pub async fn delete_result(service: State<'_, Arc<Service>>, id: String) -> Result<Deleted> {
    let service = service.inner().clone();
    blocking(move || service.delete(&id)).await
}

#[tauri::command]
pub async fn clear_results(service: State<'_, Arc<Service>>) -> Result<Deleted> {
    let service = service.inner().clone();
    blocking(move || service.clear()).await
}
