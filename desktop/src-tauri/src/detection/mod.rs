//! Detection in photos (loons, or invasive plants with vegnet), from encoded
//! bytes to percentage boxes.
//!
//! Pure: nothing here knows about Tauri, storage or the UI. `loader` decodes,
//! `preprocess` letterboxes and plans tiles, `detector` owns the ONNX session,
//! and `postprocess` maps the model's output back onto the original image:
//! YOLO11's `(1, 5, 8400)` anchors (centre/size, then NMS) or YOLO26's
//! end-to-end `(1, 300, 6)` boxes (corners, no NMS), in letterboxed pixels.

pub mod detector;
pub mod loader;
pub mod model;
pub mod postprocess;
pub mod preprocess;

pub use detector::{DetectError, DetectOptions, Detector, Outcome, Prediction};
pub use model::{ModelInfo, Subject};
