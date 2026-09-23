//! Decoding user-supplied photographs safely and cheaply.
//!
//! Everything here is header inspection until the last possible moment: the
//! format is sniffed from magic bytes, the pixel count is checked against
//! [`MAX_PIXELS`] and the EXIF orientation is read, all before a single pixel
//! is decoded. The point of the size guard is to refuse the allocation, not to
//! survive it.

use std::io::Cursor;

use image::metadata::Orientation;
use image::{DynamicImage, ImageFormat, RgbImage};

/// A 24MP photo is ~24e6 pixels; this leaves generous headroom for panoramas
/// while still refusing a decompression bomb that claims to be 2 gigapixels.
pub const MAX_PIXELS: u64 = 120_000_000;

/// What the uploader accepts. MPO is not listed separately because it is not
/// really a separate format: it is a JPEG carrying extra frames, produced by
/// plenty of phones and cameras (7% of the training set), and decoding it as
/// a JPEG yields frame 0 — the full-size primary image — which is what we want.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Jpeg,
    Png,
    Webp,
}

impl Format {
    /// The extension an original is stored under.
    pub fn extension(self) -> &'static str {
        match self {
            Format::Jpeg => ".jpg",
            Format::Png => ".png",
            Format::Webp => ".webp",
        }
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum LoadError {
    #[error("{0}")]
    Decode(String),
    #[error("{0}")]
    TooLarge(String),
    #[error("{0}")]
    Unsupported(String),
}

/// Trust the file's own header over anything the client said about it.
pub fn sniff(bytes: &[u8]) -> Result<Format, LoadError> {
    if bytes.is_empty() {
        return Err(LoadError::Unsupported("The uploaded file is empty.".into()));
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Ok(Format::Jpeg);
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(Format::Png);
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok(Format::Webp);
    }

    // Recognisable but unsupported formats get a message naming them; anything
    // else is simply not an image.
    let known = [
        (&b"GIF8"[..], "GIF"),
        (&b"BM"[..], "BMP"),
        (&b"II*\0"[..], "TIFF"),
        (&b"MM\0*"[..], "TIFF"),
    ];
    for (magic, name) in known {
        if bytes.starts_with(magic) {
            return Err(LoadError::Unsupported(format!(
                "{name} is not a supported image format."
            )));
        }
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return Err(LoadError::Unsupported(
            "HEIF is not a supported image format.".into(),
        ));
    }
    Err(LoadError::Decode(
        "The file is not a readable image.".into(),
    ))
}

/// Post-rotation dimensions from the header alone, decoding no pixels.
///
/// Used to choose between a drafted single pass and full-resolution tiling, a
/// decision that has to be made *before* committing to a decode strategy.
pub fn read_dimensions(bytes: &[u8]) -> Result<(u32, u32), LoadError> {
    let format = sniff(bytes)?;
    let (width, height) = raw_dimensions(bytes, format)?;
    Ok(if swaps_axes(orientation(bytes)) {
        (height, width)
    } else {
        (width, height)
    })
}

/// An 8-bit RGB image, row-major.
#[derive(Debug, Clone)]
pub struct Rgb {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// Decode an image, applying EXIF rotation and normalising to RGB.
///
/// `target_size` is a hint, not a resize: for JPEGs it reduces by 2, 4 or 8,
/// choosing the factor exactly as Pillow's `draft()` did in the Python
/// pipeline the model was evaluated on. Pass `None` when tiling, where full
/// resolution is the entire point.
pub fn open_image(bytes: &[u8], target_size: Option<u32>) -> Result<Rgb, LoadError> {
    let format = sniff(bytes)?;
    let (width, height) = raw_dimensions(bytes, format)?;

    let pixels = u64::from(width) * u64::from(height);
    if pixels > MAX_PIXELS {
        return Err(LoadError::TooLarge(format!(
            "Image is {:.0} megapixels; the limit is {:.0}.",
            pixels as f64 / 1e6,
            MAX_PIXELS as f64 / 1e6
        )));
    }

    let decoded = match format {
        Format::Jpeg => decode_jpeg(bytes, width, height, target_size)?,
        Format::Png | Format::Webp => {
            let image_format = if format == Format::Png {
                ImageFormat::Png
            } else {
                ImageFormat::WebP
            };
            let image = image::load_from_memory_with_format(bytes, image_format)
                .map_err(|e| LoadError::Decode(format!("The image could not be decoded: {e}")))?;
            image.to_rgb8()
        }
    };

    let mut image = DynamicImage::ImageRgb8(decoded);
    if let Some(orientation) = orientation(bytes)
        .and_then(|value| u8::try_from(value).ok())
        .and_then(Orientation::from_exif)
    {
        image.apply_orientation(orientation);
    }
    let rgb = image.into_rgb8();
    let (width, height) = rgb.dimensions();
    Ok(Rgb {
        width,
        height,
        data: rgb.into_raw(),
    })
}

fn raw_dimensions(bytes: &[u8], format: Format) -> Result<(u32, u32), LoadError> {
    match format {
        Format::Jpeg => {
            let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(bytes));
            decoder
                .read_info()
                .map_err(|e| LoadError::Decode(format!("The image could not be read: {e}")))?;
            let info = decoder
                .info()
                .ok_or_else(|| LoadError::Decode("The image could not be read.".into()))?;
            Ok((u32::from(info.width), u32::from(info.height)))
        }
        Format::Png | Format::Webp => image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| LoadError::Decode(format!("The image could not be read: {e}")))?
            .into_dimensions()
            .map_err(|e| LoadError::Decode(format!("The image could not be read: {e}"))),
    }
}

