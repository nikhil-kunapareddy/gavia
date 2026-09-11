"""Shared request dependencies.

The detector, database and repository are built once during startup and hung
off ``app.state``; these accessors are how routes reach them. Building the
detector per request would reload a 36MB graph every time.
"""

from __future__ import annotations

import secrets

from fastapi import Header, Request

from app.core.config import settings
from app.core.errors import UnauthorizedError
from app.detection import Detector, ModelUnavailableError
from app.storage.repository import ResultRepository


def get_detector(request: Request) -> Detector:
    """The loaded detector, or a clean 503 if startup could not load one.

    ``lifespan`` deliberately lets the app start without a model so the process
    stays diagnosable; this is where that decision is paid for, by turning the
    missing detector into a typed error instead of an AttributeError.
    """
    detector = getattr(request.app.state, "detector", None)
    if detector is None:
        raise ModelUnavailableError("No model is loaded.")
    return detector


def get_repository(request: Request) -> ResultRepository:
    return request.app.state.repository


def require_token(x_gavia_token: str | None = Header(default=None)) -> None:
    """Gate the API on a shared token, when one is configured.

    Binding to 127.0.0.1 keeps the service off the network, but not away from
    other processes on the same machine. The desktop shell generates a token
    per launch and passes it to the frontend, so only the app it started can
    drive the sidecar. Unset in development, where there is nothing to protect.
    """
    if not settings.auth_token:
        return

    # Constant-time: a plain != leaks the token prefix through timing.
    if x_gavia_token is None or not secrets.compare_digest(
        x_gavia_token, settings.auth_token
    ):
        raise UnauthorizedError()
