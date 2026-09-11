"""Turning an arbitrary photograph into 640x640 model inputs.

Two things happen here, and both have to be exactly reversible so detections can
be mapped back onto the original image:

* **Letterboxing** scales an image to fit 640x640 without distorting it and pads
  the leftover space. The scale and pad offsets travel with the tile so
  postprocessing can undo them.
* **Tiling** splits an image that is large relative to the model's 640px input
  into overlapping windows. A loon 40px across in a 6000px-wide drone frame is
  ~4px after a whole-image resize and is simply gone; the same bird inside a
  640px tile is still 40px.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

import numpy as np
from PIL import Image

PAD_VALUE = 114
"""Grey fill for letterbox padding. Matches Ultralytics, so the model sees the
same border statistics at inference that it saw during training."""


@dataclass(frozen=True)
class Tile:
    """One model input, plus everything needed to map its boxes back.

    A detection at (x, y) in the letterboxed tile lands at
    ``(x - pad_x) / scale + origin_x`` in the original image.
    """

    array: np.ndarray
    """float32 NCHW batch of 1, RGB, values in [0, 1]."""

    origin_x: int
    origin_y: int
    """Top-left of this tile's crop within the original image, in pixels."""

    scale: float
    """Factor the crop was multiplied by to fit the model input."""

    pad_x: float
    pad_y: float
    """Letterbox padding applied to the scaled crop, in model-input pixels."""


@dataclass(frozen=True)
class TilePlan:
    """How an image of a given size will be broken up."""

    tiles: list[tuple[int, int, int, int]]
    """Crop boxes as (left, top, right, bottom) in original-image pixels."""

    tile_size: int
    """Side length of each crop before scaling. Equals the model input size
    unless the image was big enough that we had to grow tiles to stay under the
    tile budget."""

    @property
    def is_tiled(self) -> bool:
        return len(self.tiles) > 1


def plan_tiles(
    width: int,
    height: int,
    *,
    model_size: int = 640,
    tile_threshold: float = 1.5,
    overlap: float = 0.2,
    max_tiles: int = 64,
    enabled: bool = True,
) -> TilePlan:
    """Decide whether to tile, and where the tiles go.

    Small images get a single whole-image pass — tiling a 900px phone photo
    costs time and finds nothing extra. Above ``tile_threshold * model_size``
    the downscale starts destroying small birds, so we switch to overlapping
    windows.

    ``max_tiles`` is a wall-clock guard. Rather than refuse a 100MP panorama, we
    grow the tile size until the grid fits the budget: detail degrades
    gracefully instead of the request hanging.

    ``enabled=False`` forces the single-pass path. That is what the parity
    script uses to compare like with like against Ultralytics, which has no
    tiling of its own.
    """
    if width <= 0 or height <= 0:
        raise ValueError(f"image dimensions must be positive, got {width}x{height}")

    limit = model_size * tile_threshold
    if not enabled or (width <= limit and height <= limit):
        return TilePlan(tiles=[(0, 0, width, height)], tile_size=max(width, height))

    tile_size = model_size
    while True:
        stride = max(1, int(tile_size * (1.0 - overlap)))
        xs = _window_starts(width, tile_size, stride)
        ys = _window_starts(height, tile_size, stride)
        if len(xs) * len(ys) <= max_tiles:
            break
        # Grow tiles rather than drop coverage. Each step roughly halves the count.
        tile_size = int(tile_size * 1.5)

    tiles = [
        (x, y, min(x + tile_size, width), min(y + tile_size, height)) for y in ys for x in xs
    ]
    return TilePlan(tiles=tiles, tile_size=tile_size)


def _window_starts(extent: int, window: int, stride: int) -> list[int]:
    """Window offsets covering ``extent``, with the last one flush to the edge.

    Snapping the final window back instead of letting it hang past the edge
    keeps every tile full-sized, so the model never sees a sliver of image
    surrounded by padding.
    """
    if extent <= window:
        return [0]

    starts = list(range(0, extent - window + 1, stride))
    last = extent - window
    if starts[-1] != last:
        starts.append(last)
    return starts


def letterbox(
    image: Image.Image,
    *,
    model_size: int = 640,
    out: np.ndarray | None = None,
) -> tuple[np.ndarray, float, float, float]:
    """Fit ``image`` into a square model input without distorting it.

    Returns the NCHW batch alongside the ``(scale, pad_x, pad_y)`` needed to
    invert the transform.

    ``out`` lets a caller supply a buffer to fill instead of allocating a fresh
    4.9MB array per tile. Tiled inference reuses one buffer for the whole image,
    which is what keeps peak memory flat regardless of tile count.
    """
    scale = min(model_size / image.width, model_size / image.height)
    # Never upscale: feeding the model an interpolated 200px crop blown up to
    # 640 invents detail and costs accuracy.
    scale = min(scale, 1.0)

    new_w = max(1, round(image.width * scale))
    new_h = max(1, round(image.height * scale))
    pad_x = (model_size - new_w) / 2
    pad_y = (model_size - new_h) / 2

    resized = image if (new_w, new_h) == image.size else image.resize(
        (new_w, new_h), Image.Resampling.BILINEAR
    )

    if out is None:
        out = np.empty((1, 3, model_size, model_size), dtype=np.float32)
    out.fill(PAD_VALUE / 255.0)

    # HWC uint8 -> CHW float32 in [0, 1], written straight into the padded slot.
    patch = np.asarray(resized, dtype=np.uint8)
    top, left = int(round(pad_y)), int(round(pad_x))
    np.copyto(
        out[0, :, top : top + new_h, left : left + new_w],
        patch.transpose(2, 0, 1),
        casting="unsafe",
    )
    out[0, :, top : top + new_h, left : left + new_w] /= 255.0

    if resized is not image:
        resized.close()

    return out, scale, pad_x, pad_y


def iter_tiles(
    image: Image.Image,
    plan: TilePlan,
    *,
    model_size: int = 640,
) -> Iterator[Tile]:
    """Yield model inputs one at a time, reusing a single input buffer.

    Generator rather than list on purpose: a 24MP frame is ~35 tiles, and
    materialising all of them as float32 arrays would be ~170MB for no reason.
    Because the buffer is shared, a consumer must finish with each tile before
    requesting the next — which is exactly how sequential inference works.
    """
    buffer = np.empty((1, 3, model_size, model_size), dtype=np.float32)

    for left, top, right, bottom in plan.tiles:
        crop = image.crop((left, top, right, bottom))
        try:
            array, scale, pad_x, pad_y = letterbox(crop, model_size=model_size, out=buffer)
            yield Tile(
                array=array,
                origin_x=left,
                origin_y=top,
                scale=scale,
                pad_x=pad_x,
                pad_y=pad_y,
            )
        finally:
            crop.close()