/// The reduction Pillow's JPEG `draft()` would choose for a target size.
///
/// Pillow takes the smaller of the two integer ratios and rounds it down to
/// 8, 4, 2 or 1 — so *both* sides stay at least the target. jpeg-decoder's own
/// `scale()` is satisfied when *either* side is, which on a wide photo picks a
/// smaller decode than Python did and feeds the model different pixels.
pub fn draft_factor(width: u32, height: u32, target: u32) -> u32 {
    if target == 0 {
        return 1;
    }
    let ratio = (width / target).min(height / target);
    [8, 4, 2, 1].into_iter().find(|&s| ratio >= s).unwrap_or(1)
}

fn decode_jpeg(
    bytes: &[u8],
    width: u32,
    height: u32,
    target_size: Option<u32>,
) -> Result<RgbImage, LoadError> {
    let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(bytes));
    let failed =
        |e: jpeg_decoder::Error| LoadError::Decode(format!("The image could not be decoded: {e}"));

    let pixels = decoder.decode().map_err(failed)?;
    let info = decoder
        .info()
        .ok_or_else(|| LoadError::Decode("The image could not be read.".into()))?;
    let (w, h) = (u32::from(info.width), u32::from(info.height));

    let rgb = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => pixels,
        jpeg_decoder::PixelFormat::L8 => pixels.iter().flat_map(|&v| [v, v, v]).collect(),
        jpeg_decoder::PixelFormat::L16 => pixels
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|&[v, _]| [v, v, v])
            .collect(),
        jpeg_decoder::PixelFormat::CMYK32 => pixels
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|&[c, m, y, k]| {
                // Same naive inversion Pillow applies to Adobe CMYK JPEGs.
                let k = u16::from(k);
                let channel = |v: u8| ((u16::from(v) * k) / 255) as u8;
                [channel(c), channel(m), channel(y)]
            })
            .collect(),
    };

    let factor = target_size.map_or(1, |target| draft_factor(width, height, target));
    let (w, h, rgb) = if factor > 1 {
        box_reduce(&rgb, w, h, factor)
    } else {
        (w, h, rgb)
    };

    RgbImage::from_raw(w, h, rgb).ok_or_else(|| {
        LoadError::Decode("The image could not be decoded: bad pixel buffer.".into())
    })
}

