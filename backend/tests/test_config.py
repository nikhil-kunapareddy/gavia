"""Settings, data directories, and the error envelope."""

from __future__ import annotations

import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.errors import (
    ApiError,
    NotFoundError,
    register_exception_handlers,
    request_id_var,
)
from app.core.logging import JsonFormatter
from app.core.paths import APP_DIR_NAME, default_data_dir, ensure_data_dirs
from app.detection import ImageDecodeError, ImageTooLargeError, ModelUnavailableError


class TestSettings:
    def test_cors_origins_parse_from_a_plain_comma_list(self):
        """A plain env var, not JSON — the whole reason it is stored as a string."""
        settings = Settings(cors_origins="http://a,http://b")
        assert settings.cors_origin_list == ["http://a", "http://b"]

    def test_cors_origins_tolerate_whitespace_and_blanks(self):
        settings = Settings(cors_origins=" http://a , , http://b ")
        assert settings.cors_origin_list == ["http://a", "http://b"]

    def test_thresholds_default_to_the_model_metadata(self):
        """None means "defer to the sidecar JSON", so a retrained model can
        ship its own thresholds without a code change."""
        settings = Settings()
        assert settings.confidence_threshold is None
        assert settings.iou_threshold is None

    def test_tiling_is_off_by_default(self):
        assert Settings().tiling_enabled is False

    def test_upload_cap_matches_the_frontend(self):
        # The uploader refuses >20MB client-side; disagreeing would mean the
        # user gets a different answer depending on which check fires.
        assert Settings().max_upload_bytes == 20 * 1024 * 1024

    def test_environment_overrides_defaults(self, monkeypatch):
        monkeypatch.setenv("TILING_ENABLED", "true")
        monkeypatch.setenv("MAX_UPLOAD_BYTES", "1234")
        settings = Settings()
        assert settings.tiling_enabled is True
        assert settings.max_upload_bytes == 1234


class TestDataDirectories:
    def test_default_is_per_user_not_next_to_the_install(self):
        """A packaged app may sit in a read-only, signed bundle."""
        path = default_data_dir()
        assert path.is_absolute()
        assert str(path).startswith(str(path.home()))

    def test_macos_uses_application_support(self, monkeypatch):
        monkeypatch.setattr("sys.platform", "darwin")
        assert default_data_dir().parts[-3:] == ("Library", "Application Support", APP_DIR_NAME)

    def test_linux_honours_xdg_data_home(self, monkeypatch):
        monkeypatch.setattr("sys.platform", "linux")
        monkeypatch.setenv("XDG_DATA_HOME", "/custom/share")
        assert default_data_dir() == type(default_data_dir())("/custom/share/gavia")

    def test_windows_uses_localappdata(self, monkeypatch):
        monkeypatch.setattr("sys.platform", "win32")
        monkeypatch.setenv("LOCALAPPDATA", "/users/x/AppData/Local")
        assert default_data_dir().name == APP_DIR_NAME

    def test_ensure_creates_the_whole_tree(self, tmp_path):
        paths = ensure_data_dirs(tmp_path / "gavia")
        assert paths["images"].is_dir()
        assert paths["thumbs"].is_dir()
        assert paths["database"].parent.is_dir()

    def test_ensure_is_idempotent(self, tmp_path):
        ensure_data_dirs(tmp_path / "gavia")
        ensure_data_dirs(tmp_path / "gavia")  # must not raise


@pytest.fixture
def error_client():
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/typed")
    def _typed():
        raise NotFoundError("nothing here")

    @app.get("/decode")
    def _decode():
        raise ImageDecodeError("cannot read that")

    @app.get("/too-large")
    def _too_large():
        raise ImageTooLargeError("far too big")

    @app.get("/no-model")
    def _no_model():
        raise ModelUnavailableError("gone")

    @app.get("/boom")
    def _boom():
        raise RuntimeError("internal detail that must not leak")

    return TestClient(app, raise_server_exceptions=False)


class TestErrorEnvelope:
    @pytest.mark.parametrize(
        "path,status,code",
        [
            ("/typed", 404, "NOT_FOUND"),
            ("/decode", 422, "DECODE_FAILED"),
            ("/too-large", 413, "IMAGE_TOO_LARGE"),
            ("/no-model", 503, "MODEL_UNAVAILABLE"),
            ("/boom", 500, "INTERNAL_ERROR"),
        ],
    )
    def test_every_failure_uses_one_shape(self, error_client, path, status, code):
        response = error_client.get(path)
        assert response.status_code == status
        assert response.json()["error"]["code"] == code

    def test_an_unhandled_error_does_not_leak_internals(self, error_client, caplog):
        """The traceback belongs in the log, not in the user's browser."""
        with caplog.at_level(logging.ERROR):
            body = error_client.get("/boom").json()

        assert "internal detail" not in body["error"]["message"]
        assert "internal detail" in caplog.text

    def test_api_error_carries_its_status(self):
        error = ApiError("CUSTOM", "message", 418)
        assert (error.code, error.status_code) == ("CUSTOM", 418)


class TestLogging:
    def test_formats_records_as_json_lines(self):
        record = logging.LogRecord("app", logging.INFO, "f.py", 1, "hello", (), None)
        payload = JsonFormatter().format(record)
        assert '"message": "hello"' in payload
        assert '"level": "INFO"' in payload

    def test_extra_fields_become_real_keys(self):
        """So a log can be filtered on durationMs rather than grepped."""
        record = logging.LogRecord("app", logging.INFO, "f.py", 1, "done", (), None)
        record.durationMs = 12.5
        assert '"durationMs": 12.5' in JsonFormatter().format(record)

    def test_the_request_id_rides_along_when_set(self):
        token = request_id_var.set("abc123")
        try:
            record = logging.LogRecord("app", logging.INFO, "f.py", 1, "x", (), None)
            assert '"requestId": "abc123"' in JsonFormatter().format(record)
        finally:
            request_id_var.reset(token)

    def test_exceptions_are_included(self):
        try:
            raise ValueError("kaboom")
        except ValueError:
            import sys

            record = logging.LogRecord(
                "app", logging.ERROR, "f.py", 1, "failed", (), sys.exc_info()
            )
        assert "kaboom" in JsonFormatter().format(record)
