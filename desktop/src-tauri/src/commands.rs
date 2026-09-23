//! Every `#[tauri::command]` the UI can `invoke`.
//!
//! Thin on purpose: each one unpacks its arguments, moves the work off the
//! async runtime, and calls [`Service`]. Adding one is four steps — write it
//! here, register it in `lib.rs`, wrap it in `src/services/`, and teach the
//! fakes in `src/dev/browserPreview.ts` and `App.workflow.test.tsx` to answer.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::error::ApiError;
use crate::service::{
    Deleted, DetectRequest, DetectionResult, HealthResponse, ModelResponse, SaveRequest, Service,
    SettingsView, unframe,
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

#[tauri::command]
pub async fn get_settings(service: State<'_, Arc<Service>>) -> Result<SettingsView> {
    let service = service.inner().clone();
    blocking(move || service.settings()).await
}

/// Move history to `path`, or back to the default location with `null`.
#[tauri::command]
pub async fn set_data_dir(
    service: State<'_, Arc<Service>>,
    path: Option<String>,
) -> Result<SettingsView> {
    let service = service.inner().clone();
    blocking(move || service.set_data_dir(path.map(PathBuf::from))).await
}

/// Switch models. Returns at once with `modelStatus: "starting"`; the model
/// loads on a thread, and a check requested meanwhile waits for it.
#[tauri::command]
pub async fn select_model(service: State<'_, Arc<Service>>, id: String) -> Result<SettingsView> {
    let service = service.inner().clone();
    blocking(move || {
        let view = service.select_model(&id)?;
        std::thread::spawn(move || service.load_selected_model());
        Ok(view)
    })
    .await
}

/// Show the storage folder (`"data"`) or the models folder (`"models"`) in the
/// system file manager, creating the models folder if it isn't there yet.
#[tauri::command]
pub async fn open_folder(
    app: AppHandle,
    service: State<'_, Arc<Service>>,
    which: String,
) -> Result<()> {
    let data_dir = service.data_dir();
    let path = match which.as_str() {
        "data" => data_dir,
        "models" => {
            let models = data_dir.join("models");
            std::fs::create_dir_all(&models)?;
            models
        }
        _ => {
            return Err(ApiError::invalid_request(format!(
                "Unknown folder {which}."
            )));
        }
    };
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(ApiError::internal)
}
