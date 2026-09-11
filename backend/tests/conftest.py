"""Test fixtures.

Most API tests run against a stub detector. Loading the real 36MB ONNX graph
takes ~0.4s per session and tests nothing about the HTTP layer; the tests that
genuinely need the model are marked ``slow`` and opt in.
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.core.config import Settings
from app.detection.detector import DetectionOutcome, ModelInfo, Prediction
from app.main import create_app

MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "loon_v1.onnx"


class StubDetector:
    """Stands in for the real detector, returning whatever it is told to."""

    def __init__(self, predictions: list[Prediction] | None = None) -> None:
        self.predictions = predictions if predictions is not None else []
        self.calls: list[dict] = []
        self.info = ModelInfo(
            name="stub",
            architecture="stub",
            classes=["common loon"],
            display_labels={"common loon": "Loon"},
            input_size=640,
            confidence_threshold=0.25,
            iou_threshold=0.45,
            max_detections=300,
            metrics={"mAP50": 0.89},
            sha256="0" * 64,
        )
        self.provider = "StubExecutionProvider"

    def detect(self, source, *, confidence_threshold=None, iou_threshold=None, tiling=None):
        self.calls.append({"source": source, "tiling": tiling})
        with Image.open(source) as image:
            width, height = image.size
        return DetectionOutcome(
            predictions=list(self.predictions),
            image_width=width,
            image_height=height,
            tiles_processed=1,
            duration_seconds=0.05,
        )


@pytest.fixture
def prediction() -> Prediction:
    return Prediction(label="Loon", confidence=0.94, x=10.0, y=20.0, width=30.0, height=40.0)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "gavia", model_path=MODEL_PATH)


@pytest.fixture
def detector() -> StubDetector:
    return StubDetector()


@pytest.fixture
def client(settings: Settings, detector: StubDetector):
    app = create_app(settings)
    with TestClient(app) as test_client:
        # Replace after startup so lifespan has already built real storage.
        app.state.detector = detector
        yield test_client


def make_image(
    width: int = 800, height: int = 600, fmt: str = "JPEG", colour=(40, 90, 110)
) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(buffer, fmt)
    return buffer.getvalue()


def upload(content: bytes, name: str = "loon.jpg", content_type: str = "image/jpeg"):
    return {"image": (name, content, content_type)}
