//! Starting, watching and stopping the Python backend.
//!
//! The sidecar is `backend/` frozen by PyInstaller, and it serves both halves
//! of the app: the JSON API under `/api` and the built frontend under `/`.
//! That is deliberate. One origin means the webview's `fetch` calls stay
//! relative, with no base URL to configure and no CORS exception to grant —
//! see the note at the top of `frontend/src/services/api.ts`.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

/// Printed by the sidecar as soon as it has bound a port, which is before the
/// model loads. See `backend/app/__main__.py`.
const PORT_BANNER: &str = "GAVIA_PORT=";

/// Generous on purpose: a cold start pages ~160MB of bundle off disk and then
/// builds an ONNX session. A slow laptop under load still fits comfortably.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

/// The running backend, and how to reach it.
pub struct Backend {
    /// The sidecar, holding its own stdin pipe open for as long as it lives.
    ///
    /// That pipe is the lifetime link: see the note in `start`. Nothing here
    /// may `take()` the handle out of the child.
    child: Mutex<Option<Child>>,
    /// The origin the webview loads, e.g. `http://127.0.0.1:53194`.
    pub origin: String,
    /// A secret minted for this launch alone.
    ///
    /// Binding to loopback keeps the backend off the network but not away from
    /// other processes on this machine. The token is what makes it ours: the
    /// shell passes it to the sidecar and injects it into the webview, and
    /// nothing else ever learns it.
    pub token: String,
}

impl Backend {
    /// Stop the backend. Safe to call more than once.
    pub fn shutdown(&self) {
        let Ok(mut guard) = self.child.lock() else {
            return;
        };
        if let Some(mut child) = guard.take() {
            log::info!("stopping the backend");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Launch the sidecar and wait until it answers.
pub fn start(app: &AppHandle) -> Result<Backend, String> {
    let binary = resource(app, "gavia-backend/gavia-backend")?;
    let web = resource(app, "web")?;
    let token = Uuid::new_v4().to_string();

    log::info!("starting the backend: {}", binary.display());

    // Run from inside the bundle. `Settings` resolves its `.env` relative to
    // the working directory, and a packaged app inherits whatever directory it
    // happened to be launched from — a stray `.env` there would otherwise
    // reconfigure the backend behind the user's back.
    let cwd = binary
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| web.clone());

    let mut child = Command::new(&binary)
        .arg("--port")
        .arg("0")
        .arg("--static-dir")
        .arg(&web)
        // Stop when this process does, however it goes. `Backend::shutdown`
        // handles an orderly quit, but it runs from `RunEvent::Exit`, and a
        // shell that is killed or aborts on a panic never gets there — a
        // crash on the file-open panel already left backends running with the
        // user's database open and no window left to close them.
        .arg("--exit-with-parent")
        .env("AUTH_TOKEN", &token)
        .current_dir(cwd)
        // The other half of that: the sidecar waits for EOF here, and holding
        // the write end open is the whole message. The kernel closes it when
        // this process dies, so no shutdown path of ours has to be reached.
        // `Stdio::null()` would read as EOF immediately and stop the backend
        // before it served anything.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // uvicorn logs here. Inherited rather than piped: a pipe nobody drains
        // fills up and then the backend blocks on its own logging.
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|err| format!("could not start {}: {err}", binary.display()))?;

    let port = match read_port(&mut child) {
        Ok(port) => port,
        Err(err) => {
            let _ = child.kill();
            return Err(err);
        }
    };

    let origin = format!("http://127.0.0.1:{port}");
    if let Err(err) = await_ready(&mut child, &origin) {
        let _ = child.kill();
        return Err(err);
    }

    log::info!("backend ready on {origin}");
    Ok(Backend {
        child: Mutex::new(Some(child)),
        origin,
        token,
    })
}

/// Locate something `tauri.conf.json` lists under `bundle.resources`.
fn resource(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    let path = app
        .path()
        .resolve(relative, BaseDirectory::Resource)
        .map_err(|err| format!("could not locate the bundled {relative}: {err}"))?;

    if !path.exists() {
        return Err(format!(
            "the bundled {relative} is missing from {}. \
             Run `npm run build:sidecar` before building the app.",
            path.display()
        ));
    }
    Ok(path)
}

/// Read the port off the sidecar's stdout, then keep draining it.
///
/// The read runs on its own thread for two reasons: a blocking `read_line` has
/// no timeout of its own, and stdout has to go on being consumed afterwards or
/// the backend eventually blocks writing to a full pipe.
fn read_port(child: &mut Child) -> Result<u16, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "the backend's output was not captured".to_string())?;

    let (tx, rx) = mpsc::sync_channel::<u16>(1);

    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut tx = Some(tx);

        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }

            let text = line.trim_end();
            // The backend logs to stdout as well, so anything that is not the
            // banner is just a log line passing through.
            if let Some(rest) = text.strip_prefix(PORT_BANNER) {
                match rest.trim().parse::<u16>() {
                    Ok(port) => {
                        if let Some(sender) = tx.take() {
                            let _ = sender.send(port);
                        }
                    }
                    Err(err) => log::warn!("backend reported an unreadable port: {text} ({err})"),
                }
                continue;
            }
            log::info!("backend: {text}");
        }
        log::info!("the backend's output stream closed");
    });

    rx.recv_timeout(STARTUP_TIMEOUT)
        .map_err(|_| "the backend never reported a port".to_string())
}

/// Block until `/api/health` answers.
///
/// The sidecar hands uvicorn a socket that is already listening, so this
/// connects immediately and then waits on the response — which arrives once
/// startup finishes. The polling is really only there for the case where the
/// process dies underneath us.
fn await_ready(child: &mut Child, origin: &str) -> Result<(), String> {
    let url = format!("{origin}/api/health");
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let mut last = String::from("no response");

    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("the backend exited during startup ({status})"));
        }

        match ureq::get(&url).call() {
            Ok(_) => return Ok(()),
            Err(err) => last = err.to_string(),
        }
        thread::sleep(Duration::from_millis(150));
    }

    Err(format!("the backend never became ready: {last}"))
}
