//! Reading and writing saved detection results.

use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{ErrorCode, OptionalExtension, Row, params, params_from_iter};

use super::db::Database;
use super::images::ImageStore;
use crate::detection::loader::Format;

#[derive(Debug, Clone, PartialEq)]
pub struct StoredDetection {
    pub label: String,
    pub confidence: f64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredResult {
    pub id: String,
    pub file_name: String,
    pub file_size: u64,
    pub image_ext: String,
    pub image_width: u32,
    pub image_height: u32,
    pub processing_time: f64,
    pub model_name: String,
    pub tiles_processed: u32,
    pub created_at: String,
    pub detections: Vec<StoredDetection>,
}

/// Everything about a check except the parts the store owns.
pub struct NewResult<'a> {
    pub id: &'a str,
    pub file_name: &'a str,
    pub bytes: &'a [u8],
    pub format: Format,
    pub image_width: u32,
    pub image_height: u32,
    pub processing_time: f64,
    pub model_name: &'a str,
    pub tiles_processed: u32,
    pub detections: Vec<StoredDetection>,
}

#[derive(Debug, thiserror::Error)]
pub enum SaveError {
    #[error("a result with that id is already saved")]
    Duplicate,
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub struct Repository {
    db: Database,
    images: ImageStore,
}

impl Repository {
    pub fn new(db: Database, images: ImageStore) -> Self {
        Self { db, images }
    }

    /// Persist one check: row, detections, image and thumbnail.
    ///
    /// The row is claimed *before* any bytes are written. Writing files first
    /// looks tempting, but a save under an id that already exists would then
    /// overwrite the stored photo, and the failed insert's rollback would
    /// delete the original result's files. Inserting first makes the primary
    /// key refuse the duplicate before anything on disk is touched.
    pub fn save(&self, new: NewResult<'_>) -> Result<StoredResult, SaveError> {
        let extension = new.format.extension();
        let created_at = now();
        let mut conn = self.db.lock();
        let tx = conn.transaction()?;

        let inserted = tx.execute(
            "INSERT INTO results (id, file_name, file_size, image_ext, image_width, image_height,
                                  processing_time, model_name, tiles_processed, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                new.id,
                new.file_name,
                new.bytes.len() as i64,
                extension,
                new.image_width,
                new.image_height,
                new.processing_time,
                new.model_name,
                new.tiles_processed,
                created_at,
            ],
        );
        if let Err(rusqlite::Error::SqliteFailure(e, _)) = &inserted
            && e.code == ErrorCode::ConstraintViolation
        {
            return Err(SaveError::Duplicate);
        }
        inserted?;

        {
            let mut insert = tx.prepare(
                "INSERT INTO detections (result_id, label, confidence, x, y, width, height, position)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for (position, d) in new.detections.iter().enumerate() {
                insert.execute(params![
                    new.id,
                    d.label,
                    d.confidence,
                    d.x,
                    d.y,
                    d.width,
                    d.height,
                    position as i64
                ])?;
            }
        }

        // Inside the transaction: if writing the image fails, the rows roll
        // back with it and nothing half-saved survives.
        if let Err(e) = self.images.save(new.id, new.bytes, new.format) {
            self.images.delete(new.id, extension);
            return Err(e.into());
        }
        if let Err(e) = tx.commit() {
            // Only files this call wrote; a duplicate failed long before here.
            self.images.delete(new.id, extension);
            return Err(e.into());
        }

        Ok(StoredResult {
            id: new.id.to_string(),
            file_name: new.file_name.to_string(),
            file_size: new.bytes.len() as u64,
            image_ext: extension.to_string(),
            image_width: new.image_width,
            image_height: new.image_height,
            processing_time: new.processing_time,
            model_name: new.model_name.to_string(),
            tiles_processed: new.tiles_processed,
            created_at,
            detections: new.detections,
        })
    }

