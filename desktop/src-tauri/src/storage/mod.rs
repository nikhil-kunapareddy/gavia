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

use std::path::{Path, PathBuf};

/// Open (creating if needed) the store rooted at `root`.
pub fn open(root: &Path) -> Result<Repository, String> {
    std::fs::create_dir_all(root)
        .map_err(|e| format!("Could not create {}: {e}", root.display()))?;
    let images =
        ImageStore::new(root).map_err(|e| format!("Could not create image folders: {e}"))?;
    let db = Database::open(&root.join("gavia.db"))?;
    Ok(Repository::new(db, images))
}

/// What Gavia keeps in a storage location, and so what a move carries along.
const LIBRARY_ENTRIES: [&str; 4] = ["gavia.db", "images", "thumbs", "models"];

/// Where history ends up when the user picks `folder` as its new home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Destination {
    /// The folder already holds a Gavia history: switch to it, move nothing.
    Existing(PathBuf),
    /// An empty (or new) folder: move the current history into it.
    Empty(PathBuf),
}

impl Destination {
    pub fn path(&self) -> &Path {
        match self {
            Destination::Existing(p) | Destination::Empty(p) => p,
        }
    }
}

/// Decide where a history chosen as `folder` should live.
///
/// Picking a folder that already has a history reopens it. Picking an empty
/// folder uses it directly. Picking a folder with other things in it — say
/// Documents — puts the history in a `Gavia` folder inside, rather than
/// scattering `gavia.db` and `images/` among the user's own files.
pub fn resolve_destination(folder: &Path) -> Result<Destination, String> {
    let is_library = |dir: &Path| dir.join("gavia.db").is_file();
    let is_empty = |dir: &Path| match std::fs::read_dir(dir) {
        Ok(mut entries) => entries.next().is_none(),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    };

    if is_library(folder) {
        return Ok(Destination::Existing(folder.to_path_buf()));
    }
    if is_empty(folder) {
        return Ok(Destination::Empty(folder.to_path_buf()));
    }
    let nested = folder.join("Gavia");
    if is_library(&nested) {
        return Ok(Destination::Existing(nested));
    }
    if is_empty(&nested) {
        return Ok(Destination::Empty(nested));
    }
    Err(format!(
        "{} already has a Gavia folder that isn't a Gavia history. Choose another folder.",
        folder.display()
    ))
}

/// Copy a history from `from` into the empty folder `to`.
///
/// Copies rather than renames: if anything fails partway, the original is
/// untouched and the partial copy is removed. The caller checkpoints the
/// database first so `gavia.db` is complete on its own.
pub fn copy_library(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    let copied = (|| {
        for name in LIBRARY_ENTRIES {
            let source = from.join(name);
            if source.is_dir() {
                copy_dir(&source, &to.join(name))?;
            } else if source.is_file() {
                std::fs::copy(&source, to.join(name))?;
            }
        }
        Ok(())
    })();
    if copied.is_err() {
        remove_library(to);
    }
    copied
}

/// Delete Gavia's own files from `dir`, and `dir` itself if that empties it.
/// Anything else the user keeps there is left alone.
pub fn remove_library(dir: &Path) {
    for name in LIBRARY_ENTRIES
        .iter()
        .chain(&["gavia.db-wal", "gavia.db-shm"])
    {
        let path = dir.join(name);
        let removed = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(e) = removed
            && e.kind() != std::io::ErrorKind::NotFound
        {
            log::warn!("could not remove {}: {e}", path.display());
        }
    }
    let _ = std::fs::remove_dir(dir);
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_existing_history_is_reopened() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("gavia.db"), b"").unwrap();
        assert_eq!(
            resolve_destination(dir.path()),
            Ok(Destination::Existing(dir.path().into()))
        );
    }

    #[test]
    fn empty_and_missing_folders_are_used_directly() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_destination(dir.path()),
            Ok(Destination::Empty(dir.path().into()))
        );
        let missing = dir.path().join("new");
        assert_eq!(
            resolve_destination(&missing),
            Ok(Destination::Empty(missing))
        );
    }

    #[test]
    fn a_busy_folder_gets_a_gavia_folder_inside() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"mine").unwrap();
        assert_eq!(
            resolve_destination(dir.path()),
            Ok(Destination::Empty(dir.path().join("Gavia")))
        );
        std::fs::create_dir(dir.path().join("Gavia")).unwrap();
        std::fs::write(dir.path().join("Gavia/gavia.db"), b"").unwrap();
        assert_eq!(
            resolve_destination(dir.path()),
            Ok(Destination::Existing(dir.path().join("Gavia")))
        );
    }

    #[test]
    fn refuses_a_gavia_folder_that_is_not_a_history() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"mine").unwrap();
        std::fs::create_dir(dir.path().join("Gavia")).unwrap();
        std::fs::write(dir.path().join("Gavia/other.txt"), b"x").unwrap();
        assert!(resolve_destination(dir.path()).is_err());
    }

    #[test]
    fn copies_and_removes_only_gavia_files() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        let target = to.path().join("lib");
        std::fs::write(from.path().join("gavia.db"), b"db").unwrap();
        std::fs::create_dir_all(from.path().join("images")).unwrap();
        std::fs::write(from.path().join("images/a.jpg"), b"img").unwrap();
        std::fs::write(from.path().join("keep.txt"), b"user file").unwrap();

        copy_library(from.path(), &target).unwrap();
        assert_eq!(std::fs::read(target.join("images/a.jpg")).unwrap(), b"img");
        assert!(!target.join("keep.txt").exists());

        remove_library(from.path());
        assert!(!from.path().join("gavia.db").exists());
        assert!(!from.path().join("images").exists());
        assert!(from.path().join("keep.txt").exists());
    }
}
