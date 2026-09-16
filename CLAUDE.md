# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Gavia finds loons in field photographs: upload an image, get bounding boxes with
confidence scores, keep the ones worth keeping. React 18 + TypeScript (Vite,
Tailwind) frontend, FastAPI (Python 3.11) backend, YOLO11s running locally via
ONNX Runtime. Fully offline, and it ships as a Tauri desktop app with the
backend frozen into the bundle.

## Commands

Frontend (from `frontend/`):

```bash
npm run dev          # http://localhost:5173, proxies /api to :8000
npm test             # vitest run
npm run typecheck    # tsc -b --noEmit
npm run lint         # eslint . (type-checked rules)
npm test -- src/services/historyService.test.ts     # one file
npm test -- -t 'saving'                             # one case
npm run test:coverage                               # 99% of statements
npm run test:all                                    # typecheck, lint, unit, e2e
```

Backend (venv at repo root, run uvicorn from `backend/`):

```bash
source gavia-venv/bin/activate
cd backend && uvicorn app.main:app --reload --port 8000
pytest                       # 159 tests, ~21s
pytest -m "not slow"         # skip the ones that load the model, ~6s
pytest -m workflow           # end-to-end journeys through the real stack
pytest tests/test_api.py::TestDetect
```

`pytest.ini` sets `pythonpath = .`, so no `PYTHONPATH=` prefix is needed.

End-to-end (real browser, real backend, real model):

```bash
cd frontend && npx playwright install chromium   # first time
npm run test:e2e
```

`Settings` loads `.env` relative to the working directory, so starting uvicorn
from the repo root silently ignores `backend/.env`.

Desktop (from `frontend/`):

```bash
npm run tauri:dev            # debug shell against Vite; run uvicorn yourself
npm run build:sidecar        # freeze the backend, ~2 min
GAVIA_SIDECAR=1 npm run tauri:dev   # debug shell against the frozen backend
npm run tauri:build          # sidecar + frontend + shell + .dmg
npm run package:dmg          # just re-package an already-built .app
cd src-tauri && cargo test   # the shell's own unit tests
```

`build:sidecar` needs `backend/requirements-build.txt` installed into
`gavia-venv`; PyInstaller is deliberately absent from `requirements.txt`.

The model scripts need `ultralytics`, which is deliberately absent from the
backend's environment. Use the training venv — see `backend/scripts/README.md`:

```bash
PYTHONPATH=backend ~/Documents/loonet/.venv-train/bin/python backend/scripts/evaluate.py \
  --split ~/Documents/loonet/data/annotated/loonnet_v1/val.txt \
  --weights ~/Documents/loonet/runs/loonnet_v1_yolo11s/weights/best.pt
```

## Architecture

**Inference is hand-rolled on top of ONNX Runtime, not Ultralytics.** That saves
~2.5 GB of dependencies and makes bundling feasible, but it means this repo owns
letterboxing, NMS and coordinate mapping. `app/detection/` is pure and free of
FastAPI imports: `preprocess` (letterbox + tile planning), `postprocess` (decode,
NMS, clamp, percentages), `loader` (decode, EXIF, bomb guard), `detector` (the
session). The model's `(1, 5, 8400)` output is centre/size in letterboxed pixels;
every step back to the original image happens in `postprocess.decode`.

**Two scripts guard that ownership, and they answer different questions.**
`evaluate.py` scores pipelines against ground truth and is authoritative.
`check_parity.py` is a structural smoke test against Ultralytics and is *not*
expected to match exactly — Ultralytics resizes with `cv2.INTER_LINEAR`, which
aliases at the ~6x downscale these photos need, while Pillow filters properly.
Do not tighten its tolerances to force agreement; run `evaluate.py` instead.

**Boxes are percentages (0–100), never pixels**, all the way from `postprocess`
through the API to the CSS in `DetectionOverlay`. This is what lets the detector
decode a huge JPEG at reduced scale and still report boxes that line up with the
full-size original. `imageWidth`/`imageHeight` in a response are always the
user's original dimensions, not whatever reduced-scale decode was used — getting
that wrong once already produced boxes that looked right and measured wrong.

**Detection and persistence are separate on purpose.** `POST /api/detect`
returns a result with `imageUrl: ""` and writes nothing; the reviewer decides,
and `POST /api/results` commits it with the image re-sent from the client. No
server-side staging area means nothing to expire or clean up after a crash. The
saved detections are the client's, not recomputed, so what is stored is exactly
what the reviewer looked at.

