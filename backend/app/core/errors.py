"""One error shape for the whole API.

Every failure the frontend can encounter arrives as::

    {"error": {"code": "IMAGE_TOO_LARGE", "message": "...", "requestId": "..."}}

A stable ``code`` lets the UI decide what to say without parsing prose, and
``requestId`` ties a user's screenshot to a line in the log.
"""

from __future__ import annotations

import logging
import uuid
from contextvars import ContextVar

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.detection import ImageDecodeError, ImageTooLargeError, ModelUnavailableError

logger = logging.getLogger(__name__)

request_id_var: ContextVar[str] = ContextVar("request_id", default="")


def new_request_id() -> str:
    return uuid.uuid4().hex[:12]


class ApiError(Exception):
    """An error with a code the frontend is expected to understand."""

    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class NotFoundError(ApiError):
    def __init__(self, message: str = "Not found.") -> None:
        super().__init__("NOT_FOUND", message, status.HTTP_404_NOT_FOUND)


class UnsupportedFormatError(ApiError):
    def __init__(self, message: str) -> None:
        super().__init__("UNSUPPORTED_FORMAT", message, status.HTTP_415_UNSUPPORTED_MEDIA_TYPE)


class ImageTooLargeApiError(ApiError):
    def __init__(self, message: str) -> None:
        super().__init__(
            "IMAGE_TOO_LARGE", message, status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
        )


class UnauthorizedError(ApiError):
    def __init__(self, message: str = "Missing or invalid token.") -> None:
        super().__init__("UNAUTHORIZED", message, status.HTTP_401_UNAUTHORIZED)


def error_response(code: str, message: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {"code": code, "message": message, "requestId": request_id_var.get()}
        },
    )


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return error_response(exc.code, exc.message, exc.status_code)

    @app.exception_handler(ImageDecodeError)
    async def _decode_error(_: Request, exc: ImageDecodeError) -> JSONResponse:
        return error_response(
            "DECODE_FAILED", str(exc), status.HTTP_422_UNPROCESSABLE_ENTITY
        )

    @app.exception_handler(ImageTooLargeError)
    async def _too_large(_: Request, exc: ImageTooLargeError) -> JSONResponse:
        return error_response(
            "IMAGE_TOO_LARGE", str(exc), status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
        )

    @app.exception_handler(ModelUnavailableError)
    async def _model_unavailable(_: Request, exc: ModelUnavailableError) -> JSONResponse:
        # Logged loudly: this one means the install is broken, not that the
        # user did something wrong.
        logger.error("model unavailable: %s", exc)
        return error_response(
            "MODEL_UNAVAILABLE",
            "The detection model is not available. Please restart the app.",
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        field = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
        detail = first.get("msg", "Invalid request.")
        return error_response(
            "INVALID_REQUEST",
            f"{field}: {detail}" if field else detail,
            status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        # The message is deliberately generic; the traceback goes to the log,
        # not to the client.
        logger.exception("unhandled error", exc_info=exc)
        return error_response(
            "INTERNAL_ERROR",
            "Something went wrong while handling this request.",
            status.HTTP_500_INTERNAL_SERVER_ERROR,
        )
