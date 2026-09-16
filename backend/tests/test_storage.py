"""Persistence: the database, the image files, and keeping the two in step."""

from __future__ import annotations

import sqlite3
import threading

import pytest

from app.storage.db import SCHEMA_VERSION, Database
from app.storage.images import ImageStore
from app.storage.repository import ResultRepository, StoredDetection
from tests.conftest import make_image


@pytest.fixture
def store(tmp_path):
    images = tmp_path / "images"
    thumbs = tmp_path / "thumbs"
    images.mkdir()
    thumbs.mkdir()
    return ImageStore(images, thumbs, thumbnail_size=320)


@pytest.fixture
def repository(tmp_path, store):
    return ResultRepository(Database(tmp_path / "gavia.db"), store)


@pytest.fixture
def source_image(tmp_path):
    path = tmp_path / "source.jpg"
    path.write_bytes(make_image(1200, 900))
    return path


def detection(confidence=0.9, x=10.0):
    return StoredDetection(
        label="Loon", confidence=confidence, x=x, y=20.0, width=30.0, height=40.0
    )


def save(repository, source_image, result_id="abc", detections=None, **overrides):
    payload = {
        "result_id": result_id,
        "file_name": "photo.jpg",
        "file_size": 1000,
        "source": source_image,
        "image_format": "JPEG",
        "image_width": 1200,
        "image_height": 900,
        "processing_time": 0.2,
        "model_name": "loon_v1",
        "tiles_processed": 1,
        "detections": detections if detections is not None else [detection()],
    }
    payload.update(overrides)
    return repository.save(**payload)


class TestSchema:
    def test_creates_the_schema_at_the_current_version(self, tmp_path):
        database = Database(tmp_path / "gavia.db")
        version = database.connection.execute("PRAGMA user_version").fetchone()[0]
        assert version == SCHEMA_VERSION

    def test_opening_an_existing_database_is_idempotent(self, tmp_path):
        path = tmp_path / "gavia.db"
        Database(path)
        Database(path)  # must not re-run migrations or throw

    def test_refuses_a_database_from_a_newer_build(self, tmp_path):
        """Silently reading a future schema is worse than refusing to start."""
        path = tmp_path / "gavia.db"
        Database(path)
        connection = sqlite3.connect(path)
        connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 5}")
        connection.commit()
        connection.close()

        with pytest.raises(RuntimeError, match="newer version"):
            Database(path)

    def test_foreign_keys_are_enforced(self, tmp_path):
        database = Database(tmp_path / "gavia.db")
        with pytest.raises(sqlite3.IntegrityError):
            database.connection.execute(
                "INSERT INTO detections (result_id, label, confidence, x, y, width, height, position)"
                " VALUES ('ghost', 'Loon', 0.5, 0, 0, 1, 1, 0)"
            )

    def test_uses_wal_so_a_read_is_not_blocked_by_a_write(self, tmp_path):
        database = Database(tmp_path / "gavia.db")
        mode = database.connection.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode.lower() == "wal"

    def test_each_thread_gets_its_own_connection(self, tmp_path):
        """Inference runs in a thread pool, and sqlite3 connections are not
        safe to share across threads."""
        database = Database(tmp_path / "gavia.db")
        seen = []

        def record():
            seen.append(id(database.connection))

        thread = threading.Thread(target=record)
        thread.start()
        thread.join()

        assert seen[0] != id(database.connection)


class TestSaveAndRead:
    def test_round_trips_a_result(self, repository, source_image):
        save(repository, source_image, detections=[detection(0.94)])

        stored = repository.get("abc")
        assert stored is not None
        assert stored.file_name == "photo.jpg"
        assert stored.image_width == 1200
        assert len(stored.detections) == 1
        assert stored.detections[0].confidence == pytest.approx(0.94)

    def test_writes_the_original_and_a_thumbnail(self, repository, source_image, store):
        save(repository, source_image)

        assert store.image_path("abc", ".jpg").exists()
        assert store.thumb_path("abc").exists()

    def test_the_original_is_copied_byte_for_byte(self, repository, source_image, store):
        save(repository, source_image)
        assert store.image_path("abc", ".jpg").read_bytes() == source_image.read_bytes()

    def test_the_thumbnail_is_much_smaller(self, repository, source_image, store):
        save(repository, source_image)
        original = store.image_path("abc", ".jpg").stat().st_size
        assert store.thumb_path("abc").stat().st_size < original / 4

    def test_detection_order_is_preserved(self, repository, source_image):
        ordered = [detection(0.9, x=1), detection(0.8, x=2), detection(0.7, x=3)]
        save(repository, source_image, detections=ordered)

        stored = repository.get("abc")
        assert [d.x for d in stored.detections] == [1, 2, 3]

    def test_a_result_with_no_detections_is_still_a_result(self, repository, source_image):
        """"No loon here" is a finding worth keeping, not an empty record."""
        save(repository, source_image, detections=[])

        stored = repository.get("abc")
        assert stored is not None
        assert stored.detections == []

    def test_missing_result_is_none(self, repository):
        assert repository.get("nope") is None

    @pytest.mark.parametrize(
        "fmt,extension", [("JPEG", ".jpg"), ("PNG", ".png"), ("WEBP", ".webp"), ("MPO", ".jpg")]
    )
    def test_stores_each_format_under_the_right_extension(
        self, repository, tmp_path, fmt, extension
    ):
        source = tmp_path / "in.bin"
        source.write_bytes(make_image(fmt="JPEG" if fmt == "MPO" else fmt))

        stored = save(repository, source, image_format=fmt)
        assert stored.image_ext == extension


