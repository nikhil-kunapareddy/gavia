"""Export vegnet as the ONNX model Gavia offers for invasive plants.

vegnet (in the loonet repo, models/vegnet/v1) is a YOLO26s detector for four
invasive lake plants. YOLO26 is end to end: its one-to-one head picks at most
300 boxes itself, so the exported graph ends in

    output0 (1, 300, 6)  x1, y1, x2, y2, score, class  in letterboxed pixels

and needs no NMS, unlike loon_v1's (1, 5, 8400) anchors. The .json beside it
says so (`output.end_to_end`), which is how the Rust core picks its decoder.

The ONNX model is checked against the PyTorch weights on loonet's vegnet val
split before anything is written, and the .json records where it came from.

Needs loonet's training environment (ultralytics 8.4.138):

    ~/Documents/loonet/.venv-train/bin/python scripts/export_vegnet.py \
        --loonet ~/Documents/loonet
"""

import argparse
import datetime
import hashlib
import json
import os
import shutil
import sys
import tempfile

import numpy as np
from ultralytics import YOLO

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.normpath(os.path.join(HERE, "..", "src-tauri", "resources", "models"))
NAME = "veg_v1"
# The largest differences from PyTorch that still count as the same model.
SCORE_TOLERANCE = 1e-3
BOX_TOLERANCE = 1.0  # pixels in the original photo
CONFIDENCE = 0.25

DISPLAY_LABELS = {
    "purple loosestrife": "Purple loosestrife",
    "common reed": "Common reed",
    "water chestnut": "Water chestnut",
    "yellow flag iris": "Yellow flag iris",
}


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def predictions(model, images):
    """Boxes per image as rows of (class, score, x1, y1, x2, y2), best first."""
    out = []
    for image in images:
        # One at a time, square: the exported graph is fixed at (1, 3, 640,
        # 640), and PyTorch would otherwise get a smaller rectangular input.
        b = model.predict(image, conf=CONFIDENCE, imgsz=640, rect=False, verbose=False)[0].boxes
        rows = np.column_stack([b.cls.numpy(), b.conf.numpy(), b.xyxy.numpy()])
        out.append(rows[np.argsort(-rows[:, 1], kind="stable")])
    return out


def compare(reference, exported):
    """Worst score and box difference, or None if the boxes don't pair up."""
    worst_score = worst_box = 0.0
    for ref, got in zip(reference, exported):
        if ref.shape != got.shape or not np.array_equal(ref[:, 0], got[:, 0]):
            return None
        if len(ref):
            worst_score = max(worst_score, float(np.abs(ref[:, 1] - got[:, 1]).max()))
            worst_box = max(worst_box, float(np.abs(ref[:, 2:] - got[:, 2:]).max()))
    return worst_score, worst_box


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--loonet", default=os.path.expanduser("~/Documents/loonet"))
    args = parser.parse_args()

    weights = os.path.join(args.loonet, "models", "vegnet", "v1", "best.pt")
    split = os.path.join(args.loonet, "data", "annotated", "vegnet_v1", "val.txt")
    with open(split) as f:
        images = [line.strip() for line in f if line.strip()]

    with tempfile.TemporaryDirectory() as tmp:
        staged = os.path.join(tmp, f"{NAME}.pt")
        shutil.copy(weights, staged)
        torch_model = YOLO(staged)
        head = torch_model.model.model[-1]
        if not getattr(head, "end2end", False):
            sys.exit("expected an end-to-end YOLO26 head")
        exported = torch_model.export(format="onnx", opset=17, simplify=True, imgsz=640)

        reference = predictions(YOLO(staged), images)
        result = compare(reference, predictions(YOLO(exported, task="detect"), images))
        if result is None:
            sys.exit("the ONNX model found different boxes from PyTorch")
        worst_score, worst_box = result
        boxes = sum(len(r) for r in reference)
        print(f"{len(images)} val images, {boxes} boxes: worst |Δscore| {worst_score:.2e}, "
              f"worst |Δbox| {worst_box:.3f}px")
        if worst_score > SCORE_TOLERANCE or worst_box > BOX_TOLERANCE:
            sys.exit("the ONNX model differs from PyTorch by more than the tolerance")

        target = os.path.join(MODELS, f"{NAME}.onnx")
        shutil.copy(exported, target)

    checkpoint = torch_model.ckpt
    names = [torch_model.names[i] for i in sorted(torch_model.names)]
    train = checkpoint["train_metrics"]
    metadata = {
        "name": "Vegnet 1.0",
        "description": "Invasive lake plant detector for ground-level photographs, "
        "one box per contiguous stand of a species.",
        "architecture": "YOLO26s",
        "task": "detect",
        "classes": names,
        "display_labels": {n: DISPLAY_LABELS.get(n, n) for n in names},
        "subject": {"one": "invasive plant", "many": "invasive plants"},
        "file": f"{NAME}.onnx",
        "sha256": sha256(target),
        "size_bytes": os.path.getsize(target),
        "input": {
            "name": "images",
            "shape": [1, 3, 640, 640],
            "layout": "NCHW",
            "dtype": "float32",
            "range": [0.0, 1.0],
            "color_order": "RGB",
            "letterbox_pad_value": 114,
        },
        "output": {
            "name": "output0",
            "shape": [1, 300, 6],
            "layout": "x1,y1,x2,y2,score,class x detections",
            "coordinate_space": "letterboxed input pixels",
            "end_to_end": True,
        },
        "defaults": {
            "confidence_threshold": CONFIDENCE,
            # End to end needs no NMS; this only merges boxes across tiles.
            "iou_threshold": 0.45,
            "max_detections": 300,
        },
        "export": {
            "opset": 17,
            "simplified": True,
            "dynamic": False,
            "exporter": f"ultralytics {checkpoint['version']}",
            "exported_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "check": {
                "against": "PyTorch weights, vegnet_v1 val split",
                "images": len(images),
                "boxes": boxes,
                "worst_score_difference": round(worst_score, 6),
                "worst_box_difference_px": round(worst_box, 4),
            },
        },
        "provenance": {
            "source_repo": "loonet",
            "source_run": "runs/vegnet_v1_yolo26s",
            "source_weights": "models/vegnet/v1/best.pt",
            "source_weights_sha256": sha256(weights),
            "dataset": "vegnet_v1",
            "trained_at": checkpoint["date"],
            "epochs": checkpoint["train_args"]["epochs"],
            "image_size": checkpoint["train_args"]["imgsz"],
            "base_weights": checkpoint["train_args"]["model"],
        },
        "metrics": {
            "note": "Ultralytics validation split, recorded in the best.pt checkpoint. "
            "The val boxes were drafted by Grounding DINO and reviewed, not hand-drawn.",
            "precision": round(train["metrics/precision(B)"], 5),
            "recall": round(train["metrics/recall(B)"], 5),
            "mAP50": round(train["metrics/mAP50(B)"], 5),
            "mAP50-95": round(train["metrics/mAP50-95(B)"], 5),
        },
        "license": {
            "spdx": "AGPL-3.0-only",
            "reason": "Derived from Ultralytics YOLO26, which is AGPL-3.0 licensed.",
            "url": "https://ultralytics.com/license",
        },
    }
    with open(os.path.join(MODELS, f"{NAME}.json"), "w") as f:
        json.dump(metadata, f, indent=2)
        f.write("\n")
    print(f"wrote {target} ({metadata['size_bytes'] / 1e6:.1f} MB, sha256 {metadata['sha256'][:8]}…)")


if __name__ == "__main__":
    main()
