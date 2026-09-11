#!/usr/bin/env python
"""Score detection pipelines against ground-truth labels.

The parity script asks "do we agree with Ultralytics?". This asks the question
that actually matters: "do we find the loons?". They can diverge — our
preprocessing filters a downscale properly where Ultralytics' aliases it, so
byte-identical inputs were never achievable without taking on OpenCV. What we
need to know is whether the difference costs accuracy.

Reports precision, recall and AP@0.5 for each pipeline over a YOLO-format
split, so a preprocessing or model change can be judged on evidence.

    PYTHONPATH=backend ~/Documents/loonet/.venv-train/bin/python \\
        backend/scripts/evaluate.py --split <val.txt> --weights <best.pt>
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.detection.detector import Detector  # noqa: E402

IOU_MATCH = 0.5


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--split", type=Path, required=True, help="YOLO split .txt")
    parser.add_argument("--weights", type=Path, help="Ultralytics .pt, to include as a baseline")
    parser.add_argument("--onnx", type=Path, default=BACKEND_ROOT / "models" / "loon_v1.onnx")
    parser.add_argument("--conf", type=float, default=0.001, help="low, so AP sees the full curve")
    parser.add_argument("--iou", type=float, default=0.45)
    args = parser.parse_args()

    images = [Path(line) for line in args.split.read_text().split() if line]
    truth = {p: load_labels(p) for p in images}
    total_objects = sum(len(v) for v in truth.values())
    print(f"{len(images)} images, {total_objects} labelled loons\n")

    detector = Detector(args.onnx)
    runs: dict[str, dict[Path, list[tuple[float, np.ndarray]]]] = {}

    runs["onnx single-pass"] = {
        p: [
            (d.confidence, to_xyxy_pixels(d, w, h))
            for d, w, h in _predictions(detector, p, args, tiling=False)
        ]
        for p in images
    }
    runs["onnx tiled"] = {
        p: [
            (d.confidence, to_xyxy_pixels(d, w, h))
            for d, w, h in _predictions(detector, p, args, tiling=True)
        ]
        for p in images
    }

    if args.weights:
        from ultralytics import YOLO

        model = YOLO(str(args.weights))
        baseline = {}
        for p in images:
            r = model.predict(
                str(p), imgsz=640, conf=args.conf, iou=args.iou, verbose=False, device="cpu"
            )[0]
            baseline[p] = [
                (float(b.conf[0]), np.array(b.xyxy[0].tolist(), dtype=np.float64))
                for b in r.boxes
            ]
        runs["ultralytics baseline"] = baseline

    print(f"{'pipeline':24s} {'P':>7s} {'R':>7s} {'AP@0.5':>8s} {'preds':>7s}")
    print("-" * 56)
    for name in ("ultralytics baseline", "onnx single-pass", "onnx tiled"):
        if name not in runs:
            continue
        p, r, ap, n = score(runs[name], truth, total_objects)
        print(f"{name:24s} {p:7.4f} {r:7.4f} {ap:8.4f} {n:7d}")

    return 0


def _predictions(detector: Detector, path: Path, args, *, tiling: bool):
    outcome = detector.detect(
        path, confidence_threshold=args.conf, iou_threshold=args.iou, tiling=tiling
    )
    return [(d, outcome.image_width, outcome.image_height) for d in outcome.predictions]


def to_xyxy_pixels(prediction, width: int, height: int) -> np.ndarray:
    """Percentage box -> pixel corners, for IoU against pixel-space truth."""
    return np.array(
        [
            prediction.x / 100 * width,
            prediction.y / 100 * height,
            (prediction.x + prediction.width) / 100 * width,
            (prediction.y + prediction.height) / 100 * height,
        ],
        dtype=np.float64,
    )


def load_labels(image_path: Path) -> np.ndarray:
    """Read the YOLO sidecar label file as pixel-space xyxy boxes.

    Dimensions come from the shared loader so that ground truth and
    predictions agree on EXIF orientation; reading ``Image.size`` directly
    would put a rotated photo's labels in a transposed coordinate space.
    """
    from app.detection.loader import read_dimensions

    label_path = Path(str(image_path).replace("/images/", "/labels/")).with_suffix(".txt")
    if not label_path.exists():
        return np.zeros((0, 4))

    width, height = read_dimensions(image_path)

    boxes = []
    for line in label_path.read_text().splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        _, cx, cy, w, h = (float(v) for v in parts[:5])
        boxes.append(
            [
                (cx - w / 2) * width,
                (cy - h / 2) * height,
                (cx + w / 2) * width,
                (cy + h / 2) * height,
            ]
        )
    return np.array(boxes, dtype=np.float64) if boxes else np.zeros((0, 4))


def iou_matrix(box: np.ndarray, targets: np.ndarray) -> np.ndarray:
    if targets.size == 0:
        return np.zeros(0)
    x1 = np.maximum(box[0], targets[:, 0])
    y1 = np.maximum(box[1], targets[:, 1])
    x2 = np.minimum(box[2], targets[:, 2])
    y2 = np.minimum(box[3], targets[:, 3])
    inter = (x2 - x1).clip(min=0) * (y2 - y1).clip(min=0)
    area_a = (box[2] - box[0]) * (box[3] - box[1])
    area_b = (targets[:, 2] - targets[:, 0]) * (targets[:, 3] - targets[:, 1])
    union = area_a + area_b - inter
    return np.divide(inter, union, out=np.zeros_like(inter), where=union > 0)


def score(predictions, truth, total_objects: int):
    """Greedy IoU matching, then AP by continuous interpolation of the PR curve."""
    rows = []
    for path, preds in predictions.items():
        targets = truth[path]
        claimed = np.zeros(len(targets), dtype=bool)
        for confidence, box in sorted(preds, key=lambda t: t[0], reverse=True):
            ious = iou_matrix(box, targets)
            hit = -1
            if ious.size:
                order = np.argsort(-ious)
                for idx in order:
                    if ious[idx] < IOU_MATCH:
                        break
                    if not claimed[idx]:
                        claimed[idx] = True
                        hit = int(idx)
                        break
            rows.append((confidence, 1 if hit >= 0 else 0))

    if not rows or total_objects == 0:
        return 0.0, 0.0, 0.0, len(rows)

    rows.sort(key=lambda t: t[0], reverse=True)
    tp = np.cumsum([r[1] for r in rows])
    fp = np.cumsum([1 - r[1] for r in rows])
    recall = tp / total_objects
    precision = tp / np.maximum(tp + fp, 1e-12)

    # Monotone envelope, then area under the step curve.
    envelope = np.maximum.accumulate(precision[::-1])[::-1]
    ap = float(np.sum(np.diff(np.concatenate([[0.0], recall])) * envelope))

    # Operating point at the threshold the app actually ships with.
    at = [r for r in rows if r[0] >= 0.25]
    if at:
        hits = sum(r[1] for r in at)
        return hits / len(at), hits / total_objects, ap, len(rows)
    return 0.0, 0.0, ap, len(rows)


if __name__ == "__main__":
    raise SystemExit(main())
