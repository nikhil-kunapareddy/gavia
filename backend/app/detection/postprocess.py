"""Turning raw model output into boxes on the original image.

The model emits 8400 candidate boxes per tile in letterboxed coordinates.

    filter by score -> convert to corners -> map back to the original image
    -> merge across tiles -> suppress overlaps -> convert to percentages

Order matters: coordinates are mapped back to the original image *before* NMS
so that duplicate detections of the same bird seen in two overlapping tiles
land on top of each other and can be suppressed.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.detection.preprocess import Tile


@dataclass(frozen=True)
class RawDetection:
    """A box in original-image pixel coordinates."""

    x1: float
    y1: float
    x2: float
    y2: float
    score: float
    class_id: int


def decode(
    output: np.ndarray,
    tile: Tile,
    *,
    confidence_threshold: float,
) -> list[RawDetection]:
    """Decode one tile's output into original-image pixel boxes.

    ``output`` is the model's ``(1, 4 + num_classes, anchors)`` tensor: box
    centre and size stacked above per-class scores. There is no objectness row
    — YOLO11 folds it into the class scores.
    """
    predictions = output[0]  # (4 + nc, anchors)
    num_classes = predictions.shape[0] - 4
    if num_classes < 1:
        raise ValueError(f"model output has no class rows: shape {output.shape}")

    scores = predictions[4:]  # (nc, anchors)
    class_ids = scores.argmax(axis=0)
    best = scores[class_ids, np.arange(scores.shape[1])]

    keep = best >= confidence_threshold
    if not keep.any():
        return []

    boxes = predictions[:4, keep]
    best = best[keep]
    class_ids = class_ids[keep]

    # Centre/size -> corners, still in letterboxed tile pixels.
    cx, cy, w, h = boxes
    half_w, half_h = w / 2.0, h / 2.0
    x1 = cx - half_w
    y1 = cy - half_h
    x2 = cx + half_w
    y2 = cy + half_h

    # Undo letterbox padding and scaling, then shift by the tile's origin.
    inv = 1.0 / tile.scale
    x1 = (x1 - tile.pad_x) * inv + tile.origin_x
    x2 = (x2 - tile.pad_x) * inv + tile.origin_x
    y1 = (y1 - tile.pad_y) * inv + tile.origin_y
    y2 = (y2 - tile.pad_y) * inv + tile.origin_y

    return [
        RawDetection(
            x1=float(a), y1=float(b), x2=float(c), y2=float(d), score=float(s), class_id=int(k)
        )
        for a, b, c, d, s, k in zip(x1, y1, x2, y2, best, class_ids)
    ]


def non_max_suppression(
    detections: list[RawDetection],
    *,
    iou_threshold: float,
    max_detections: int,
) -> list[RawDetection]:
    """Greedy NMS, highest score first.

    Class-agnostic, which is free here (the model has one class) and is the
    behaviour we want if a second class is ever added: two overlapping boxes on
    the same bird are a duplicate regardless of what each is labelled.
    """
    if not detections:
        return []

    order = sorted(range(len(detections)), key=lambda i: detections[i].score, reverse=True)
    boxes = np.array([[d.x1, d.y1, d.x2, d.y2] for d in detections], dtype=np.float64)
    areas = (boxes[:, 2] - boxes[:, 0]).clip(min=0) * (boxes[:, 3] - boxes[:, 1]).clip(min=0)

    kept: list[int] = []
    remaining = np.array(order)

    while remaining.size and len(kept) < max_detections:
        current, remaining = int(remaining[0]), remaining[1:]
        kept.append(current)
        if not remaining.size:
            break

        # Intersection of the winner against every survivor at once.
        xx1 = np.maximum(boxes[current, 0], boxes[remaining, 0])
        yy1 = np.maximum(boxes[current, 1], boxes[remaining, 1])
        xx2 = np.minimum(boxes[current, 2], boxes[remaining, 2])
        yy2 = np.minimum(boxes[current, 3], boxes[remaining, 3])

        overlap = (xx2 - xx1).clip(min=0) * (yy2 - yy1).clip(min=0)
        union = areas[current] + areas[remaining] - overlap
        # Zero-area boxes would divide by zero; they cannot overlap anything.
        iou = np.divide(overlap, union, out=np.zeros_like(overlap), where=union > 0)

        remaining = remaining[iou <= iou_threshold]

    return [detections[i] for i in kept]


def clamp_to_image(
    detections: list[RawDetection], width: int, height: int
) -> list[RawDetection]:
    """Trim boxes to the image and drop any that collapse to nothing.

    Boxes can extend past the edge legitimately — the model will happily
    predict the full extent of a bird half out of frame — but a box drawn
    outside the image is meaningless to the reviewer.
    """
    clamped: list[RawDetection] = []

    for d in detections:
        x1 = min(max(d.x1, 0.0), width)
        y1 = min(max(d.y1, 0.0), height)
        x2 = min(max(d.x2, 0.0), width)
        y2 = min(max(d.y2, 0.0), height)
        if x2 - x1 <= 0 or y2 - y1 <= 0:
            continue
        clamped.append(
            RawDetection(x1=x1, y1=y1, x2=x2, y2=y2, score=d.score, class_id=d.class_id)
        )

    return clamped


def to_percentages(
    detection: RawDetection, width: int, height: int
) -> tuple[float, float, float, float]:
    """Pixel corners -> ``(x, y, width, height)`` as percentages of the image.

    The frontend overlays boxes with CSS percentage offsets, so the API speaks
    percentages and stays independent of how large the image is displayed.
    """
    return (
        detection.x1 / width * 100.0,
        detection.y1 / height * 100.0,
        (detection.x2 - detection.x1) / width * 100.0,
        (detection.y2 - detection.y1) / height * 100.0,
    )
