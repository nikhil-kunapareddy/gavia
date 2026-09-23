//! Turning an arbitrary photograph into 640x640 model inputs.
//!
//! Two things happen here, and both have to be exactly reversible so
//! detections can be mapped back onto the original image:
//!
//! * **Letterboxing** scales an image to fit 640x640 without distorting it and
//!   pads the leftover space. The scale and pad offsets travel with the tile
//!   so postprocessing can undo them.
//! * **Tiling** splits an image that is large relative to the model's input
//!   into overlapping windows. A loon 40px across in a 6000px drone frame is
//!   ~4px after a whole-image resize and is simply gone; inside a 640px tile it
//!   is still 40px. Off by default — see [`crate::detection::Detector`].

use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};

use super::loader::Rgb;

/// Grey fill for letterbox padding. Matches Ultralytics, so the model sees the
/// same border statistics at inference that it saw during training.
pub const PAD_VALUE: u8 = 114;

/// How tiling is configured. The defaults are the Python backend's.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TileSettings {
    pub enabled: bool,
    pub threshold: f64,
    pub overlap: f64,
    pub max_tiles: usize,
}

impl Default for TileSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold: 1.5,
            overlap: 0.2,
            max_tiles: 64,
        }
    }
}

/// Crop boxes as (left, top, right, bottom) in original-image pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TilePlan {
    pub tiles: Vec<[u32; 4]>,
    /// Side length of each crop before scaling. Equals the model input size
    /// unless the image was big enough that tiles had to grow to stay under
    /// the tile budget.
    pub tile_size: u32,
}

impl TilePlan {
    pub fn is_tiled(&self) -> bool {
        self.tiles.len() > 1
    }
}

/// Decide whether to tile, and where the tiles go.
///
/// Small images get a single whole-image pass. `max_tiles` is a wall-clock
/// guard: rather than refuse a 100MP panorama, tiles grow until the grid fits
/// the budget, so detail degrades gracefully instead of the request hanging.
pub fn plan_tiles(width: u32, height: u32, model_size: u32, settings: &TileSettings) -> TilePlan {
    assert!(
        width > 0 && height > 0,
        "image dimensions must be positive, got {width}x{height}"
    );

    let limit = f64::from(model_size) * settings.threshold;
    if !settings.enabled || (f64::from(width) <= limit && f64::from(height) <= limit) {
        return TilePlan {
            tiles: vec![[0, 0, width, height]],
            tile_size: width.max(height),
        };
    }

    let mut tile_size = model_size;
    let (xs, ys) = loop {
        let stride = ((f64::from(tile_size) * (1.0 - settings.overlap)) as u32).max(1);
        let xs = window_starts(width, tile_size, stride);
        let ys = window_starts(height, tile_size, stride);
        if xs.len() * ys.len() <= settings.max_tiles {
            break (xs, ys);
        }
        // Grow tiles rather than drop coverage. Each step roughly halves the count.
        tile_size = (f64::from(tile_size) * 1.5) as u32;
    };

    let tiles = ys
        .iter()
        .flat_map(|&y| {
            xs.iter().map(move |&x| {
                [
                    x,
                    y,
                    (x + tile_size).min(width),
                    (y + tile_size).min(height),
                ]
            })
        })
        .collect();
    TilePlan { tiles, tile_size }
}

/// Window offsets covering `extent`, with the last one flush to the edge, so
/// every tile is full-sized and the model never sees a sliver among padding.
fn window_starts(extent: u32, window: u32, stride: u32) -> Vec<u32> {
    if extent <= window {
        return vec![0];
    }
    let last = extent - window;
    let mut starts: Vec<u32> = (0..=last).step_by(stride as usize).collect();
    if starts.last() != Some(&last) {
        starts.push(last);
    }
    starts
}

/// How a crop was fitted into the model input, which is what it takes to
/// invert the transform: a point `(x, y)` in the letterboxed tile lands at
/// `(x - pad_x) / scale + origin_x` in the original image.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Letterbox {
    pub origin_x: u32,
    pub origin_y: u32,
    pub scale: f64,
    pub pad_x: f64,
    pub pad_y: f64,
}

