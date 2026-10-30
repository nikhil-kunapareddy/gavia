//! Loon calls, from an encoded recording to a probability per 3 s window.
//!
//! Pure, like `detection/`: nothing here knows about Tauri, storage or the UI.
//! `decode` streams any supported recording as mono samples, `windows` cuts
//! them into the model's 3 s windows at 48 kHz (`resample` does the rate
//! change), and `listener` owns the ONNX session that scores them.
//!
//! The model is looncall (from the loonet repo): BirdNET 2.4 up to its
//! embedding, then a logistic regression, exported as one ONNX graph by
//! `scripts/export_looncall.py`. Each step here mirrors what the `birdnet`
//! Python package does before its model sees a window, because that is what
//! looncall was trained and measured on; `tests/call_parity.rs` holds the port
//! to it.

pub mod decode;
pub mod listener;
pub mod model;
pub mod resample;
pub mod windows;

pub use decode::AudioError;
pub use listener::{CallDetector, Heard, ListenError, WindowScore};
pub use model::CallModelInfo;
