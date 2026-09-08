# Gavia

*A Product of Humanitarians AI*

A computer-vision tool that finds loons in photographs, built to support loon
research and conservation work in the field.

Upload a photo and the app highlights each loon it finds with a bounding box and
a confidence score. Results can be saved to a local history (kept in
`localStorage`, alongside a few demo samples) and reopened later. It assists
expert judgment rather than replacing it — results are meant to be reviewed.

React 18 + TypeScript (Vite, Tailwind) on the frontend, FastAPI (Python 3.11) on
the backend.

## Status

**Detection is not wired up yet.** `frontend/src/services/detectionService.ts`
is a stub that returns fixed boxes after a short delay, chosen from the uploaded
file's name. The backend is a skeleton exposing only `GET /api/health`, and the
frontend does not call it — the whole app currently runs in the browser.

## Getting started

The frontend is enough to see the app:

```bash
cd frontend && npm install && npm run dev   # http://localhost:5173
```

Other scripts: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

The backend runs separately, if you need it:

```bash
source gavia-venv/bin/activate
pip install -r backend/requirements.txt
cd backend && uvicorn app.main:app --reload --port 8000   # docs at /docs
```

## Configuration

Backend only, via `backend/.env` — copy `backend/.env.example` to start.

| Variable | Default |
| --- | --- |
| `APP_NAME` | `Gavia API` |
| `DEBUG` | `false` |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` |