/// Fit `image` into a square NCHW float input without distorting it, writing
/// into `out` (length `3 * size * size`) rather than allocating per tile.
///
/// Resampling is a Pillow-compatible bilinear convolution and rounding is
/// round-half-to-even, both to match the Python pipeline this replaced: the
/// model's accuracy was measured on exactly those pixels.
pub fn letterbox(image: &Rgb, model_size: u32, out: &mut [f32]) -> Letterbox {
    let size = model_size as usize;
    assert_eq!(
        out.len(),
        3 * size * size,
        "input buffer has the wrong length"
    );

    let (width, height) = (f64::from(image.width), f64::from(image.height));
    let size_f = f64::from(model_size);
    // Never upscale: an interpolated 200px crop blown up to 640 invents detail.
    let scale = (size_f / width).min(size_f / height).min(1.0);

    let new_w = ((width * scale).round_ties_even() as u32).max(1);
    let new_h = ((height * scale).round_ties_even() as u32).max(1);
    let pad_x = (size_f - f64::from(new_w)) / 2.0;
    let pad_y = (size_f - f64::from(new_h)) / 2.0;

    let resized;
    let patch: &[u8] = if (new_w, new_h) == (image.width, image.height) {
        &image.data
    } else {
        resized = resize(image, new_w, new_h, FilterType::Bilinear);
        &resized
    };

    out.fill((f64::from(PAD_VALUE) / 255.0) as f32);
    let top = pad_y.round_ties_even() as usize;
    let left = pad_x.round_ties_even() as usize;
    let plane = size * size;
    let (new_w, new_h) = (new_w as usize, new_h as usize);
    for y in 0..new_h {
        let row = &patch[y * new_w * 3..(y + 1) * new_w * 3];
        let base = (top + y) * size + left;
        for (x, pixel) in row.as_chunks::<3>().0.iter().enumerate() {
            for c in 0..3 {
                out[c * plane + base + x] = f32::from(pixel[c]) / 255.0;
            }
        }
    }

    Letterbox {
        origin_x: 0,
        origin_y: 0,
        scale,
        pad_x,
        pad_y,
    }
}

/// Resize an RGB buffer with one of Pillow's convolution filters.
pub fn resize(image: &Rgb, width: u32, height: u32, filter: FilterType) -> Vec<u8> {
    let source = ImageRef::new(image.width, image.height, &image.data, PixelType::U8x3)
        .expect("an Rgb buffer always matches its dimensions");
    let mut target = Image::new(width, height, PixelType::U8x3);
    Resizer::new()
        .resize(
            &source,
            &mut target,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(filter)),
        )
        .expect("same pixel type on both sides");
    target.into_vec()
}

