#!/usr/bin/env python3
"""Compose the desktop app icon: white squircle with the dino's face cropped large.

Inputs : icon-source.png (the dino character, transparent background, 1218x1360)
Outputs: icon-1024.png (1024x1024), icon.iconset/*.png, and on macOS icon.icns (iconutil)

The same picture is the phone's app icon (mobile/app/ios AppIcon, Android ic_launcher).
Design ④ "big face" — all three horns and both eyes stay inside, the body runs
off the right and bottom edges.

Why a squircle background?
  macOS native apps put the logo on a rounded square. Apple's exact shape is a superellipse, but a rounded
  rectangle with corner radius ≈ 22.37% of the side is visually indistinguishable and is what most
  design tools export. Windows and Linux builds read icon-1024.png directly (electron-builder.yml).
"""
import subprocess, sys
from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "icon-source.png"
OUT = HERE / "icon-1024.png"
SET = HERE / "icon.iconset"

SIZE = 1024
CORNER = round(SIZE * 0.2237)   # macOS squircle approximation
# Placement on the 1024 canvas. The character is drawn 1048 px wide with its top-left at (40, 66):
# the leftmost horn keeps a 40 px margin, the right eye ends 57 px from the edge.
ART_WIDTH = 1048
ART_LEFT, ART_TOP = 40, 66
ICONSET = {  # file name -> pixels
    "icon_16x16.png": 16, "icon_16x16@2x.png": 32, "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128, "icon_128x128@2x.png": 256, "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512, "icon_512x512@2x.png": 1024,
}


def compose(size: int) -> Image.Image:
    """The icon at `size` px, drawn 2x (4x when small) and reduced, so small sizes stay clean."""
    k = 4 if size <= 256 else 2
    n = size * k
    f = n / SIZE
    art = Image.open(SRC).convert("RGBA")
    w = round(ART_WIDTH * f)
    h = round(w * art.height / art.width)
    canvas = Image.new("RGBA", (n, n), (255, 255, 255, 255))
    canvas.alpha_composite(art.resize((w, h), Image.LANCZOS), (round(ART_LEFT * f), round(ART_TOP * f)))
    # a faint inner edge so the white square does not vanish on a white desktop
    edge = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle([(0, 0), (n - 1, n - 1)], round(n * 0.2237), outline=(0, 0, 0, 40), width=max(1, round(2 * f)))
    canvas.alpha_composite(edge.filter(ImageFilter.GaussianBlur(1.2 * f)))
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([(0, 0), (n - 1, n - 1)], round(n * 0.2237), fill=255)
    canvas.putalpha(mask)
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"missing {SRC}")
    compose(SIZE).save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")
    SET.mkdir(exist_ok=True)
    for name, px in ICONSET.items():
        compose(px).save(SET / name, "PNG", optimize=True)
    print(f"wrote {len(ICONSET)} files in {SET}")
    if sys.platform == "darwin":
        subprocess.run(["iconutil", "-c", "icns", str(SET), "-o", str(HERE / "icon.icns")], check=True)
        print(f"wrote {HERE / 'icon.icns'}")
    else:
        print("icon.icns not rebuilt: iconutil exists only on macOS")


if __name__ == "__main__":
    main()
