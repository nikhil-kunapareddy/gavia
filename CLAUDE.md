# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Gavia finds loons in field photographs: upload an image, get bounding boxes with
confidence scores, keep the ones worth keeping. React 18 + TypeScript (Vite,
Tailwind) frontend, FastAPI (Python 3.11) backend, YOLO11s running locally via
ONNX Runtime. Fully offline; the eventual target is a Tauri desktop app.

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
- `e2e/` is Node, not React: it lives in `tsconfig.node.json` and the
  `react-hooks` rule is off there (it mistakes Playwright's fixture `use()`
  for React's `use`).

## Model

`backend/models/loon_v1.json` holds provenance, thresholds, metrics and a
checksum; `GET /api/model` reports it, so API claims cannot drift from the
loaded weights. Swapping in a retrained model is a two-file drop-in. Current:
P 0.906 / R 0.879 / AP@0.5 0.892 on the `loonnet_v1` val split.