/// Copy one tile's crop out of the full image.
pub fn crop(image: &Rgb, [left, top, right, bottom]: [u32; 4]) -> Rgb {
    let (w, h) = ((right - left) as usize, (bottom - top) as usize);
    let stride = image.width as usize * 3;
    let mut data = Vec::with_capacity(w * h * 3);
    for y in top as usize..bottom as usize {
        let start = y * stride + left as usize * 3;
        data.extend_from_slice(&image.data[start..start + w * 3]);
    }
    Rgb {
        width: w as u32,
        height: h as u32,
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: u32 = 640;

    fn solid(width: u32, height: u32, rgb: [u8; 3]) -> Rgb {
        Rgb {
            width,
            height,
            data: rgb.repeat((width * height) as usize),
        }
    }

    /// The deterministic pattern the Python reference was generated from.
    fn pattern(width: u32, height: u32) -> Rgb {
        let mut data = Vec::with_capacity((width * height * 3) as usize);
        for y in 0..height {
            for x in 0..width {
                data.push(((x * 7 + y * 3) % 256) as u8);
                data.push(((x * 5 + y * 11) % 256) as u8);
                data.push(((x * 13 + y * 2) % 256) as u8);
            }
        }
        Rgb {
            width,
            height,
            data,
        }
    }

    fn buffer() -> Vec<f32> {
        vec![0.0; (3 * SIZE * SIZE) as usize]
    }

    fn reference() -> serde_json::Value {
        let path = format!(
            "{}/tests/fixtures/python_reference.json",
            env!("CARGO_MANIFEST_DIR")
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn landscape_pads_top_and_bottom() {
        let mut out = buffer();
        let lb = letterbox(&solid(1280, 640, [255, 0, 0]), SIZE, &mut out);
        assert_eq!(lb.scale, 0.5);
        assert_eq!((lb.pad_x, lb.pad_y), (0.0, 160.0));
    }

    #[test]
    fn padding_uses_the_training_fill_value() {
        let mut out = buffer();
        letterbox(&solid(1280, 640, [255, 0, 0]), SIZE, &mut out);
        // Row 0 is padding, row 200 is image.
        assert_eq!(out[0], (114.0f64 / 255.0) as f32);
        assert_eq!(out[200 * SIZE as usize], 1.0);
    }

    #[test]
    fn never_upscales() {
        let mut out = buffer();
        assert_eq!(
            letterbox(&solid(200, 100, [0, 0, 0]), SIZE, &mut out).scale,
            1.0
        );
    }

    #[test]
    fn rounds_half_to_even_like_python() {
        // Python's round() is banker's rounding; f64::round is half-away-from-zero
        // and would shift a letterbox by a pixel on exact halves.
        assert_eq!(12.5f64.round_ties_even(), 12.0);
        assert_eq!(13.5f64.round_ties_even(), 14.0);
    }

    #[test]
    fn letterbox_matches_the_python_reference() {
        for case in reference()["letterbox"].as_array().unwrap() {
            let (w, h) = (
                case["width"].as_u64().unwrap() as u32,
                case["height"].as_u64().unwrap() as u32,
            );
            let mut out = buffer();
            let lb = letterbox(&pattern(w, h), SIZE, &mut out);
            assert!(
                (lb.scale - case["scale"].as_f64().unwrap()).abs() < 1e-12,
                "{w}x{h} scale"
            );
            assert_eq!(lb.pad_x, case["padX"].as_f64().unwrap(), "{w}x{h} pad_x");
            assert_eq!(lb.pad_y, case["padY"].as_f64().unwrap(), "{w}x{h} pad_y");

            let plane = (SIZE * SIZE) as usize;
            for (c, expected) in case["channelMeans"].as_array().unwrap().iter().enumerate() {
                let mean = out[c * plane..(c + 1) * plane]
                    .iter()
                    .map(|&v| f64::from(v))
                    .sum::<f64>()
                    / plane as f64;
                assert!(
                    (mean - expected.as_f64().unwrap()).abs() < 2e-3,
                    "{w}x{h} channel {c} mean {mean} vs {expected}"
                );
            }
            // Individual pixels: within one 8-bit step of Pillow on this
            // aliasing-heavy pattern, where any real resampling difference shows.
            let mut worst = 0.0f64;
            for sample in case["samples"].as_array().unwrap() {
                let (c, y, x) = (
                    sample[0].as_u64().unwrap() as usize,
                    sample[1].as_u64().unwrap() as usize,
                    sample[2].as_u64().unwrap() as usize,
                );
                let got = f64::from(out[c * plane + y * SIZE as usize + x]);
                worst = worst.max((got - sample[3].as_f64().unwrap()).abs());
            }
            assert!(
                worst <= 1.5 / 255.0,
                "{w}x{h}: worst pixel error {}",
                worst * 255.0
            );
        }
    }

    #[test]
    fn small_image_is_a_single_pass() {
        let plan = plan_tiles(
            800,
            600,
            SIZE,
            &TileSettings {
                enabled: true,
                ..Default::default()
            },
        );
        assert!(!plan.is_tiled());
        assert_eq!(plan.tiles, vec![[0, 0, 800, 600]]);
    }

    #[test]
    fn large_image_tiles_with_overlap_and_snaps_to_edges() {
        let plan = plan_tiles(
            2000,
            1000,
            SIZE,
            &TileSettings {
                enabled: true,
                ..Default::default()
            },
        );
        assert!(plan.is_tiled());
        assert_eq!(plan.tiles[0], [0, 0, 640, 640]);
        assert_eq!(plan.tiles.iter().map(|t| t[2]).max(), Some(2000));
        assert_eq!(plan.tiles.iter().map(|t| t[3]).max(), Some(1000));
    }

    #[test]
    fn tiles_cover_every_pixel() {
        let (w, h) = (3000u32, 2000u32);
        let plan = plan_tiles(
            w,
            h,
            SIZE,
            &TileSettings {
                enabled: true,
                ..Default::default()
            },
        );
        let mut covered = vec![false; (w * h) as usize];
        for [l, t, r, b] in plan.tiles {
            for y in t..b {
                for x in l..r {
                    covered[(y * w + x) as usize] = true;
                }
            }
        }
        assert!(covered.iter().all(|&c| c));
    }

    #[test]
    fn enormous_image_stays_within_the_tile_budget() {
        let plan = plan_tiles(
            20000,
            20000,
            SIZE,
            &TileSettings {
                enabled: true,
                ..Default::default()
            },
        );
        assert!(plan.tiles.len() <= 64);
        assert!(plan.tile_size > SIZE);
    }

    #[test]
    fn disabled_tiling_is_always_one_pass() {
        let plan = plan_tiles(6000, 4000, SIZE, &TileSettings::default());
        assert_eq!(plan.tiles, vec![[0, 0, 6000, 4000]]);
    }

    #[test]
    fn tile_plans_match_the_python_reference() {
        for case in reference()["plans"].as_array().unwrap() {
            let settings = TileSettings {
                enabled: case["enabled"].as_bool().unwrap(),
                max_tiles: case["maxTiles"].as_u64().unwrap() as usize,
                ..Default::default()
            };
            let (w, h) = (
                case["width"].as_u64().unwrap() as u32,
                case["height"].as_u64().unwrap() as u32,
            );
            let plan = plan_tiles(w, h, SIZE, &settings);
            let expected: Vec<[u32; 4]> = serde_json::from_value(case["tiles"].clone()).unwrap();
            assert_eq!(plan.tiles, expected, "{w}x{h}");
            assert_eq!(
                u64::from(plan.tile_size),
                case["tileSize"].as_u64().unwrap(),
                "{w}x{h}"
            );
        }
    }

    #[test]
    fn crop_takes_the_right_pixels() {
        let image = pattern(10, 10);
        let tile = crop(&image, [2, 3, 5, 7]);
        assert_eq!((tile.width, tile.height), (3, 4));
        assert_eq!(
            &tile.data[..3],
            &image.data[(3 * 10 + 2) * 3..(3 * 10 + 2) * 3 + 3]
        );
    }
}
