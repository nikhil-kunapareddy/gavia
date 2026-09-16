"""Decoding user-supplied photographs safely and cheaply."""

from __future__ import annotations

import io
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

# A 24MP photo is ~24e6 pixels; this leaves generous headroom for panoramas
# while still refusing a decompression bomb that would claim to be 2 gigapixels.
MAX_PIXELS = 120_000_000

SUPPORTED_FORMATS = {"JPEG", "PNG", "WEBP", "MPO"}
"""Matches what the frontend uploader accepts.

MPO is in the list because it is not really a separate format: it is a JPEG
carrying extra frames, produced by plenty of phones and cameras (7% of the
training set). Pillow reports it distinctly and opens frame 0 — the full-size
primary image — which is exactly what we want.
"""


class ImageDecodeError(Exception):
    """The bytes could not be read as a supported image."""


class ImageTooLargeError(Exception):
    """The image's pixel count exceeds what we are willing to decode."""


def open_image(source: Path | bytes, *, target_size: int | None = None) -> Image.Image:
    """Decode an image, applying EXIF rotation and normalising to RGB.

    ``target_size`` is a hint, not a resize: for JPEGs it enables Pillow's
    ``draft`` mode, which decodes the file directly at 1/2, 1/4 or 1/8 scale
    inside libjpeg. A 24MP photo destined for a 640px pass never has to exist
    at full size in memory at all. Pass ``None`` when tiling, where full
    resolution is the entire point.

    The image is returned open; callers own closing it.
    """
    handle = io.BytesIO(source) if isinstance(source, bytes) else source

    try:
        image = Image.open(handle)
    except UnidentifiedImageError as exc:
        raise ImageDecodeError("The file is not a readable image.") from exc
    except OSError as exc:
        raise ImageDecodeError(f"The image could not be opened: {exc}") from exc

    try:
        if image.format not in SUPPORTED_FORMATS:
            raise ImageDecodeError(
                f"Unsupported image format {image.format or 'unknown'}. "
                "Use JPEG, PNG, or WEBP."
            )

        # Checked before any pixels are decoded — the point is to refuse the
        # allocation, not to survive it.
        pixels = image.width * image.height
        if pixels > MAX_PIXELS:
            raise ImageTooLargeError(
                f"Image is {pixels / 1e6:.0f} megapixels; the limit is "
                f"{MAX_PIXELS / 1e6:.0f}."
            )

        if target_size is not None:
            image.draft("RGB", (target_size, target_size))

        # exif_transpose returns a new image and does the decode; everything
        # above this line was header inspection only.
        rotated = ImageOps.exif_transpose(image)
        if rotated is not image:
            image.close()
            image = rotated

        if image.mode != "RGB":
            converted = image.convert("RGB")
            image.close()
            image = converted

        return image
    except (ImageDecodeError, ImageTooLargeError):
        image.close()
        raise
    except OSError as exc:
        image.close()
        raise ImageDecodeError(f"The image could not be decoded: {exc}") from exc


_EXIF_ORIENTATION = 0x0112
_ORIENTATIONS_THAT_SWAP_AXES = {5, 6, 7, 8}


def read_dimensions(source: Path | bytes) -> tuple[int, int]:
    """Post-rotation dimensions from the header alone, decoding no pixels.

    Used to choose between a drafted single pass and full-resolution tiling,
    a decision that has to be made *before* committing to a decode strategy.
    Orientation is applied by hand rather than via ``exif_transpose``, which
    would load the whole image just to tell us its shape.
    """
    handle = io.BytesIO(source) if isinstance(source, bytes) else source
    try:
        with Image.open(handle) as image:
            width, height = image.size
            try:
                orientation = (image.getexif() or {}).get(_EXIF_ORIENTATION)
            except Exception:  # noqa: BLE001 - malformed EXIF must not be fatal
                orientation = None
            if orientation in _ORIENTATIONS_THAT_SWAP_AXES:
                width, height = height, width
            return width, height
    except (UnidentifiedImageError, OSError) as exc:
        raise ImageDecodeError(f"The image could not be read: {exc}") from exc
