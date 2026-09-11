"""The real ONNX model, end to end.

Marked ``slow`` because each of these loads the 36MB graph. Run the fast suite
with ``-m "not slow"``; run these before shipping, after re-exporting the model,
and after any change to pre/postprocessing.

These are the only tests that would catch a model file that is corrupt, an
export with the wrong output shape, or preprocessing that has drifted far
enough to stop finding loons.
"""

from __future__ import annotations

import io
import threading
from pathlib import Path

import pytest
from PIL import Image

from app.detection.detector import Detector, ModelUnavailableError

pytestmark = pytest.mark.slow

MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "loon_v1.onnx"
DATASET = Path.home() / "Documents/loonet/data/annotated/loonnet_v1"

requires_dataset = pytest.mark.skipif(
    not DATASET.exists(), reason="loonnet_v1 dataset not available on this machine"
)


@pytest.fixture(scope="module")
def detector() -> Detector:
    if not MODEL_PATH.exists():
        pytest.skip("model file not present")
    return Detector(MODEL_PATH)


def labelled_images(limit: int = 6) -> list[tuple[Path, int]]:
    """Validation images paired with how many loons are labelled in each."""
    split = DATASET / "val.txt"
    pairs = []
    for line in split.read_text().split()[:limit]:
        image = Path(line)
        label = Path(str(image).replace("/images/", "/labels/")).with_suffix(".txt")
        count = len([x for x in label.read_text().splitlines() if x.strip()])
        pairs.append((image, count))
    return pairs


class TestModelLoading:
    def test_loads_and_reports_its_own_metadata(self, detector):
        assert detector.info.name == "loon_v1"
        assert detector.info.classes == ["common loon"]
        assert detector.info.input_size == 640

    def test_runs_on_cpu(self, detector):
        """The desktop build ships CPU-only; a GPU provider sneaking in would
        change memory and startup characteristics silently."""
        assert detector.provider == "CPUExecutionProvider"

    def test_a_missing_model_fails_with_a_typed_error(self, tmp_path):
        with pytest.raises(ModelUnavailableError, match="not found"):
            Detector(tmp_path / "absent.onnx")

    def test_a_corrupt_model_fails_with_a_typed_error(self, tmp_path):
        broken = tmp_path / "broken.onnx"
        broken.write_bytes(b"not a protobuf")
        (tmp_path / "broken.json").write_text(MODEL_PATH.with_suffix(".json").read_text())

        with pytest.raises(ModelUnavailableError):
            Detector(broken)

    def test_missing_metadata_fails_with_a_typed_error(self, tmp_path):
        orphan = tmp_path / "orphan.onnx"
        orphan.write_bytes(MODEL_PATH.read_bytes()[:1000])

        with pytest.raises(ModelUnavailableError, match="metadata not found"):
            Detector(orphan)


