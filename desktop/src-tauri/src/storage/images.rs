//! Storing the original image and its thumbnail on disk.
//!
//! Images live on the filesystem rather than in SQLite. A saved check embeds a
//! multi-megabyte photo; putting those in the database bloats every backup and
//! makes the common query (list the history) drag the images along with it.

use std::path::{Path, PathBuf};

use fast_image_resize::FilterType;

use crate::detection::loader::{self, Format, Rgb};
use crate::detection::preprocess;

pub const THUMBNAIL_SIZE: u32 = 320;
const THUMBNAIL_QUALITY: f32 = 72.0;

/// Keyed by result id, never by anything a client sends.
pub struct ImageStore {
    root: PathBuf,
    images: PathBuf,
    thumbs: PathBuf,
}

impl ImageStore {
    /// Originals and thumbnails are kept apart so regenerating every thumbnail
    /// is one directory to delete and cannot touch a user's source images.
    pub fn new(root: &Path) -> std::io::Result<Self> {
        let store = Self {
            root: root.to_path_buf(),
            images: root.join("images"),
            thumbs: root.join("thumbs"),
        };
        std::fs::create_dir_all(&store.images)?;
        std::fs::create_dir_all(&store.thumbs)?;
        Ok(store)
    }

    /// The storage location this store writes under.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn image_path(&self, result_id: &str, extension: &str) -> PathBuf {
        self.images.join(format!("{result_id}{extension}"))
    }

    pub fn thumb_path(&self, result_id: &str) -> PathBuf {
        self.thumbs.join(format!("{result_id}.webp"))
    }

    /// Write the original byte-for-byte and render a thumbnail.
    ///
    /// This is a research tool: a re-encoded photo is no longer the evidence
    /// the user uploaded. A thumbnail failure only degrades the history grid,
    /// so it is logged and swallowed rather than failing the save.
    pub fn save(&self, result_id: &str, bytes: &[u8], format: Format) -> std::io::Result<()> {
        std::fs::write(self.image_path(result_id, format.extension()), bytes)?;
        match thumbnail(bytes) {
            Ok(webp) => {
                if let Err(e) = std::fs::write(self.thumb_path(result_id), webp) {
                    log::warn!("thumbnail for {result_id} could not be written: {e}");
                }
            }
            Err(e) => log::warn!("thumbnail for {result_id} failed: {e}"),
        }
        Ok(())
    }

    /// Remove both files, tolerating either already being gone.
    pub fn delete(&self, result_id: &str, extension: &str) {
        for path in [
            self.image_path(result_id, extension),
            self.thumb_path(result_id),
        ] {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => log::warn!("could not delete {}: {e}", path.display()),
            }
        }
    }
}

/// A lossy WebP no larger than [`THUMBNAIL_SIZE`] on either side.
pub fn thumbnail(bytes: &[u8]) -> Result<Vec<u8>, String> {
    // Drafted decode: a 24MP original never has to exist at full size.
    let image = loader::open_image(bytes, Some(THUMBNAIL_SIZE)).map_err(|e| e.to_string())?;
    let (w, h) = fit_within(image.width, image.height, THUMBNAIL_SIZE);
    let pixels = if (w, h) == (image.width, image.height) {
        image.data
    } else {
        preprocess::resize(&image, w, h, FilterType::Lanczos3)
    };
    let small = Rgb {
        width: w,
        height: h,
        data: pixels,
    };
    Ok(
        webp::Encoder::from_rgb(&small.data, small.width, small.height)
            .encode(THUMBNAIL_QUALITY)
            .to_vec(),
    )
}

/// Pillow's `thumbnail()` sizing: shrink to fit, never enlarge, and pick
/// whichever of floor and ceil keeps the aspect ratio closer.
pub fn fit_within(width: u32, height: u32, bound: u32) -> (u32, u32) {
    if width <= bound && height <= bound {
        return (width, height);
    }
    let aspect = f64::from(width) / f64::from(height);
    let closest = |exact: f64, error: &dyn Fn(f64) -> f64| {
        let (lo, hi) = (exact.floor(), exact.ceil());
        (if error(lo) <= error(hi) { lo } else { hi }).max(1.0) as u32
    };
    let b = f64::from(bound);
    if aspect >= 1.0 {
        (
            bound,
            closest(b / aspect, &|n| {
                if n == 0.0 {
                    f64::INFINITY
                } else {
                    (aspect - b / n).abs()
                }
            }),
        )
    } else {
        (closest(b * aspect, &|n| (aspect - n / b).abs()), bound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, RgbImage};
    use std::io::Cursor;

    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(RgbImage::from_pixel(
            width,
            height,
            image::Rgb([40, 120, 200]),
        ))
        .write_to(&mut out, ImageFormat::Jpeg)
        .unwrap();
        out.into_inner()
    }

    #[test]
    fn fits_like_pillow() {
        assert_eq!(fit_within(4000, 3000, 320), (320, 240));
        assert_eq!(fit_within(3000, 4000, 320), (240, 320));
        assert_eq!(fit_within(100, 50, 320), (100, 50));
        assert_eq!(fit_within(10000, 10, 320), (320, 1));
    }

    #[test]
    fn stores_the_original_untouched_and_a_webp_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let store = ImageStore::new(dir.path()).unwrap();
        let bytes = jpeg(1200, 800);
        store.save("abc", &bytes, Format::Jpeg).unwrap();

        assert_eq!(
            std::fs::read(store.image_path("abc", ".jpg")).unwrap(),
            bytes
        );
        let thumb = std::fs::read(store.thumb_path("abc")).unwrap();
        assert_eq!(&thumb[8..12], b"WEBP");
        let decoded = image::load_from_memory(&thumb).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (320, 213));
    }

    #[test]
    fn a_bad_thumbnail_does_not_fail_the_save() {
        let dir = tempfile::tempdir().unwrap();
        let store = ImageStore::new(dir.path()).unwrap();
        store
            .save("broken", b"\xFF\xD8\xFFnot really", Format::Jpeg)
            .unwrap();
        assert!(store.image_path("broken", ".jpg").exists());
        assert!(!store.thumb_path("broken").exists());
    }

    #[test]
    fn delete_tolerates_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = ImageStore::new(dir.path()).unwrap();
        store.delete("never-saved", ".jpg");
    }
}
