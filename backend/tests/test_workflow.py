"""Complete journeys through the real stack.

Everything here runs the actual ONNX model against the actual database and the
actual filesystem — no stubs. Unit tests prove each piece behaves; these prove
the pieces still fit together, which is where the interesting bugs live (the
reported-dimensions bug and the duplicate-save file loss were both of this
kind).
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.core.config import Settings
from app.main import create_app
from tests.test_api import save_payload

pytestmark = [pytest.mark.slow, pytest.mark.workflow]

MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "loon_v1.onnx"
DATASET = Path.home() / "Documents/loonet/data/annotated/loonnet_v1"


@pytest.fixture
def live_client(tmp_path):
    """A fully wired app: real model, real SQLite, real image files."""
    if not MODEL_PATH.exists():
        pytest.skip("model file not present")

    app = create_app(Settings(data_dir=tmp_path / "gavia", model_path=MODEL_PATH))
    with TestClient(app) as client:
        yield client


@pytest.fixture
def photo() -> bytes:
    """A real labelled photograph if the dataset is here, else a synthetic one."""
    if DATASET.exists():
        first = DATASET / "val.txt"
        return Path(first.read_text().split()[0]).read_bytes()

    buffer = io.BytesIO()
    Image.new("RGB", (1600, 1200), (50, 90, 110)).save(buffer, "JPEG")
    return buffer.getvalue()


def upload(content: bytes, name: str = "loon.jpg"):
    return {"image": (name, content, "image/jpeg")}


class TestCheckAndKeepJourney:
    def test_the_whole_journey(self, live_client, photo):
        """Check a photo, keep it, find it in history, reopen it, delete it.

        This is the app's entire reason for existing, in one test.
        """
        # 1. The app comes up with a model loaded.
        assert live_client.get("/api/health").json()["status"] == "ok"

        # 2. Check a photo. Nothing is written yet.
        detected = live_client.post("/api/detect", files=upload(photo)).json()
        assert detected["saved"] is False
        assert live_client.get("/api/results").json() == []

        # 3. The reviewer keeps it.
        saved = live_client.post(
            "/api/results", files=upload(photo), data=save_payload(detected)
        )
        assert saved.status_code == 201

        # 4. It shows up in history with the same detections.
        history = live_client.get("/api/results").json()
        assert len(history) == 1
        assert history[0]["id"] == detected["id"]
        assert len(history[0]["detections"]) == len(detected["detections"])

        # 5. Reopening it serves the original image back.
        image = live_client.get(history[0]["imageUrl"])
        assert image.status_code == 200
        assert image.content == photo

        # 6. And it can be removed again, cleanly.
        assert live_client.delete(f"/api/results/{detected['id']}").json() == {"deleted": 1}
        assert live_client.get("/api/results").json() == []

    def test_detections_survive_the_round_trip_exactly(self, live_client, photo):
        """What the reviewer approved is what gets stored — not a recomputation
        that might differ if a threshold changed in between."""
        detected = live_client.post("/api/detect", files=upload(photo)).json()
        live_client.post("/api/results", files=upload(photo), data=save_payload(detected))

        reloaded = live_client.get(f"/api/results/{detected['id']}").json()

        assert len(reloaded["detections"]) == len(detected["detections"])
        for before, after in zip(detected["detections"], reloaded["detections"]):
            assert after["label"] == before["label"]
            assert after["confidence"] == pytest.approx(before["confidence"], abs=1e-6)
            assert after["boundingBox"] == pytest.approx(before["boundingBox"], abs=1e-6)

    def test_dimensions_survive_the_round_trip(self, live_client, photo):
        """Boxes are percentages of these numbers; if they drift, every saved
        box silently describes a different region."""
        with Image.open(io.BytesIO(photo)) as opened:
            expected = opened.size

        detected = live_client.post("/api/detect", files=upload(photo)).json()
        live_client.post("/api/results", files=upload(photo), data=save_payload(detected))
        reloaded = live_client.get(f"/api/results/{detected['id']}").json()

        assert (detected["imageWidth"], detected["imageHeight"]) == expected
        assert (reloaded["imageWidth"], reloaded["imageHeight"]) == expected


class TestAbandonedReview:
    def test_declining_to_save_leaves_nothing_behind(self, live_client, photo, tmp_path):
        """The reason there is no server-side staging area: an abandoned review
        must not leave a temp file for someone to clean up later."""
        live_client.post("/api/detect", files=upload(photo))
        live_client.post("/api/detect", files=upload(photo))

        data_dir = tmp_path / "gavia"
        assert list((data_dir / "images").iterdir()) == []
        assert list((data_dir / "thumbs").iterdir()) == []
        assert live_client.get("/api/results").json() == []

    def test_a_rejected_upload_leaves_nothing_behind(self, live_client, tmp_path):
        live_client.post("/api/detect", files=upload(b"not an image"))

        data_dir = tmp_path / "gavia"
        assert list((data_dir / "images").iterdir()) == []


class TestMultipleChecks:
    def test_several_photos_accumulate_in_order(self, live_client, photo):
        ids = []
        for index in range(3):
            detected = live_client.post(
                "/api/detect", files=upload(photo, f"photo-{index}.jpg")
            ).json()
            live_client.post("/api/results", files=upload(photo), data=save_payload(detected))
            ids.append(detected["id"])

        history = live_client.get("/api/results").json()
        assert [row["id"] for row in history] == list(reversed(ids))

    def test_each_result_keeps_its_own_image(self, live_client, photo):
        """Two saves of visually different photos must not share a file."""
        other = io.BytesIO()
        Image.new("RGB", (900, 700), (200, 40, 40)).save(other, "JPEG")
        other_bytes = other.getvalue()

        first = live_client.post("/api/detect", files=upload(photo)).json()
        live_client.post("/api/results", files=upload(photo), data=save_payload(first))
        second = live_client.post("/api/detect", files=upload(other_bytes)).json()
        live_client.post("/api/results", files=upload(other_bytes), data=save_payload(second))

        assert live_client.get(f"/api/results/{first['id']}/image").content == photo
        assert live_client.get(f"/api/results/{second['id']}/image").content == other_bytes

    def test_clearing_removes_every_file(self, live_client, photo, tmp_path):
        for _ in range(3):
            detected = live_client.post("/api/detect", files=upload(photo)).json()
            live_client.post("/api/results", files=upload(photo), data=save_payload(detected))

        assert live_client.delete("/api/results").json() == {"deleted": 3}

        data_dir = tmp_path / "gavia"
        assert list((data_dir / "images").iterdir()) == []
        assert list((data_dir / "thumbs").iterdir()) == []


class TestPersistenceAcrossRestart:
    def test_history_survives_a_restart(self, tmp_path, photo):
        """The whole point of moving off localStorage: the record outlives the
        process, and a browser cache clear cannot take it."""
        if not MODEL_PATH.exists():
            pytest.skip("model file not present")

        settings = Settings(data_dir=tmp_path / "gavia", model_path=MODEL_PATH)

        first_app = create_app(settings)
        with TestClient(first_app) as client:
            detected = client.post("/api/detect", files=upload(photo)).json()
            client.post("/api/results", files=upload(photo), data=save_payload(detected))
            saved_id = detected["id"]

        second_app = create_app(settings)
        with TestClient(second_app) as client:
            history = client.get("/api/results").json()
            assert [row["id"] for row in history] == [saved_id]
            assert client.get(f"/api/results/{saved_id}/image").content == photo


class TestFormatsEndToEnd:
    @pytest.mark.parametrize(
        "fmt,content_type", [("JPEG", "image/jpeg"), ("PNG", "image/png"), ("WEBP", "image/webp")]
    )
    def test_every_accepted_format_completes_the_journey(
        self, live_client, fmt, content_type
    ):
        buffer = io.BytesIO()
        Image.new("RGB", (1000, 800), (60, 100, 120)).save(buffer, fmt)
        content = buffer.getvalue()
        files = {"image": (f"photo.{fmt.lower()}", content, content_type)}

        detected = live_client.post("/api/detect", files=files).json()
        saved = live_client.post("/api/results", files=files, data=save_payload(detected))

        assert saved.status_code == 201
        assert live_client.get(f"/api/results/{detected['id']}/image").content == content
        assert live_client.get(f"/api/results/{detected['id']}/thumb").status_code == 200

    def test_a_rotated_photo_keeps_its_orientation_throughout(self, live_client):
        """EXIF rotation is applied at decode; the reported dimensions and the
        boxes have to agree with each other about which way is up."""
        exif = Image.Exif()
        exif[0x0112] = 6  # rotate a quarter turn
        buffer = io.BytesIO()
        Image.new("RGB", (1200, 800), (70, 110, 90)).save(buffer, "JPEG", exif=exif)
        content = buffer.getvalue()

        detected = live_client.post("/api/detect", files=upload(content)).json()

        assert (detected["imageWidth"], detected["imageHeight"]) == (800, 1200)


class TestDegradedOperation:
    def test_the_app_starts_and_stays_diagnosable_without_a_model(self, tmp_path):
        """A sidecar that exits on a missing model tells the shell nothing."""
        app = create_app(
            Settings(data_dir=tmp_path / "gavia", model_path=tmp_path / "absent.onnx")
        )
        with TestClient(app) as client:
            assert client.get("/api/health").json()["status"] == "degraded"

            failed = client.post("/api/detect", files=upload(b"\xff\xd8"))
            assert failed.status_code == 503
            assert failed.json()["error"]["code"] == "MODEL_UNAVAILABLE"

            # History still works — saved results are readable without a model.
            assert client.get("/api/results").status_code == 200
