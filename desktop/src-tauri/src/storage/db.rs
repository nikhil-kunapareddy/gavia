//! SQLite schema and the connection.
//!
//! Raw `rusqlite`, no ORM: the schema is two tables that will not grow much and
//! the queries are simple. The schema is byte-for-byte the Python backend's, so
//! a history saved by an earlier Gavia opens unchanged.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;

pub const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = "
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
";

/// One connection behind a mutex. Every statement is short and the app has one
/// user, so there is nothing to gain from a pool.
pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path)
            .map_err(|e| format!("Could not open {}: {e}", path.display()))?;
        Self::configure(connection)
    }

    pub fn in_memory() -> Result<Self, String> {
        Self::configure(Connection::open_in_memory().map_err(|e| e.to_string())?)
    }

    fn configure(mut connection: Connection) -> Result<Self, String> {
        let setup = || -> rusqlite::Result<()> {
            // Failing fast beats a UI that hangs on a lock it will never win.
            connection.busy_timeout(Duration::from_secs(5))?;
            connection.pragma_update(None, "journal_mode", "WAL")?;
            connection.pragma_update(None, "foreign_keys", "ON")?;
            connection.pragma_update(None, "synchronous", "NORMAL")?;
            Ok(())
        };
        setup().map_err(|e| e.to_string())?;
        migrate(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        // SQLite rolls back an interrupted transaction itself, so a panic while
        // holding the lock leaves the connection usable.
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Bring the database up to [`SCHEMA_VERSION`].
///
/// `user_version` is a SQLite built-in, so versioning costs no table of its
/// own. Migrations are forward-only: an older build silently reading a newer
/// schema is worse than refusing to open it.
fn migrate(connection: &mut Connection) -> Result<(), String> {
    let current: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;

    if current > SCHEMA_VERSION {
        return Err(format!(
            "The database has schema version {current}, but this build understands \
             {SCHEMA_VERSION}. It was written by a newer version of Gavia."
        ));
    }
    if current == SCHEMA_VERSION {
        return Ok(());
    }

    log::info!("migrating database from {current} to {SCHEMA_VERSION}");
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_the_schema_and_records_its_version() {
        let db = Database::in_memory().unwrap();
        let conn = db.lock();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let tables: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('results','detections')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tables, 2);
    }

    #[test]
    fn reopening_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gavia.db");
        drop(Database::open(&path).unwrap());
        Database::open(&path).unwrap();
    }

    #[test]
    fn refuses_a_database_from_a_newer_build() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gavia.db");
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", 99)
            .unwrap();
        let error = Database::open(&path).err().unwrap();
        assert!(error.contains("newer version"), "{error}");
    }

    #[test]
    fn enforces_foreign_keys() {
        let db = Database::in_memory().unwrap();
        let result = db.lock().execute(
            "INSERT INTO detections (result_id, label, confidence, x, y, width, height, position) VALUES ('nope','l',1,0,0,0,0,0)",
            [],
        );
        assert!(result.is_err());
    }
}
