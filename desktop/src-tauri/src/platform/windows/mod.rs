//! Windows.

use std::path::PathBuf;

pub const ASSET_ORIGIN: &str = "http://gavia.localhost";

pub fn default_data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .filter(|base| !base.is_empty())
        .map(|base| PathBuf::from(base).join("Gavia"))
        .unwrap_or_else(|| super::home().join("Gavia"))
}

pub fn legacy_data_dir() -> Option<PathBuf> {
    None
}

/// The updater runs the new NSIS installer, which installs per user.
pub fn can_self_update() -> bool {
    true
}
