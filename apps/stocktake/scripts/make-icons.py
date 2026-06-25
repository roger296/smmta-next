#!/usr/bin/env python3
"""Generate the two PWA icons (no third-party deps — a tiny raw-PNG encoder).

A flat dark tile with a centred accent rounded-square — clean enough as a home-
screen icon for the demo. Re-run if the brand colours change.

  python apps/stocktake/scripts/make-icons.py
"""
import os
import struct
import zlib

BG = (0x1F, 0x2A, 0x37)      # --bar
FG = (0x2F, 0x6F, 0xED)      # --accent
INNER = (0xF4, 0xF5, 0xF7)   # --paper


def rounded_square(px, py, x0, y0, x1, y1, r):
    # Clamp the point to the rect inset by r; inside iff within r of that point.
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    dx, dy = px - cx, py - cy
    return dx * dx + dy * dy <= r * r


def make(size, path):
    s = size
    pad = int(s * 0.18)
    x0, y0, x1, y1 = pad, pad, s - pad, s - pad
    r = int(s * 0.16)
    ipad = int(s * 0.34)
    ix0, iy0, ix1, iy1 = ipad, ipad, s - ipad, s - ipad
    ir = int(s * 0.06)

    rows = bytearray()
    for y in range(s):
        rows.append(0)  # no filter
        for x in range(s):
            colour = BG
            if rounded_square(x, y, x0, y0, x1, y1, r):
                colour = FG
            if rounded_square(x, y, ix0, iy0, ix1, iy1, ir):
                colour = INNER
            rows.extend(colour)

    def chunk(tag, data):
        return (
            struct.pack('>I', len(data))
            + tag
            + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', s, s, 8, 2, 0, 0, 0)  # 8-bit RGB
    idat = zlib.compress(bytes(rows), 9)
    png = sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)
    print(f"[make-icons] wrote {path} ({len(png)} bytes)")


def main():
    out = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'public'))
    os.makedirs(out, exist_ok=True)
    make(192, os.path.join(out, 'icon-192.png'))
    make(512, os.path.join(out, 'icon-512.png'))


if __name__ == '__main__':
    main()
