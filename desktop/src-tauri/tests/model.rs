//! The real ONNX model through the real pipeline. These are the only tests
//! that catch a bad model export or preprocessing drift, because everything
//! else runs against fixtures.

mod common;

use common::*;
use gavia_lib::detection::loader::LoadError;
use gavia_lib::detection::{DetectError, DetectOptions};
use image::{DynamicImage, ImageFormat};

#[test]
fn loads_with_the_shipped_metadata() {
    let detector = detector();
    assert_eq!(detector.info().name, "Loonet 1.0");
    assert_eq!(detector.info().input_size, 640);
    assert!(!detector.tiling_enabled());
}

#[test]
fn boxes_are_percentages_inside_the_image() {
    // A real photograph when this machine has the dataset; synthetic noise,
    // which the model rightly finds nothing in, otherwise.
    let (bytes, real) = match val_split() {
        Some(images) => (std::fs::read(&images[0]).unwrap(), true),
        None => (jpeg(1600, 1000), false),
    };
    let options = DetectOptions {
        confidence_threshold: Some(0.001),
        ..Default::default()
    };
    let outcome = detector().detect(&bytes, options).unwrap();
    if real {
        assert!(
            !outcome.predictions.is_empty(),
            "a near-zero threshold should surface some boxes"
        );
    }
    for p in &outcome.predictions {
        assert!((0.0..=1.0).contains(&p.confidence));
        assert!(p.x >= 0.0 && p.y >= 0.0 && p.width > 0.0 && p.height > 0.0);
        assert!(p.x + p.width <= 100.0 + 1e-9 && p.y + p.height <= 100.0 + 1e-9);
        assert_eq!(p.label, "Loon");
    }
    let scores: Vec<f64> = outcome.predictions.iter().map(|p| p.confidence).collect();
    assert!(
        scores.windows(2).all(|w| w[0] >= w[1]),
        "sorted by confidence"
    );
}

#[test]
fn reports_the_original_size_after_a_drafted_decode() {
    // 4000x3000 decodes at quarter scale for a single pass; the result must
    // still describe the photo the user chose.
    let outcome = detector()
        .detect(&jpeg(4000, 3000), DetectOptions::default())
        .unwrap();
    assert_eq!((outcome.image_width, outcome.image_height), (4000, 3000));
    assert_eq!(outcome.tiles_processed, 1);
}

#[test]
fn reports_rotated_dimensions_for_exif_photos() {
    let outcome = detector()
        .detect(&fixture("orient_6.jpg"), DetectOptions::default())
        .unwrap();
    assert_eq!((outcome.image_width, outcome.image_height), (24, 48));
}

#[test]
fn accepts_mpo_png_and_webp() {
    for name in ["frames.mpo", "plain.png", "plain.webp"] {
        detector()
            .detect(&fixture(name), DetectOptions::default())
            .unwrap_or_else(|e| panic!("{name}: {e}"));
    }
}

#[test]
fn tiling_can_be_turned_on_per_call() {
    let options = DetectOptions {
        tiling: Some(true),
        ..Default::default()
    };
    let outcome = detector().detect(&jpeg(2000, 1200), options).unwrap();
    assert!(outcome.tiles_processed > 1);
    assert_eq!((outcome.image_width, outcome.image_height), (2000, 1200));
}

#[test]
fn a_higher_threshold_never_finds_more() {
    let bytes = jpeg(1200, 900);
    let low = detector()
        .detect(
            &bytes,
            DetectOptions {
                confidence_threshold: Some(0.001),
                ..Default::default()
            },
        )
        .unwrap();
    let high = detector()
        .detect(
            &bytes,
            DetectOptions {
                confidence_threshold: Some(0.5),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(high.predictions.len() <= low.predictions.len());
}

#[test]
fn garbage_is_a_decode_error_not_a_panic() {
    match detector().detect(b"\xFF\xD8\xFFgarbage", DetectOptions::default()) {
        Err(DetectError::Load(LoadError::Decode(_))) => {}
        other => panic!("expected a decode error, got {other:?}"),
    }
}

#[test]
fn concurrent_checks_do_not_corrupt_each_other() {
    // The shared input buffer is the hazard: two checks interleaving tiles
    // would feed one image's pixels into the other's boxes.
    let a = jpeg(1500, 1000);
    let b = encode(DynamicImage::new_rgb8(900, 900), ImageFormat::Png);
    let expected_a = detector()
        .detect(&a, DetectOptions::default())
        .unwrap()
        .predictions;
    let expected_b = detector()
        .detect(&b, DetectOptions::default())
        .unwrap()
        .predictions;
    std::thread::scope(|s| {
        for i in 0..4 {
            let (bytes, expected) = if i % 2 == 0 {
                (&a, &expected_a)
            } else {
                (&b, &expected_b)
            };
            s.spawn(move || {
                assert_eq!(
                    &detector()
                        .detect(bytes, DetectOptions::default())
                        .unwrap()
                        .predictions,
                    expected
                )
            });
        }
    });
}
