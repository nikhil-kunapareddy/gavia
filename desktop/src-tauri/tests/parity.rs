//! The Rust pipeline against the Python one it replaced, on real photographs.
//!
//! `tests/fixtures/python_reference.json` holds what the Python backend found
//! on every image in the loonnet_v1 validation split. This test re-runs them
//! here and requires the same loons in the same places. The dataset is not in
//! the repository, so this skips on machines (and CI runners) without it; set
//! `GAVIA_VAL_SPLIT` to point at a copy.

mod common;

use common::*;
use gavia_lib::detection::DetectOptions;

#[test]
fn finds_the_same_loons_as_the_python_pipeline() {
    let Some(images) = val_split() else {
        eprintln!("skipping: loonnet_v1 val split not found");
        return;
    };
    let reference: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/python_reference.json"
        ))
        .unwrap(),
    )
    .unwrap();

    let mut compared = 0;
    let (mut worst_conf, mut worst_box) = (0.0f64, 0.0f64);
    for expected in reference["val"].as_array().unwrap() {
        let name = expected["file"].as_str().unwrap();
        let path = images
            .iter()
            .find(|p| p.file_name().is_some_and(|f| f == name))
            .expect("image in split");
        let outcome = detector()
            .detect(&std::fs::read(path).unwrap(), DetectOptions::default())
            .unwrap();

        assert_eq!(
            outcome.image_width as u64,
            expected["imageWidth"].as_u64().unwrap(),
            "{name}"
        );
        assert_eq!(
            outcome.image_height as u64,
            expected["imageHeight"].as_u64().unwrap(),
            "{name}"
        );

        // Every loon Python found must be found here, in the same place.
        // Measured at the port: worst confidence delta 0.015, worst box delta
        // 0.15 percentage points, all 32 boxes reproduced and none added. The
        // tolerances leave roughly 2-3x headroom over that and no more.
        for want in expected["detections"].as_array().unwrap() {
            let conf = want["confidence"].as_f64().unwrap();
            let matched = outcome.predictions.iter().find(|p| {
                let near = |a: f64, b: &serde_json::Value| (a - b.as_f64().unwrap()).abs() < 0.5;
                near(p.x, &want["x"])
                    && near(p.y, &want["y"])
                    && near(p.width, &want["width"])
                    && near(p.height, &want["height"])
            });
            match matched {
                Some(p) => {
                    worst_conf = worst_conf.max((p.confidence - conf).abs());
                    for (got, key) in [
                        (p.x, "x"),
                        (p.y, "y"),
                        (p.width, "width"),
                        (p.height, "height"),
                    ] {
                        worst_box = worst_box.max((got - want[key].as_f64().unwrap()).abs());
                    }
                    assert!(
                        (p.confidence - conf).abs() < 0.04,
                        "{name}: confidence {} vs {conf}",
                        p.confidence
                    );
                    compared += 1;
                }
                None => {
                    panic!("{name}: Python found a loon at {conf:.3} that Rust did not: {want}")
                }
            }
        }
        for got in &outcome.predictions {
            let known = expected["detections"]
                .as_array()
                .unwrap()
                .iter()
                .any(|w| (got.x - w["x"].as_f64().unwrap()).abs() < 0.5);
            assert!(
                known,
                "{name}: new box at {:.3} Python never reported",
                got.confidence
            );
        }
    }
    eprintln!(
        "{compared} boxes compared; worst confidence delta {worst_conf:.4}, worst box delta {worst_box:.3} points"
    );
    let total: usize = reference["val"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["detections"].as_array().unwrap().len())
        .sum();
    assert_eq!(compared, total);
}