    /// Newest first, detections included. Two queries rather than a join, which
    /// would repeat every result column once per detection.
    pub fn list(&self, limit: u32, offset: u32) -> rusqlite::Result<Vec<StoredResult>> {
        let conn = self.db.lock();
        let mut rows: Vec<StoredResult> = conn
            .prepare(
                "SELECT * FROM results ORDER BY created_at DESC, rowid DESC LIMIT ?1 OFFSET ?2",
            )?
            .query_map(params![limit, offset], to_result)?
            .collect::<Result<_, _>>()?;
        if rows.is_empty() {
            return Ok(rows);
        }

        let placeholders = vec!["?"; rows.len()].join(",");
        let sql = format!(
            "SELECT * FROM detections WHERE result_id IN ({placeholders}) ORDER BY position"
        );
        let mut grouped: HashMap<String, Vec<StoredDetection>> = HashMap::new();
        let mut statement = conn.prepare(&sql)?;
        let mut detection_rows =
            statement.query(params_from_iter(rows.iter().map(|r| r.id.as_str())))?;
        while let Some(row) = detection_rows.next()? {
            grouped
                .entry(row.get("result_id")?)
                .or_default()
                .push(to_detection(row)?);
        }
        for result in &mut rows {
            result.detections = grouped.remove(&result.id).unwrap_or_default();
        }
        Ok(rows)
    }

    pub fn get(&self, id: &str) -> rusqlite::Result<Option<StoredResult>> {
        let conn = self.db.lock();
        let Some(mut result) = conn
            .query_row("SELECT * FROM results WHERE id = ?1", [id], to_result)
            .optional()?
        else {
            return Ok(None);
        };
        result.detections = conn
            .prepare("SELECT * FROM detections WHERE result_id = ?1 ORDER BY position")?
            .query_map([id], to_detection)?
            .collect::<Result<_, _>>()?;
        Ok(Some(result))
    }

    pub fn delete(&self, id: &str) -> rusqlite::Result<bool> {
        let conn = self.db.lock();
        let Some(ext): Option<String> = conn
            .query_row("SELECT image_ext FROM results WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()?
        else {
            return Ok(false);
        };
        // Detections go with it via ON DELETE CASCADE.
        conn.execute("DELETE FROM results WHERE id = ?1", [id])?;
        drop(conn);
        self.images.delete(id, &ext);
        Ok(true)
    }

    pub fn clear(&self) -> rusqlite::Result<usize> {
        let conn = self.db.lock();
        let rows: Vec<(String, String)> = conn
            .prepare("SELECT id, image_ext FROM results")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        conn.execute("DELETE FROM results", [])?;
        drop(conn);
        for (id, ext) in &rows {
            self.images.delete(id, ext);
        }
        Ok(rows.len())
    }

    pub fn count(&self) -> rusqlite::Result<u64> {
        self.db
            .lock()
            .query_row("SELECT COUNT(*) FROM results", [], |r| r.get::<_, i64>(0))
            .map(|n| n as u64)
    }

    /// Fold the write-ahead log into `gavia.db`, so the file alone is a
    /// complete copy of the history. Done before the library is moved.
    pub fn checkpoint(&self) -> rusqlite::Result<()> {
        self.db
            .lock()
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
    }

    /// The storage location: the folder holding `gavia.db`, `images/` and `thumbs/`.
    pub fn root(&self) -> &std::path::Path {
        self.images.root()
    }

    pub fn image_path(&self, id: &str, extension: &str) -> PathBuf {
        self.images.image_path(id, extension)
    }

    pub fn thumb_path(&self, id: &str) -> PathBuf {
        self.images.thumb_path(id)
    }
}

/// UTC to the second, in the exact format Python's `isoformat` wrote, so rows
/// from both eras sort together under `ORDER BY created_at`.
fn now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S+00:00")
        .to_string()
}

fn to_result(row: &Row<'_>) -> rusqlite::Result<StoredResult> {
    Ok(StoredResult {
        id: row.get("id")?,
        file_name: row.get("file_name")?,
        file_size: row.get::<_, i64>("file_size")? as u64,
        image_ext: row.get("image_ext")?,
        image_width: row.get("image_width")?,
        image_height: row.get("image_height")?,
        processing_time: row.get("processing_time")?,
        model_name: row.get("model_name")?,
        tiles_processed: row.get("tiles_processed")?,
        created_at: row.get("created_at")?,
        detections: Vec::new(),
    })
}

