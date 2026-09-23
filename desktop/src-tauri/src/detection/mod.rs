//! Loon detection, from encoded bytes to percentage boxes.
//!
//! Pure: nothing here knows about Tauri, storage or the UI. `loader` decodes,
//! `preprocess` letterboxes and plans tiles, `detector` owns the ONNX session,
//! and `postprocess` maps the model's `(1, 5, 8400)` output — centre/size in
//! letterboxed pixels — back onto the original image.

pub mod detector;
pub mod loader;
pub mod model;
pub mod postprocess;
pub mod preprocess;

pub use detector::{DetectError, DetectOptions, Detector, Outcome, Prediction};
pub use model::ModelInfo;
