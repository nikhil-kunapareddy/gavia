//! Linux. XDG, which specifies `~/.local/share` when `XDG_DATA_HOME` is unset.

use std::path::PathBuf;

pub const ASSET_ORIGIN: &str = "gavia://localhost";

pub fn default_data_dir() -> PathBuf {
    match std::env::var_os("XDG_DATA_HOME") {
        Some(base) if !base.is_empty() => PathBuf::from(base).join("gavia"),
        _ => super::home().join(".local").join("share").join("gavia"),
    }
}

pub fn legacy_data_dir() -> Option<PathBuf> {
    None
}

/// Only an AppImage, which sets `APPIMAGE` to its own path when it runs.
/// A `.deb` or `.rpm` is the package manager's to update.
pub fn can_self_update() -> bool {
    std::env::var_os("APPIMAGE").is_some()
}
