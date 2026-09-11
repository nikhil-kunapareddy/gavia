"""Response models.

Field names are camelCase to match the TypeScript interfaces in
``frontend/src/types/detection.ts`` exactly — the frontend consumes these
without a mapping layer, so the two definitions have to agree.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from app.storage.repository import StoredResult


class BoundingBox(BaseModel):
    """Position and size as percentages of the image, 0-100.

    Percentages rather than pixels so the overlay does not care what size the
    image is rendered at, and a result stays correct if it is later displayed
    from a thumbnail.
    """

    x: float
    y: float
    width: float
    height: float


class Detection(BaseModel):
    id: str
    label: str
    confidence: float = Field(ge=0.0, le=1.0)
    boundingBox: BoundingBox  # noqa: N815 - matches the TypeScript interface


class DetectionResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    imageUrl: str  # noqa: N815
    fileName: str  # noqa: N815
    fileSize: int  # noqa: N815
    detections: list[Detection]
    processingTime: float  # noqa: N815
    timestamp: str

    # Additions beyond the original client-side type. The frontend ignores
    # what it does not use, so these are safe to send.
    imageWidth: int  # noqa: N815
    imageHeight: int  # noqa: N815
    modelName: str  # noqa: N815
    tilesProcessed: int  # noqa: N815
    saved: bool = False


class SaveRequest(BaseModel):
    """The client's copy of a result, handed back to be committed.

    A subset of DetectionResult: the fields that describe the check, without
    the ones the server owns (``imageUrl``, ``saved``, ``timestamp``).
    """

    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    """Constrained because it becomes a filename. Rejecting anything with a
    path separator or a dot here is what keeps ``images/<id>.jpg`` inside the
    data directory."""

    fileName: str = Field(min_length=1, max_length=512)  # noqa: N815
    detections: list[Detection] = Field(max_length=1000)
    processingTime: float = Field(ge=0)  # noqa: N815
    imageWidth: int = Field(gt=0)  # noqa: N815
    imageHeight: int = Field(gt=0)  # noqa: N815
    modelName: str = Field(min_length=1, max_length=128)  # noqa: N815
    tilesProcessed: int = Field(ge=1)  # noqa: N815


class ModelResponse(BaseModel):
    name: str
    architecture: str
    classes: list[str]
    inputSize: int  # noqa: N815
    confidenceThreshold: float  # noqa: N815
    iouThreshold: float  # noqa: N815
    tilingEnabled: bool  # noqa: N815
    provider: str
    metrics: dict[str, float]
    sha256: str


class DeletedResponse(BaseModel):
    deleted: int


def result_to_schema(stored: StoredResult, *, saved: bool = True) -> DetectionResult:
    """Adapt a stored row into the wire format."""
    return DetectionResult(
        id=stored.id,
        imageUrl=f"/api/results/{stored.id}/image",
        fileName=stored.file_name,
        fileSize=stored.file_size,
        detections=[
            Detection(
                # Stable and derived from position, so re-fetching a result
                # gives the same ids and React keys stay put.
                id=f"{stored.id}-{index}",
                label=detection.label,
                confidence=detection.confidence,
                boundingBox=BoundingBox(
                    x=detection.x,
                    y=detection.y,
                    width=detection.width,
                    height=detection.height,
                ),
            )
            for index, detection in enumerate(stored.detections)
        ],
        processingTime=stored.processing_time,
        timestamp=stored.created_at,
        imageWidth=stored.image_width,
        imageHeight=stored.image_height,
        modelName=stored.model_name,
        tilesProcessed=stored.tiles_processed,
        saved=saved,
    )
