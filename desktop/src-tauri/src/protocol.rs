//! The `gavia://` scheme, which serves stored images to `<img src>`.
//!
//! `invoke` returns data, but an `<img>` needs a URL. A custom scheme gives
//! stored originals and thumbnails one without a local HTTP server, a port or
//! a token. URLs look like `gavia://localhost/results/<id>/image` on macOS and
//! Linux and `http://gavia.localhost/results/<id>/image` on Windows; see
//! `platform::ASSET_ORIGIN`.

use std::sync::Arc;

use tauri::http::{Response, StatusCode, header};

use crate::service::Service;

pub const SCHEME: &str = "gavia";

/// Stored images never change: ids are unique per save and bytes are written
/// once, so they can be cached hard and the history grid never re-fetches.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

pub fn respond(service: Option<Arc<Service>>, path: &str) -> Response<Vec<u8>> {
    let builder = Response::builder()
        // The page is served from another origin (tauri://localhost). Without
        // this, drawing a stored photo onto a canvas for the annotated
        // download taints the canvas and the export throws.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

    let Some(service) = service else {
        return builder
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .body(Vec::new())
            .unwrap_or_default();
    };
    match service.asset(path) {
        Ok((bytes, content_type)) => builder
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CACHE_CONTROL, IMMUTABLE)
            .body(bytes)
            .unwrap_or_default(),
        Err(error) => {
            let status =
                StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            builder
                .status(status)
                .header(header::CONTENT_TYPE, "application/json")
                .body(serde_json::to_vec(&error).unwrap_or_default())
                .unwrap_or_default()
        }
    }
}
