//! Score the detector against ground-truth labels: the authoritative accuracy
//! check. Run it after any change to pre- or postprocessing, any model
//! re-export, and before turning tiling on for a new kind of imagery.
//!
//! ```sh
//! cargo run --release --example evaluate -- \
//!     --split ~/Documents/loonet/data/annotated/loonnet_v1/val.txt [--tiled] [--model path.onnx]
//! ```
//!
//! Reports precision and recall at the shipped 0.25 threshold and AP@0.5 over
//! the full curve, for a YOLO-format split: one image path per line, labels in
//! the sibling `labels/` folder as `class cx cy w h`, normalised.

use std::path::{Path, PathBuf};

use gavia_lib::detection::detector::default_thread_count;
use gavia_lib::detection::loader;
use gavia_lib::detection::preprocess::TileSettings;
use gavia_lib::detection::{DetectOptions, Detector};

const IOU_MATCH: f64 = 0.5;
/// Low, so AP sees the whole precision-recall curve.
const CURVE_THRESHOLD: f64 = 0.001;
const SHIPPED_THRESHOLD: f64 = 0.25;

type Box = [f64; 4];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let Some(split) = value("--split") else {
        eprintln!("usage: evaluate --split <val.txt> [--tiled] [--model <loon.onnx>] [--iou 0.45]");
        std::process::exit(2);
    };
    let model = value("--model").map(PathBuf::from).unwrap_or_else(|| {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models/loon_v1.onnx")
    });
    let iou = value("--iou").and_then(|v| v.parse().ok()).unwrap_or(0.45);
    let tiled = args.iter().any(|a| a == "--tiled");

    let text = std::fs::read_to_string(&split).unwrap_or_else(|e| panic!("{split}: {e}"));
    let images: Vec<PathBuf> = text.split_whitespace().map(PathBuf::from).collect();
    let truth: Vec<Vec<Box>> = images.iter().map(|p| load_labels(p)).collect();
    let total: usize = truth.iter().map(Vec::len).sum();
    println!("{} images, {total} labelled loons\n", images.len());

    let detector = Detector::load(
        &model,
        Some(default_thread_count()),
        TileSettings::default(),
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let options = DetectOptions {
        confidence_threshold: Some(CURVE_THRESHOLD),
        iou_threshold: Some(iou),
        tiling: Some(tiled),
    };

    let predictions: Vec<Vec<(f64, Box)>> = images
        .iter()
        .map(|path| {
            let outcome = detector
                .detect(&std::fs::read(path).unwrap(), options)
                .unwrap();
            let (w, h) = (
                f64::from(outcome.image_width),
                f64::from(outcome.image_height),
            );
            outcome
                .predictions
                .iter()
                .map(|p| {
                    let corners = [
                        p.x / 100.0 * w,
                        p.y / 100.0 * h,
                        (p.x + p.width) / 100.0 * w,
                        (p.y + p.height) / 100.0 * h,
                    ];
                    (p.confidence, corners)
                })
                .collect()
        })
        .collect();

    let (p, r, ap, n) = score(&predictions, &truth, total);
    let name = if tiled {
        "onnx tiled"
    } else {
        "onnx single-pass"
    };
    println!(
        "{:24} {:>7} {:>7} {:>8} {:>7}",
        "pipeline", "P", "R", "AP@0.5", "preds"
    );
    println!("{}", "-".repeat(56));
    println!("{name:24} {p:7.4} {r:7.4} {ap:8.4} {n:7}");
}

/// YOLO label file as pixel-space corners. Dimensions come from the shared
/// loader so truth and predictions agree on EXIF orientation.
fn load_labels(image: &Path) -> Vec<Box> {
    let label = PathBuf::from(image.to_string_lossy().replace("/images/", "/labels/"))
        .with_extension("txt");
    let Ok(text) = std::fs::read_to_string(label) else {
        return Vec::new();
    };
    let (w, h) = loader::read_dimensions(&std::fs::read(image).unwrap()).unwrap();
    let (w, h) = (f64::from(w), f64::from(h));
    text.lines()
        .filter_map(|line| {
            let v: Vec<f64> = line
                .split_whitespace()
                .filter_map(|t| t.parse().ok())
                .collect();
            (v.len() >= 5).then(|| {
                let (cx, cy, bw, bh) = (v[1], v[2], v[3], v[4]);
                [
                    (cx - bw / 2.0) * w,
                    (cy - bh / 2.0) * h,
                    (cx + bw / 2.0) * w,
                    (cy + bh / 2.0) * h,
                ]
            })
        })
        .collect()
}

fn iou(a: &Box, b: &Box) -> f64 {
    let inter =
        (a[2].min(b[2]) - a[0].max(b[0])).max(0.0) * (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    if union > 0.0 { inter / union } else { 0.0 }
}

/// Greedy IoU matching per image, then AP by the monotone envelope of the
/// precision-recall curve — the same scoring `evaluate.py` used, so numbers
/// from before and after the Rust port compare directly.
fn score(
    predictions: &[Vec<(f64, Box)>],
    truth: &[Vec<Box>],
    total: usize,
) -> (f64, f64, f64, usize) {
    let mut rows: Vec<(f64, bool)> = Vec::new();
    for (preds, targets) in predictions.iter().zip(truth) {
        let mut claimed = vec![false; targets.len()];
        let mut sorted = preds.clone();
        sorted.sort_by(|a, b| b.0.total_cmp(&a.0));
        for (confidence, candidate) in sorted {
            let mut order: Vec<(usize, f64)> = targets
                .iter()
                .map(|t| iou(&candidate, t))
                .enumerate()
                .collect();
            order.sort_by(|a, b| b.1.total_cmp(&a.1));
            let hit = order
                .into_iter()
                .take_while(|&(_, overlap)| overlap >= IOU_MATCH)
                .find(|&(i, _)| !claimed[i])
                .map(|(i, _)| claimed[i] = true)
                .is_some();
            rows.push((confidence, hit));
        }
    }
    if rows.is_empty() || total == 0 {
        return (0.0, 0.0, 0.0, rows.len());
    }

    rows.sort_by(|a, b| b.0.total_cmp(&a.0));
    let (mut tp, mut fp) = (0.0, 0.0);
    let mut curve: Vec<(f64, f64)> = Vec::with_capacity(rows.len());
    for &(_, hit) in &rows {
        if hit {
            tp += 1.0
        } else {
            fp += 1.0
        }
        curve.push((tp / total as f64, tp / f64::max(tp + fp, 1e-12)));
    }
    let mut envelope = 0.0f64;
    let mut ap = 0.0;
    let mut prev_recall = vec![0.0; curve.len()];
    for i in 1..curve.len() {
        prev_recall[i] = curve[i - 1].0;
    }
    for i in (0..curve.len()).rev() {
        envelope = envelope.max(curve[i].1);
        ap += (curve[i].0 - prev_recall[i]) * envelope;
    }

    let at: Vec<&(f64, bool)> = rows.iter().filter(|r| r.0 >= SHIPPED_THRESHOLD).collect();
    let hits = at.iter().filter(|r| r.1).count() as f64;
    if at.is_empty() {
        return (0.0, 0.0, ap, rows.len());
    }
    (hits / at.len() as f64, hits / total as f64, ap, rows.len())
}
