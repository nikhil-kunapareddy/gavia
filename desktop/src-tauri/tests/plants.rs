//! vegnet, the invasive plant model, through the real pipeline.
//!
//! YOLO26 is end to end, so this is the only model that runs
//! `postprocess::decode_end_to_end`. `tests/fixtures/vegnet_reference.json`
//! holds what `scripts/vegnet_reference.py` found with the same pipeline in
//! Python (Pillow, ONNX Runtime, NumPy): on the photos in `fixtures/plants`,
//! which always run, and on loonet's vegnet_v1 val split, which runs when that
//! data is there (or `GAVIA_VEGNET_SPLIT` points at it).

mod common;

use common::*;
use gavia_lib::detection::{DetectOptions, Outcome, Prediction};
use serde_json::Value;

/// Measured at the port: worst confidence delta 0.004 and box delta 0.04
/// points on the fixtures; 0.021 and 0.28 over the 33 val boxes, whose
/// camera JPEGs decode a level or so apart in jpeg-decoder and libjpeg. The
/// same limits as `parity.rs`: loose next to that, tight next to a wrong decode.
const CONFIDENCE_TOLERANCE: f64 = 0.04;
const BOX_TOLERANCE: f64 = 0.5;

fn reference(key: &str) -> Vec<Value> {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/vegnet_reference.json"
    ))
    .unwrap();
    let json: Value = serde_json::from_str(&text).unwrap();
    json[key].as_array().unwrap().clone()
}

/// Every box Python found, found here with the same label in the same place,
/// and nothing else. Returns `(boxes, worst confidence, worst box)` deltas.
fn same_boxes(name: &str, outcome: &Outcome, expected: &Value) -> (usize, f64, f64) {
    assert_eq!(
        u64::from(outcome.image_width),
        expected["imageWidth"].as_u64().unwrap(),
        "{name}"
    );
    assert_eq!(
        u64::from(outcome.image_height),
        expected["imageHeight"].as_u64().unwrap(),
        "{name}"
    );
    let want = expected["detections"].as_array().unwrap();
    assert_eq!(
        outcome.predictions.len(),
        want.len(),
        "{name}: found {:?}",
        outcome.predictions
    );
    let (mut worst_conf, mut worst_box) = (0.0f64, 0.0f64);
    // Matched by place, not rank: near-equal confidences can swap order.
    for want in want {
        let field = |key: &str| want[key].as_f64().unwrap();
        let distance = |p: &Prediction| {
            [
                (p.x, "x"),
                (p.y, "y"),
                (p.width, "width"),
                (p.height, "height"),
            ]
            .into_iter()
            .map(|(value, key)| (value - field(key)).abs())
            .fold(0.0, f64::max)
        };
        let got = outcome
            .predictions
            .iter()
            .filter(|p| p.label == want["label"].as_str().unwrap())
            .min_by(|a, b| distance(a).total_cmp(&distance(b)))
            .unwrap_or_else(|| panic!("{name}: no {} found", want["label"]));
        worst_conf = worst_conf.max((got.confidence - field("confidence")).abs());
        worst_box = worst_box.max(distance(got));
    }
    assert!(
        worst_conf < CONFIDENCE_TOLERANCE,
        "{name}: confidence off by {worst_conf}"
    );
    assert!(
        worst_box < BOX_TOLERANCE,
        "{name}: box off by {worst_box} points"
    );
    (want.len(), worst_conf, worst_box)
}

#[test]
fn loads_as_an_end_to_end_model() {
    let detector = plant_detector();
    let info = detector.info();
    assert_eq!(info.name, "Vegnet 1.0");
    assert!(info.end_to_end);
    assert_eq!(info.classes.len(), 4);
    assert_eq!(info.subject.many, "invasive plants");
}

#[test]
fn finds_each_fixture_species_as_python_did() {
    for expected in reference("fixtures") {
        let name = expected["file"].as_str().unwrap();
        let outcome = plant_detector()
            .detect(&plant_fixture(name), DetectOptions::default())
            .unwrap();
        same_boxes(name, &outcome, &expected);
    }
}

#[test]
fn boxes_are_percentages_inside_the_image() {
    let options = DetectOptions {
        confidence_threshold: Some(0.001),
        ..Default::default()
    };
    let outcome = plant_detector()
        .detect(&plant_fixture("yellow_iris.jpg"), options)
        .unwrap();
    assert!(outcome.predictions.len() > 2);
    // The model's own top 300 is the most it can ever return.
    assert!(outcome.predictions.len() <= 300);
    for p in &outcome.predictions {
        assert!((0.0..=1.0).contains(&p.confidence));
        assert!(p.x >= 0.0 && p.y >= 0.0 && p.width > 0.0 && p.height > 0.0);
        assert!(p.x + p.width <= 100.0 + 1e-9 && p.y + p.height <= 100.0 + 1e-9);
        assert_ne!(p.label, "Unknown");
    }
}

#[test]
fn tiling_merges_boxes_across_tiles() {
    // Tiles overlap, so an end-to-end model still needs NMS across them.
    let options = DetectOptions {
        tiling: Some(true),
        ..Default::default()
    };
    let bytes = jpeg(2400, 1600);
    let outcome = plant_detector().detect(&bytes, options).unwrap();
    assert!(outcome.tiles_processed > 1);
}

#[test]
fn finds_the_same_plants_as_python_on_the_val_split() {
    let Some(images) = vegnet_split() else {
        eprintln!("skipping: vegnet_v1 val split not found");
        return;
    };
    let (mut boxes, mut worst_conf, mut worst_box) = (0, 0.0f64, 0.0f64);
    for expected in reference("val") {
        let name = expected["file"].as_str().unwrap();
        let path = images
            .iter()
            .find(|p| p.file_name().is_some_and(|f| f == name))
            .expect("image in split");
        let outcome = plant_detector()
            .detect(&std::fs::read(path).unwrap(), DetectOptions::default())
            .unwrap();
        let (n, conf, bx) = same_boxes(name, &outcome, &expected);
        boxes += n;
        worst_conf = worst_conf.max(conf);
        worst_box = worst_box.max(bx);
    }
    eprintln!(
        "{boxes} boxes compared; worst confidence delta {worst_conf:.4}, worst box delta {worst_box:.3} points"
    );
}
