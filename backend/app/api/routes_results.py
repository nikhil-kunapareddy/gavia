"""Saved history: listing, fetching, deleting, and serving image bytes."""

from __future__ import annotations

import asyncio
import sqlite3

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import ValidationError

from app.api.deps import get_repository
from app.api.routes_detect import spool_to_disk, sniff_format
from app.core.errors import ApiError, NotFoundError
from app.schemas.detection import (
    DeletedResponse,
    DetectionResult,
    SaveRequest,
    result_to_schema,
)
from app.storage.repository import ResultRepository, StoredDetection

router = APIRouter(prefix="/results", tags=["results"])

MEDIA_TYPES = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}

# Stored images never change: the id is unique per upload and the bytes are
# written once. That makes them safe to cache hard, which keeps the history
# grid from re-fetching thumbnails on every render.
IMMUTABLE = "public, max-age=31536000, immutable"


@router.post("", response_model=DetectionResult, status_code=201)
async def save_result(
    image: UploadFile = File(...),
    result: str = Form(..., description="JSON body of the DetectionResult to keep."),
    repository: ResultRepository = Depends(get_repository),
) -> DetectionResult:
    """Commit a result the reviewer chose to keep.

    Takes the detections rather than recomputing them, so that what gets saved
    is exactly what the reviewer looked at when they decided. Re-running
    inference here could quietly store something different if a threshold had
    changed in between.

    The image is re-sent rather than held server-side between the two calls:
    a staging area would need a lifetime, a cleanup job, and a story for what
    happens when the app is killed mid-review. Over loopback the extra copy is
    cheap, and this way nothing outlives a single request.
    """
    try:
        parsed = SaveRequest.model_validate_json(result)
    except ValidationError as exc:
        raise ApiError(
            "INVALID_REQUEST", f"Malformed result payload: {exc.error_count()} problem(s).", 422
        ) from exc

    temp_path, file_size = await spool_to_disk(image)
    try:
        stored = await asyncio.to_thread(
            repository.save,
            result_id=parsed.id,
            file_name=parsed.fileName,
            file_size=file_size,
            source=temp_path,
            image_format=sniff_format(temp_path),
            image_width=parsed.imageWidth,
            image_height=parsed.imageHeight,
            processing_time=parsed.processingTime,
            model_name=parsed.modelName,
            tiles_processed=parsed.tilesProcessed,
            detections=[
                StoredDetection(
                    label=d.label,
                    confidence=d.confidence,
                    x=d.boundingBox.x,
                    y=d.boundingBox.y,
                    width=d.boundingBox.width,
                    height=d.boundingBox.height,
                )
                for d in parsed.detections
            ],
        )
    except sqlite3.IntegrityError as exc:
        # The primary key is the arbiter rather than a prior SELECT: checking
        # first and inserting after leaves a window where two saves of the
        # same result both pass the check.
        raise ApiError(
            "ALREADY_SAVED", "That result is already in the history.", 409
        ) from exc
    finally:
        temp_path.unlink(missing_ok=True)

    return result_to_schema(stored)


@router.get("", response_model=list[DetectionResult])
def list_results(
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    repository: ResultRepository = Depends(get_repository),
) -> list[DetectionResult]:
    return [result_to_schema(row) for row in repository.list(limit=limit, offset=offset)]


@router.get("/{result_id}", response_model=DetectionResult)
def get_result(
    result_id: str, repository: ResultRepository = Depends(get_repository)
) -> DetectionResult:
    stored = repository.get(result_id)
    if stored is None:
        raise NotFoundError("No saved result with that id.")
    return result_to_schema(stored)


@router.get("/{result_id}/image")
def get_image(
    result_id: str, repository: ResultRepository = Depends(get_repository)
) -> Response:
    """The original upload, byte-for-byte as it was received."""
    stored = repository.get(result_id)
    if stored is None:
        raise NotFoundError("No saved result with that id.")

    path = repository.image_path(result_id, stored.image_ext)
    if not path.exists():
        raise NotFoundError("The image for that result is missing from disk.")

    return FileResponse(
        path,
        media_type=MEDIA_TYPES.get(stored.image_ext, "application/octet-stream"),
        headers={"Cache-Control": IMMUTABLE},
    )


@router.get("/{result_id}/thumb")
def get_thumbnail(
    result_id: str, repository: ResultRepository = Depends(get_repository)
) -> Response:
    stored = repository.get(result_id)
    if stored is None:
        raise NotFoundError("No saved result with that id.")

    path = repository.thumb_path(result_id)
    if not path.exists():
        # Thumbnailing is best-effort at save time, so fall back rather than
        # showing the user a broken image.
        return get_image(result_id, repository)

    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": IMMUTABLE})


@router.delete("/{result_id}", response_model=DeletedResponse)
def delete_result(
    result_id: str, repository: ResultRepository = Depends(get_repository)
) -> DeletedResponse:
    if not repository.delete(result_id):
        raise NotFoundError("No saved result with that id.")
    return DeletedResponse(deleted=1)


@router.delete("", response_model=DeletedResponse)
def clear_results(
    repository: ResultRepository = Depends(get_repository),
) -> DeletedResponse:
    return DeletedResponse(deleted=repository.clear())
