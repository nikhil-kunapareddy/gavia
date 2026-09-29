# Changelog

All notable changes to Gavia are recorded here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.1] - 2026-09-29

### Added
- Check up to 25 images at once. Pick or drop several photos, a zip of them, or both. Gavia checks them one at a time with a progress bar and a Stop button. Open any image to see its boxes, and save all the ones with loons in one go.
- Files that can't be checked, such as a `notes.txt` inside a zip, are left out, and a note names them.

## [0.3.0] - 2026-09-29

### Added
- Updates. When Gavia starts, it checks GitHub for a newer release, downloads it in the background, and offers to restart into it. It never restarts on its own. **Settings → Updates** turns the check off; it is the only thing Gavia sends over the internet.

### Changed
- On Linux, only the AppImage updates itself. A `.deb` or `.rpm` install is updated through the package manager, or by installing the new file by hand.

Copies of 0.2.0 have no updater, so moving to 0.3.0 is a one-time manual install. From 0.3.0 on, updates arrive on their own.

## [0.2.0] - 2026-09-23

### Added
- Windows and Linux support. CI builds a `.dmg` (Apple Silicon), a Windows `-setup.exe`, and Linux `.deb`, `.rpm` and `.AppImage` files for every change.
- A "Loons detected" count in the result details.
- Contributing guide, code of conduct, security policy, roadmap, and issue and pull request templates.
- A Settings page: light, dark or system theme, a movable storage location, and a choice of detection model once more than one is installed.
- A Help page behind the **?** button in the header.
- A loon app icon, replacing Tauri's placeholder, and artwork for the macOS disk image window and the Windows installer.

### Changed
- The detection backend was rewritten in Rust and now runs inside the app. There's no Python sidecar, local server, port or auth token any more. The macOS download shrank from 84 MB to 43 MB.
- The interface talks to the core through Tauri `invoke`, and saved images are served over a `gavia://` URL scheme.
- Accuracy matches the Python pipeline. On `loonnet_v1` val, Python scored P 0.9062 / R 0.8788 / AP@0.5 0.8921 and Rust scores P 0.9062 / R 0.8788 / AP@0.5 0.8910. All 32 detections are reproduced, and confidences differ by at most 0.015.
- Settings are now `GAVIA_*` environment variables (`GAVIA_DATA_DIR`, `GAVIA_TILING`, …).
- On macOS, history is kept in `~/Library/Gavia`, a path without spaces, instead of `~/Library/Application Support/Gavia`.
- The detection model is called Loonet 1.0.
- The check, history and settings screens are simpler, with fewer labels and notes.

### Removed
- The Take a photo button.
- The FastAPI backend, the PyInstaller build and the Playwright end-to-end suite. Their coverage moved to Rust integration tests that run the real model, SQLite and files.

Saved history from earlier versions opens unchanged: the database schema and file layout are the same, and on macOS a history in the old folder is moved to `~/Library/Gavia` the first time the new version starts.

## [0.1.0] - 2026-09-15

### Added
- First macOS desktop build: a React interface in Tauri with a frozen Python backend running YOLO11s through ONNX Runtime.
