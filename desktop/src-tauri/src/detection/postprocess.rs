//! Turning raw model output into boxes on the original image.
//!
//! ```text
//! filter by score -> corners -> map back to the original image
//!   -> merge across tiles -> suppress overlaps -> clamp -> percentages
//! ```
//!
//! Order matters: coordinates are mapped back *before* NMS so duplicate
//! detections of one bird seen in two overlapping tiles land on top of each
//! other and can be suppressed.

use super::preprocess::Letterbox;

/// A box in original-image pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RawDetection {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub score: f64,
    pub class_id: usize,
}

/// Decode one tile's output into original-image pixel boxes.
///
/// `output` is the model's `(1, 4 + classes, anchors)` tensor flattened: box
/// centre and size stacked above per-class scores. There is no objectness row;
/// YOLO11 folds it into the class scores.
///
/// The arithmetic is `f32` on purpose. NumPy did it in `float32` in the Python
/// pipeline, and matching that keeps boxes identical to the last bit rather
/// than merely close.
pub fn decode(
    output: &[f32],
    rows: usize,
    anchors: usize,
    tile: &Letterbox,
    confidence_threshold: f64,
) -> Vec<RawDetection> {
    assert!(rows > 4, "model output has no class rows: {rows} rows");
    assert_eq!(
        output.len(),
        rows * anchors,
        "output length does not match its shape"
    );
    let row = |r: usize| &output[r * anchors..(r + 1) * anchors];

    let inv = (1.0 / tile.scale) as f32;
    let (pad_x, pad_y) = (tile.pad_x as f32, tile.pad_y as f32);
    let (origin_x, origin_y) = (tile.origin_x as f32, tile.origin_y as f32);
    let threshold = confidence_threshold as f32;

    let mut found = Vec::new();
    for a in 0..anchors {
        // argmax, first maximum wins as with NumPy.
        let (class_id, best) =
            (4..rows)
                .map(|r| (r - 4, row(r)[a]))
                .fold(
                    (0, f32::NEG_INFINITY),
                    |acc, (k, s)| if s > acc.1 { (k, s) } else { acc },
                );
        if best < threshold {
            continue;
        }

        let (cx, cy, w, h) = (row(0)[a], row(1)[a], row(2)[a], row(3)[a]);
        let (half_w, half_h) = (w / 2.0, h / 2.0);
        let map_x = |v: f32| f64::from((v - pad_x) * inv + origin_x);
        let map_y = |v: f32| f64::from((v - pad_y) * inv + origin_y);
        found.push(RawDetection {
            x1: map_x(cx - half_w),
            y1: map_y(cy - half_h),
            x2: map_x(cx + half_w),
            y2: map_y(cy + half_h),
            score: f64::from(best),
            class_id,
        });
    }
    found
}

/// Greedy NMS, highest score first, class-agnostic.
///
/// Class-agnostic is free with one class, and is the behaviour we want if a
/// second is ever added: two overlapping boxes on the same bird are a duplicate
/// regardless of what each is labelled.
pub fn non_max_suppression(
    detections: &[RawDetection],
    iou_threshold: f64,
    max_detections: usize,
) -> Vec<RawDetection> {
    // Stable sort, so equal scores keep input order exactly as Python's did.
    let mut order: Vec<usize> = (0..detections.len()).collect();
    order.sort_by(|&a, &b| detections[b].score.total_cmp(&detections[a].score));

    let area = |d: &RawDetection| (d.x2 - d.x1).max(0.0) * (d.y2 - d.y1).max(0.0);
    let mut suppressed = vec![false; detections.len()];
    let mut kept = Vec::new();

    for (i, &current) in order.iter().enumerate() {
        if suppressed[current] {
            continue;
        }
        if kept.len() >= max_detections {
            break;
        }
        kept.push(detections[current]);
        let a = &detections[current];
        for &other in &order[i + 1..] {
            if suppressed[other] {
                continue;
            }
            let b = &detections[other];
            let overlap = (a.x2.min(b.x2) - a.x1.max(b.x1)).max(0.0)
                * (a.y2.min(b.y2) - a.y1.max(b.y1)).max(0.0);
            let union = area(a) + area(b) - overlap;
            // Zero-area boxes would divide by zero; they cannot overlap anything.
            let iou = if union > 0.0 { overlap / union } else { 0.0 };
            if iou > iou_threshold {
                suppressed[other] = true;
            }
        }
    }
    kept
}

/// Trim boxes to the image and drop any that collapse to nothing.
///
/// The model will happily predict the full extent of a bird half out of
/// frame, but a box drawn outside the image means nothing to the reviewer.
pub fn clamp_to_image(detections: Vec<RawDetection>, width: u32, height: u32) -> Vec<RawDetection> {
    let (w, h) = (f64::from(width), f64::from(height));
    detections
        .into_iter()
        .filter_map(|d| {
            let clamped = RawDetection {
                x1: d.x1.clamp(0.0, w),
                y1: d.y1.clamp(0.0, h),
                x2: d.x2.clamp(0.0, w),
                y2: d.y2.clamp(0.0, h),
                ..d
            };
            (clamped.x2 - clamped.x1 > 0.0 && clamped.y2 - clamped.y1 > 0.0).then_some(clamped)
        })
        .collect()
}

