"""Storing the original image and its thumbnail on disk.

Images live on the filesystem rather than in SQLite. A saved check embeds a
multi-megabyte photo; putting those in the database bloats every backup and
makes the common query (list the history) drag the images along with it.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from PIL import Image

from app.detection.loader import open_image

logger = logging.getLogger(__name__)

EXTENSIONS = {"JPEG": ".jpg", "MPO": ".jpg", "PNG": ".png", "WEBP": ".webp"}


class ImageStore:
    """Content-addressed by result id, never by anything a client sends."""

    def __init__(self, images_dir: Path, thumbs_dir: Path, *, thumbnail_size: int = 320):
        self._images = images_dir
        self._thumbs = thumbs_dir
        self._thumbnail_size = thumbnail_size

    @staticmethod
    def extension_for(image_format: str) -> str:
        """The extension a format will be stored under.

        Available before writing anything, so a caller can record the path in
        the database and only then commit bytes to disk.
        """
        return EXTENSIONS.get(image_format, ".jpg")

    def image_path(self, result_id: str, extension: str) -> Path:
        return self._images / f"{result_id}{extension}"

    def thumb_path(self, result_id: str) -> Path:
        return self._thumbs / f"{result_id}.webp"

    def save(self, result_id: str, source: Path, image_format: str) -> str:
        """Copy the original in unmodified and render a thumbnail.

        The original is copied byte-for-byte: this is a research tool, and a
        re-encoded photo is no longer the evidence the user uploaded.

        Returns the extension the original was stored under.
        """
        extension = self.extension_for(image_format)
        destination = self.image_path(result_id, extension)
        shutil.copyfile(source, destination)

        try:
            self._write_thumbnail(result_id, destination)
        except Exception:  # noqa: BLE001
            # A missing thumbnail degrades the history grid; it must not fail
            # the save and lose the user's result.
            logger.warning("thumbnail failed", extra={"resultId": result_id}, exc_info=True)

        return extension

    def _write_thumbnail(self, result_id: str, source: Path) -> None:
        # draft() lets libjpeg decode straight to roughly thumbnail scale, so
        # a 24MP original never has to be fully decoded to make a 320px image.
        with open_image(source, target_size=self._thumbnail_size) as image:
            image.thumbnail(
                (self._thumbnail_size, self._thumbnail_size), Image.Resampling.LANCZOS
            )
            image.save(self.thumb_path(result_id), "WEBP", quality=72, method=4)

    def delete(self, result_id: str, extension: str) -> None:
        """Remove both files, tolerating either already being gone."""
        for path in (self.image_path(result_id, extension), self.thumb_path(result_id)):
            path.unlink(missing_ok=True)
