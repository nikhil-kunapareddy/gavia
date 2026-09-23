//! Gavia's core: detection, storage, and the commands the UI calls.
//!
//! One process. The React UI is served from the bundle and talks to this code
//! through `invoke` (see `commands.rs`); stored images reach `<img>` tags
//! through the `gavia://` scheme (see `protocol.rs`). There is no local server,
//! no port and no token, so there is nothing for another process on the
//! machine to connect to.

pub mod commands;
pub mod config;
pub mod detection;
pub mod error;
pub mod models;
pub mod platform;
pub mod protocol;
pub mod service;
pub mod settings;
pub mod storage;

use std::sync::Arc;

use tauri::Manager;
use tauri::path::BaseDirectory;
use tauri_plugin_log::{Target, TargetKind};

use crate::config::Config;
use crate::service::{Library, Service};

/// Where the bundled models live, relative to the app's resource directory.
pub const MODELS_RESOURCE: &str = "models";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Native confirmations; the webview's window.confirm is a silent no on macOS.
        .plugin(tauri_plugin_dialog::init())
        // Opens the storage and models folders in Finder, Explorer or Files.
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    Target::new(TargetKind::Stdout),
                    // A packaged app has no terminal, and a launch that fails
                    // leaves nothing else behind to explain itself.
                    Target::new(TargetKind::LogDir { file_name: None }),
                ])
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, |ctx, request, responder| {
            let service = ctx
                .app_handle()
                .try_state::<Arc<Service>>()
                .map(|s| s.inner().clone());
            let path = request.uri().path().to_string();
            // Disk reads stay off the webview's thread.
            std::thread::spawn(move || responder.respond(protocol::respond(service, &path)));
        })
        .setup(|app| {
            let library = Library {
                settings_file: app.path().app_config_dir()?.join("settings.json"),
                bundled_models: app
                    .path()
                    .resolve(MODELS_RESOURCE, BaseDirectory::Resource)?,
                default_data_dir: storage::adopt_legacy_library(
                    &platform::default_data_dir(),
                    platform::legacy_data_dir().as_deref(),
                ),
                env_data_dir: platform::env_data_dir(),
            };
            let service = Arc::new(Service::open(library, Config::from_env())?);
            app.manage(service.clone());
            // Loading and warming up takes a second or two; the window is up
            // meanwhile, and a check requested early waits for it.
            std::thread::spawn(move || service.load_selected_model());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::health,
            commands::model_info,
            commands::detect,
            commands::save_result,
            commands::list_results,
            commands::get_result,
            commands::delete_result,
            commands::clear_results,
            commands::get_settings,
            commands::set_data_dir,
            commands::select_model,
            commands::open_folder,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Gavia");
}