/// Average each `factor`-square block into one pixel, rounding half up.
///
/// This stands in for libjpeg's scaled IDCT, which is what Pillow's `draft()`
/// used. jpeg-decoder has a scaled IDCT of its own, but it upsamples chroma
/// differently at reduced scale and was measured at a mean error of 1.2 levels
/// (max 34) against Pillow on a loonnet photo; a full decode reduced this way
/// is 0.33 (max 10), and moves confidences by hundredths rather than tenths.
/// The price is decoding at full size first, briefly ~70MB for a 24MP photo.
fn box_reduce(rgb: &[u8], width: u32, height: u32, factor: u32) -> (u32, u32, Vec<u8>) {
    let (w, h, f) = (width as usize, height as usize, factor as usize);
    let (out_w, out_h) = (w.div_ceil(f), h.div_ceil(f));
    let mut out = vec![0u8; out_w * out_h * 3];
    let mut sums = vec![0u32; out_w * 3];
    for oy in 0..out_h {
        sums.fill(0);
        let rows = oy * f..((oy + 1) * f).min(h);
        let block_h = rows.len() as u32;
        for y in rows {
            let row = &rgb[y * w * 3..(y + 1) * w * 3];
            for (x, &[r, g, b]) in row.as_chunks::<3>().0.iter().enumerate() {
                let base = (x / f) * 3;
                sums[base] += u32::from(r);
                sums[base + 1] += u32::from(g);
                sums[base + 2] += u32::from(b);
            }
        }
        for ox in 0..out_w {
            let block_w = (((ox + 1) * f).min(w) - ox * f) as u32;
            let n = block_w * block_h;
            for c in 0..3 {
                out[(oy * out_w + ox) * 3 + c] = ((sums[ox * 3 + c] + n / 2) / n) as u8;
            }
        }
    }
    (out_w as u32, out_h as u32, out)
}

/// The EXIF orientation tag, if the file has a readable one.
///
/// Malformed EXIF is common in the wild and never fatal: the photo is shown as
/// stored rather than refused.
fn orientation(bytes: &[u8]) -> Option<u32> {
    let exif = exif::Reader::new()
        .read_from_container(&mut Cursor::new(bytes))
        .ok()?;
    let field = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)?;
    field.value.get_uint(0)
}

