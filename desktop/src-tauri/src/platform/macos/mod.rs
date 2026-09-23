//! macOS.

use std::path::PathBuf;

pub const ASSET_ORIGIN: &str = "gavia://localhost";

pub fn default_data_dir() -> PathBuf {
    super::home().join("Library").join("Gavia")
}

/// The Python backend's location, and Gavia's default until the path lost its
/// space.
pub fn legacy_data_dir() -> Option<PathBuf> {
    Some(
        super::home()
            .join("Library")
            .join("Application Support")
            .join("Gavia"),
    )
}
