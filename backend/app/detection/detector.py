"""The ONNX Runtime detector: one session, loaded once, reused for every request."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

from app.detection import postprocess
from app.detection.loader import open_image, read_dimensions
from app.detection.preprocess import TilePlan, iter_tiles, plan_tiles

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ModelInfo:
    """What ``models/<name>.json`` says about the loaded weights."""

    name: str
    architecture: str
    classes: list[str]
    display_labels: dict[str, str]
    input_size: int
    confidence_threshold: float
    iou_threshold: float
    max_detections: int
    metrics: dict[str, float]
    sha256: str

    def label_for(self, class_id: int) -> str:
        """Human-facing label, e.g. ``common loon`` -> ``Loon``."""
        if not 0 <= class_id < len(self.classes):
            return "Unknown"
        raw = self.classes[class_id]
        return self.display_labels.get(raw, raw)


@dataclass(frozen=True)
class Prediction:
    """One detected object, in the coordinate system the frontend draws in."""

    label: str
    confidence: float
    x: float
    y: float
    width: float
    height: float
    """Percentages of the source image, 0-100."""


@dataclass(frozen=True)
class DetectionOutcome:
    predictions: list[Prediction]
    image_width: int
    image_height: int
    """Dimensions of the source image as the user supplied it, after EXIF
    rotation — not of whatever reduced-scale decode was used internally."""

    tiles_processed: int
    duration_seconds: float


class ModelUnavailableError(Exception):
    """The model file is missing or could not be loaded."""


class Detector:
    """Wraps an ONNX Runtime session with the pre/post-processing it needs.

    One session serves the whole process. Inference is serialised behind a lock:
    on a single-user desktop app there is no throughput to gain from parallel
    runs, and serialising means peak memory is one tile's worth no matter how
    many requests pile up.

    ``tiling_enabled`` defaults to **off**, which is a measured decision rather
    than a cautious one. Tiling exists for small-object imagery: a 40px bird in
    a 6000px drone frame survives a 640px tile and does not survive a whole-image
    resize. But on the loonnet_v1 photographs 64% of labelled loons are *larger*
    than a 640px tile (median longest side 1077px, 41% of the frame), so tiles
    see fragments of a bird rather than a bird, and precision collapses:

        single pass    P 0.906  R 0.879  AP@0.5 0.892
        tiled          P 0.074  R 0.364  AP@0.5 0.231
        tiled + full   P 0.154  R 0.849  AP@0.5 0.629

    Turn it on for genuine top-down drone frames where birds are small in
    pixels, and re-run scripts/evaluate.py to confirm it helps that data.
    """

    def __init__(
        self,
        model_path: Path,
        *,
        intra_op_threads: int | None = None,
        tiling_enabled: bool = False,
        tile_threshold: float = 1.5,
        tile_overlap: float = 0.2,
        max_tiles: int = 64,
    ) -> None:
        self._model_path = model_path
        self._info = _load_model_info(model_path)
        self._tiling_enabled = tiling_enabled
        self._tile_threshold = tile_threshold
        self._tile_overlap = tile_overlap
        self._max_tiles = max_tiles
        self._lock = threading.Lock()
        self._session = self._create_session(intra_op_threads)
        self._warm_up()

    @property
    def info(self) -> ModelInfo:
        return self._info

    @property
    def provider(self) -> str:
        return self._session.get_providers()[0]

    def _create_session(self, intra_op_threads: int | None) -> ort.InferenceSession:
        if not self._model_path.exists():
            raise ModelUnavailableError(f"Model file not found: {self._model_path}")

        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        # Serialised inference means the parallel executor buys nothing and
        # costs thread pools we would rather not hold open on a laptop.
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.intra_op_num_threads = intra_op_threads or _default_thread_count()
        options.inter_op_num_threads = 1
        # Keeps arena growth bounded across the many small runs that tiling
        # produces, rather than letting the allocator ratchet up and hold on.
        options.enable_mem_pattern = True

        try:
            session = ort.InferenceSession(
                str(self._model_path),
                sess_options=options,
                providers=["CPUExecutionProvider"],
            )
        except Exception as exc:  # onnxruntime raises bare RuntimeError subclasses
            raise ModelUnavailableError(f"Could not load model: {exc}") from exc

        inputs = session.get_inputs()
        if len(inputs) != 1:
            raise ModelUnavailableError(
                f"Expected a single model input, found {len(inputs)}."
            )
        self._input_name = inputs[0].name
        return session

    def _warm_up(self) -> None:
        """Run one throwaway inference so the first real request is not slow.

        ORT defers a good deal of allocation and kernel selection to the first
        run — on this model that is roughly a second, which the user would
        otherwise pay while staring at a spinner.
        """
        size = self._info.input_size
        blank = np.zeros((1, 3, size, size), dtype=np.float32)
        started = time.perf_counter()
        self._session.run(None, {self._input_name: blank})
        logger.info(
            "model warmed up",
            extra={"model": self._info.name, "seconds": round(time.perf_counter() - started, 3)},
        )

    def detect(
        self,
        source: Path | bytes,
        *,
        confidence_threshold: float | None = None,
        iou_threshold: float | None = None,
        tiling: bool | None = None,
    ) -> DetectionOutcome:
        """Find every loon in one image.

        Blocking and CPU-bound; call it from a worker thread, not the event loop.

        ``tiling`` defaults to the detector's configured setting, which is off.
        See the note on ``tiling_enabled`` before turning it on for a dataset.
        """
        conf = self._info.confidence_threshold if confidence_threshold is None else confidence_threshold
        iou = self._info.iou_threshold if iou_threshold is None else iou_threshold
        tile = self._tiling_enabled if tiling is None else tiling
        size = self._info.input_size

        started = time.perf_counter()

        # Planning from header dimensions decides the decode strategy: a small
        # image can be drafted down during decode, but a tiled one needs every
        # pixel it has.
        original_width, original_height = read_dimensions(source)
        plan = self._plan(original_width, original_height, size, tile)

        image = open_image(source, target_size=None if plan.is_tiled else size)
        try:
            # Drafting may hand back something smaller than the header promised.
            # Coordinate maths must use the decoded size, but everything we
            # report describes the image the user actually uploaded — the two
            # differ by a constant factor, which percentages divide out.
            width, height = image.size
            if not plan.is_tiled:
                plan = self._plan(width, height, size, tile)

            detections = self._run_tiles(image, plan, size, conf)
        finally:
            image.close()

        detections = postprocess.non_max_suppression(
            detections, iou_threshold=iou, max_detections=self._info.max_detections
        )
        detections = postprocess.clamp_to_image(detections, width, height)
        detections.sort(key=lambda d: d.score, reverse=True)

        predictions = []
        for d in detections:
            x, y, w, h = postprocess.to_percentages(d, width, height)
            predictions.append(
                Prediction(
                    label=self._info.label_for(d.class_id),
                    confidence=d.score,
                    x=x,
                    y=y,
                    width=w,
                    height=h,
                )
            )

        return DetectionOutcome(
            predictions=predictions,
            image_width=original_width,
            image_height=original_height,
            tiles_processed=len(plan.tiles),
            duration_seconds=time.perf_counter() - started,
        )

    def _plan(self, width: int, height: int, size: int, tiling: bool) -> TilePlan:
        return plan_tiles(
            width,
            height,
            model_size=size,
            tile_threshold=self._tile_threshold,
            overlap=self._tile_overlap,
            max_tiles=self._max_tiles,
            enabled=tiling,
        )

    def _run_tiles(
        self,
        image: Image.Image,
        plan: TilePlan,
        size: int,
        confidence_threshold: float,
    ) -> list[postprocess.RawDetection]:
        found: list[postprocess.RawDetection] = []

        # Held across the whole image so the shared tile buffer cannot be
        # overwritten by another request mid-iteration.
        with self._lock:
            for tile in iter_tiles(image, plan, model_size=size):
                output = self._session.run(None, {self._input_name: tile.array})[0]
                found.extend(
                    postprocess.decode(output, tile, confidence_threshold=confidence_threshold)
                )

        return found


def _load_model_info(model_path: Path) -> ModelInfo:
    """Read the sidecar JSON that describes the weights.

    Keeping thresholds and class names beside the model rather than in code
    means swapping in a retrained model is a two-file drop-in.
    """
    metadata_path = model_path.with_suffix(".json")
    if not metadata_path.exists():
        raise ModelUnavailableError(f"Model metadata not found: {metadata_path}")

    try:
        raw = json.loads(metadata_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ModelUnavailableError(f"Model metadata is not valid JSON: {exc}") from exc

    try:
        defaults = raw["defaults"]
        return ModelInfo(
            name=raw["name"],
            architecture=raw.get("architecture", "unknown"),
            classes=list(raw["classes"]),
            display_labels=dict(raw.get("display_labels", {})),
            input_size=int(raw["input"]["shape"][2]),
            confidence_threshold=float(defaults["confidence_threshold"]),
            iou_threshold=float(defaults["iou_threshold"]),
            max_detections=int(defaults["max_detections"]),
            metrics={
                k: v for k, v in raw.get("metrics", {}).items() if isinstance(v, (int, float))
            },
            sha256=raw.get("sha256", ""),
        )
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise ModelUnavailableError(f"Model metadata is missing {exc}") from exc


def _default_thread_count() -> int:
    """Performance cores, roughly, leaving the machine usable.

    ``sched_getaffinity`` is Linux-only; ``cpu_count`` on Apple silicon counts
    efficiency cores too, which slow a compute-bound graph down rather than up.
    """
    total = os.cpu_count() or 4
    return max(1, min(total - 2, 8)) if total > 4 else max(1, total - 1)
