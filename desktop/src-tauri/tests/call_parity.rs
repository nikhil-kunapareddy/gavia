//! The call model against loonet's Python pipeline on the looncall val split:
//! every window of every recording, compared one to one.
//!
//! Skips unless the recordings are on this machine, at
//! `~/Documents/loonet/data/looncall_raw` or `GAVIA_LOONCALL_RAW`, so it never
//! runs in CI. The expected numbers are in `fixtures/looncall_reference.json`
//! (`scripts/looncall_reference.py`).

mod common;

use std::path::PathBuf;

use common::*;

/// Measured at the port: 0.0031 worst over 147 windows (all MP3, 48 kHz),
/// every window on the same side of the threshold. Don't loosen this to make
/// a change pass — find out why it moved.
const TOLERANCE: f64 = 0.005;

fn recordings_dir() -> Option<PathBuf> {
    let dir = std::env::var_os("GAVIA_LOONCALL_RAW")
        .map(PathBuf::from)
        .or_else(|| {
            #[allow(deprecated)]
            std::env::home_dir().map(|h| h.join("Documents/loonet/data/looncall_raw"))
        })?;
    dir.is_dir().then_some(dir)
}

#[test]
fn val_split_matches_the_python_pipeline() {
    let Some(dir) = recordings_dir() else {
        eprintln!("skipping: loonet's looncall recordings are not on this machine");
        return;
    };
    let reference: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/looncall_reference.json"),
        )
        .expect("reference"),
    )
    .expect("json");
    let detector = call_detector();
    let threshold = detector.info().threshold;

    let (mut worst, mut windows, mut flipped) = (0.0f64, 0, 0);
    for (file, expected) in reference["recordings"].as_object().expect("recordings") {
        let bytes = std::fs::read(dir.join(file)).unwrap_or_else(|e| panic!("{file}: {e}"));
        let heard = detector.listen(&bytes, 4.0 * 3600.0).expect(file);
        let expected = expected.as_array().expect("windows");
        assert_eq!(heard.windows.len(), expected.len(), "{file}: window count");
        for (got, want) in heard.windows.iter().zip(expected) {
            let (start, p) = (
                want[0].as_f64().expect("start"),
                want[2].as_f64().expect("p"),
            );
            assert_eq!(got.start, start, "{file}");
            worst = worst.max((got.probability - p).abs());
            flipped += usize::from((got.probability >= threshold) != (p >= threshold));
            windows += 1;
        }
    }
    println!(
        "{windows} windows: worst |P - Python| = {worst:.4}, {flipped} on the other side of {threshold}"
    );
    assert!(windows > 0);
    assert_eq!(flipped, 0);
    assert!(worst <= TOLERANCE, "worst difference {worst:.4}");
}