/// Pixel corners to `(x, y, width, height)` as percentages of the image.
///
/// Percentages all the way to the CSS are what let a reduced-scale decode
/// report boxes that line up with the full-size original.
pub fn to_percentages(d: &RawDetection, width: u32, height: u32) -> (f64, f64, f64, f64) {
    let (w, h) = (f64::from(width), f64::from(height));
    (
        d.x1 / w * 100.0,
        d.y1 / h * 100.0,
        (d.x2 - d.x1) / w * 100.0,
        (d.y2 - d.y1) / h * 100.0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> Letterbox {
        Letterbox {
            origin_x: 0,
            origin_y: 0,
            scale: 1.0,
            pad_x: 0.0,
            pad_y: 0.0,
        }
    }

    fn det(x1: f64, y1: f64, x2: f64, y2: f64, score: f64) -> RawDetection {
        RawDetection {
            x1,
            y1,
            x2,
            y2,
            score,
            class_id: 0,
        }
    }

    /// A `(1, 5, anchors)` output with one box per `(cx, cy, w, h, score)`.
    fn output(boxes: &[[f32; 5]]) -> Vec<f32> {
        let n = boxes.len();
        let mut out = vec![0.0; 5 * n];
        for (a, b) in boxes.iter().enumerate() {
            for r in 0..5 {
                out[r * n + a] = b[r];
            }
        }
        out
    }

    #[test]
    fn decodes_centre_size_to_corners() {
        let out = output(&[[100.0, 200.0, 40.0, 20.0, 0.9]]);
        let d = decode(&out, 5, 1, &identity(), 0.25);
        assert_eq!(d.len(), 1);
        assert_eq!(
            (d[0].x1, d[0].y1, d[0].x2, d[0].y2),
            (80.0, 190.0, 120.0, 210.0)
        );
        assert!((d[0].score - 0.9).abs() < 1e-6);
    }

    #[test]
    fn drops_boxes_below_the_threshold() {
        let out = output(&[[1.0, 1.0, 1.0, 1.0, 0.1], [1.0, 1.0, 1.0, 1.0, 0.3]]);
        assert_eq!(decode(&out, 5, 2, &identity(), 0.25).len(), 1);
    }

    #[test]
    fn undoes_letterbox_padding_scale_and_tile_origin() {
        // A 1280x640 image letterboxed to 640: scale 0.5, pad_y 160.
        let tile = Letterbox {
            origin_x: 100,
            origin_y: 50,
            scale: 0.5,
            pad_x: 0.0,
            pad_y: 160.0,
        };
        let out = output(&[[320.0, 320.0, 64.0, 32.0, 0.8]]);
        let d = decode(&out, 5, 1, &tile, 0.25)[0];
        // x: (288 - 0) / 0.5 + 100 = 676; y: (304 - 160) / 0.5 + 50 = 338
        assert_eq!((d.x1, d.y1, d.x2, d.y2), (676.0, 338.0, 804.0, 402.0));
    }

    #[test]
    fn picks_the_best_class() {
        // Two classes: rows 4 and 5.
        let out = vec![10.0, 10.0, 4.0, 4.0, 0.3, 0.7];
        let d = decode(&out, 6, 1, &identity(), 0.25);
        assert_eq!(d[0].class_id, 1);
        assert!((d[0].score - 0.7).abs() < 1e-6);
    }

    #[test]
    fn nms_keeps_the_best_of_overlapping_boxes() {
        let kept = non_max_suppression(
            &[
                det(0.0, 0.0, 10.0, 10.0, 0.6),
                det(1.0, 1.0, 11.0, 11.0, 0.9),
                det(50.0, 50.0, 60.0, 60.0, 0.5),
            ],
            0.45,
            300,
        );
        assert_eq!(
            kept.iter().map(|d| d.score).collect::<Vec<_>>(),
            vec![0.9, 0.5]
        );
    }

    #[test]
    fn nms_keeps_boxes_at_exactly_the_threshold() {
        // IoU of these two is exactly 0.5; Python kept `iou <= threshold`.
        let a = det(0.0, 0.0, 10.0, 10.0, 0.9);
        let b = det(0.0, 0.0, 10.0, 5.0, 0.8);
        assert_eq!(non_max_suppression(&[a, b], 0.5, 300).len(), 2);
    }

    #[test]
    fn nms_respects_the_detection_cap() {
        let boxes: Vec<_> = (0..10)
            .map(|i| {
                det(
                    f64::from(i) * 20.0,
                    0.0,
                    f64::from(i) * 20.0 + 10.0,
                    10.0,
                    0.5,
                )
            })
            .collect();
        assert_eq!(non_max_suppression(&boxes, 0.45, 3).len(), 3);
    }

    #[test]
    fn nms_tolerates_zero_area_boxes() {
        let kept = non_max_suppression(
            &[det(5.0, 5.0, 5.0, 5.0, 0.9), det(5.0, 5.0, 5.0, 5.0, 0.8)],
            0.45,
            300,
        );
        assert_eq!(kept.len(), 2);
        assert!(non_max_suppression(&[], 0.45, 300).is_empty());
    }

    #[test]
    fn clamps_to_the_image_and_drops_collapsed_boxes() {
        let clamped = clamp_to_image(
            vec![
                det(-10.0, -5.0, 50.0, 40.0, 0.9),
                det(120.0, 0.0, 130.0, 10.0, 0.8),
            ],
            100,
            100,
        );
        assert_eq!(clamped.len(), 1);
        assert_eq!(
            (clamped[0].x1, clamped[0].y1, clamped[0].x2, clamped[0].y2),
            (0.0, 0.0, 50.0, 40.0)
        );
    }

    #[test]
    fn percentages_are_of_the_image() {
        assert_eq!(
            to_percentages(&det(10.0, 20.0, 60.0, 70.0, 0.9), 200, 100),
            (5.0, 20.0, 25.0, 50.0)
        );
    }
}
