# Gavia

*A Product of Humanitarians AI*

A computer-vision tool that finds loons in photographs, built to support loon
research and conservation work in the field.

Upload a photo and the app highlights each loon it finds with a bounding box and
a confidence score. Results you choose to keep are saved to a local database and
can be reopened later. It assists expert judgment rather than replacing it —
results are meant to be reviewed.

React 18 + TypeScript (Vite, Tailwind) on the frontend, FastAPI (Python 3.11) on
the backend, with a YOLO11s detector running locally through ONNX Runtime.
Everything runs on your machine; no image is ever sent anywhere.

---

## Running it locally

You need **Python 3.11** and **Node 18+**. Nothing else — the model ships with
the repo.

The app is two processes. Open two terminals and leave both running.

### Terminal 1 — the backend

```bash
cd /path/to/gavia

python3.11 -m venv gavia-venv          # first time only
source gavia-venv/bin/activate
pip install -r backend/requirements.txt

cd backend
uvicorn app.main:app --reload --port 8000
```

You should see, once the model has loaded and warmed up (about half a second):

```json
{"level": "INFO", "message": "model ready", "model": "loon_v1", "provider": "CPUExecutionProvider"}
{"level": "INFO", "message": "Uvicorn running on http://127.0.0.1:8000"}
```

> **Run uvicorn from inside `backend/`.** Settings load `.env` relative to the
> working directory, so starting from the repo root silently ignores
> `backend/.env`.

### Terminal 2 — the frontend

```bash
cd /path/to/gavia/frontend
npm install                            # first time only
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/api` to port 8000, so there is
no CORS to configure and nothing else to set up.

### Check it works

Upload any photo and press **Check for loons**. Or from a third terminal:

```bash
curl -s localhost:8000/api/health
curl -s localhost:8000/api/model | python3 -m json.tool
curl -s -X POST localhost:8000/api/detect -F "image=@/path/to/photo.jpg"
```

Interactive API docs are at **http://localhost:8000/docs**.

### If something is wrong

| Symptom | Cause |
| --- | --- |
| `Could not reach the detection service` in the UI | The backend is not running, or not on port 8000. |
| `/api/health` says `"degraded"` | The process is up but the model failed to load — check the startup log. |
| `Port 5173 is already in use` | Another Vite server is running. `npm run dev -- --port 5174`. |
| `ModuleNotFoundError: No module named 'app'` | uvicorn was started from the repo root instead of `backend/`. |
| Settings in `.env` seem ignored | Same cause as above. |

---

## Testing

Three levels. All of them pass on a clean checkout.

| Suite | Count | Command | Needs |
| --- | --- | --- | --- |
| Backend | 159 | `pytest` | Python venv |
| Frontend unit | 126 | `npm test` | npm install |
| End-to-end | 15 | `npm run test:e2e` | + Playwright browser |

### Backend

```bash
source gavia-venv/bin/activate
cd backend

pytest                        # everything, ~21s
pytest -m "not slow"          # skip the ones that load the model, ~6s
pytest tests/test_api.py      # one file
pytest -k "tiling"            # one topic
pytest -m workflow            # the end-to-end journeys
```

Tests marked `slow` load the real 36 MB ONNX model. They are the only ones that
would catch a corrupt model file, a bad export, or preprocessing that has
drifted far enough to stop finding loons — so run the full suite before
shipping, and `-m "not slow"` while iterating.

- `test_geometry.py` — letterboxing, tiling, NMS and coordinate maths against
  hand-computed values.
- `test_loader.py` — real formats and real failures: MPO, EXIF rotation,
  decompression bombs, truncated files, draft decoding.
- `test_storage.py` — schema migrations, CRUD, and keeping the database and the
  image files in step.
- `test_config.py` — settings, per-platform data directories, the error
  envelope, JSON logging.
- `test_api.py` — the HTTP contract the frontend depends on.
- `test_model_integration.py` — the real model, including thread safety.
- `test_workflow.py` — complete journeys through the real stack.

### Frontend

```bash
cd frontend

npm test                      # unit and component tests
npm run test:watch
npm run test:coverage         # currently 99% of statements
npm test -- src/services      # one directory
npm test -- -t 'saving'       # one case
```

`App.test.tsx` mocks the service layer; `App.workflow.test.tsx` mocks only
`fetch`, so the real `api.ts` and service modules run against responses shaped
exactly like the backend's. That second file is what catches the app and the
API drifting apart.

### End-to-end

A real Chromium browser driving the real app against the real backend and the
real model. Nothing is stubbed.

```bash
cd frontend
npx playwright install chromium    # first time only, ~95 MB
npm run test:e2e
npm run test:e2e:ui                # step through it visually
```

Playwright starts both servers itself, on ports 5179 and 8111 so it cannot
collide with a dev server you already have open (override with
`E2E_FRONTEND_PORT` / `E2E_BACKEND_PORT`). The backend gets a throwaway data
directory each run, so your saved history is never touched.

