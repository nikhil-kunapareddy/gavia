# Contributing to Gavia

Thanks for helping. Everyone is welcome, and you don't need to write code to make a difference: bug reports, labelled photos, ideas and design feedback all count.

1. [Ways to help](#ways-to-help)
2. [How the app fits together](#how-the-app-fits-together)
3. [Set up your machine](#set-up-your-machine)
4. [Run the app](#run-the-app)
5. [Test your changes](#test-your-changes)
6. [Measure accuracy](#measure-accuracy)
7. [Make a pull request](#make-a-pull-request)
8. [Code guidelines](#code-guidelines)
9. [Releasing](#releasing)
10. [Troubleshooting](#troubleshooting)

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, see [SECURITY.md](SECURITY.md) rather than opening an issue.

## Ways to help

| Area | Stack | Examples |
| --- | --- | --- |
| Screens | React, TypeScript | Checking, review, history, accessibility |
| Core | Rust | Decoding, the detector, storage, performance |
| Windows and Linux | Rust, packaging | Testing installers, fixing system-specific bugs |
| Models | Python, Ultralytics | Training, evaluating, exporting to ONNX |
| Field knowledge | — | Labelling photos, reporting missed or false detections |

For anything bigger than a small fix, please [open an issue](https://github.com/nikhil-kunapareddy/gavia/issues/new/choose) first so we can agree on the approach before you spend time on it.

## How the app fits together

Gavia is one [Tauri](https://tauri.app) app with two halves: a Rust core, and a React interface running in the system webview. They talk through Tauri's `invoke`, not HTTP. There's no local server, no port and no token, so nothing else on the machine can drive the core.

```
desktop/
  src/                        the interface (React 18, TypeScript, Vite)
    App.tsx                   all app state lives here; pages are presentational
    services/                 the only code that calls the core (api.ts wraps invoke)
    dev/browserPreview.ts     a fake core, so `npm run dev` works in a browser
    index.css                 every style, as named semantic classes
  src-tauri/                  the core (Rust)
    src/
      lib.rs                  run(): starts storage, loads the model, registers commands
      commands.rs             every #[tauri::command] the interface can invoke
      service.rs              what those commands do, free of Tauri types
      protocol.rs             gavia:// — serves saved images to <img> tags
      detection/              pure: decode -> letterbox -> ONNX -> NMS -> percentages
      storage/                SQLite metadata plus images and thumbnails on disk
      platform/{macos,windows,linux}/   everything OS-specific, same names in each
    resources/models/         loon_v1.onnx and its metadata, bundled with the app
    tests/                    real model, real SQLite, real files
    examples/evaluate.rs      the accuracy check
```

A few rules hold the design together:

- **Boxes are percentages (0–100), never pixels,** all the way from `postprocess.rs` through the commands to the CSS. That's what lets the core decode a huge JPEG at reduced scale and still report boxes that line up with the full-size original. `imageWidth` and `imageHeight` are always the user's original dimensions.
- **Detection and saving are separate.** `detect` writes nothing. The reviewer decides, and `save_result` commits the result with the image sent again from the interface. What's stored is exactly what the reviewer looked at.
- **Each `platform/` folder exposes the same functions,** so the rest of the core never checks which system it's on.

## Set up your machine

Everyone needs:

- **Node 22** or newer
- **Rust**, stable (1.88 or newer), from [rustup.rs](https://rustup.rs)
- **Git**, and this repository (about 40 MB; the model is committed, not in LFS)

### macOS

```sh
xcode-select --install
brew install node
```

### Windows

1. Install **Visual Studio Build Tools** with the *Desktop development with C++* workload.
2. Install the rest:

   ```powershell
   winget install Rustlang.Rustup OpenJS.NodeJS.LTS Git.Git
   rustup default stable-msvc
   ```
3. WebView2 comes with Windows 10 and 11. If it's missing, install it from Microsoft.

Clone into a short path such as `C:\src\gavia`. Some build tools on Windows still struggle with very long paths.

### Linux

Tauri needs WebKitGTK and a few other system libraries.

**Debian, Ubuntu, Mint, Pop!_OS**

```sh
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  libssl-dev libxdo-dev build-essential file patchelf pkg-config
```

**Fedora**

```sh
sudo dnf install webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel \
  openssl-devel libxdo-devel file patchelf
sudo dnf group install "c-development"
```

**Arch**

```sh
sudo pacman -S webkit2gtk-4.1 libappindicator-gtk3 librsvg openssl xdotool base-devel file patchelf
```

Then, on any system:

```sh
cd desktop
npm install
```

The first Rust build downloads ONNX Runtime (about 30 MB) and compiles everything, which takes a few minutes. Later builds are much faster.

## Run the app

```sh
cd desktop
npm run app          # the full app, with live reload for the interface
```

To work on the screens without building any Rust, run the interface in a browser. A fake core in `src/dev/browserPreview.ts` answers every command with sample detections:

```sh
npm run dev          # then open http://localhost:5173
```

To build installers for your own system:

```sh
npm run app:build    # the .app and .dmg, -setup.exe, or .deb/.rpm/.AppImage
```

The installers land in `desktop/src-tauri/target/release/bundle/`.

### Settings

The Settings screen covers the theme, storage location and model. These environment variables are for benchmarking and for trying unusual imagery:

| Variable | Default | What it does |
| --- | --- | --- |
| `GAVIA_DATA_DIR` | see below | Where history is kept. Overrides, and locks, the location chosen in Settings |
| `GAVIA_TILING` | `false` | Tiled inference for small birds in large frames. [Measure](#measure-accuracy) before relying on it |
| `GAVIA_CONFIDENCE_THRESHOLD` | from the model (0.25) | Minimum score for a box |
| `GAVIA_IOU_THRESHOLD` | from the model (0.45) | Overlap above which duplicate boxes are merged |
| `GAVIA_INFERENCE_THREADS` | most performance cores | ONNX Runtime threads |

### Where your data lives

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| History | `~/Library/Application Support/Gavia` | `%LOCALAPPDATA%\Gavia` | `~/.local/share/gavia` |
| Logs | `~/Library/Logs/ai.humanitarians.gavia` | `%LOCALAPPDATA%\ai.humanitarians.gavia\logs` | `~/.local/share/ai.humanitarians.gavia/logs` |

These are the same history folders the earlier Python version of Gavia used, so upgrading keeps everyone's saved checks. You can move history elsewhere in **Settings**; the choice is saved in `settings.json` in the app's config folder (`~/Library/Application Support/ai.humanitarians.gavia` on macOS). The theme is kept in the webview's `localStorage`, so it applies before the first paint.

## Test your changes

Run these before opening a pull request. CI runs the same checks on macOS, Windows and Linux.

```sh
cd desktop
npm run typecheck && npm run lint && npm test

cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

What each level catches:

- **Rust unit tests** sit at the bottom of each file in `#[cfg(test)] mod tests`. They cover pure logic: geometry, decoding, storage and validation. Several check against `tests/fixtures/python_reference.json`, which records exactly what the original Python pipeline did, so the port can't drift.
- **Rust integration tests** in `src-tauri/tests/` run the real model, real SQLite and real files. `model.rs` is the only thing that catches a bad model export. `workflow.rs` drives `Service`, the same object the commands call.
- **`tests/parity.rs`** re-runs the Python pipeline's results on the real `loonnet_v1` photos. The dataset isn't in the repository, so the test skips itself unless it finds the split at `~/Documents/loonet/data/annotated/loonnet_v1/val.txt` or you set `GAVIA_VAL_SPLIT`.
- **Interface unit tests** (Vitest, jsdom) cover components and services.
- **`App.workflow.test.tsx`** mocks only Tauri's IPC, so the real service layer runs against core-shaped replies. It's what catches the interface and the core drifting apart. Its fake core must match `service.rs`.

When you add a command or change a result's shape, update `service.rs`, `src/types/detection.ts`, the fake core in `App.workflow.test.tsx`, and `src/dev/browserPreview.ts` together. They all describe the same contract.

### By hand

Before a release, or after touching decoding or the webview, try this on each system you can:

- Check a JPEG, a PNG, an MPO from a phone, and a photo taken with the camera rotated. The boxes should sit on the birds.
- Save a result, restart the app, and confirm it's still in History with its thumbnail.
- Download the annotated image and open it.
- Try a file that isn't an image, and one over 20 MB. Both should show a clear message.

## Measure accuracy

`examples/evaluate.rs` is the authoritative check. It reports precision and recall at the shipped threshold, and AP@0.5 over the whole curve, against ground-truth labels. Run it after any change to decoding, pre- or postprocessing, any new model, and before turning tiling on for a new kind of imagery:

```sh
cd desktop/src-tauri
cargo run --release --example evaluate -- --split ~/Documents/loonet/data/annotated/loonnet_v1/val.txt
cargo run --release --example evaluate -- --split …/val.txt --tiled
```

The split is a YOLO-format text file of image paths, with labels in a sibling `labels/` folder. On `loonnet_v1` val the current model scores P 0.906 / R 0.879 / AP@0.5 0.891. Put the before and after numbers in your pull request.

### Updating the model

To try a model without rebuilding, put `name.onnx` and `name.json` in the `models/` folder inside the storage location. It appears in **Settings → Detection model**. To ship one with the app, it's the same two-file drop-in into `resources/models/`: Thresholds, class names and display labels are all read from the JSON, so no code changes. Export from Ultralytics with static shapes:

```python
from ultralytics import YOLO
YOLO("best.pt").export(format="onnx", imgsz=640, opset=17, simplify=True, dynamic=False, device="cpu")
```

Then update the JSON's `sha256`, `size_bytes`, `provenance` and `metrics`, and run `evaluate` before and after.

## Make a pull request

1. Fork the repository and branch from `dev`: `feat/…`, `fix/…`, `docs/…` or `ci/…`.
2. Keep commits focused. Messages in the imperative, e.g. `fix: keep EXIF rotation on PNG`.
3. Open the pull request against **`dev`**. `main` is protected and only takes merges from `dev`.
4. In the description, say what changed and why, link the issue (`Fixes #123`), list the systems you tested on, and add screenshots for anything visible.
5. CI builds installers for every pull request. Download them from the run's summary page to try the change without building it.

A maintainer reviews every pull request from outside the core team before it merges.

## Code guidelines

**Rust**
- No warnings: CI builds with `-D warnings`, and `cargo fmt` decides formatting.
- Don't `unwrap()` on anything that comes from a user or the disk. Return an `ApiError` with a code from `error.rs`, and add a code if none fits.
- Keep `detection/` pure: no Tauri, no storage, no I/O beyond the bytes it's given.
- OS-specific code goes only in `platform/<os>/`, and a new item goes into all three folders.
- `unsafe` is forbidden crate-wide.

**Adding a command** takes four steps:
1. Write the logic as a method on `Service` in `service.rs`, with a test in `tests/workflow.rs`.
2. Add a thin `#[tauri::command]` in `commands.rs` and register it in `lib.rs`'s `generate_handler!`.
3. Call it through `call()` from a module in `src/services/`.
4. Teach the fake cores in `src/dev/browserPreview.ts` and `App.workflow.test.tsx` to answer it.

**TypeScript**
- Prettier decides formatting: no semicolons, single quotes, 100 columns. `npm run format` applies it.
- Styles are hand-written semantic classes in `src/index.css`. Add a class there and reference it by name; don't use Tailwind utility classes in components.
- Only `src/services/` talks to the core, and it turns every failure into an `ApiError` whose `code` the interface branches on.

**Words in the app** are short and plain. Say what happened and what the person can do about it.

## Releasing

Maintainers only. Releases are built by CI from a tag:

1. Bump the version in `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml` and `desktop/package.json`, add a section to `CHANGELOG.md`, and merge to `main`.
2. From an up-to-date `main`: `cd desktop && npm run release` for a beta, `npm run release -- stable` for the real thing. The script needs the [GitHub CLI](https://cli.github.com), signed in.
3. CI builds the installers on all three systems and attaches them to the release. Releases start as pre-releases; promote a stable one once its files are attached, with the command the script prints.

## Troubleshooting

**`npm run app` says port 5173 is in use.** Another dev server is running. Stop it, or anything else on that port. Tauri waits on exactly that port.

**The first build fails downloading ONNX Runtime.** The `ort` crate fetches it at build time. Check your connection or proxy, then rebuild. Once built, the app itself never touches the network.

**Windows: `link.exe` not found.** The Visual Studio Build Tools C++ workload is missing, or you're not on the MSVC toolchain. Run `rustup default stable-msvc`.

**Linux: `webkit2gtk-4.1` not found.** Install the development packages for your distribution listed above. Ubuntu 20.04 and older only have 4.0, which Tauri 2 doesn't support.

**macOS: the app quits the moment you click upload.** A bundle without a valid signature can't open a file panel. `scripts/make-dmg.sh` checks this before packaging. For a local build, run `codesign --verify --deep --strict` on the `.app`. If it's valid and the crash comes about 60 seconds after the click, the file-panel service on that Mac is stuck. Look for "semaphore timed out" in `log show --predicate 'process == "gavia"'`.

**macOS: "Gavia can't be opened because Apple cannot check it".** Expected for unsigned builds. Right-click the app, choose **Open**, then **Open** again.
