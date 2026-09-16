"""The desktop sidecar: static serving and the command line that drives it.

These cover the seams the packaged app depends on and nothing else does — a
frontend served from the same origin as the API, and arguments that reach the
settings singleton rather than only the instance handed to ``create_app``.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.__main__ import (
    PORT_BANNER,
    _apply_settings_env,
    _exit_when_stdin_closes,
    _parse_args,
)
from app.core.config import Settings
from app.main import create_app

from tests.conftest import MODEL_PATH, StubDetector


@pytest.fixture
def web_root(tmp_path: Path) -> Path:
    """A stand-in for `frontend/dist`."""
    root = tmp_path / "web"
    root.mkdir()
    (root / "index.html").write_text("<!doctype html><title>Gavia</title>")
    (root / "assets").mkdir()
    (root / "assets" / "app.js").write_text("export const ok = true\n")
    return root


@pytest.fixture
def web_client(tmp_path: Path, web_root: Path, detector: StubDetector):
    config = Settings(
        data_dir=tmp_path / "gavia", model_path=MODEL_PATH, static_dir=web_root
    )
    app = create_app(config)
    with TestClient(app) as client:
        app.state.detector = detector
        yield client


class TestServingTheFrontend:
    def test_root_serves_index(self, web_client):
        response = web_client.get("/")
        assert response.status_code == 200
        assert "Gavia" in response.text

    def test_assets_are_served(self, web_client):
        assert web_client.get("/assets/app.js").status_code == 200

    def test_api_still_wins_over_the_static_mount(self, web_client):
        # The mount is at "/", so this is the check that it did not swallow the
        # API routes registered before it.
        assert web_client.get("/api/health").json()["status"] == "ok"

    def test_unknown_api_path_keeps_the_error_shape(self, web_client):
        """An unknown /api path must not fall through to StaticFiles.

        StaticFiles would answer with its own bare 404, and the frontend
        branches on `error.code`.
        """
        response = web_client.get("/api/does-not-exist")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOT_FOUND"

    def test_unknown_api_path_under_any_method(self, web_client):
        assert web_client.post("/api/nope").json()["error"]["code"] == "NOT_FOUND"

    def test_nothing_is_mounted_without_a_static_dir(self, client):
        # The development app serves the API alone; Vite serves the frontend.
        assert client.get("/").status_code == 404


class TestCommandLine:
    def test_port_defaults_to_an_ephemeral_one(self):
        assert _parse_args([]).port == 0

    def test_binds_loopback_by_default(self):
        assert _parse_args([]).host == "127.0.0.1"

    def test_directories_are_paths(self):
        args = _parse_args(["--data-dir", "/tmp/d", "--static-dir", "/tmp/s"])
        assert args.data_dir == Path("/tmp/d")
        assert args.static_dir == Path("/tmp/s")

    def test_arguments_reach_the_settings_singleton(self, monkeypatch, tmp_path):
        """The env is the channel, because `require_token` reads the singleton.

        Configuring only the instance passed to `create_app` would leave the
        token check consulting defaults.
        """
        monkeypatch.delenv("DATA_DIR", raising=False)
        monkeypatch.delenv("STATIC_DIR", raising=False)

        _apply_settings_env(_parse_args(["--data-dir", str(tmp_path)]))

        assert os.environ["DATA_DIR"] == str(tmp_path)
        assert Settings().data_dir == tmp_path
        assert "STATIC_DIR" not in os.environ

    def test_unset_arguments_leave_the_env_alone(self, monkeypatch):
        monkeypatch.setenv("DATA_DIR", "/keep/me")
        _apply_settings_env(_parse_args([]))
        assert os.environ["DATA_DIR"] == "/keep/me"

    def test_banner_is_greppable(self):
        # The shell parses this prefix out of stdout to find the port.
        assert PORT_BANNER == "GAVIA_PORT="

    def test_nothing_watches_the_parent_by_default(self):
        # Run by hand from a terminal, stdin means nothing in particular.
        assert _parse_args([]).exit_with_parent is False

    def test_the_shell_can_ask_to_be_followed(self):
        assert _parse_args(["--exit-with-parent"]).exit_with_parent is True


class TestParentWatchdog:
    """Stopping when the shell does, including when it dies badly.

    `Backend::shutdown` in `frontend/src-tauri/src/sidecar.rs` covers an
    orderly quit. This covers the rest: a shell that is killed or aborts never
    reaches that code, and a backend left behind holds the database open with
    no window able to close it.
    """

    @pytest.fixture
    def pipe(self):
        read_fd, write_fd = os.pipe()
        yield read_fd, write_fd
        # Write end first: that releases any watchdog still blocked on the
        # read end, so nothing is reading a descriptor as it is closed.
        for fd in (write_fd, read_fd):
            try:
                os.close(fd)
            except OSError:
                pass

    def test_keeps_running_while_the_far_end_is_held(self, pipe):
        read_fd, _write_fd = pipe
        server = SimpleNamespace(should_exit=False)

        thread = _exit_when_stdin_closes(server, fd=read_fd)
        thread.join(timeout=0.2)

        assert thread.is_alive()
        assert server.should_exit is False

    def test_stops_once_the_far_end_closes(self, pipe):
        read_fd, write_fd = pipe
        server = SimpleNamespace(should_exit=False)

        thread = _exit_when_stdin_closes(server, fd=read_fd)
        os.close(write_fd)
        thread.join(timeout=5)

        assert not thread.is_alive()
        assert server.should_exit is True

    def test_writes_are_drained_rather_than_read_as_a_message(self, pipe):
        """Only the EOF is the signal; the shell never writes here."""
        read_fd, write_fd = pipe
        server = SimpleNamespace(should_exit=False)

        thread = _exit_when_stdin_closes(server, fd=read_fd)
        os.write(write_fd, b"noise\n")
        thread.join(timeout=0.2)

        assert server.should_exit is False

        os.close(write_fd)
        thread.join(timeout=5)
        assert server.should_exit is True

    def test_an_unusable_descriptor_stops_rather_than_lingers(self):
        """Losing the descriptor is losing the shell; stay down either way.

        A write-only descriptor rather than a closed one: closing a number
        frees it to be handed to the next thing that opens a file, and this
        test would then be reading whatever that turned out to be.
        """
        fd = os.open(os.devnull, os.O_WRONLY)
        try:
            server = SimpleNamespace(should_exit=False)

            thread = _exit_when_stdin_closes(server, fd=fd)
            thread.join(timeout=5)

            assert server.should_exit is True
        finally:
            os.close(fd)
