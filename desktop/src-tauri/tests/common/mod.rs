//! Shared helpers for the integration tests. Each test binary compiles this
//! separately, so not every helper is used by every binary.
#![allow(dead_code)]

use std::io::Cursor;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use gavia_lib::calls::CallDetector;
use gavia_lib::config::Config;
use gavia_lib::detection::Detector;
use gavia_lib::detection::preprocess::TileSettings;
use image::{DynamicImage, ImageFormat, RgbImage};

pub fn model_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/models/loon_v1.onnx")
}

/// One real detector per test binary; loading it takes a second or two.
pub fn detector() -> Arc<Detector> {
    static DETECTOR: OnceLock<Arc<Detector>> = OnceLock::new();
    DETECTOR
        .get_or_init(|| {
            Arc::new(
                Detector::load(&model_path(), Some(2), TileSettings::default())
                    .expect("model loads"),
            )
        })
        .clone()
}

pub fn fresh_detector(config: &Config) -> Detector {
    Detector::load(&model_path(), config.inference_threads, config.tiles).expect("model loads")
}

pub fn call_model_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/calls/looncall_v1.onnx")
}

/// One real call detector per test binary.
pub fn call_detector() -> Arc<CallDetector> {
    static DETECTOR: OnceLock<Arc<CallDetector>> = OnceLock::new();
    DETECTOR
        .get_or_init(|| {
            Arc::new(CallDetector::load(&call_model_path(), Some(2)).expect("call model loads"))
        })
        .clone()
}

pub fn audio_fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/audio")
            .join(name),
    )
    .expect("audio fixture")
}

pub fn plant_model_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/models/veg_v1.onnx")
}

/// One real plant detector per test binary.
pub fn plant_detector() -> Arc<Detector> {
    static DETECTOR: OnceLock<Arc<Detector>> = OnceLock::new();
    DETECTOR
        .get_or_init(|| {
            Arc::new(
                Detector::load(&plant_model_path(), Some(2), TileSettings::default())
                    .expect("plant model loads"),
            )
        })
        .clone()
}

pub fn plant_fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/plants")
            .join(name),
    )
    .expect("plant fixture")
}

pub fn encode(image: DynamicImage, format: ImageFormat) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, format).expect("encodes");
    out.into_inner()
}

/// A noisy landscape-ish frame: enough texture that the model has something
/// to look at, nothing that should read as a loon.
pub fn scene(width: u32, height: u32) -> RgbImage {
    RgbImage::from_fn(width, height, |x, y| {
        let v = ((x * 31 + y * 17) ^ (x * y)) % 97;
        image::Rgb([(60 + v) as u8, (90 + v / 2) as u8, (120 + v / 3) as u8])
    })
}

pub fn jpeg(width: u32, height: u32) -> Vec<u8> {
    encode(
        DynamicImage::ImageRgb8(scene(width, height)),
        ImageFormat::Jpeg,
    )
}

pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/images")
            .join(name),
    )
    .expect("fixture")
}

/// The loonnet_v1 validation split, if this machine has it. The dataset is
/// not in the repository, so tests that need it skip elsewhere (and in CI).
pub fn val_split() -> Option<Vec<PathBuf>> {
    split("GAVIA_VAL_SPLIT", "loonnet_v1")
}

/// vegnet's val split, for `tests/plants.rs`; `GAVIA_VEGNET_SPLIT` overrides.
pub fn vegnet_split() -> Option<Vec<PathBuf>> {
    split("GAVIA_VEGNET_SPLIT", "vegnet_v1")
}

fn split(variable: &str, dataset: &str) -> Option<Vec<PathBuf>> {
    let split = std::env::var_os(variable).map(PathBuf::from).or_else(|| {
        #[allow(deprecated)]
        std::env::home_dir().map(|h| {
            h.join("Documents/loonet/data/annotated")
                .join(dataset)
                .join("val.txt")
        })
    })?;
    let text = std::fs::read_to_string(split).ok()?;
    let paths: Vec<PathBuf> = text.split_whitespace().map(PathBuf::from).collect();
    paths.iter().all(|p| p.exists()).then_some(paths)
}
