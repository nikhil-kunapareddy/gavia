"""Entry point for the packaged desktop sidecar.

``python -m app`` — and the PyInstaller binary built from it — starts the same
FastAPI application uvicorn serves in development. Two things differ, and both
only matter once the process is running underneath the desktop shell:

* The listening socket is created here rather than by uvicorn, so the port can
  be reported to the shell before the server starts. Asking the OS for a free
  port and then handing the bare number to a separate ``bind()`` leaves a gap
  in which something else can claim it; binding first and passing the socket
  along closes that gap.
* Configuration arrives as environment variables rather than ``backend/.env``,
  because ``Settings`` resolves that file relative to the working directory and
  a frozen binary inherits whatever directory the shell happened to launch it
  from.
* With ``--exit-with-parent`` the process stops when its stdin closes, so a
  shell that dies without running its own shutdown path does not leave the
  backend behind.
"""

from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import uvicorn

PORT_BANNER = "GAVIA_PORT="
"""Prefix of the line the shell parses to learn where to point the webview."""


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="gavia-backend",
        description="Run the Gavia backend as a local service.",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Interface to bind. Loopback by default; this is not a network service.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="Port to bind. 0 (the default) asks the OS for a free one.",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=None,
        help="Where to keep the database and images. Defaults to the platform location.",
    )
    parser.add_argument(
        "--static-dir",
        type=Path,
        default=None,
        help="Directory of built frontend assets to serve from '/'.",
    )
    parser.add_argument("--log-level", default="info")
    parser.add_argument(
        "--exit-with-parent",
        action="store_true",
        help="Stop when stdin closes. The desktop shell passes this; it holds "
        "the other end of the pipe and never writes to it.",
    )
    return parser.parse_args(argv)


def _apply_settings_env(args: argparse.Namespace) -> None:
    """Push the CLI arguments into the environment before the app is imported.

    ``app.core.config`` builds a module-level ``Settings()`` at import time, and
    ``require_token`` reads that singleton rather than the instance passed to
    ``create_app``. Going through the environment is what keeps the two in
    agreement — configuring only the instance would leave the token check
    looking at defaults and waving every request through.
    """
    if args.data_dir is not None:
        os.environ["DATA_DIR"] = str(args.data_dir)
    if args.static_dir is not None:
        os.environ["STATIC_DIR"] = str(args.static_dir)


def _exit_when_stdin_closes(
    server: uvicorn.Server, fd: int = 0
) -> threading.Thread:
    """Stop the server once the far end of ``fd`` is gone.

    The shell holds the write end of this process's stdin and never writes to
    it, so the read below blocks for as long as the shell is alive and reports
    EOF the moment it is not. That covers the cases a shutdown message cannot:
    the shell being killed outright, or aborting on a panic, either of which
    skips its own stop-the-backend path and would otherwise leave this process
    running with the user's database open and no window left to close it.

    ``fd`` is a parameter so the tests can watch a pipe of their own rather
    than the interpreter's real stdin.
    """

    def watch() -> None:
        try:
            # Anything actually written here is not a protocol, just noise to
            # drain; only the EOF matters.
            while os.read(fd, 4096):
                pass
        except OSError:
            # The descriptor died in some less orderly way. Either way it can
            # no longer tell us the shell is alive, so stop rather than linger.
            pass
        server.should_exit = True

    thread = threading.Thread(target=watch, name="parent-watchdog", daemon=True)
    thread.start()
    return thread


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    _apply_settings_env(args)

    # Imported only now: the settings singleton snapshots the environment as it
    # is imported, so these have to come after _apply_settings_env. The module
    # level `app` is the same object `uvicorn app.main:app` serves in
    # development, built from that singleton.
    import uvicorn

    from app.main import app

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    sock.listen(128)
    port = sock.getsockname()[1]

    # Announced before the model loads. That load takes long enough that a
    # shell waiting only for the port to answer would sit there looking hung.
    print(f"{PORT_BANNER}{port}", flush=True)

    server = uvicorn.Server(
        uvicorn.Config(
            app,
            log_level=args.log_level,
            # The shell reads this stream; uvicorn's per-request lines would
            # bury the startup banner it is looking for.
            access_log=False,
        )
    )

    if args.exit_with_parent:
        # uvicorn's run loop polls `should_exit`, so setting it from the
        # watchdog thread unwinds the server through its normal shutdown and
        # the database closes cleanly.
        _exit_when_stdin_closes(server)

    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    sys.exit(main())
