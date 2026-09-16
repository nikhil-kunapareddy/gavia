# -*- mode: python ; coding: utf-8 -*-
"""Freeze the backend into the binary the desktop shell spawns.

Built as a *directory*, not a one-file archive. One-file re-extracts the whole
~200MB payload into a temp directory on every launch, which the user waits
through each time they open the app; a directory is mapped in place and starts
in about the time uvicorn itself needs.

Run it through `backend/scripts/build_sidecar.py`, which knows where the output
has to land for Tauri to bundle it.
"""

from pathlib import Path

BACKEND = Path(SPECPATH)

# The model travels inside the bundle. `Settings.model_path` resolves against
# `_MEIPASS` when frozen, so `models/` here is where it will look.
datas = [
    (str(BACKEND / "models" / "loon_v1.onnx"), "models"),
    (str(BACKEND / "models" / "loon_v1.json"), "models"),
]

# uvicorn resolves its loop and protocol implementations by string at runtime,
# so static analysis never sees them.
hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
]

# Nothing here is reachable from the app; excluding them keeps the bundle from
# quietly absorbing a plotting stack or a test runner.
excludes = [
    "tkinter",
    "matplotlib",
    "pytest",
    "IPython",
    "notebook",
    "PIL.ImageTk",
    "PIL.ImageQt",
]

a = Analysis(
    [str(BACKEND / "app" / "__main__.py")],
    pathex=[str(BACKEND)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="gavia-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="gavia-backend",
)