Tests that need an actual loon photograph skip themselves if the `loonnet_v1`
dataset is not on the machine; the rest run anywhere.

### Everything at once

```bash
cd frontend && npm run test:all    # typecheck, lint, unit, e2e
cd backend  && pytest
```

### Model accuracy

Neither suite above measures accuracy — that needs labelled data and lives in
`backend/scripts/`. See `backend/scripts/README.md`.

---

## Status

Detection works end to end. `backend/models/loon_v1.onnx` is a single-class
common loon detector trained on `loonnet_v1`, scoring **P 0.906 / R 0.879 /
AP@0.5 0.892** on its validation split — slightly ahead of the Ultralytics
runtime it was exported from.

It is an early model on a small dataset. Treat its confidence scores as a
starting point for review, not an answer.

## How it works

```
photo ─▶ stream to temp file ─▶ decode (EXIF, draft-scaled)
      ─▶ letterbox to 640 ─▶ ONNX Runtime ─▶ NMS ─▶ percentages ─▶ JSON
```

Boxes are returned as percentages of the image rather than pixels, so the
overlay is independent of display size.

Detection does not save anything. The reviewer looks at the result and decides;
`POST /api/results` commits it, writing the original image unmodified plus a
thumbnail, with metadata in SQLite.

| | |
| --- | --- |
| `POST /api/detect` | Run the detector. Returns detections; persists nothing. |
| `POST /api/results` | Keep a result: image, thumbnail, and detections. |
| `GET /api/results` | Saved checks, newest first. |
| `GET /api/results/{id}` | One saved check. |
| `GET /api/results/{id}/image` | The original bytes. |
| `GET /api/results/{id}/thumb` | ~320px WebP for the history grid. |
| `DELETE /api/results/{id}` | Remove one, files included. |
| `DELETE /api/results` | Clear the history. |
| `GET /api/health` | Liveness. Answers even with no model loaded. |
| `GET /api/model` | What is actually loaded, read from the model's metadata. |

Errors share one shape, so the UI can branch on `code` rather than parse prose:

```json
{ "error": { "code": "IMAGE_TOO_LARGE", "message": "…", "requestId": "4cf9e88e401d" } }
```

## Where data lives

Saved checks go to the platform's per-user data directory — on macOS
`~/Library/Application Support/Gavia`:

```
gavia.db          results and detections
images/<id>.jpg   the original, byte-for-byte
thumbs/<id>.webp  ~11 KB grid thumbnail
```

Override with `DATA_DIR`. History used to live in `localStorage` with images
inlined as base64, which silently dropped the oldest saved checks once the
browser's ~5 MB quota filled up.

## Performance

Measured on an M2 Pro, single-pass at 640:

| | |
| --- | --- |
| Cold start (load + warmup) | 0.37 s |
| Inference, 3–20 MP photo | 120–210 ms |
| Steady memory | ~370 MB |
| Model file | 36 MB |

Large JPEGs are decoded at reduced scale directly by libjpeg rather than being
decoded in full and then shrunk, which is most of the memory saving on the
common path.

## Tiling

Off by default, and that is a measured decision rather than a cautious one.
Tiling exists for small-object imagery — a 40px bird in a 6000px drone frame
survives a 640px tile and does not survive a whole-image resize. But on the
current dataset 64% of labelled loons are *larger* than a 640px tile (median
longest side 1077px, 41% of the frame), so tiles see fragments of a bird rather
than a bird:

| pipeline | P | R | AP@0.5 |
| --- | --- | --- | --- |
| single pass | 0.906 | 0.879 | 0.892 |
| tiled | 0.074 | 0.364 | 0.231 |
| tiled + full pass | 0.154 | 0.849 | 0.629 |

Enable it with `TILING_ENABLED=true` or per request with `?tiling=true` when
working with genuine top-down drone frames, and confirm it helps with
`backend/scripts/evaluate.py`.

## Configuration

Backend only, via `backend/.env` — copy `backend/.env.example` to start. It
documents every setting; the ones you are most likely to touch:

| Variable | Default |
| --- | --- |
| `DEBUG` | `false` |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` |
| `TILING_ENABLED` | `false` |
| `DATA_DIR` | platform per-user data directory |
| `MAX_UPLOAD_BYTES` | `20971520` (20 MB) |
| `AUTH_TOKEN` | empty (open) |

`AUTH_TOKEN` gates every endpoint except `/api/health` behind an
`X-Gavia-Token` header. Binding to 127.0.0.1 keeps the service off the network
but not away from other processes on the machine; the packaged desktop shell
generates a token per launch so only the app it started can drive the backend.

## Model

See `backend/scripts/README.md` for evaluating, re-exporting, and the parity
check. `backend/models/loon_v1.json` records provenance, thresholds, metrics
and a checksum, and `GET /api/model` reports it — so what the API claims cannot
drift from the weights in use.

## Licence

AGPL-3.0. The detector is derived from Ultralytics YOLO11, which is AGPL-3.0,
and that obligation carries to anything distributed with these weights. See
[LICENSE](LICENSE).
