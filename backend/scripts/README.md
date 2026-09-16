# Scripts

`evaluate.py` and `check_parity.py` are model scripts; `build_sidecar.py` is a
packaging script and runs somewhere else entirely. Mind which is which.

## Model scripts — the training venv

Both compare this backend against Ultralytics, so they need an interpreter that
has `ultralytics` and `torch` installed — deliberately *not* the backend's own
environment, which exists to stay small enough to bundle.

The training venv from the `loonet` repo works:

```bash
cd /path/to/gavia
PYTHONPATH=backend ~/Documents/loonet/.venv-train/bin/python backend/scripts/<script>.py ...
```

### `evaluate.py` — the authoritative accuracy check

Scores each pipeline against ground-truth labels. Run this after any change to
pre/postprocessing, any model re-export, and before turning tiling on for a new
kind of imagery.

```bash
PYTHONPATH=backend ~/Documents/loonet/.venv-train/bin/python backend/scripts/evaluate.py \
  --split ~/Documents/loonet/data/annotated/loonnet_v1/val.txt \
  --weights ~/Documents/loonet/runs/loonnet_v1_yolo11s/weights/best.pt
```

Last run on `loonnet_v1` val (26 images, 33 labelled loons):

| pipeline | P | R | AP@0.5 |
| --- | --- | --- | --- |
| ultralytics baseline | 0.849 | 0.849 | 0.884 |
| onnx single-pass | 0.906 | 0.879 | 0.892 |
| onnx tiled | 0.074 | 0.364 | 0.231 |

### `check_parity.py` — structural smoke test

Confirms boxes land in the same places as Ultralytics. Catches coordinate bugs
(transposed axes, a dropped letterbox offset, the wrong image dimensions).

It does **not** expect exact agreement and should not be tightened to. Ultralytics
resizes with `cv2.INTER_LINEAR`, which at the ~6x downscale these photos need is
a point sample that aliases; Pillow filters the same downscale properly. The two
feed the model measurably different pixels and no Pillow filter closes the gap —
`evaluate.py` is what decides whether that matters.

### Re-exporting the model

```bash
cd ~/Documents/loonet
uv pip install --python .venv-train/bin/python onnx onnxslim
.venv-train/bin/python -c "
from ultralytics import YOLO
YOLO('runs/loonnet_v1_yolo11s/weights/best.pt').export(
    format='onnx', imgsz=640, opset=17, simplify=True, dynamic=False, device='cpu')
"
cp runs/loonnet_v1_yolo11s/weights/best.onnx /path/to/gavia/backend/models/loon_v1.onnx
shasum -a 256 /path/to/gavia/backend/models/loon_v1.onnx   # update loon_v1.json
```

Then update `models/loon_v1.json` (sha256, provenance, metrics) and re-run both
scripts above.

## Packaging — the backend's own venv

### `build_sidecar.py` — freeze the backend for the desktop app

```bash
pip install -r backend/requirements-build.txt      # adds PyInstaller
gavia-venv/bin/python backend/scripts/build_sidecar.py
```

Writes `backend/dist/gavia-backend/`, which `tauri.conf.json` bundles as a
resource. This one runs in `gavia-venv`, not the training venv — the whole
point is to freeze exactly the dependency set the app ships with, so borrowing
an environment that has torch in it would bundle the wrong thing.

It starts the binary afterwards and asks it for `/api/health`, from a working
directory with no source tree in it. That is the failure this step actually
has: a module that resolved during analysis and is missing at run time, which
inspecting the output directory would never reveal.

`frontend/npm run tauri:build` calls this for you.
