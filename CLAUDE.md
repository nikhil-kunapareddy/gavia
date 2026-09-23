# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Gavia finds loons in field photographs: open an image, get bounding boxes with
confidence scores, keep the ones worth keeping. One Tauri 2 app for macOS
(Apple Silicon), Windows and Linux: a React 18 + TypeScript interface (Vite,
Tailwind) over a Rust core that runs YOLO11s through ONNX Runtime (`ort`).
Fully offline. There was a Python/FastAPI backend until the Rust port; it is
gone, and `src-tauri/tests/fixtures/python_reference.json` is what remains of it.

## Commands

Everything runs from `desktop/`.

```bash
npm run app            # the full app with live reload (Vite on :5173 + Rust core)
npm run dev            # interface only, in a browser, against src/dev/browserPreview.ts
npm run app:build      # release build + installers; on macOS also runs make-dmg.sh
npm test               # vitest run
npm run typecheck      # tsc -b --noEmit
npm run lint           # eslint . (type-checked rules)
npm run format:check   # prettier; CI runs this
npm test -- src/services/historyService.test.ts     # one file
npm test -- -t 'saving'                             # one case
npm run test:coverage                               # ~99% of statements
npm run release        # maintainers: tag + GitHub pre-release; CI attaches installers
```

Core (from `desktop/src-tauri/`):

```bash
cargo test                          # unit + integration; real model, ~60s in debug
cargo test --lib                    # unit only, ~3s
cargo test --test workflow          # Service end to end: detect, save, list, assets
cargo test --test parity            # vs Python reference; needs the loonnet dataset
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo run --release --example evaluate -- --split ~/Documents/loonet/data/annotated/loonnet_v1/val.txt
```

`tauri::generate_context!` embeds `../dist`, so `cargo` commands need a built
frontend (`npx vite build`) on a fresh checkout. `npm run app` builds it for you.

## Architecture

**The UI talks to the core over `invoke`, not HTTP.** No server, port or token.
`src/services/api.ts` is the only module that calls `invoke`, through `call()`,
which turns every rejection into a typed `ApiError` whose `code` the UI branches
on (`ACTIONABLE_CODES` in `App.tsx`). Outside the app (`'__TAURI_INTERNALS__'`
absent) `call()` routes to `src/dev/browserPreview.ts`, a fake core.

**Uploads are one binary body, framed.** `detect` and `save_result` take a raw
`invoke` body: little-endian u32 length, that much JSON metadata, then the file.
`frame()`/`unframe()` in `api.ts` and `unframe` in `service.rs` must agree.
This keeps a 20 MB photo out of any JSON encoder.

**Saved images reach `<img>` through the `gavia://` scheme** (`protocol.rs`),
spelled `gavia://localhost/...` on macOS/Linux and `http://gavia.localhost/...`
on Windows (`platform::ASSET_ORIGIN`). Responses carry
`Access-Control-Allow-Origin: *` — without it the annotated-download canvas
in `DetectionResult.tsx` is tainted and `toDataURL` throws. The CSP in
`tauri.conf.json` must list both spellings in `img-src`.

**`service.rs` is the contract, `commands.rs` is a thin adapter.** `Service`
holds no Tauri types, which is what lets `tests/workflow.rs` drive the real
model, SQLite and files without a webview. The model loads on a background
thread at startup; a `detect` that arrives first blocks on a condvar until it is
ready. A model that fails to load leaves the app `degraded`, not dead: history
still works and `detect` returns `MODEL_UNAVAILABLE`.

**`detection/` is pure** and owns what Ultralytics would otherwise do:
`loader` (sniff, EXIF, bomb guard, decode), `preprocess` (letterbox, tile plan),
`detector` (the ORT session), `postprocess` (decode, NMS, clamp, percentages).
The model's `(1, 5, 8400)` output is centre/size in letterboxed pixels; every
step back to the original image happens in `postprocess::decode`.

