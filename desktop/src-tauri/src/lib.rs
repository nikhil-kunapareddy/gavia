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
pub mod platform;
pub mod protocol;
pub mod service;
pub mod storage;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::Manager;
use tauri::path::BaseDirectory;
use tauri_plugin_log::{Target, TargetKind};

use crate::config::Config;
use crate::detection::Detector;
use crate::service::Service;

/// Where the bundled model lives, relative to the app's resource directory.
pub const MODEL_RESOURCE: &str = "models/loon_v1.onnx";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            let data_dir = platform::data_dir();
            log::info!("data directory: {}", data_dir.display());
            let repository = storage::open(&data_dir)?;
            let config = Config::from_env();
            let service = Arc::new(Service::new(repository, config));
            app.manage(service.clone());

            let model_path = app
                .path()
                .resolve(MODEL_RESOURCE, BaseDirectory::Resource)?;
            // Loading and warming up takes a second or two; the window is up
            // meanwhile, and a check requested early waits for it.
            std::thread::spawn(move || load_model(&service, model_path));
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Gavia");
}

fn load_model(service: &Service, model_path: PathBuf) {
    let config = service.config();
    service.set_model(Detector::load(
        &model_path,
        config.inference_threads,
        config.tiles,
    ));
}
