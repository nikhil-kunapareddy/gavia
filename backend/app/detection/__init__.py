"""Loon detection: image decoding, tiling, ONNX inference, and box postprocessing."""

from app.detection.detector import (
    Detector,
    DetectionOutcome,
    ModelInfo,
    ModelUnavailableError,
    Prediction,
)
from app.detection.loader import ImageDecodeError, ImageTooLargeError

__all__ = [
    "Detector",
    "DetectionOutcome",
    "ImageDecodeError",
    "ImageTooLargeError",
    "ModelInfo",
    "ModelUnavailableError",
    "Prediction",
]
