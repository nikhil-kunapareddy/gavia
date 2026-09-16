"""Logging setup and the request-id middleware.

Logs are JSON lines. A packaged desktop app writes its log to a file the user
will one day be asked to send us; one object per line is far easier to filter
and paste than wrapped console prose.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.core.errors import new_request_id, request_id_var

_RESERVED = set(
    logging.LogRecord("", 0, "", 0, "", (), None).__dict__
) | {"message", "asctime", "taskName"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        request_id = request_id_var.get()
        if request_id:
            payload["requestId"] = request_id

        # Anything passed via `extra=` rides along as a real field rather than
        # being interpolated into the message.
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, default=str)


def configure_logging(*, debug: bool) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.DEBUG if debug else logging.INFO)

    # Uvicorn installs its own colourised handlers; drop them so everything
    # goes through one formatter.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        log = logging.getLogger(name)
        log.handlers = []
        log.propagate = True


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Tags each request with an id, and logs how it went."""

    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = request.headers.get("x-request-id") or new_request_id()
        token = request_id_var.set(request_id)
        started = time.perf_counter()

        try:
            response = await call_next(request)
        except Exception:
            # The exception handlers turn this into a response; here we only
            # make sure the failure is timed and attributable.
            logging.getLogger("app.request").exception(
                "request failed",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "durationMs": round((time.perf_counter() - started) * 1000, 1),
                },
            )
            raise
        finally:
            request_id_var.reset(token)

        duration_ms = round((time.perf_counter() - started) * 1000, 1)
        response.headers["x-request-id"] = request_id

        # Health checks would otherwise dominate the log in a packaged app.
        if request.url.path != "/api/health":
            logging.getLogger("app.request").info(
                "request",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "durationMs": duration_ms,
                    "requestId": request_id,
                },
            )

        return response
