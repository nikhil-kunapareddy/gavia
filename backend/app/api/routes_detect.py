"""The detection endpoint."""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Query, UploadFile

from app.api.deps import get_detector
from app.core.config import settings
from app.core.errors import ImageTooLargeApiError, UnsupportedFormatError
from app.detection import Detector
from app.detection.loader import SUPPORTED_FORMATS, ImageDecodeError
from app.schemas.detection import BoundingBox, Detection, DetectionResult

logger = logging.getLogger(__name__)

router = APIRouter()

ACCEPTED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
CHUNK_SIZE = 1024 * 1024


@router.post("/detect", response_model=DetectionResult, tags=["detection"])
async def detect(
    image: UploadFile = File(...),
    tiling: bool | None = Query(
        default=None,
        description=(
            "Override tiled inference. Off by default: it helps only when birds "
            "are small relative to the frame."
        ),
    ),
    detector: Detector = Depends(get_detector),
) -> DetectionResult:
    """Detect loons in an uploaded photograph.

    Deliberately does **not** persist. The UI lets a reviewer look at a result
    and decide whether it is worth keeping, so writing every check to disk
    would fill a researcher's history with images they had already dismissed.
    ``POST /api/results`` commits one when they choose to.

    The upload is streamed to a temporary file rather than read into memory:
    the cap is 20MB, but a handful of concurrent uploads buffered in RAM is
    exactly the kind of thing that makes a desktop app feel heavy.
    """
    if image.content_type and image.content_type not in ACCEPTED_CONTENT_TYPES:
        raise UnsupportedFormatError(
            f"{image.content_type} is not supported. Upload a JPG, PNG, or WEBP image."
        )

    result_id = uuid.uuid4().hex
    temp_path, file_size = await spool_to_disk(image)

    try:
        # Inference is CPU-bound and blocking; a thread keeps the event loop
        # free to serve the health check and any other request.
        sniff_format(temp_path)
        outcome = await asyncio.to_thread(detector.detect, temp_path, tiling=tiling)

        logger.info(
            "detection complete",
            extra={
                "resultId": result_id,
                "detections": len(outcome.predictions),
                "tiles": outcome.tiles_processed,
                "durationMs": round(outcome.duration_seconds * 1000, 1),
                "pixels": outcome.image_width * outcome.image_height,
            },
        )

        return DetectionResult(
            id=result_id,
            # Nothing is on disk yet, so there is no URL to serve. The client
            # already holds the file and shows its own object URL.
            imageUrl="",
            fileName=image.filename or "upload",
            fileSize=file_size,
            detections=[
                Detection(
                    id=f"{result_id}-{index}",
                    label=prediction.label,
                    confidence=prediction.confidence,
                    boundingBox=BoundingBox(
                        x=prediction.x,
                        y=prediction.y,
                        width=prediction.width,
                        height=prediction.height,
                    ),
                )
                for index, prediction in enumerate(outcome.predictions)
            ],
            processingTime=round(outcome.duration_seconds, 3),
            timestamp=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            imageWidth=outcome.image_width,
            imageHeight=outcome.image_height,
            modelName=detector.info.name,
            tilesProcessed=outcome.tiles_processed,
            saved=False,
        )
    finally:
        temp_path.unlink(missing_ok=True)


async def spool_to_disk(image: UploadFile) -> tuple[Path, int]:
    """Stream the upload to a temp file, refusing anything oversized.

    The limit is enforced as bytes arrive rather than from Content-Length,
    which a client controls and can simply lie about.
    """
    handle, raw_path = tempfile.mkstemp(prefix="gavia-upload-")
    path = Path(raw_path)
    total = 0

    try:
        with os.fdopen(handle, "wb") as out:
            while chunk := await image.read(CHUNK_SIZE):
                total += len(chunk)
                if total > settings.max_upload_bytes:
                    raise ImageTooLargeApiError(
                        "This image is too large. Please choose an image smaller "
                        f"than {settings.max_upload_bytes // (1024 * 1024)} MB."
                    )
                out.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise

    if total == 0:
        path.unlink(missing_ok=True)
        raise UnsupportedFormatError("The uploaded file is empty.")

    return path, total


def sniff_format(path: Path) -> str:
    """Trust the file's own header over the client's content type.

    A filename and a Content-Type are both client-supplied and prove nothing;
    this reads the actual magic bytes.
    """
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(path) as probe:
            image_format = probe.format or ""
    except (UnidentifiedImageError, OSError) as exc:
        # Pillow's own exception would escape as a 500. The file being
        # unreadable is the user's problem to fix, not a server fault.
        raise ImageDecodeError("The file is not a readable image.") from exc

    if image_format not in SUPPORTED_FORMATS:
        raise UnsupportedFormatError(
            f"{image_format or 'This file'} is not a supported image format."
        )
    return image_format