fn to_detection(row: &Row<'_>) -> rusqlite::Result<StoredDetection> {
    Ok(StoredDetection {
        label: row.get("label")?,
        confidence: row.get("confidence")?,
        x: row.get("x")?,
        y: row.get("y")?,
        width: row.get("width")?,
        height: row.get("height")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, RgbImage};
    use std::io::Cursor;

    fn jpeg() -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(RgbImage::from_pixel(64, 48, image::Rgb([1, 2, 3])))
            .write_to(&mut out, ImageFormat::Jpeg)
            .unwrap();
        out.into_inner()
    }

    fn repo(dir: &std::path::Path) -> Repository {
        Repository::new(
            Database::open(&dir.join("gavia.db")).unwrap(),
            ImageStore::new(dir).unwrap(),
        )
    }

    fn detection(confidence: f64) -> StoredDetection {
        StoredDetection {
            label: "Loon".into(),
            confidence,
            x: 1.0,
            y: 2.0,
            width: 3.0,
            height: 4.0,
        }
    }

    fn new<'a>(id: &'a str, bytes: &'a [u8], detections: Vec<StoredDetection>) -> NewResult<'a> {
        NewResult {
            id,
            file_name: "loon.jpg",
            bytes,
            format: Format::Jpeg,
            image_width: 64,
            image_height: 48,
            processing_time: 0.2,
            model_name: "loon_v1",
            tiles_processed: 1,
            detections,
        }
    }

    #[test]
    fn saves_and_reads_back_a_result() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo(dir.path());
        let bytes = jpeg();
        let saved = repo
            .save(new("r1", &bytes, vec![detection(0.9), detection(0.4)]))
            .unwrap();

        assert_eq!(saved.file_size, bytes.len() as u64);
        assert_eq!(repo.get("r1").unwrap().unwrap(), saved);
        assert_eq!(std::fs::read(repo.image_path("r1", ".jpg")).unwrap(), bytes);
        assert!(repo.thumb_path("r1").exists());
        assert_eq!(repo.count().unwrap(), 1);
    }

    #[test]
    fn keeps_detections_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo(dir.path());
        let bytes = jpeg();
        repo.save(new(
            "r1",
            &bytes,
            vec![detection(0.3), detection(0.9), detection(0.5)],
        ))
        .unwrap();
        let got: Vec<f64> = repo
            .get("r1")
            .unwrap()
            .unwrap()
            .detections
            .iter()
            .map(|d| d.confidence)
            .collect();
        assert_eq!(got, vec![0.3, 0.9, 0.5]);
    }

    #[test]
    fn a_duplicate_save_leaves_the_original_untouched() {
        // The regression behind the insert-before-files ordering.
        let dir = tempfile::tempdir().unwrap();
        let repo = repo(dir.path());
        let first = jpeg();
        repo.save(new("same", &first, vec![detection(0.9)]))
            .unwrap();

        let mut second = jpeg();
        second.extend_from_slice(b"different");
        assert!(matches!(
            repo.save(new("same", &second, vec![])),
            Err(SaveError::Duplicate)
        ));

        assert_eq!(
            std::fs::read(repo.image_path("same", ".jpg")).unwrap(),
            first
        );
        assert!(repo.thumb_path("same").exists());
        assert_eq!(repo.get("same").unwrap().unwrap().detections.len(), 1);
    }

    #[test]
    fn lists_newest_first_with_paging() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo(dir.path());
        let bytes = jpeg();
        for id in ["a", "b", "c"] {
            repo.save(new(id, &bytes, vec![detection(0.5)])).unwrap();
        }
        // Same second, so rowid breaks the tie: last saved comes first.
        let ids: Vec<String> = repo
            .list(200, 0)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["c", "b", "a"]);
        let page: Vec<String> = repo.list(1, 1).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(page, vec!["b"]);
        assert!(
            repo.list(200, 0)
                .unwrap()
                .iter()
                .all(|r| r.detections.len() == 1)
        );
    }

    #[test]
    fn delete_removes_row_detections_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo(dir.path());
        let bytes = jpeg();
        repo.save(new("r1", &bytes, vec![detection(0.5)])).unwrap();
        assert!(repo.delete("r1").unwrap());
        assert!(repo.get("r1").unwrap().is_none());
        assert!(!repo.image_path("r1", ".jpg").exists());
        assert!(!repo.thumb_path("r1").exists());
        assert!(!repo.delete("r1").unwrap());
        let orphans: i64 = repo
            .db
            .lock()
            .query_row("SELECT COUNT(*) FROM detections", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0);
    }

    #[test]
    fn clear_removes_everything_and_counts_it() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo(dir.path());
        let bytes = jpeg();
        for id in ["a", "b"] {
            repo.save(new(id, &bytes, vec![])).unwrap();
        }
        assert_eq!(repo.clear().unwrap(), 2);
        assert_eq!(repo.count().unwrap(), 0);
        assert!(!repo.image_path("a", ".jpg").exists());
    }

    #[test]
    fn timestamps_match_the_python_format() {
        let stamp = now();
        assert_eq!(stamp.len(), "2026-09-22T12:00:00+00:00".len());
        assert!(stamp.ends_with("+00:00"));
    }
}
