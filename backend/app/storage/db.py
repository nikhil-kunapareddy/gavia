"""SQLite schema and connection handling.

Deliberately raw ``sqlite3`` rather than an ORM. The schema is two tables that
will not grow much, the queries are simple, and a desktop bundle is smaller and
starts faster without SQLAlchemy in it.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS results (
    id              TEXT PRIMARY KEY,
    file_name       TEXT    NOT NULL,
    file_size       INTEGER NOT NULL,
    image_ext       TEXT    NOT NULL,
    image_width     INTEGER NOT NULL,
    image_height    INTEGER NOT NULL,
    processing_time REAL    NOT NULL,
    model_name      TEXT    NOT NULL,
    tiles_processed INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS detections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    result_id  TEXT    NOT NULL REFERENCES results(id) ON DELETE CASCADE,
    label      TEXT    NOT NULL,
    confidence REAL    NOT NULL,
    x          REAL    NOT NULL,
    y          REAL    NOT NULL,
    width      REAL    NOT NULL,
    height     REAL    NOT NULL,
    position   INTEGER NOT NULL
);

-- History is always read newest-first, and detections always by parent.
CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_detections_result  ON detections(result_id, position);
"""


class Database:
    """Owns one connection per thread.

    SQLite connections are not safe to share across threads, and inference runs
    in a worker thread pool, so each thread gets its own. WAL mode lets a read
    on one thread proceed while another writes.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._local = threading.local()
        self._migrate_lock = threading.Lock()
        with self._migrate_lock:
            self._migrate(self.connection)

    @property
    def path(self) -> Path:
        return self._path

    @property
    def connection(self) -> sqlite3.Connection:
        existing = getattr(self._local, "connection", None)
        if existing is not None:
            return existing

        connection = sqlite3.connect(
            self._path,
            # Every statement we run is short; failing fast beats a UI that
            # hangs on a lock we will never win.
            timeout=5.0,
            isolation_level=None,  # autocommit; transactions are explicit
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA synchronous = NORMAL")
        self._local.connection = connection
        return connection

    def close(self) -> None:
        connection = getattr(self._local, "connection", None)
        if connection is not None:
            connection.close()
            self._local.connection = None

    def _migrate(self, connection: sqlite3.Connection) -> None:
        """Bring the database up to ``SCHEMA_VERSION``.

        ``user_version`` is a SQLite built-in, so versioning costs no table of
        its own. Migrations are forward-only: a downgrade would mean an older
        build silently reading a newer schema, which is worse than refusing.
        """
        current = connection.execute("PRAGMA user_version").fetchone()[0]

        if current > SCHEMA_VERSION:
            raise RuntimeError(
                f"Database at {self._path} has schema version {current}, but this "
                f"build understands {SCHEMA_VERSION}. It was written by a newer "
                "version of Gavia."
            )

        if current == SCHEMA_VERSION:
            return

        logger.info(
            "migrating database", extra={"from": current, "to": SCHEMA_VERSION}
        )
        with connection:
            connection.executescript(_SCHEMA)
            connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