fn swaps_axes(orientation: Option<u32>) -> bool {
    matches!(orientation, Some(5..=8))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        let path = format!(
            "{}/tests/fixtures/images/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    fn encode(image: DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    #[test]
    fn sniffs_supported_formats_from_magic_bytes() {
        assert_eq!(sniff(&fixture("orient_1.jpg")), Ok(Format::Jpeg));
        assert_eq!(sniff(&fixture("plain.png")), Ok(Format::Png));
        assert_eq!(sniff(&fixture("plain.webp")), Ok(Format::Webp));
    }

    #[test]
    fn mpo_is_a_jpeg() {
        // Excluding MPO rejects real user photos. See CLAUDE.md.
        let bytes = fixture("frames.mpo");
        assert_eq!(sniff(&bytes), Ok(Format::Jpeg));
        let image = open_image(&bytes, None).unwrap();
        // Frame 0 is 48x24; the appended frame is 24x12.
        assert_eq!((image.width, image.height), (48, 24));
    }

    #[test]
    fn names_recognisable_but_unsupported_formats() {
        match sniff(b"GIF89a\x01\0\x01\0\0\0\0") {
            Err(LoadError::Unsupported(message)) => assert!(message.contains("GIF")),
            other => panic!("expected Unsupported, got {other:?}"),
        }
        assert!(matches!(
            sniff(b"BM\0\0\0\0"),
            Err(LoadError::Unsupported(_))
        ));
    }

    #[test]
    fn rejects_bytes_that_are_not_an_image() {
        assert!(matches!(sniff(b"hello, world"), Err(LoadError::Decode(_))));
        assert!(matches!(sniff(b""), Err(LoadError::Unsupported(_))));
    }

    #[test]
    fn truncated_jpeg_is_a_decode_failure_not_a_panic() {
        let bytes = fixture("orient_1.jpg");
        let result = open_image(&bytes[..bytes.len() / 3], None);
        assert!(matches!(result, Err(LoadError::Decode(_))));
    }

    #[test]
    fn refuses_a_decompression_bomb_before_decoding() {
        // A PNG header claiming 20000x20000 with no pixel data behind it.
        let mut ihdr = b"IHDR".to_vec();
        ihdr.extend_from_slice(&20000u32.to_be_bytes());
        ihdr.extend_from_slice(&20000u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\r".to_vec();
        bytes.extend_from_slice(&ihdr);
        bytes.extend_from_slice(&crc32(&ihdr).to_be_bytes());
        // The PNG reader wants to reach the first data chunk before it reports
        // a size; two bytes of it are all a bomb needs to supply.
        let idat = b"IDAT\x78\x9c";
        bytes.extend_from_slice(&2u32.to_be_bytes());
        bytes.extend_from_slice(idat);
        bytes.extend_from_slice(&crc32(idat).to_be_bytes());
        let result = open_image(&bytes, None);
        assert!(matches!(result, Err(LoadError::TooLarge(_))), "{result:?}");
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &byte in data {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    #[test]
    fn applies_every_exif_orientation() {
        for o in 1..=8 {
            let bytes = fixture(&format!("orient_{o}.jpg"));
            let expected = if o >= 5 { (24, 48) } else { (48, 24) };
            assert_eq!(
                read_dimensions(&bytes).unwrap(),
                expected,
                "header, orientation {o}"
            );
            let image = open_image(&bytes, None).unwrap();
            assert_eq!(
                (image.width, image.height),
                expected,
                "decoded, orientation {o}"
            );
        }
    }

    #[test]
    fn normalises_alpha_and_greyscale_to_rgb() {
        let alpha = open_image(&fixture("alpha.png"), None).unwrap();
        assert_eq!(&alpha.data[..3], &[10, 200, 30]);
        let grey = open_image(&fixture("grey.png"), None).unwrap();
        assert_eq!(&grey.data[..3], &[77, 77, 77]);
        assert_eq!(grey.data.len(), 30 * 20 * 3);
    }

    #[test]
    fn draft_factor_matches_pillow() {
        // Pillow: min(w // t, h // t), rounded down to 8, 4, 2 or 1.
        assert_eq!(draft_factor(4000, 3000, 640), 4);
        assert_eq!(draft_factor(5472, 3648, 640), 4); // jpeg-decoder alone would pick 8
        assert_eq!(draft_factor(1280, 1280, 640), 2);
        assert_eq!(draft_factor(1279, 5000, 640), 1);
        assert_eq!(draft_factor(8000, 8000, 640), 8);
        assert_eq!(draft_factor(100, 100, 640), 1);
    }

    #[test]
    fn box_reduce_averages_blocks_including_ragged_edges() {
        // 3x2 image, factor 2: a full block on the left, a 1x2 column on the right.
        let rgb = [
            0, 0, 0, 10, 10, 10, 50, 50, 50, 20, 20, 20, 30, 30, 30, 70, 70, 70,
        ];
        let (w, h, out) = box_reduce(&rgb, 3, 2, 2);
        assert_eq!((w, h), (2, 1));
        assert_eq!(out, vec![15, 15, 15, 60, 60, 60]);
    }

    #[test]
    fn drafted_decode_is_the_reduced_size() {
        let big =
            DynamicImage::ImageRgb8(RgbImage::from_pixel(2600, 1300, image::Rgb([90, 20, 200])));
        let bytes = encode(big, ImageFormat::Jpeg);
        let image = open_image(&bytes, Some(640)).unwrap();
        // min(2600 // 640, 1300 // 640) = 2
        assert_eq!((image.width, image.height), (1300, 650));
        let full = open_image(&bytes, None).unwrap();
        assert_eq!((full.width, full.height), (2600, 1300));
    }

    #[test]
    fn matches_the_python_reference_on_every_fixture() {
        let reference: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(format!(
                "{}/tests/fixtures/python_reference.json",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap(),
        )
        .unwrap();
        for case in reference["images"].as_array().unwrap() {
            let name = case["file"].as_str().unwrap();
            let bytes = fixture(name);
            let pair = |v: &serde_json::Value| {
                (v[0].as_u64().unwrap() as u32, v[1].as_u64().unwrap() as u32)
            };
            assert_eq!(
                read_dimensions(&bytes).unwrap(),
                pair(&case["header"]),
                "{name} header"
            );
            let image = open_image(&bytes, None).unwrap();
            assert_eq!(
                (image.width, image.height),
                pair(&case["decoded"]),
                "{name} decoded"
            );
        }
    }
}