**Tiling is off by default and should stay off unless measured.** 64% of
labelled loons are larger than a 640px tile, so tiles see fragments and
precision collapses (AP@0.5 0.892 single-pass vs 0.231 tiled). The code is
correct and kept for genuine small-object drone imagery. The numbers are in
`Detector`'s docstring and the README.

**The desktop shell serves both halves from one origin.** `frontend/src-tauri`
spawns the PyInstaller-frozen backend, which serves the API under `/api` *and*
the built frontend under `/` (`Settings.static_dir`), then points the window at
`http://127.0.0.1:<port>`. That is what lets `services/api.ts` use relative
URLs with no base URL and no CORS exception, in the packaged app exactly as
through Vite's proxy. The sidecar binds its own port and prints
`GAVIA_PORT=<n>` before loading the model, passing the live socket to uvicorn
so no other process can claim the port in between; the shell mints a UUID per
launch, passes it as `AUTH_TOKEN`, and injects it as `window.__GAVIA_TOKEN__`.
The sidecar's stdin is a lifetime link, not a channel: the shell holds the
write end open and never writes to it, and `--exit-with-parent` stops the
backend on EOF. `Backend::shutdown` only covers an orderly quit — a shell that
is killed or aborts never reaches `RunEvent::Exit`, and used to leave the
backend running on the user's database with no window left to close it. Do not
hand the child `Stdio::null()` or `take()` the handle; either reads as "shell
gone" and stops the backend before it serves anything.
Serving the frontend over `tauri://` instead would mean an absolute API URL and
two ways for the halves to disagree — don't.

**Storage** is raw `sqlite3` (no ORM) plus files on disk: originals byte-for-byte
in `images/`, WebP thumbnails in `thumbs/`, metadata in `gavia.db`. Schema
versioning uses SQLite's `user_version`; migrations are forward-only. One
connection per thread, because inference runs in a thread pool.

**Frontend state all lives in `App.tsx`**; pages and components are
presentational. No router — `page` is a `Page` state value. `services/api.ts` is
the only module that calls `fetch`, and it turns every failure into a typed
`ApiError` with a `code` the UI branches on.

## Conventions

- **Styling is hand-written semantic CSS in `src/index.css`** (`.drop-zone`,
  `.result-main-grid`, …). Tailwind is installed and its theme configured, but
  components use no utility classes and the CSS uses no `@apply`. Add a class to
  `index.css` and reference it by name.
- Response models are camelCase to match `frontend/src/types/detection.ts`
  exactly, hence the `# noqa: N815` markers. The two definitions must agree.
- Every API error goes out as `{"error": {"code", "message", "requestId"}}` via
  the handlers in `app/core/errors.py`. Add a typed `ApiError` subclass rather
  than raising `HTTPException`.
- Prettier: no semicolons, single quotes, 100 columns. ESLint runs
  `recommendedTypeChecked`, so new source files must fall under
  `tsconfig.app.json`'s `include: ["src"]` or linting fails.
- `ruff` is installed in `gavia-venv` but is not this project's linter. It
  reports ~54 errors on untouched files and its formatter disagrees with the
  repo's style; the Python here is kept by hand. Don't run it.
- `src/test/setup.ts` shims `localStorage` and `URL.createObjectURL`; don't
  re-mock those globally in individual tests.

## Testing

Three levels, and each catches a different class of bug:

- **Backend unit** (`test_geometry`, `test_loader`, `test_storage`,
  `test_config`) — pure logic, no model, no HTTP.
- **Backend API** (`test_api`) — the HTTP contract, against a stub detector so
  it stays fast.
- **Backend slow** (`test_model_integration`, `test_workflow`) — the real ONNX
  model, real SQLite, real files. Marked `slow`; these are the only tests that
  catch a bad model export or preprocessing drift.
- **Frontend unit** — components and services in jsdom.
- **`App.workflow.test.tsx`** — mocks only `fetch`, so the real service layer
  runs against backend-shaped responses. This is what catches the app and the
  API drifting apart, and its fixtures must stay in step with
  `app/schemas/detection.py`.
- **`frontend/e2e/`** — Playwright: real browser, real backend, real model.

