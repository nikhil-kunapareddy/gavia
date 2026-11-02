"""Write the vegnet reference the Rust port is checked against.

Runs resources/models/veg_v1.onnx through Gavia's pipeline, written in Python
the way the original Python backend did it for loons: Pillow's draft() for
large JPEGs, EXIF rotation, a bilinear letterbox to 640 with grey (114)
padding, ONNX Runtime, then YOLO26's end-to-end rows (x1, y1, x2, y2, score,
class) kept at score >= 0.25 and mapped back in float32. No NMS: the model
picks its own boxes.

Output: src-tauri/tests/fixtures/vegnet_reference.json, with every box as
percentages of the photo for

- `fixtures`: the photos in src-tauri/tests/fixtures/plants, checked in CI by
  tests/plants.rs;
- `val`: loonet's vegnet_v1 val split, by file name, checked by the same test
  when that data is there.

Needs loonet's training environment (Pillow, onnxruntime):

    ~/Documents/loonet/.venv-train/bin/python scripts/vegnet_reference.py \
        --loonet ~/Documents/loonet
"""

import argparse
import json
import os

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
TAURI = os.path.normpath(os.path.join(HERE, "..", "src-tauri"))
MODEL = os.path.join(TAURI, "resources", "models", "veg_v1.onnx")
FIXTURES = os.path.join(TAURI, "tests", "fixtures", "plants")
OUTPUT = os.path.join(TAURI, "tests", "fixtures", "vegnet_reference.json")
SIZE = 640
PAD = 114
CONFIDENCE = 0.25


def letterbox(path):
    """The model input, the geometry to undo it, and the photo's size."""
    image = Image.open(path)
    # The photo as the user sees it: full size, after EXIF rotation.
    width, height = image.size
    if image.getexif().get(0x0112, 1) in (5, 6, 7, 8):
        width, height = height, width
    if image.format == "JPEG":
        image.draft("RGB", (SIZE, SIZE))
    image = ImageOps.exif_transpose(image).convert("RGB")

    w, h = image.size
    scale = min(SIZE / w, SIZE / h, 1.0)
    new_w, new_h = max(1, round(w * scale)), max(1, round(h * scale))
    if (new_w, new_h) != (w, h):
        image = image.resize((new_w, new_h), Image.BILINEAR)
    pad_x, pad_y = (SIZE - new_w) / 2, (SIZE - new_h) / 2
    canvas = Image.new("RGB", (SIZE, SIZE), (PAD, PAD, PAD))
    canvas.paste(image, (round(pad_x), round(pad_y)))
    tensor = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None] / np.float32(255)
    # Boxes come back in the decoded image's pixels; the drafted decode is the
    # original divided by a constant, which percentages cancel.
    return tensor, (scale, pad_x, pad_y), (w, h), (width, height)


def detect(session, labels, path):
    tensor, (scale, pad_x, pad_y), (w, h), (width, height) = letterbox(path)
    rows = session.run(None, {"images": tensor})[0][0]
    inv = np.float32(1.0 / scale)
    found = []
    for x1, y1, x2, y2, score, cls in rows:
        if score < np.float32(CONFIDENCE):
            continue
        xs = [float((v - np.float32(pad_x)) * inv) for v in (x1, x2)]
        ys = [float((v - np.float32(pad_y)) * inv) for v in (y1, y2)]
        x1, x2 = (min(max(v, 0.0), w) for v in xs)
        y1, y2 = (min(max(v, 0.0), h) for v in ys)
        if x2 - x1 <= 0 or y2 - y1 <= 0:
            continue
        found.append({
            "label": labels[int(round(float(cls)))],
            "confidence": float(score),
            "x": x1 / w * 100,
            "y": y1 / h * 100,
            "width": (x2 - x1) / w * 100,
            "height": (y2 - y1) / h * 100,
        })
    found.sort(key=lambda d: -d["confidence"])
    return {
        "file": os.path.basename(path),
        "imageWidth": width,
        "imageHeight": height,
        "detections": found,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--loonet", default=os.path.expanduser("~/Documents/loonet"))
    args = parser.parse_args()

    with open(MODEL.replace(".onnx", ".json")) as f:
        info = json.load(f)
    labels = [info["display_labels"].get(c, c) for c in info["classes"]]
    session = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])

    fixtures = sorted(
        os.path.join(FIXTURES, n) for n in os.listdir(FIXTURES) if n.endswith(".jpg")
    )
    split = os.path.join(args.loonet, "data", "annotated", "vegnet_v1", "val.txt")
    with open(split) as f:
        val = [line.strip() for line in f if line.strip()]

    reference = {
        "fixtures": [detect(session, labels, p) for p in fixtures],
        "val": [detect(session, labels, p) for p in val],
    }
    with open(OUTPUT, "w") as f:
        json.dump(reference, f, indent=1)
        f.write("\n")
    for key, entries in reference.items():
        boxes = sum(len(e["detections"]) for e in entries)
        print(f"{key}: {len(entries)} photos, {boxes} boxes")


if __name__ == "__main__":
    main()
