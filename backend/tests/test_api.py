"""HTTP behaviour: the contract the frontend depends on."""

from __future__ import annotations

import json

import pytest

from tests.conftest import make_image, upload


class TestHealthAndModel:
    def test_health_reports_ok_with_a_model_loaded(self, client):
        body = client.get("/api/health").json()
        assert body["status"] == "ok"

    def test_health_answers_even_without_a_model(self, client):
        """The probe has to work in exactly the situation it exists to report."""
        client.app.state.detector = None
        body = client.get("/api/health").json()
        assert body["status"] == "degraded"

    def test_model_describes_what_is_loaded(self, client):
        body = client.get("/api/model").json()
        assert body["classes"] == ["common loon"]
        assert body["inputSize"] == 640
        assert body["tilingEnabled"] is False

    def test_model_endpoint_reports_unavailable_rather_than_crashing(self, client):
        client.app.state.detector = None
        response = client.get("/api/model")
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "MODEL_UNAVAILABLE"


class TestDetect:
    def test_returns_detections_in_the_frontend_shape(self, client, detector, prediction):
        detector.predictions = [prediction]

        body = client.post("/api/detect", files=upload(make_image())).json()

        assert body["detections"][0]["boundingBox"] == {
            "x": 10.0,
            "y": 20.0,
            "width": 30.0,
            "height": 40.0,
        }
        assert body["detections"][0]["label"] == "Loon"
        assert body["imageWidth"] == 800
        assert body["imageHeight"] == 600

    def test_does_not_persist(self, client, detector, prediction):
        """Detection is a preview; only an explicit save writes to history."""
        detector.predictions = [prediction]

        body = client.post("/api/detect", files=upload(make_image())).json()

        assert body["saved"] is False
        assert body["imageUrl"] == ""
        assert client.get("/api/results").json() == []

    def test_an_image_with_no_loons_is_a_result_not_an_error(self, client):
        response = client.post("/api/detect", files=upload(make_image()))
        assert response.status_code == 200
        assert response.json()["detections"] == []

    def test_rejects_a_non_image_content_type(self, client):
        response = client.post("/api/detect", files=upload(b"hello", "a.txt", "text/plain"))
        assert response.status_code == 415
        assert response.json()["error"]["code"] == "UNSUPPORTED_FORMAT"

    def test_rejects_bytes_that_are_not_an_image(self, client):
        """A .jpg name and an image/jpeg header prove nothing about content."""
        response = client.post("/api/detect", files=upload(b"\xff\xd8 not a jpeg"))
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "DECODE_FAILED"

    def test_rejects_an_empty_upload(self, client):
        assert client.post("/api/detect", files=upload(b"")).status_code == 415

    def test_enforces_the_size_cap_while_streaming(self, client, settings):
        oversized = b"\xff\xd8" + b"\x00" * (settings.max_upload_bytes + 1)
        response = client.post("/api/detect", files=upload(oversized))
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "IMAGE_TOO_LARGE"

    def test_accepts_png_and_webp(self, client):
        for fmt, content_type in (("PNG", "image/png"), ("WEBP", "image/webp")):
            response = client.post(
                "/api/detect",
                files=upload(make_image(fmt=fmt), f"a.{fmt.lower()}", content_type),
            )
            assert response.status_code == 200, fmt

    def test_tiling_can_be_requested_per_call(self, client, detector):
        client.post("/api/detect?tiling=true", files=upload(make_image()))
        assert detector.calls[-1]["tiling"] is True

    def test_tiling_is_left_to_configuration_by_default(self, client, detector):
        client.post("/api/detect", files=upload(make_image()))
        assert detector.calls[-1]["tiling"] is None

    def test_errors_carry_a_request_id(self, client):
        body = client.post("/api/detect", files=upload(b"", "a.jpg")).json()
        assert body["error"]["requestId"]


def save_payload(result: dict) -> dict:
    return {
        "result": json.dumps(
            {
                "id": result["id"],
                "fileName": result["fileName"],
                "detections": result["detections"],
                "processingTime": result["processingTime"],
                "imageWidth": result["imageWidth"],
                "imageHeight": result["imageHeight"],
                "modelName": result["modelName"],
                "tilesProcessed": result["tilesProcessed"],
            }
        )
    }


