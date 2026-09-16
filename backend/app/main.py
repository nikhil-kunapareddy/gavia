import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api.routes import router
from app.core.config import Settings, settings
from app.core.errors import NotFoundError, register_exception_handlers
from app.core.logging import RequestContextMiddleware, configure_logging
from app.core.paths import ensure_data_dirs
from app.detection import Detector, ModelUnavailableError
from app.storage.db import Database
from app.storage.images import ImageStore
from app.storage.repository import ResultRepository

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Build the expensive, long-lived objects once per process.

    The model session in particular costs ~0.4s and ~140MB; creating it per
    request would make the app unusable. Storage is opened here too so that a
    broken data directory fails at startup rather than on the user's first save.
    """
    config: Settings = app.state.settings

    paths = ensure_data_dirs(config.data_dir)
    database = Database(paths["database"])
    images = ImageStore(
        paths["images"], paths["thumbs"], thumbnail_size=config.thumbnail_size
    )
    app.state.database = database
    app.state.repository = ResultRepository(database, images)
    logger.info("storage ready", extra={"dataDir": str(paths["root"])})

    try:
        app.state.detector = Detector(
            config.model_path,
            intra_op_threads=config.inference_threads,
            tiling_enabled=config.tiling_enabled,
            tile_threshold=config.tile_threshold,
            tile_overlap=config.tile_overlap,
            max_tiles=config.max_tiles,
        )
        logger.info(
            "model ready",
            extra={
                "model": app.state.detector.info.name,
                "provider": app.state.detector.provider,
                "tiling": config.tiling_enabled,
            },
        )
    except ModelUnavailableError:
        # Start anyway. A running process that reports MODEL_UNAVAILABLE on
        # /api/detect and "degraded" on /api/health is far easier to diagnose
        # than a sidecar that exits before the shell can talk to it.
        app.state.detector = None
        logger.exception("model failed to load; detection will be unavailable")

    try:
        yield
    finally:
        database.close()


def create_app(config: Settings | None = None) -> FastAPI:
    config = config or settings
    configure_logging(debug=config.debug)

    app = FastAPI(
        title=config.app_name,
        version=__version__,
        lifespan=lifespan,
        # The desktop shell has no use for these, but they cost nothing and
        # make the API explorable during development.
        docs_url="/docs",
    )
    app.state.settings = config

    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["x-request-id"],
    )
    app.add_middleware(RequestContextMiddleware)

    register_exception_handlers(app)
    app.include_router(router, prefix="/api")

    if config.static_dir is not None:
        _serve_frontend(app, config.static_dir)

    return app


def _serve_frontend(app: FastAPI, static_dir: Path) -> None:
    """Serve the built frontend from ``/``, beside the API.

    Only the packaged desktop build does this. Putting both halves on one
    origin is what lets the webview use plain relative ``/api`` URLs, with no
    base URL to configure and no CORS exception to grant.
    """
    # Registered after the API router, so real endpoints still win, but before
    # the catch-all mount, so an unknown /api path keeps the JSON error shape
    # the frontend branches on instead of falling through to StaticFiles' bare
    # 404.
    @app.api_route(
        "/api/{_path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        include_in_schema=False,
    )
    async def api_not_found(_path: str) -> None:
        raise NotFoundError()

    app.mount("/", StaticFiles(directory=static_dir, html=True), name="web")
    logger.info("serving frontend", extra={"staticDir": str(static_dir)})


app = create_app()
