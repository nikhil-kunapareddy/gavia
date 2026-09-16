//! The desktop shell.
//!
//! Gavia's window is not built from `tauri.conf.json`, because the URL it
//! loads is not known until runtime: the backend picks a free port and reports
//! it, and only then can the window be pointed at it. Everything here exists to
//! get from "process started" to "window pointed at a backend that answers".

mod sidecar;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_log::{Target, TargetKind};

/// Where the webview points under `npm run tauri:dev`.
///
/// Vite serves the frontend and proxies `/api` to the uvicorn you started
/// yourself, exactly as in a browser. Mirrors `build.devUrl` in
/// `tauri.conf.json`, which is the copy the Tauri CLI waits on.
const DEV_URL: &str = "http://localhost:5173";

/// Set to any value to exercise the packaged path from a debug build.
///
/// Without it a debug build talks to Vite, so UI work does not require
/// re-freezing the backend; with it you get the real sidecar, which is the
/// only way to test that half short of a full release build.
const FORCE_SIDECAR: &str = "GAVIA_SIDECAR";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    Target::new(TargetKind::Stdout),
                    // A packaged app has no terminal to print to, and a launch
                    // that fails before the window appears leaves nothing else
                    // behind to explain itself.
                    Target::new(TargetKind::LogDir { file_name: None }),
                ])
                .build(),
        )
        .setup(|app| {
            let (url, init_script) = if uses_sidecar() {
                let backend = sidecar::start(app.handle())?;
                let url = backend.origin.clone();
                let script = token_script(&backend.token);
                // Held so the exit handler can stop it.
                app.manage(backend);
                (url, Some(script))
            } else {
                log::info!("development build: expecting Vite on {DEV_URL}");
                (DEV_URL.to_string(), None)
            };

            let mut window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(tauri::Url::parse(&url)?),
            )
            .title("Gavia")
            .inner_size(1280.0, 880.0)
            .min_inner_size(960.0, 640.0)
            .resizable(true);

            if let Some(script) = init_script {
                window = window.initialization_script(script);
            }

            window.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Gavia app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Nothing else reaps the sidecar: it is a plain child process, and
            // on macOS a quit that skipped this would leave it running with the
            // user's database open.
            if let Some(backend) = handle.try_state::<sidecar::Backend>() {
                backend.shutdown();
            }
        }
    });
}

/// Release builds always bundle their own backend; debug builds opt in.
fn uses_sidecar() -> bool {
    !cfg!(debug_assertions) || std::env::var_os(FORCE_SIDECAR).is_some()
}

/// The script that hands the webview its token before any page script runs.
///
/// Injected here rather than served in the HTML so the token never travels
/// over the wire — anything that could read it from a response could already
/// have made the request itself.
fn token_script(token: &str) -> String {
    // serde_json does the escaping, so no token value can break out of the
    // string literal.
    let literal = serde_json::to_string(token).unwrap_or_else(|_| "null".to_string());
    format!("window.__GAVIA_TOKEN__ = {literal};")
}

#[cfg(test)]
mod tests {
    use super::token_script;

    #[test]
    fn assigns_the_token_to_the_global_the_frontend_reads() {
        // The name is the contract with `authToken()` in services/api.ts.
        assert_eq!(
            token_script("9f8c2a1e"),
            r#"window.__GAVIA_TOKEN__ = "9f8c2a1e";"#
        );
    }

    #[test]
    fn a_token_cannot_break_out_of_its_string_literal() {
        // Tokens are uuids today, so nothing here can actually occur. The
        // escaping is still the only thing between this function and script
        // injection if the token ever comes from somewhere else.
        let script = token_script(r#"x"; window.pwned = 1; //"#);

        assert!(script.ends_with(r#";"#));
        // The quote comes back escaped, so this stays one assignment.
        assert!(script.contains(r#"x\"; window.pwned = 1; //"#));
    }

    #[test]
    fn escapes_control_characters() {
        assert_eq!(token_script("a\nb"), r#"window.__GAVIA_TOKEN__ = "a\nb";"#);
    }
}
