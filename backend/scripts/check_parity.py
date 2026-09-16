#!/usr/bin/env python
"""Verify the ONNX pipeline reproduces Ultralytics' own predictions.

Not using Ultralytics at runtime means owning letterboxing, decoding and NMS
ourselves. That is the right trade for a 2.5GB dependency, but it puts a burden
of proof on us. This script carries half of it: a fast structural check that
boxes land in the same places. scripts/evaluate.py carries the other half, and
is the one that decides whether accuracy is acceptable.

Run both after any model re-export or change to pre/postprocessing.

Needs both environments, so it is invoked with the *training* interpreter
(which has ultralytics) and imports the backend from source:

    PYTHONPATH=backend ~/Documents/loonet/.venv-train/bin/python \\
        backend/scripts/check_parity.py <image> [<image> ...]
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

# This is a smoke test for gross errors — transposed axes, a missing letterbox
# offset, boxes in the wrong coordinate space — not an exact-match test.
#
# Exact agreement is not achievable and not desirable. Ultralytics resizes with
# cv2 INTER_LINEAR, which at the ~6x downscale these photos need is a point
# sample that aliases badly; Pillow filters the same downscale properly. The
# two therefore feed the model measurably different pixels (mean |delta| ~5/255),
# and no choice of Pillow filter closes the gap.
#
# scripts/evaluate.py is the authoritative check, and it scores this pipeline
# slightly *ahead* of the Ultralytics baseline (AP@0.5 0.892 vs 0.884). These
# tolerances just need to be tight enough to catch a real coordinate bug.
BOX_TOLERANCE = 3.0
SCORE_TOLERANCE = 0.10

# Only detections comfortably clear of the threshold are compared. A box the
# model scores near the cutoff is included by one pipeline and excluded by the
# other for a 0.05 score difference, which says nothing about correctness and
# makes the check flap.
COMPARE_ABOVE = 0.40


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("images", nargs="+", type=Path)
    parser.add_argument("--weights", type=Path, required=True, help="Ultralytics .pt")
    parser.add_argument("--onnx", type=Path, default=BACKEND_ROOT / "models" / "loon_v1.onnx")
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--iou", type=float, default=0.45)
    args = parser.parse_args()

    from ultralytics import YOLO

    reference = YOLO(str(args.weights))
    detector = Detector(args.onnx)

    failures = 0
    for image_path in args.images:
        failures += 0 if compare(image_path, reference, detector, args) else 1

    total = len(args.images)
    print(f"\n{total - failures}/{total} images matched")
    return 1 if failures else 0


def compare(image_path: Path, reference, detector: Detector, args) -> bool:
    # imgsz/conf/iou pinned to the same values our pipeline uses, and tiling is
    # off by construction: parity is about the model path, not the tiling
    # strategy, which Ultralytics has no equivalent of.
    predicted = reference.predict(
        str(image_path), imgsz=640, conf=args.conf, iou=args.iou, verbose=False, device="cpu"
    )[0]

    height, width = predicted.orig_shape
    expected = sorted(
        (
            (
                float(box.conf[0]),
                *(_to_percent(box.xyxy[0].tolist(), width, height)),
            )
            for box in predicted.boxes
            if float(box.conf[0]) >= COMPARE_ABOVE
        ),
        reverse=True,
    )

    # tiling=False is essential: Ultralytics always does one 640 pass, so a
    # tiled run would legitimately find more (and different) boxes and there
    # would be nothing to compare.
    outcome = detector.detect(
        image_path, confidence_threshold=args.conf, iou_threshold=args.iou, tiling=False
    )
    actual = sorted(
        (
            (p.confidence, p.x, p.y, p.x + p.width, p.y + p.height)
            for p in outcome.predictions
            if p.confidence >= COMPARE_ABOVE
        ),
        reverse=True,
    )

    name = image_path.name
    if len(expected) != len(actual):
        print(f"FAIL {name}: ultralytics found {len(expected)}, onnx found {len(actual)}")
        _dump(expected, actual)
        return False

    if not expected:
        print(f"  ok {name}: neither found a confident detection")
        return True

    worst_box = max(
        (max(abs(a - b) for a, b in zip(e[1:], g[1:])) for e, g in zip(expected, actual)),
        default=0.0,
    )
    worst_score = max(
        (abs(e[0] - g[0]) for e, g in zip(expected, actual)),
        default=0.0,
    )

    if worst_box > BOX_TOLERANCE or worst_score > SCORE_TOLERANCE:
        print(
            f"FAIL {name}: {len(actual)} boxes, "
            f"max edge delta {worst_box:.3f}% (limit {BOX_TOLERANCE}), "
            f"max score delta {worst_score:.4f} (limit {SCORE_TOLERANCE})"
        )
        _dump(expected, actual)
        return False

    print(
        f"  ok {name}: {len(actual)} boxes, "
        f"edge delta {worst_box:.3f}%, score delta {worst_score:.4f}"
    )
    return True


def _to_percent(xyxy: list[float], width: int, height: int) -> tuple[float, ...]:
    x1, y1, x2, y2 = xyxy
    return (x1 / width * 100, y1 / height * 100, x2 / width * 100, y2 / height * 100)


def _dump(expected, actual) -> None:
    print("      ultralytics:")
    for row in expected:
        print(f"        conf={row[0]:.4f} box=({row[1]:.2f}, {row[2]:.2f}, {row[3]:.2f}, {row[4]:.2f})")
    print("      onnx:")
    for row in actual:
        print(f"        conf={row[0]:.4f} box=({row[1]:.2f}, {row[2]:.2f}, {row[3]:.2f}, {row[4]:.2f})")


if __name__ == "__main__":
    raise SystemExit(main())