class TestListing:
    def test_lists_newest_first(self, repository, source_image):
        save(repository, source_image, result_id="first")
        save(repository, source_image, result_id="second")

        assert [r.id for r in repository.list()] == ["second", "first"]

    def test_paginates(self, repository, source_image):
        for index in range(5):
            save(repository, source_image, result_id=f"r{index}")

        page = repository.list(limit=2, offset=2)
        assert len(page) == 2

    def test_empty_history_is_an_empty_list(self, repository):
        assert repository.list() == []

    def test_detections_are_grouped_with_the_right_parent(self, repository, source_image):
        """The listing fetches detections in one query and regroups them; a
        mistake here silently attributes one photo's loons to another."""
        save(repository, source_image, result_id="a", detections=[detection(0.9, x=1)])
        save(
            repository,
            source_image,
            result_id="b",
            detections=[detection(0.8, x=2), detection(0.7, x=3)],
        )

        by_id = {row.id: row for row in repository.list()}
        assert [d.x for d in by_id["a"].detections] == [1]
        assert [d.x for d in by_id["b"].detections] == [2, 3]

    def test_count(self, repository, source_image):
        save(repository, source_image, result_id="a")
        save(repository, source_image, result_id="b")
        assert repository.count() == 2


class TestDeletion:
    def test_delete_removes_the_row_and_both_files(self, repository, source_image, store):
        save(repository, source_image)

        assert repository.delete("abc") is True
        assert repository.get("abc") is None
        assert not store.image_path("abc", ".jpg").exists()
        assert not store.thumb_path("abc").exists()

    def test_delete_cascades_to_detections(self, repository, source_image):
        save(repository, source_image, detections=[detection(), detection(0.5, x=50)])
        repository.delete("abc")

        remaining = repository._db.connection.execute(  # noqa: SLF001
            "SELECT COUNT(*) FROM detections"
        ).fetchone()[0]
        assert remaining == 0

    def test_deleting_something_absent_reports_false(self, repository):
        assert repository.delete("nope") is False

    def test_clear_removes_everything_and_reports_the_count(
        self, repository, source_image, store
    ):
        save(repository, source_image, result_id="a")
        save(repository, source_image, result_id="b")

        assert repository.clear() == 2
        assert repository.list() == []
        assert not any(store._images.iterdir())  # noqa: SLF001

    def test_clear_on_an_empty_history_is_zero(self, repository):
        assert repository.clear() == 0


class TestFailureHandling:
    def test_a_failed_insert_leaves_no_orphaned_files(self, repository, source_image, store):
        """Files are written before the row, so the write has to be undone if
        the row never lands."""
        save(repository, source_image, result_id="abc")

        with pytest.raises(sqlite3.IntegrityError):
            save(repository, source_image, result_id="abc")  # duplicate primary key

        # The retry's files must not have clobbered or outlived the original.
        assert store.image_path("abc", ".jpg").exists()
        assert repository.count() == 1

    def test_a_thumbnail_failure_does_not_lose_the_result(
        self, repository, tmp_path, store
    ):
        """Thumbnailing is cosmetic; failing it must not discard the user's work."""
        unreadable = tmp_path / "broken.jpg"
        unreadable.write_bytes(b"\xff\xd8 not really a jpeg")

        stored = save(repository, unreadable)

        assert repository.get(stored.id) is not None
        assert not store.thumb_path(stored.id).exists()

    def test_image_store_delete_tolerates_missing_files(self, store):
        store.delete("never-existed", ".jpg")  # must not raise
