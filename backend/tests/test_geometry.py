"""Coordinate maths, checked against values worked out by hand.

Every bug the parity script caught was a coordinate bug, and coordinate bugs
are silent — boxes still render, just in the wrong place. These tests pin the
transforms so a regression fails here rather than in a reviewer's eyes.
"""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from app.detection.postprocess import (
    RawDetection,
    clamp_to_image,
    decode,
    non_max_suppression,
    to_percentages,
)
from app.detection.preprocess import PAD_VALUE, Tile, letterbox, plan_tiles


class TestLetterbox:
    def test_landscape_pads_top_and_bottom(self):
        image = Image.new("RGB", (1280, 640), (255, 0, 0))
        array, scale, pad_x, pad_y = letterbox(image, model_size=640)

        assert array.shape == (1, 3, 640, 640)
        assert scale == pytest.approx(0.5)
        # 1280x640 scaled by 0.5 is 640x320, so all slack is vertical.
        assert pad_x == pytest.approx(0.0)
        assert pad_y == pytest.approx(160.0)

    def test_padding_uses_the_training_fill_value(self):
        image = Image.new("RGB", (1280, 640), (255, 0, 0))
        array, _, _, _ = letterbox(image, model_size=640)

        # Row 0 is padding, row 200 is image.
        assert array[0, 0, 0, 0] == pytest.approx(PAD_VALUE / 255.0)
        assert array[0, 0, 200, 0] == pytest.approx(1.0)

    def test_never_upscales(self):
        """A 200px crop must not be blown up to 640 — that invents detail."""
        image = Image.new("RGB", (200, 100))
        _, scale, _, _ = letterbox(image, model_size=640)
        assert scale == pytest.approx(1.0)

    def test_reuses_the_supplied_buffer(self):
        image = Image.new("RGB", (640, 640))
        buffer = np.empty((1, 3, 640, 640), dtype=np.float32)
        array, _, _, _ = letterbox(image, model_size=640, out=buffer)
        assert array is buffer


class TestTilePlan:
    def test_small_image_is_a_single_pass(self):
        plan = plan_tiles(800, 600, model_size=640)
        assert not plan.is_tiled
        assert plan.tiles == [(0, 0, 800, 600)]

    def test_large_image_tiles_with_overlap(self):
        plan = plan_tiles(2000, 1000, model_size=640, overlap=0.2)
        assert plan.is_tiled
        # Stride is 512, and the final window snaps flush to each edge.
        assert plan.tiles[0] == (0, 0, 640, 640)
        assert max(right for _, _, right, _ in plan.tiles) == 2000
        assert max(bottom for _, _, _, bottom in plan.tiles) == 1000

    def test_tiles_cover_every_pixel(self):
        width, height = 3000, 2000
        plan = plan_tiles(width, height, model_size=640)
        covered = np.zeros((height, width), dtype=bool)
        for left, top, right, bottom in plan.tiles:
            covered[top:bottom, left:right] = True
        assert covered.all()

    def test_enormous_image_stays_within_the_tile_budget(self):
        plan = plan_tiles(20000, 20000, model_size=640, max_tiles=64)
        assert len(plan.tiles) <= 64
        # Coverage is preserved by growing tiles, not by dropping them.
        assert max(r for _, _, r, _ in plan.tiles) == 20000

    def test_disabled_forces_single_pass(self):
        plan = plan_tiles(5000, 5000, model_size=640, enabled=False)
        assert not plan.is_tiled

    def test_rejects_degenerate_dimensions(self):
        with pytest.raises(ValueError):
            plan_tiles(0, 100)


