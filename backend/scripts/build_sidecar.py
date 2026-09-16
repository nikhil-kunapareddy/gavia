#!/usr/bin/env python3
"""Freeze the backend into the binary the Tauri shell bundles.

    python backend/scripts/build_sidecar.py

Writes `backend/dist/gavia-backend/`, which `frontend/src-tauri/tauri.conf.json`
lists as a bundled resource. Needs the packaging extras:

    pip install -r backend/requirements-build.txt

Unlike `evaluate.py` and `check_parity.py`, this one runs in the ordinary
backend venv — the point of the exercise is to freeze exactly the dependency
set the app ships with, so borrowing the training environment would bundle the
wrong thing.

The build is followed by a smoke test that starts the binary and asks it for
`/api/health`. That catches the failure this packaging step actually has —
a module resolved fine during analysis but missing at runtime — which no amount
of inspecting the output directory would reveal.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
SPEC = BACKEND / "gavia-backend.spec"
DIST = BACKEND / "dist"
WORK = BACKEND / "build"
BUNDLE = DIST / "gavia-backend"
BINARY = BUNDLE / "gavia-backend"

PORT_BANNER = "GAVIA_PORT="
STARTUP_TIMEOUT = 60.0


def build(clean: bool) -> None:
    if clean:
        for path in (DIST, WORK):
            shutil.rmtree(path, ignore_errors=True)

    print(f"freezing {SPEC.name} -> {BUNDLE}")
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            str(SPEC),
            "--noconfirm",
            "--distpath",
            str(DIST),
            "--workpath",
            str(WORK),
            "--log-level",
            "WARN",
        ],
        cwd=BACKEND,
        check=True,
    )

    if not BINARY.exists():
        raise SystemExit(f"build reported success but {BINARY} is missing")


def smoke_test() -> None:
    """Start the frozen binary and confirm it answers."""
    print("smoke test: starting the frozen sidecar")
    process = subprocess.Popen(
        [str(BINARY), "--port", "0"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        # Somewhere with no .env and no source tree, which is the situation the
        # packaged app launches it in.
        cwd=Path.home(),
    )
    try:
        port = _await_port(process)
        _await_health(port)
        print(f"smoke test: ok (port {port})")
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()


def _await_port(process: subprocess.Popen[str]) -> int:
    deadline = time.monotonic() + STARTUP_TIMEOUT
    assert process.stdout is not None
    while time.monotonic() < deadline:
        line = process.stdout.readline()
        if not line:
            raise SystemExit("sidecar exited before reporting a port")
        if line.startswith(PORT_BANNER):
            return int(line[len(PORT_BANNER) :].strip())
        print(f"  | {line.rstrip()}")
    raise SystemExit("sidecar never reported a port")


def _await_health(port: int) -> None:
    url = f"http://127.0.0.1:{port}/api/health"
    deadline = time.monotonic() + STARTUP_TIMEOUT
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, OSError) as exc:  # not up yet
            last = exc
        time.sleep(0.25)
    raise SystemExit(f"sidecar never became healthy: {last}")


def report_size() -> None:
    total = sum(f.stat().st_size for f in BUNDLE.rglob("*") if f.is_file())
    print(f"bundle: {BUNDLE} ({total / 1024 / 1024:.0f} MB)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--no-clean",
        action="store_true",
        help="Reuse the previous build directory. Faster, and occasionally wrong.",
    )
    parser.add_argument(
        "--no-smoke-test",
        action="store_true",
        help="Skip starting the built binary.",
    )
    args = parser.parse_args()

    build(clean=not args.no_clean)
    report_size()
    if not args.no_smoke_test:
        smoke_test()
    return 0


if __name__ == "__main__":
    sys.exit(main())
