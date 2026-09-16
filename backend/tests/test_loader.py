"""Image decoding: the layer that meets whatever a camera actually produced.

Most of these guard against real formats and real failure modes rather than
hypothetical ones — MPO and EXIF rotation both came out of the training set.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image

from app.detection.loader import (
    MAX_PIXELS,
    SUPPORTED_FORMATS,
    ImageDecodeError,
    ImageTooLargeError,
    open_image,
    read_dimensions,
)


def encode(width=800, height=600, fmt="JPEG", exif=None, colour=(30, 80, 100)) -> bytes:
    buffer = io.BytesIO()
    image = Image.new("RGB", (width, height), colour)
    if exif is not None:
        image.save(buffer, fmt, exif=exif)
    else:
        image.save(buffer, fmt)
    return buffer.getvalue()


def exif_with_orientation(value: int) -> Image.Exif:
    exif = Image.Exif()
    exif[0x0112] = value
    return exif


class TestFormats:
    @pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP"])
    def test_opens_every_format_the_uploader_accepts(self, fmt):
        with open_image(encode(fmt=fmt)) as image:
            assert image.size == (800, 600)
            assert image.mode == "RGB"

    def test_mpo_is_supported(self):
        """MPO is JPEG with extra frames and 7% of the training set is MPO.

        Rejecting it would turn real photographs from real cameras away.
        """
        assert "MPO" in SUPPORTED_FORMATS

    def test_rejects_a_format_we_do_not_handle(self):
        buffer = io.BytesIO()
        Image.new("RGB", (10, 10)).save(buffer, "BMP")

        with pytest.raises(ImageDecodeError, match="Unsupported image format"):
            open_image(buffer.getvalue())

    def test_rejects_bytes_that_are_not_an_image(self):
        with pytest.raises(ImageDecodeError):
            open_image(b"this is not an image at all")

    def test_rejects_truncated_data(self):
        with pytest.raises(ImageDecodeError):
            open_image(encode()[:120])

    def test_converts_greyscale_and_alpha_to_rgb(self):
        """The model wants 3 channels; a PNG with alpha would otherwise be 4."""
        for mode, fmt in (("L", "PNG"), ("RGBA", "PNG"), ("P", "PNG")):
            buffer = io.BytesIO()
            Image.new(mode, (64, 48)).save(buffer, fmt)
            with open_image(buffer.getvalue()) as image:
                assert image.mode == "RGB", mode


class TestOrientation:
    def test_applies_exif_rotation(self):
        """Orientation 6 is a quarter turn, so the decoded image is portrait."""
        data = encode(800, 600, exif=exif_with_orientation(6))
        with open_image(data) as image:
            assert image.size == (600, 800)

    def test_read_dimensions_agrees_with_the_decoded_image(self):
        """Tiling is planned from read_dimensions and boxes are mapped against
        the decode, so a disagreement puts every box in the wrong place."""
        for orientation in (1, 3, 6, 8):
            data = encode(800, 600, exif=exif_with_orientation(orientation))
            with open_image(data) as image:
                assert read_dimensions(data) == image.size, orientation

    def test_read_dimensions_survives_missing_exif(self):
        assert read_dimensions(encode(320, 240, fmt="PNG")) == (320, 240)

    def test_read_dimensions_rejects_junk(self):
        with pytest.raises(ImageDecodeError):
            read_dimensions(b"nope")


class TestSafety:
    def test_refuses_a_decompression_bomb_before_decoding_it(self):
        """The header is checked first, so the allocation never happens."""
        buffer = io.BytesIO()
        Image.new("RGB", (64, 64)).save(buffer, "PNG")
        data = bytearray(buffer.getvalue())

        # Rewrite the IHDR width/height to claim an enormous image.
        header = data.index(b"IHDR") + 4
        data[header : header + 8] = (60000).to_bytes(4, "big") + (60000).to_bytes(4, "big")

        with pytest.raises((ImageTooLargeError, ImageDecodeError)):
            open_image(bytes(data))

    def test_the_pixel_ceiling_leaves_room_for_real_cameras(self):
        # A 100MP medium-format frame should not be refused.
        assert MAX_PIXELS > 100_000_000


class TestDraftDecoding:
    def test_draft_decodes_a_large_jpeg_at_reduced_scale(self):
        """This is where most of the memory saving on the common path comes
        from: libjpeg shrinks during decode rather than after."""
        data = encode(4000, 3000)

        with open_image(data, target_size=640) as drafted:
            assert max(drafted.size) < 4000

        with open_image(data, target_size=None) as full:
            assert full.size == (4000, 3000)

    def test_draft_preserves_aspect_ratio(self):
        with open_image(encode(4000, 2000), target_size=640) as image:
            assert image.width / image.height == pytest.approx(2.0, abs=0.01)

    def test_draft_is_a_no_op_for_png(self):
        """PNG has no DCT scaling; the request must simply be ignored."""
        with open_image(encode(1200, 900, fmt="PNG"), target_size=640) as image:
            assert image.size == (1200, 900)
