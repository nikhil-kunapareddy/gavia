"""Reading and writing saved detection results."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from app.storage.db import Database
from app.storage.images import ImageStore

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class StoredDetection:
    label: str
    confidence: float
    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class StoredResult:
    id: str
    file_name: str
    file_size: int
    image_ext: str
    image_width: int
    image_height: int
    processing_time: float
    model_name: str
    tiles_processed: int
    created_at: str
    detections: list[StoredDetection]


class ResultRepository:
    def __init__(self, database: Database, images: ImageStore) -> None:
        self._db = database
        self._images = images

    def save(
        self,
        *,
        result_id: str,
        file_name: str,
        file_size: int,
        source: Path,
        image_format: str,
        image_width: int,
        image_height: int,
        processing_time: float,
        model_name: str,
        tiles_processed: int,
        detections: list[StoredDetection],
    ) -> StoredResult:
        """Persist one check: image, thumbnail, row, and its detections.

        The row is claimed *before* any bytes are written. Writing files first
        looks tempting — a row would never lack its image — but it means a save
        under an id that already exists overwrites the stored photo and then,
        when the duplicate insert fails, the rollback deletes the original
        result's files. Inserting first makes the primary key refuse the
        duplicate before anything on disk is touched.
        """
        extension = self._images.extension_for(image_format)
        created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        wrote_files = False

        connection = self._db.connection
        try:
            with connection:
                connection.execute(
                    """
                    INSERT INTO results (
                        id, file_name, file_size, image_ext, image_width, image_height,
                        processing_time, model_name, tiles_processed, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        result_id,
                        file_name,
                        file_size,
                        extension,
                        image_width,
                        image_height,
                        processing_time,
                        model_name,
                        tiles_processed,
                        created_at,
                    ),
                )
                connection.executemany(
                    """
                    INSERT INTO detections (
                        result_id, label, confidence, x, y, width, height, position
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            result_id,
                            d.label,
                            d.confidence,
                            d.x,
                            d.y,
                            d.width,
                            d.height,
                            position,
                        )
                        for position, d in enumerate(detections)
                    ],
                )

                # Inside the transaction: if writing the image throws, the
                # rows roll back with it and nothing half-saved survives.
                self._images.save(result_id, source, image_format)
                wrote_files = True
        except Exception:
            # Only clean up files this call actually wrote. A duplicate id
            # fails at the insert, before wrote_files is set, so the existing
            # result's image is left alone.
            if wrote_files:
                self._images.delete(result_id, extension)
            raise

        return StoredResult(
            id=result_id,
            file_name=file_name,
            file_size=file_size,
            image_ext=extension,
            image_width=image_width,
            image_height=image_height,
            processing_time=processing_time,
            model_name=model_name,
            tiles_processed=tiles_processed,
            created_at=created_at,
            detections=list(detections),
        )

    def list(self, *, limit: int = 200, offset: int = 0) -> list[StoredResult]:
        """Newest first, detections included.

        Two queries rather than a join: a join would repeat every result column
        once per detection, and the caller wants them nested anyway.
        """
        connection = self._db.connection
        rows = connection.execute(
            "SELECT * FROM results ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        if not rows:
            return []

        ids = [row["id"] for row in rows]
        placeholders = ",".join("?" * len(ids))
        detection_rows = connection.execute(
            f"SELECT * FROM detections WHERE result_id IN ({placeholders}) ORDER BY position",
            ids,
        ).fetchall()

        grouped: dict[str, list[StoredDetection]] = {result_id: [] for result_id in ids}
        for row in detection_rows:
            grouped[row["result_id"]].append(_to_detection(row))

        return [_to_result(row, grouped[row["id"]]) for row in rows]

    def get(self, result_id: str) -> StoredResult | None:
        connection = self._db.connection
        row = connection.execute(
            "SELECT * FROM results WHERE id = ?", (result_id,)
        ).fetchone()
        if row is None:
            return None

        detection_rows = connection.execute(
            "SELECT * FROM detections WHERE result_id = ? ORDER BY position", (result_id,)
        ).fetchall()
        return _to_result(row, [_to_detection(r) for r in detection_rows])

    def delete(self, result_id: str) -> bool:
        connection = self._db.connection
        row = connection.execute(
            "SELECT image_ext FROM results WHERE id = ?", (result_id,)
        ).fetchone()
        if row is None:
            return False

        with connection:
            # detections go with it via ON DELETE CASCADE.
            connection.execute("DELETE FROM results WHERE id = ?", (result_id,))

        self._images.delete(result_id, row["image_ext"])
        return True

    def clear(self) -> int:
        connection = self._db.connection
        rows = connection.execute("SELECT id, image_ext FROM results").fetchall()
        with connection:
            connection.execute("DELETE FROM results")

        for row in rows:
            self._images.delete(row["id"], row["image_ext"])
        return len(rows)

    def image_path(self, result_id: str, extension: str) -> Path:
        """On-disk location of a stored original."""
        return self._images.image_path(result_id, extension)

    def thumb_path(self, result_id: str) -> Path:
        """On-disk location of a stored thumbnail, which may not exist."""
        return self._images.thumb_path(result_id)

    def count(self) -> int:
        return self._db.connection.execute("SELECT COUNT(*) FROM results").fetchone()[0]


def _to_detection(row) -> StoredDetection:
    return StoredDetection(
        label=row["label"],
        confidence=row["confidence"],
        x=row["x"],
        y=row["y"],
        width=row["width"],
        height=row["height"],
    )


def _to_result(row, detections: list[StoredDetection]) -> StoredResult:
    return StoredResult(
        id=row["id"],
        file_name=row["file_name"],
        file_size=row["file_size"],
        image_ext=row["image_ext"],
        image_width=row["image_width"],
        image_height=row["image_height"],
        processing_time=row["processing_time"],
        model_name=row["model_name"],
        tiles_processed=row["tiles_processed"],
        created_at=row["created_at"],
        detections=detections,
    )