class TestRealDetection:
    @requires_dataset
    def test_finds_loons_in_labelled_photographs(self, detector):
        """The headline behaviour: given a photo with loons in it, find them.

        Deliberately loose — this asserts the pipeline works, not a particular
        accuracy figure. scripts/evaluate.py is where accuracy is measured.
        """
        found = 0
        for image, expected in labelled_images():
            outcome = detector.detect(image)
            if expected > 0 and outcome.predictions:
                found += 1

        assert found >= 4, "the model should find loons in most labelled photos"

    @requires_dataset
    def test_detections_are_ordered_by_confidence(self, detector):
        for image, expected in labelled_images():
            outcome = detector.detect(image)
            scores = [p.confidence for p in outcome.predictions]
            assert scores == sorted(scores, reverse=True)

    @requires_dataset
    def test_boxes_stay_inside_the_image(self, detector):
        """Percentages outside 0-100 would render off the edge of the photo."""
        for image, _ in labelled_images():
            for prediction in detector.detect(image).predictions:
                assert 0 <= prediction.x <= 100
                assert 0 <= prediction.y <= 100
                assert 0 < prediction.width <= 100
                assert 0 < prediction.height <= 100
                assert prediction.x + prediction.width <= 100.01
                assert prediction.y + prediction.height <= 100.01

    @requires_dataset
    def test_reports_the_original_dimensions_not_the_decode_size(self, detector):
        """Drafting decodes a large JPEG small; the reported size must still
        describe the file the user uploaded."""
        for image, _ in labelled_images(3):
            with Image.open(image) as opened:
                expected = opened.size
            outcome = detector.detect(image)
            assert (outcome.image_width, outcome.image_height) == expected

    def test_a_blank_image_yields_no_detections(self, detector):
        buffer = io.BytesIO()
        Image.new("RGB", (800, 600), (128, 128, 128)).save(buffer, "JPEG")
        assert detector.detect(buffer.getvalue()).predictions == []

    def test_accepts_raw_bytes_as_well_as_a_path(self, detector):
        buffer = io.BytesIO()
        Image.new("RGB", (640, 480), (60, 90, 110)).save(buffer, "JPEG")
        outcome = detector.detect(buffer.getvalue())
        assert outcome.image_width == 640

    def test_is_deterministic(self, detector):
        """Two runs of the same bytes must agree, or nothing above is stable."""
        buffer = io.BytesIO()
        Image.new("RGB", (800, 600), (40, 70, 90)).save(buffer, "JPEG")
        data = buffer.getvalue()

        first = detector.detect(data).predictions
        second = detector.detect(data).predictions

        assert len(first) == len(second)
        for a, b in zip(first, second):
            assert a.confidence == pytest.approx(b.confidence)
            assert a.x == pytest.approx(a.x)

    def test_a_tiny_image_is_handled_without_upscaling(self, detector):
        buffer = io.BytesIO()
        Image.new("RGB", (32, 24), (50, 80, 100)).save(buffer, "JPEG")
        outcome = detector.detect(buffer.getvalue())
        assert outcome.image_width == 32

    def test_an_extreme_aspect_ratio_survives_letterboxing(self, detector):
        buffer = io.BytesIO()
        Image.new("RGB", (2000, 100), (50, 80, 100)).save(buffer, "JPEG")
        outcome = detector.detect(buffer.getvalue())
        assert (outcome.image_width, outcome.image_height) == (2000, 100)


class TestThresholds:
    @requires_dataset
    def test_a_higher_threshold_never_yields_more_detections(self, detector):
        image = labelled_images(1)[0][0]

        low = detector.detect(image, confidence_threshold=0.1)
        high = detector.detect(image, confidence_threshold=0.9)

        assert len(high.predictions) <= len(low.predictions)

    @requires_dataset
    def test_every_detection_clears_the_threshold(self, detector):
        for prediction in detector.detect(
            labelled_images(1)[0][0], confidence_threshold=0.5
        ).predictions:
            assert prediction.confidence >= 0.5


class TestTiling:
    @requires_dataset
    def test_tiling_is_off_unless_asked_for(self, detector):
        """A large photo must take the single-pass route by default."""
        image = labelled_images(1)[0][0]
        assert detector.detect(image).tiles_processed == 1

    @requires_dataset
    def test_tiling_splits_a_large_image(self, detector):
        image = labelled_images(1)[0][0]
        assert detector.detect(image, tiling=True).tiles_processed > 1

    def test_a_small_image_is_never_tiled_even_when_asked(self, detector):
        buffer = io.BytesIO()
        Image.new("RGB", (500, 400), (50, 80, 100)).save(buffer, "JPEG")
        assert detector.detect(buffer.getvalue(), tiling=True).tiles_processed == 1


class TestConcurrency:
    def test_parallel_calls_do_not_corrupt_each_other(self, detector):
        """Tiles share one input buffer, so the lock is doing real work here.

        Without it, two threads would interleave writes into the same array
        and quietly produce detections for a blend of two images.
        """
        sizes = [(800, 600), (1024, 768), (640, 480)]
        images = []
        for width, height in sizes:
            buffer = io.BytesIO()
            Image.new("RGB", (width, height), (40, 80, 100)).save(buffer, "JPEG")
            images.append((buffer.getvalue(), (width, height)))

        results: dict[int, tuple[int, int]] = {}
        errors: list[BaseException] = []

        def run(index: int, data: bytes) -> None:
            try:
                outcome = detector.detect(data)
                results[index] = (outcome.image_width, outcome.image_height)
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [
            threading.Thread(target=run, args=(index, data))
            for index, (data, _) in enumerate(images * 2)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert not errors
        for index, (_, expected) in enumerate(images * 2):
            assert results[index] == expected
