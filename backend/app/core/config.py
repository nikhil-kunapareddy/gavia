import sys
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

from app.core.paths import default_data_dir


def _backend_root() -> Path:
    """Where the bundled ``models/`` directory sits.

    PyInstaller unpacks the frozen sidecar into a temporary tree and rewrites
    ``__file__`` to point inside it, so walking up from this module happens to
    land in the right place — but only by coincidence of the layout. Reading
    ``_MEIPASS`` says what we mean instead of relying on that.
    """
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parents[2]


BACKEND_ROOT = _backend_root()


class Settings(BaseSettings):
    """Application settings, overridable via environment variables or backend/.env."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="",
        extra="ignore",
    )

    app_name: str = "Gavia API"
    debug: bool = False

    # Comma-separated rather than a list so a plain env var like
    # CORS_ORIGINS=http://a,http://b works without JSON quoting.
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # --- Model -------------------------------------------------------------

    model_path: Path = BACKEND_ROOT / "models" / "loon_v1.onnx"

    inference_threads: int | None = None
    """ONNX Runtime intra-op threads. ``None`` picks a count that leaves the
    machine responsive; pin it only if you are benchmarking."""

    confidence_threshold: float | None = None
    iou_threshold: float | None = None
    """``None`` defers to the values in the model's sidecar JSON, so a
    retrained model can ship its own thresholds without a code change."""

    # --- Tiling ------------------------------------------------------------

    tiling_enabled: bool = False
    """Off by default. Tiling helps only when birds are small relative to the
    frame; on the current dataset most loons are larger than a tile and tiling
    costs far more precision than it gains. See ``Detector`` for the numbers."""

    tile_threshold: float = 1.5
    tile_overlap: float = 0.2
    max_tiles: int = 64

    # --- Uploads -----------------------------------------------------------

    max_upload_bytes: int = 20 * 1024 * 1024
    """Matches the frontend uploader's own limit, so the two agree on what is
    too large and the user gets the same answer either way."""

    request_timeout_seconds: float = 120.0

    # --- Storage -----------------------------------------------------------

    data_dir: Path = default_data_dir()
    thumbnail_size: int = 320

    # --- Desktop shell -----------------------------------------------------

    static_dir: Path | None = None
    """When set, the built frontend is served from ``/`` beside the API.

    This is what makes the packaged app same-origin: one process serves both
    halves, so the webview's relative ``/api`` URLs need no base URL and the
    app needs no CORS exception. Left unset in development, where Vite serves
    the frontend and proxies ``/api`` here."""

    # --- Local service hardening -------------------------------------------

    auth_token: str = ""
    """When set, every /api request must carry ``X-Gavia-Token``. Left empty in
    development; the desktop shell generates one per launch so that nothing
    else on the machine can drive the sidecar."""

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


settings = Settings()
