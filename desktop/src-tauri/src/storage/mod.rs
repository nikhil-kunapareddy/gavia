//! Saved history: SQLite for metadata, files on disk for images.
//!
//! Originals are kept byte-for-byte in `images/`, WebP thumbnails in `thumbs/`
//! and metadata in `gavia.db`, all under [`crate::platform::data_dir`].

pub mod db;
pub mod images;
pub mod repository;

pub use db::Database;
pub use images::ImageStore;
pub use repository::{NewResult, Repository, SaveError, StoredDetection, StoredResult};

use std::path::Path;

/// Open (creating if needed) the store rooted at `root`.
pub fn open(root: &Path) -> Result<Repository, String> {
    std::fs::create_dir_all(root)
        .map_err(|e| format!("Could not create {}: {e}", root.display()))?;
    let images =
        ImageStore::new(root).map_err(|e| format!("Could not create image folders: {e}"))?;
    let db = Database::open(&root.join("gavia.db"))?;
    Ok(Repository::new(db, images))
}
