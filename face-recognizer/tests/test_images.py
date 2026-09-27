from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from app.images import ImageDecodeError, decode_image


def encode(image: Image.Image, fmt: str = "JPEG", **kwargs) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format=fmt, **kwargs)
    return buf.getvalue()


def test_exif_rotation_is_applied():
    # 300 wide x 100 tall, tagged "rotate 90" (EXIF orientation 6) like a phone portrait
    img = Image.new("RGB", (300, 100), (255, 0, 0))
    exif = Image.Exif()
    exif[0x0112] = 6
    decoded = decode_image(encode(img, exif=exif.tobytes()))
    assert decoded.shape[:2] == (300, 100)  # now tall


def test_output_is_bgr():
    decoded = decode_image(encode(Image.new("RGB", (10, 10), (255, 0, 0)), "PNG"))
    assert tuple(decoded[0, 0]) == (0, 0, 255)


def test_large_images_are_downscaled():
    decoded = decode_image(encode(Image.new("RGB", (4000, 3000))), max_side=1600)
    assert max(decoded.shape[:2]) == 1600


def test_unreadable_bytes_raise():
    with pytest.raises(ImageDecodeError):
        decode_image(b"definitely not an image")


def test_heic_support_is_installed():
    pytest.importorskip("pillow_heif")
    assert "HEIF" in Image.registered_extensions().values() or ".heic" in Image.registered_extensions()
