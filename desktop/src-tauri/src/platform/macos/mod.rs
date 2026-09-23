//! macOS.

use std::path::PathBuf;

pub const ASSET_ORIGIN: &str = "gavia://localhost";

pub fn default_data_dir() -> PathBuf {
    super::home()
        .join("Library")
        .join("Application Support")
        .join("Gavia")
}