class TestDecode:
    def _output(self, cx, cy, w, h, score):
        """One anchor's worth of model output, shaped (1, 5, 1)."""
        return np.array([[[cx], [cy], [w], [h], [score]]], dtype=np.float32)

    def test_undoes_letterbox_and_tile_offset(self):
        # A crop taken at (1000, 500), halved to fit, padded 80px vertically.
        tile = Tile(
            array=np.empty(0), origin_x=1000, origin_y=500, scale=0.5, pad_x=0.0, pad_y=80.0
        )
        # Box centred at (320, 240) in tile space, 100x40.
        output = self._output(320, 240, 100, 40, 0.9)

        (detection,) = decode(output, tile, confidence_threshold=0.25)

        # x: (320 - 50 - 0) / 0.5 + 1000 = 1540
        # y: (240 - 20 - 80) / 0.5 + 500  = 780
        assert detection.x1 == pytest.approx(1540.0)
        assert detection.y1 == pytest.approx(780.0)
        assert detection.x2 == pytest.approx(1740.0)
        assert detection.y2 == pytest.approx(860.0)
        assert detection.score == pytest.approx(0.9)

    def test_drops_boxes_below_threshold(self):
        tile = Tile(array=np.empty(0), origin_x=0, origin_y=0, scale=1.0, pad_x=0, pad_y=0)
        assert decode(self._output(10, 10, 4, 4, 0.1), tile, confidence_threshold=0.25) == []

    def test_rejects_output_without_class_rows(self):
        tile = Tile(array=np.empty(0), origin_x=0, origin_y=0, scale=1.0, pad_x=0, pad_y=0)
        with pytest.raises(ValueError):
            decode(np.zeros((1, 4, 10), dtype=np.float32), tile, confidence_threshold=0.25)


class TestNonMaxSuppression:
    def _box(self, x1, y1, x2, y2, score):
        return RawDetection(x1=x1, y1=y1, x2=x2, y2=y2, score=score, class_id=0)

    def test_keeps_the_highest_scoring_of_an_overlapping_pair(self):
        kept = non_max_suppression(
            [self._box(0, 0, 100, 100, 0.6), self._box(5, 5, 105, 105, 0.9)],
            iou_threshold=0.45,
            max_detections=300,
        )
        assert len(kept) == 1
        assert kept[0].score == pytest.approx(0.9)

    def test_keeps_separate_birds(self):
        kept = non_max_suppression(
            [self._box(0, 0, 50, 50, 0.9), self._box(500, 500, 550, 550, 0.8)],
            iou_threshold=0.45,
            max_detections=300,
        )
        assert len(kept) == 2

    def test_zero_area_boxes_do_not_divide_by_zero(self):
        kept = non_max_suppression(
            [self._box(10, 10, 10, 10, 0.9), self._box(0, 0, 50, 50, 0.8)],
            iou_threshold=0.45,
            max_detections=300,
        )
        assert len(kept) == 2

    def test_respects_the_detection_cap(self):
        boxes = [self._box(i * 200, 0, i * 200 + 50, 50, 0.5) for i in range(10)]
        assert len(non_max_suppression(boxes, iou_threshold=0.45, max_detections=3)) == 3

    def test_empty_input(self):
        assert non_max_suppression([], iou_threshold=0.45, max_detections=300) == []


class TestClampAndPercentages:
    def test_trims_a_box_hanging_off_the_edge(self):
        (clamped,) = clamp_to_image(
            [RawDetection(x1=-50, y1=-20, x2=100, y2=80, score=0.9, class_id=0)], 1000, 1000
        )
        assert (clamped.x1, clamped.y1) == (0.0, 0.0)
        assert (clamped.x2, clamped.y2) == (100.0, 80.0)

    def test_drops_a_box_entirely_outside(self):
        outside = RawDetection(x1=2000, y1=2000, x2=2100, y2=2100, score=0.9, class_id=0)
        assert clamp_to_image([outside], 1000, 1000) == []

    def test_percentages_are_relative_to_the_image(self):
        detection = RawDetection(x1=250, y1=100, x2=750, y2=400, score=0.9, class_id=0)
        x, y, w, h = to_percentages(detection, 1000, 500)
        assert (x, y, w, h) == pytest.approx((25.0, 20.0, 50.0, 60.0))

    def test_percentages_are_scale_invariant(self):
        """The same bird in a half-size decode must yield the same percentages.

        This is what lets the detector decode a huge JPEG at reduced scale and
        still report boxes that line up with the full-size original.
        """
        full = to_percentages(
            RawDetection(x1=500, y1=200, x2=1000, y2=600, score=0.9, class_id=0), 2000, 1000
        )
        half = to_percentages(
            RawDetection(x1=250, y1=100, x2=500, y2=300, score=0.9, class_id=0), 1000, 500
        )
        assert full == pytest.approx(half)
