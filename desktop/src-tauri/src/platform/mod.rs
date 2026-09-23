//! Operating-system specific code. Each OS has its own folder and exposes the
//! same items, so the rest of the app never needs a `cfg` check:
//!
//! - `default_data_dir()`: where history lives. These are the exact paths the
//!   Python backend used, so an existing history opens unchanged.
//! - `ASSET_ORIGIN`: how the webview spells a `gavia://` URL. Windows' WebView2
//!   cannot load custom schemes directly and Tauri maps them onto
//!   `http://<scheme>.localhost` there.
//!
//! Adding an item means adding it to all three folders.

use std::path::PathBuf;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

/// Overrides the data directory. Used by tests and by anyone who wants their
/// history on another disk.
pub const DATA_DIR_ENV: &str = "GAVIA_DATA_DIR";

/// The data directory, honouring [`DATA_DIR_ENV`].
pub fn data_dir() -> PathBuf {
    match std::env::var_os(DATA_DIR_ENV) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => default_data_dir(),
    }
}

fn home() -> PathBuf {
    #[allow(deprecated)] // std::env::home_dir is correct again since Rust 1.85.
    std::env::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_data_dir_is_named_for_the_app() {
        let dir = default_data_dir();
        let name = dir.file_name().unwrap().to_string_lossy().to_lowercase();
        assert_eq!(name, "gavia");
    }

    #[test]
    fn asset_origin_has_no_trailing_slash() {
        assert!(!ASSET_ORIGIN.ends_with('/'));
        assert!(ASSET_ORIGIN.contains("gavia"));
    }
}
