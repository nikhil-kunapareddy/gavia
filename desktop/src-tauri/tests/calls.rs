//! The shipped call model on real recordings, one clip per container Gavia
//! reads. This is what catches a bad export of `looncall_v1.onnx` and any
//! drift in decoding, resampling or windowing, since the expected numbers come
//! from loonet's Python pipeline (`scripts/looncall_reference.py`).

mod common;

use common::*;
use serde_json::Value;

/// Worst P(loon) difference from the Python pipeline, any clip. Measured at the
/// port: 0.0011 for MP3 and Vorbis (Symphonia's decoders, not libsndfile's),
/// 0.0002 for FLAC, and 0.0049 for M4A, whose reference went through ffmpeg's
/// resampler rather than birdnet's (the two differ by that much in Python
/// too). Before the MP4 edit list was read it was 0.054; don't loosen this to
/// make a change pass — find out why it moved.
const TOLERANCE: f64 = 0.01;

#[test]
fn every_container_matches_the_python_pipeline() {
    let reference = reference();
    let detector = call_detector();
    let clips = reference["fixtures"].as_object().expect("fixtures");
    assert_eq!(clips.len(), 5);

    for (clip, expected) in clips {
        let heard = detector
            .listen(&audio_fixture(clip), 4.0 * 3600.0)
            .unwrap_or_else(|e| panic!("{clip}: {e}"));
        let expected = expected.as_array().expect("windows");
        assert_eq!(heard.windows.len(), expected.len(), "{clip}: window count");

        let mut worst = 0.0f64;
        for (got, want) in heard.windows.iter().zip(expected) {
            let want: Vec<f64> = want
                .as_array()
                .expect("window")
                .iter()
                .map(|v| v.as_f64().expect("number"))
                .collect();
            assert_eq!(got.start, want[0], "{clip}: window start");
            // birdnet keeps times as float16, so a short last window's end
            // is only good to a few milliseconds.
            assert!(
                (got.end - want[1]).abs() < 0.03,
                "{clip}: end {} vs {}",
                got.end,
                want[1]
            );
            worst = worst.max((got.probability - want[2]).abs());
        }
        println!("{clip}: worst |P - Python| = {worst:.4}");
        assert!(worst <= TOLERANCE, "{clip}: worst difference {worst:.4}");
    }
}

#[test]
fn hears_the_loon_and_not_the_bullfrog() {
    let detector = call_detector();
    let threshold = detector.info().threshold;

    let loon = detector.listen(&audio_fixture("loon.mp3"), 3600.0).unwrap();
    assert_eq!(loon.sample_rate, 48_000);
    assert!(
        (loon.duration_seconds - 6.6).abs() < 0.05,
        "{}",
        loon.duration_seconds
    );
    assert!(loon.windows.iter().all(|w| w.probability >= threshold));

    let frog = detector
        .listen(&audio_fixture("bullfrog.mp3"), 3600.0)
        .unwrap();
    assert!(frog.windows.iter().all(|w| w.probability < threshold));
}

#[test]
fn stereo_44_1_khz_is_downmixed_and_resampled() {
    let heard = call_detector()
        .listen(&audio_fixture("loon_44k_stereo.ogg"), 3600.0)
        .unwrap();
    assert_eq!((heard.sample_rate, heard.channels), (44_100, 2));
    assert_eq!(heard.windows.len(), 3);
}

fn reference() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/looncall_reference.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("reference")).expect("json")
}
