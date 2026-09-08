from fastapi import APIRouter

from app import __version__
from app.core.config import settings
from app.schemas.health import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["system"])
def health() -> HealthResponse:
    """Liveness probe. The frontend calls this on load to confirm the API is reachable."""
    return HealthResponse(status="ok", service=settings.app_name, version=__version__)
