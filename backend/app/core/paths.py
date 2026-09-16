"""Where Gavia keeps its data on disk.

A desktop app cannot write to its own install directory — on macOS it may sit
inside a signed, read-only bundle, and on Windows under Program Files. Data
belongs in the per-user location each platform designates for it.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_DIR_NAME = "Gavia"


def default_data_dir() -> Path:
    """The per-user data directory for the current platform.

    Hand-rolled rather than pulling in ``platformdirs``: it is three branches,
    and every dependency is one more thing to bundle into the desktop build.
    """
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_DIR_NAME

    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        return Path(base) / APP_DIR_NAME if base else Path.home() / APP_DIR_NAME

    # Linux and friends: XDG, which specifies this default when unset.
    base = os.environ.get("XDG_DATA_HOME")
    return Path(base) / "gavia" if base else Path.home() / ".local" / "share" / "gavia"


def ensure_data_dirs(root: Path) -> dict[str, Path]:
    """Create the data directory tree and return its parts.

    Originals and thumbnails are kept apart so that regenerating every
    thumbnail — after a size change, say — is a single directory to delete and
    cannot possibly touch a user's source images.
    """
    paths = {
        "root": root,
        "images": root / "images",
        "thumbs": root / "thumbs",
        "database": root / "gavia.db",
    }
    for key in ("root", "images", "thumbs"):
        paths[key].mkdir(parents=True, exist_ok=True)
    return paths
