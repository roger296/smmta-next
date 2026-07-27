#!/usr/bin/env python3
"""Generate the favicon + PWA icons for Auto-Stock from the Big Bakes logo.

  python apps/web/scripts/make-icons.py <source.png>

Writes into apps/web/public (and apps/stocktake/public with --stocktake):
  favicon.ico          16/32/48 — the browser tab
  icon-192.png         PWA / Android home screen   (manifest already expects it)
  icon-512.png         PWA splash + store listing  (ditto)
  apple-touch-icon.png 180 — iPad home screen

Why the "B" alone and not the full lockup: the brand mark is a wide
rolling-pin-plus-B (roughly 2.8:1). Squeezed into a square the pin handles
collapse to two or three pixels of mush at favicon size and read as noise. The
B is the distinctive element and stays legible at 16px, so it is cropped out
and centred on the brand's own dark background.

The PWA icons are declared `purpose: "any maskable"` in the manifest, which
means the platform may crop them to a circle, squircle or rounded square of its
choosing. Anything outside the central ~80% can be cut, so the mark is scaled
to sit well inside that safe zone rather than filling the tile.
"""
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[3]
WEB_PUBLIC = REPO / 'apps' / 'web' / 'public'
STOCKTAKE_PUBLIC = REPO / 'apps' / 'stocktake' / 'public'

#: Fraction of the tile the mark occupies. Kept under the maskable safe zone
#: (~80%) so a circular crop can't clip the B.
MARK_SCALE = 0.62


def find_mark_bbox(im: Image.Image, bg: tuple[int, int, int]) -> tuple[int, int, int, int]:
    """Bounding box of the teal B — the most saturated blue-green region.

    Matching on hue rather than "not background" deliberately excludes the
    orange rolling pin, which spans nearly the full width and would otherwise
    make the box useless for a square crop.
    """
    px = im.load()
    w, h = im.size
    minx, miny, maxx, maxy = w, h, 0, 0
    for y in range(0, h, 3):
        for x in range(0, w, 3):
            r, g, b = px[x, y][:3]
            # teal: blue and green both clearly above red
            if g > r + 25 and b > r + 25 and (g + b) > 120:
                minx, miny = min(minx, x), min(miny, y)
                maxx, maxy = max(maxx, x), max(maxy, y)
    if maxx <= minx or maxy <= miny:
        raise SystemExit('could not locate the teal mark in the source image')
    return minx, miny, maxx, maxy


def drop_warm_fragments(mark: Image.Image, bg: tuple[int, int, int]) -> Image.Image:
    """Repaint the orange rolling-pin offcuts in the background colour.

    Cropping to the B slices the pin into a few short bars either side. At 32px
    those don't read as a rolling pin — they look like specks of dirt on the
    icon. The teal mark has green and blue above red; the pin is the only warm
    thing in the image, so warm pixels can be removed without touching the B or
    its antialiased edges.
    """
    out = mark.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a > 0 and r > g + 8 and r > b + 8:
                px[x, y] = (*bg, 255)
    return out


def build_tile(mark: Image.Image, size: int, bg: tuple[int, int, int]) -> Image.Image:
    """Square tile: background colour, mark centred at MARK_SCALE."""
    tile = Image.new('RGBA', (size, size), (*bg, 255))
    target = int(size * MARK_SCALE)
    mw, mh = mark.size
    scale = target / max(mw, mh)
    new = mark.resize((max(1, int(mw * scale)), max(1, int(mh * scale))), Image.LANCZOS)
    tile.paste(new, ((size - new.width) // 2, (size - new.height) // 2), new)
    return tile


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit('usage: make-icons.py <source.png> [--stocktake]')
    src = Path(sys.argv[1])
    also_stocktake = '--stocktake' in sys.argv

    im = Image.open(src).convert('RGBA')
    bg = im.convert('RGB').resize((64, 32)).getpixel((1, 1))  # a corner = background

    box = find_mark_bbox(im.convert('RGB'), bg)
    pad = int(max(box[2] - box[0], box[3] - box[1]) * 0.06)
    mark = im.crop((max(0, box[0] - pad), max(0, box[1] - pad),
                    min(im.width, box[2] + pad), min(im.height, box[3] + pad)))
    mark = drop_warm_fragments(mark, bg)
    print(f'source {im.size}  bg {bg}  mark {mark.size}')

    targets = [WEB_PUBLIC] + ([STOCKTAKE_PUBLIC] if also_stocktake else [])
    for out in targets:
        out.mkdir(parents=True, exist_ok=True)
        build_tile(mark, 192, bg).save(out / 'icon-192.png')
        build_tile(mark, 512, bg).save(out / 'icon-512.png')
        build_tile(mark, 180, bg).save(out / 'apple-touch-icon.png')
        # .ico carries several sizes; browsers pick what they need.
        build_tile(mark, 256, bg).save(
            out / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)]
        )
        print(f'  wrote favicon.ico, icon-192.png, icon-512.png, apple-touch-icon.png -> {out}')


if __name__ == '__main__':
    main()
