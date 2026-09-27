"""In-memory image decoding. Nothing here touches the filesystem, so request
frames are never written to disk (spec §4.1)."""
from __future__ import annotations

import io

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

try:  # iPhone photos default to HEIC
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # pragma: no cover - optional at runtime
    pass

MAX_SIDE_PX = 1600


class ImageDecodeError(ValueError):
    pass


def decode_image(data: bytes, max_side: int = MAX_SIDE_PX) -> np.ndarray:
    """Bytes -> upright BGR array, downscaled so the long side <= max_side."""
    try:
        with Image.open(io.BytesIO(data)) as img:
            img = ImageOps.exif_transpose(img)  # phones store rotation in EXIF
            rgb = np.asarray(img.convert("RGB"))
    except (UnidentifiedImageError, OSError, ValueError) as err:
        raise ImageDecodeError(f"Unreadable image: {err}") from err

    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    height, width = bgr.shape[:2]
    scale = max_side / max(height, width)
    if scale < 1:
        bgr = cv2.resize(bgr, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
    return bgr