When adding an endpoint or changing a response shape, update `test_api.py`,
the fake backend in `App.workflow.test.tsx`, and the `Api*` interfaces in
`e2e/fixtures.ts` together — they encode the same contract three times over.

## Gotchas

- **MPO is a supported format.** It is JPEG with extra frames, emitted by plenty
  of phones and cameras (7% of the training set). Excluding it from
  `SUPPORTED_FORMATS` rejects real user photos.
- `loader.read_dimensions` applies EXIF orientation by hand rather than calling
  `exif_transpose`, which would decode the whole image just to report its shape.
- The detector serialises inference behind a lock and reuses one input buffer
  across tiles. A caller must finish with each tile before requesting the next.
- The model is AGPL-3.0 (inherited from Ultralytics YOLO11) and so is this repo.
- `ResultRepository.save` inserts the database row *before* writing any file.
  Writing files first means a save under an existing id overwrites the stored
  photo and then the failed insert's rollback deletes the original's files.
- Playwright's e2e servers use ports 5179/8111, not the dev ports, so a run
  cannot collide with a dev server you have open.
- `require_token` and the `/api/health` and `/api/model` routes read the
  *module-level* `settings`, not the instance passed to `create_app`. That is
  why `app/__main__.py` configures the sidecar through the environment rather
  than through constructor arguments, and why `test_api.py` mutates the global
  to test auth.
- The sidecar is built `onedir`, not `onefile`, and bundled as a Tauri
  *resource* rather than an `externalBin` — `externalBin` takes a single file,
  and onefile re-extracts ~160 MB on every launch. Resource copying does
  preserve the executable bit.
- `Path(sys._MEIPASS)` is where the frozen app finds `models/`; see
  `_backend_root()` in `core/config.py`.
- **The bundle must be ad-hoc signed or file dialogs abort the app.**
  `bundle.macOS.signingIdentity: "-"` is load-bearing. Without it the bundle
  carries only the linker's signature on the main executable — no resource
  seal, `Info.plist` unbound, `codesign --verify` failing. The app then runs
  fine until AppKit is asked for an out-of-process file panel, which refuses to
  start for an invalid bundle; `+[NSOpenPanel openPanel]` returns nil, wry does
  not guard it, and the process aborts with SIGABRT the moment the user clicks
  upload. `scripts/make-dmg.sh` verifies the signature before packaging so this
  cannot reach a user again.
- **A valid signature does not rule that abort out.** `+[NSOpenPanel openPanel]`
  also returns nil when the panel service stalls for reasons outside the
  bundle: AppKit waits 60s inside `_initBridgeAndStuff`, then
  `NSSavePanel.m:448` asserts *Advance to configuration phase semaphore timed
  out*. Same nil, same SIGABRT. A wedged File Provider daemon does it, since
  the panel enumerates every registered domain to build its sidebar. Before
  suspecting the bundle, check `log show --predicate 'process == "gavia"'` for
  that assertion, and look at the gap between the click and the crash — 60s
  means the timeout, not the signature. A dozen lines of Swift calling
  `NSOpenPanel()` in an ad-hoc signed bundle tells you in one run whether it is
  the machine or this app. wry 0.56 downgrades the nil to a cancelled picker;
  tauri 2.11 pins wry 0.55.
- `hardenedRuntime` is off on purpose: it enables library validation, which
  rejects PyInstaller's unsigned dylibs, and is pointless without notarisation.
- The `.dmg` is built by `frontend/scripts/make-dmg.sh`, not Tauri, and
  `bundle.targets` is `["app"]`. Tauri's dmg target mounts a scratch volume and
  drives Finder over AppleScript; on a bundle this size the unmount races
  Spotlight and fails with `Resource busy` about half the time, leaving the
  volume mounted so the *next* build fails too. `hdiutil create` never mounts.
- The `.app` is ad-hoc signed, not Developer ID signed, so it runs on the
  machine that built it but will trip Gatekeeper if copied elsewhere.
- `e2e/` is Node, not React: it lives in `tsconfig.node.json` and the
  `react-hooks` rule is off there (it mistakes Playwright's fixture `use()`
  for React's `use`).

## Model

`backend/models/loon_v1.json` holds provenance, thresholds, metrics and a
checksum; `GET /api/model` reports it, so API claims cannot drift from the
loaded weights. Swapping in a retrained model is a two-file drop-in. Current:
P 0.906 / R 0.879 / AP@0.5 0.892 on the `loonnet_v1` val split.