**Parity with the Python pipeline is deliberate and tested.** The model's
accuracy was measured on the pixels Pillow produced, so the port matches them:
Pillow-compatible bilinear resampling (`fast_image_resize` convolution),
round-half-to-even (`round_ties_even`, Python's `round`), `f32` arithmetic in
`decode` (NumPy's), and Pillow's `draft()` factor rule for reduced JPEG decodes.
`evaluate` is authoritative for accuracy; `tests/parity.rs` pins per-box
agreement (worst confidence delta 0.015, box 0.15 points at the port). Do not
loosen those tolerances to make a change pass — find out why it moved.

**Reduced-scale JPEG decoding is a full decode plus a box average**, not
jpeg-decoder's scaled IDCT. The scaled IDCT upsamples chroma differently and
was measured at mean error 1.2 levels (max 34) against Pillow's draft; the box
average is 0.33 (max 10). The price is briefly holding the full-size image.

**Boxes are percentages (0–100), never pixels**, from `postprocess` through the
commands to the CSS in `DetectionOverlay`. `imageWidth`/`imageHeight` are always
the user's original post-EXIF dimensions, not the reduced decode's.

**Detection and persistence are separate on purpose.** `detect` returns a result
with `imageUrl: ""` and writes nothing; `save_result` commits it with the image
re-sent from the UI. No staging area means nothing to expire after a crash, and
what is stored is exactly what the reviewer looked at.

**Tiling is off by default and should stay off unless measured.** 64% of
labelled loons are larger than a 640px tile, so tiles see fragments and
precision collapses (AP@0.5 0.892 single-pass vs 0.231 tiled). The code is kept
for genuine small-object drone imagery; `GAVIA_TILING=true` turns it on.

**Storage** is `rusqlite` (no ORM) plus files: originals byte-for-byte in
`images/`, lossy WebP thumbnails (q72, `webp` crate) in `thumbs/`, metadata in
`gavia.db`, one connection behind a mutex. Schema, directory names and the
`created_at` format (`%Y-%m-%dT%H:%M:%S+00:00`) are exactly the Python
backend's. `platform::default_data_dir()` returns `~/Library/Gavia` on macOS
(no spaces) and the Python paths elsewhere (`%LOCALAPPDATA%\Gavia`,
`~/.local/share/gavia` — lowercase on Linux), not Tauri's identifier-based
`app_data_dir`. The old macOS default, `~/Library/Application Support/Gavia`,
is `platform::legacy_data_dir()`; `storage::adopt_legacy_library` renames a
history found there into the new default at startup, and keeps using the old
folder if the rename fails. Changing a default without such a move orphans
existing users' history.
`user_version` versions the schema; migrations are forward-only.

**Settings** (`settings.rs`, `models.rs`, the settings half of `service.rs`)
covers the storage location and the model. `settings.json` lives in Tauri's
`app_config_dir`; `GAVIA_DATA_DIR` overrides and locks the location. Moving
storage holds the repository's write lock, checkpoints the WAL, *copies* the
library (`storage::copy_library`), opens the copy, swaps it in, and only then
deletes the original. A destination with a `gavia.db` is reopened instead of
moved into, and a non-empty folder gets a `Gavia/` subfolder. Models are every
`.onnx` + `.json` pair in the bundled `resources/models` plus
`<storage>/models`; switching sets the slot to `starting` and reloads on a
thread. The theme is not a core setting: `src/lib/theme.ts` keeps it in
`localStorage` and sets `data-theme` on `<html>` in `main.tsx` before the first
render; every colour in `index.css` is a variable on `:root` /
`:root[data-theme='dark']` except the detection boxes, which stay red on photos.
`window.confirm` is a silent `false` in WKWebView, so confirmations go through
`services/dialog.ts` (tauri-plugin-dialog).

**OS-specific code lives only in `platform/{macos,windows,linux}/`**, each
exposing the same items, re-exported by `platform/mod.rs` under `cfg`. A new
item goes into all three.

**Frontend state all lives in `App.tsx`**; pages and components are
presentational. No router — `page` is a `Page` state value.

## Conventions

- **Styling is hand-written semantic CSS in `src/index.css`**. Tailwind is
  installed and configured but components use no utility classes and the CSS
  uses no `@apply`. Add a class to `index.css` and reference it by name.
- Wire types are camelCase (`#[serde(rename_all = "camelCase")]`) to match
  `src/types/detection.ts` exactly.
- Every command rejects with `ApiError { code, message, status, requestId }`
  from `error.rs`. Add a constructor there rather than inventing a shape.
- Rust: `unsafe` is forbidden crate-wide; clippy runs with `-D warnings` in CI;
  no `unwrap()` on user or disk data. Edition 2024, so collapsible `if let`s are
  written as let-chains.
- Prettier: no semicolons, single quotes, 100 columns. ESLint runs
  `recommendedTypeChecked`, so new source files must fall under
  `tsconfig.app.json`'s `include: ["src"]`. Plain-object throws in tests go
  through a `rejectWith(value: unknown): never` helper (`only-throw-error`), and
  test helpers must not start with `use` (`rules-of-hooks`).
- `src/test/setup.ts` shims `localStorage` and `URL.createObjectURL`; don't
  re-mock those globally in individual tests.
- `@tauri-apps/api/mocks`' `clearMocks()` leaves an empty `__TAURI_INTERNALS__`
  behind, which makes `inApp()` true; tests that mock IPC delete it in `afterEach`.

## Testing

- **Rust unit** (`#[cfg(test)]` at the bottom of each file) — pure logic;
  several compare against `tests/fixtures/python_reference.json` and the tiny
  images in `tests/fixtures/images/` (EXIF orientations 1–8, MPO, PNG, WebP).
- **Rust integration** (`tests/`) — `model.rs` is the only thing that catches a
  bad model export; `workflow.rs` is the contract `src/services/` relies on;
  `parity.rs` skips unless the loonnet val split is at the default path or
  `GAVIA_VAL_SPLIT`, so it never runs in CI.
- **Frontend unit** — components and services in jsdom.
- **`App.workflow.test.tsx`** — mocks only IPC (`mockIPC`), so the real service
  layer runs against core-shaped replies. Its fake core must match `service.rs`.

When adding a command or changing a result's shape, update `service.rs` (+
`tests/workflow.rs`), `commands.rs` and `generate_handler!` in `lib.rs`,
`src/types/detection.ts`, the fake core in `App.workflow.test.tsx`, and
`src/dev/browserPreview.ts` together.

## CI and releases

`.github/workflows/desktop.yml`: `frontend` (typecheck, lint, format, coverage,
build), `rust (macOS|Windows|Linux)` (fmt on Linux, clippy, test), `audit`
(`npm audit`, `cargo audit`), then `installers (…)` on all three, uploaded as
artifacts on every run. A `v*` tag skips the checks and attaches installers to
the release `npm run release` created — releases are created with a person's
`gh` login because a workflow token can't create a release that triggers other
workflows. Linux system packages live in
`.github/actions/setup-desktop-build/action.yml`. `main` is protected by a
repository ruleset (PR + one approval + the check jobs; admin and write roles
may bypass the approval in pull-request mode).

## Gotchas

- **MPO is a supported format.** It is a JPEG with extra frames (7% of the
  training set); `sniff` reports it as JPEG and decoding yields frame 0.
- `loader::read_dimensions` reads EXIF orientation from the header rather than
  decoding, because the tile-vs-draft decision has to be made first.
- The detector serialises inference behind one mutex that also guards the
  reused input buffer. Hold it for a whole image, not per tile.
- `Repository::save` inserts the row *before* writing any file. Writing files
  first means a save under an existing id overwrites the stored photo and then
  the failed insert's rollback deletes the original's files.
- **ONNX Runtime has no Intel Mac build**, so macOS ships for
  `aarch64-apple-darwin` only. `ort` downloads and statically links ORT at build
  time (`download-binaries`); the app itself makes no network connections.
- **The bundle must be ad-hoc signed or file dialogs abort the app.**
  `bundle.macOS.signingIdentity: "-"` (in `tauri.macos.conf.json`) is
  load-bearing: without it `+[NSOpenPanel openPanel]` returns nil, wry does not
  guard it, and the process aborts with SIGABRT when the user clicks upload.
  `scripts/make-dmg.sh` runs `codesign --verify --deep --strict` before
  packaging so this cannot reach a user.
- **A valid signature does not rule that abort out.** The panel service can also
  stall for reasons outside the bundle (a wedged File Provider daemon): AppKit
  waits 60s in `_initBridgeAndStuff`, then asserts *Advance to configuration
  phase semaphore timed out* at `NSSavePanel.m:448`. Check
  `log show --predicate 'process == "gavia"'` and the click-to-crash gap before
  suspecting the bundle.
- `hardenedRuntime` is off: pointless without notarisation.
- The `.dmg` is built by `scripts/make-dmg.sh` with `hdiutil create`, not
  Tauri's dmg target (which races Spotlight on unmount and fails with
  `Resource busy`). macOS `bundle.targets` is `["app"]`; Windows is NSIS
  (`currentUser`), Linux deb/rpm/AppImage, each in its `tauri.<os>.conf.json`.
- The `.dmg` window layout is a checked-in Finder `.DS_Store`
  (`src-tauri/installer/dmg-DS_Store`, made by `dmg-layout.py`), because
  `hdiutil create` never mounts the image for Finder to lay out. It finds
  `.background.tiff` by path, so the volume name must stay `Gavia`, and the
  icon positions refer to `Gavia.app` and `Applications` by name.
- Installers are unsigned (ad-hoc on macOS), so Gatekeeper and SmartScreen warn;
  the README documents the workaround.
- Dependencies build without debug info (`[profile.dev.package."*"]`); a debug
  build of Tauri plus ORT is several GB otherwise.
- The model is AGPL-3.0 (inherited from Ultralytics YOLO11) and so is this repo.

## Model

`resources/models/loon_v1.json` holds provenance, thresholds, class labels,
metrics and a checksum; `model_info` reports it, so claims cannot drift from the
loaded weights. Swapping in a retrained model is a two-file drop-in. Current:
P 0.906 / R 0.879 / AP@0.5 0.891 on the `loonnet_v1` val split (0.892 under the
Python pipeline). Training lives in the separate `loonet` repo.
