from fastapi import APIRouter, Depends, Request

from app import __version__
from app.api import routes_detect, routes_results
from app.api.deps import get_detector, require_token
from app.core.config import settings
from app.detection import Detector
from app.schemas.detection import ModelResponse
from app.schemas.health import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["system"])
def health(request: Request) -> HealthResponse:
    """Liveness probe. The desktop shell polls this to know the sidecar is up.

    Deliberately unauthenticated and free of dependencies: it has to answer
    even when the model failed to load, because that is exactly when someone
    needs to know the process is alive.
    """
    return HealthResponse(
        status="ok" if getattr(request.app.state, "detector", None) else "degraded",
        service=settings.app_name,
        version=__version__,
    )


@router.get(
    "/model",
    response_model=ModelResponse,
    tags=["system"],
    dependencies=[Depends(require_token)],
)
def model(detector: Detector = Depends(get_detector)) -> ModelResponse:
    """What the running process actually loaded.

    Reported from the model's own sidecar metadata rather than constants, so
    this cannot drift from the weights in use.
    """
    info = detector.info
    return ModelResponse(
        name=info.name,
        architecture=info.architecture,
        classes=info.classes,
        inputSize=info.input_size,
        confidenceThreshold=info.confidence_threshold,
        iouThreshold=info.iou_threshold,
        tilingEnabled=settings.tiling_enabled,
        provider=detector.provider,
        metrics=info.metrics,
        sha256=info.sha256,
    )


# Everything except the health probe sits behind the token, when one is set.
# /model is gated too: it is the one system route that describes the install
# rather than merely proving it is alive.
router.include_router(routes_detect.router, dependencies=[Depends(require_token)])
router.include_router(routes_results.router, dependencies=[Depends(require_token)])
