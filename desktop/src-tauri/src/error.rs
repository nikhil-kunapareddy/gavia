//! The one error shape every command rejects with.
//!
//! The UI branches on `code`, never on `message`, so codes are a contract with
//! `ACTIONABLE_CODES` in `src/App.tsx`. `status` keeps the HTTP-era number each
//! code used to travel with; the UI still receives it on `ApiError.status`, and
//! it keeps the codes grouped the way readers of the old API expect.

use serde::Serialize;

use crate::detection::loader::LoadError;

#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code}: {message}")]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
    pub status: u16,
    /// Short and random, so a line in the log can be matched to what the user saw.
    pub request_id: String,
}

impl ApiError {
    pub fn new(code: &'static str, message: impl Into<String>, status: u16) -> Self {
        let request_id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        Self {
            code,
            message: message.into(),
            status,
            request_id,
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("NOT_FOUND", message, 404)
    }

    pub fn unsupported_format(message: impl Into<String>) -> Self {
        Self::new("UNSUPPORTED_FORMAT", message, 415)
    }

    pub fn image_too_large(message: impl Into<String>) -> Self {
        Self::new("IMAGE_TOO_LARGE", message, 413)
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new("INVALID_REQUEST", message, 422)
    }

    pub fn already_saved() -> Self {
        Self::new(
            "ALREADY_SAVED",
            "That result is already in the history.",
            409,
        )
    }

    pub fn model_unavailable() -> Self {
        // Fixed wording: the underlying cause is a path or an ORT error, which
        // means nothing to a reviewer and is in the log for whoever needs it.
        Self::new(
            "MODEL_UNAVAILABLE",
            "The detection model is not available. Please restart Gavia.",
            503,
        )
    }

    pub fn internal(cause: impl std::fmt::Display) -> Self {
        let error = Self::new("INTERNAL_ERROR", "Something went wrong inside Gavia.", 500);
        log::error!("internal error {}: {cause}", error.request_id);
        error
    }
}

impl From<LoadError> for ApiError {
    fn from(error: LoadError) -> Self {
        match error {
            LoadError::Decode(message) => Self::new("DECODE_FAILED", message, 422),
            LoadError::TooLarge(message) => Self::image_too_large(message),
            LoadError::Unsupported(message) => Self::unsupported_format(message),
        }
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        Self::internal(error)
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        Self::internal(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_the_shape_the_ui_reads() {
        let value = serde_json::to_value(ApiError::not_found("gone")).unwrap();
        assert_eq!(value["code"], "NOT_FOUND");
        assert_eq!(value["message"], "gone");
        assert_eq!(value["status"], 404);
        assert_eq!(value["requestId"].as_str().unwrap().len(), 12);
    }

    #[test]
    fn loader_errors_map_to_their_codes() {
        let cases = [
            (LoadError::Decode("x".into()), "DECODE_FAILED", 422),
            (LoadError::TooLarge("x".into()), "IMAGE_TOO_LARGE", 413),
            (
                LoadError::Unsupported("x".into()),
                "UNSUPPORTED_FORMAT",
                415,
            ),
        ];
        for (error, code, status) in cases {
            let api = ApiError::from(error);
            assert_eq!((api.code, api.status), (code, status));
        }
    }

    #[test]
    fn request_ids_differ() {
        assert_ne!(
            ApiError::internal("a").request_id,
            ApiError::internal("a").request_id
        );
    }
}