class TestSaveAndHistory:
    def _detect_and_save(self, client, detector, prediction, content=None):
        detector.predictions = [prediction]
        content = content or make_image()
        detected = client.post("/api/detect", files=upload(content)).json()
        saved = client.post(
            "/api/results", files=upload(content), data=save_payload(detected)
        )
        return detected, saved

    def test_saving_persists_the_reviewed_detections(self, client, detector, prediction):
        _, saved = self._detect_and_save(client, detector, prediction)

        assert saved.status_code == 201
        body = saved.json()
        assert body["saved"] is True
        assert body["imageUrl"].endswith("/image")
        assert len(body["detections"]) == 1

    def test_saved_results_appear_in_history(self, client, detector, prediction):
        self._detect_and_save(client, detector, prediction)
        assert len(client.get("/api/results").json()) == 1

    def test_history_is_newest_first(self, client, detector, prediction):
        first, _ = self._detect_and_save(client, detector, prediction)
        second, _ = self._detect_and_save(client, detector, prediction)

        ids = [row["id"] for row in client.get("/api/results").json()]
        assert ids[0] == second["id"]
        assert ids[1] == first["id"]

    def test_image_and_thumbnail_are_served(self, client, detector, prediction):
        _, saved = self._detect_and_save(client, detector, prediction)
        result_id = saved.json()["id"]

        image = client.get(f"/api/results/{result_id}/image")
        thumb = client.get(f"/api/results/{result_id}/thumb")

        assert image.status_code == 200
        assert image.headers["content-type"] == "image/jpeg"
        assert thumb.status_code == 200
        assert thumb.headers["content-type"] == "image/webp"
        # The thumbnail exists to keep the history grid light.
        assert len(thumb.content) < len(image.content)

    def test_the_original_is_stored_byte_for_byte(self, client, detector, prediction):
        """This is a research record; a re-encoded photo is not the evidence."""
        content = make_image(colour=(12, 34, 56))
        _, saved = self._detect_and_save(client, detector, prediction, content)

        served = client.get(f"/api/results/{saved.json()['id']}/image")
        assert served.content == content

    def test_saving_the_same_result_twice_is_refused(self, client, detector, prediction):
        content = make_image()
        detector.predictions = [prediction]
        detected = client.post("/api/detect", files=upload(content)).json()

        first = client.post("/api/results", files=upload(content), data=save_payload(detected))
        second = client.post("/api/results", files=upload(content), data=save_payload(detected))

        assert first.status_code == 201
        assert second.status_code == 409
        assert second.json()["error"]["code"] == "ALREADY_SAVED"

    def test_rejects_a_malformed_payload(self, client):
        response = client.post(
            "/api/results", files=upload(make_image()), data={"result": "{not json"}
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_REQUEST"

    @pytest.mark.parametrize("bad_id", ["../escape", "a/b", "..", "with space", ""])
    def test_rejects_ids_that_could_escape_the_data_directory(self, client, bad_id):
        """The id becomes a filename, so it is validated rather than trusted."""
        payload = {
            "result": json.dumps(
                {
                    "id": bad_id,
                    "fileName": "x.jpg",
                    "detections": [],
                    "processingTime": 0.1,
                    "imageWidth": 100,
                    "imageHeight": 100,
                    "modelName": "stub",
                    "tilesProcessed": 1,
                }
            )
        }
        response = client.post("/api/results", files=upload(make_image()), data=payload)
        assert response.status_code == 422

    def test_deleting_removes_the_row_and_its_files(self, client, detector, prediction, settings):
        _, saved = self._detect_and_save(client, detector, prediction)
        result_id = saved.json()["id"]

        assert client.delete(f"/api/results/{result_id}").json() == {"deleted": 1}
        assert client.get(f"/api/results/{result_id}").status_code == 404
        assert not list((settings.data_dir / "images").glob(f"{result_id}*"))
        assert not list((settings.data_dir / "thumbs").glob(f"{result_id}*"))

    def test_deleting_something_absent_is_a_404(self, client):
        assert client.delete("/api/results/missing").status_code == 404

    def test_clearing_reports_how_many_went(self, client, detector, prediction):
        self._detect_and_save(client, detector, prediction)
        self._detect_and_save(client, detector, prediction)

        assert client.delete("/api/results").json() == {"deleted": 2}
        assert client.get("/api/results").json() == []

    def test_unknown_result_is_a_typed_404(self, client):
        body = client.get("/api/results/nope").json()
        assert body["error"]["code"] == "NOT_FOUND"


class TestAuthToken:
    def test_requests_are_open_when_no_token_is_configured(self, client):
        assert client.get("/api/results").status_code == 200

    def test_a_configured_token_is_required(self, settings, detector):
        from fastapi.testclient import TestClient

        from app.core.config import settings as global_settings
        from app.main import create_app

        # require_token reads the module-level settings, which is how the
        # packaged app configures it.
        original = global_settings.auth_token
        global_settings.auth_token = "secret-token"
        try:
            app = create_app(settings)
            with TestClient(app) as authed:
                app.state.detector = detector
                assert authed.get("/api/results").status_code == 401
                assert (
                    authed.get(
                        "/api/results", headers={"X-Gavia-Token": "secret-token"}
                    ).status_code
                    == 200
                )
                # The health probe stays open so the shell can see the sidecar
                # come up before it knows anything else.
                assert authed.get("/api/health").status_code == 200
        finally:
            global_settings.auth_token = original
