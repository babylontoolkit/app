#!/usr/bin/env python3
"""
Decode EVERY pixel's alpha byte out of a PNG, from the raw file — no image library, no canvas.

T9's Details single this out as the one measurement that must not be taken from a container check:
"Verify alpha by decoding every pixel's alpha byte, not by reading the PNG colortype. A fully opaque
image in an RGBA container passes a naive `colortype === 6` check, and this repo has already shipped
that exact false positive once."

So this parses IHDR, inflates the IDAT stream, reverses the per-scanline filters, and counts the alpha
byte of every pixel. It reports the colortype separately and deliberately does NOT use it to decide
anything, so the two can be compared: colortype 6 with 100% alpha=255 is exactly the false positive.

Usage: python3 decode-alpha.py <file.png>
"""
import struct
import sys
import zlib


def chunks(data: bytes):
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    i = 8
    while i < len(data):
        (length,) = struct.unpack(">I", data[i : i + 4])
        ctype = data[i + 4 : i + 8]
        yield ctype, data[i + 8 : i + 8 + length]
        i += 8 + length + 4  # +4 CRC


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def main(path: str) -> int:
    raw = open(path, "rb").read()

    idat = b""
    width = height = colortype = bitdepth = None

    for ctype, body in chunks(raw):
        if ctype == b"IHDR":
            width, height, bitdepth, colortype = struct.unpack(">IIBB", body[:10])
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break

    if colortype != 6 or bitdepth != 8:
        print(f"colortype={colortype} bitdepth={bitdepth} — this script handles 8-bit RGBA only")
        return 2

    bpp = 4
    stride = width * bpp
    data = zlib.decompress(idat)

    prev = bytearray(stride)
    out = bytearray()
    pos = 0

    for _ in range(height):
        f = data[pos]
        pos += 1
        line = bytearray(data[pos : pos + stride])
        pos += stride

        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0

            if f == 1:
                line[x] = (line[x] + a) & 0xFF
            elif f == 2:
                line[x] = (line[x] + b) & 0xFF
            elif f == 3:
                line[x] = (line[x] + (a + b) // 2) & 0xFF
            elif f == 4:
                line[x] = (line[x] + paeth(a, b, c)) & 0xFF

        out += line
        prev = line

    total = width * height
    transparent = semi = opaque = 0

    for i in range(3, len(out), 4):
        alpha = out[i]
        if alpha == 0:
            transparent += 1
        elif alpha == 255:
            opaque += 1
        else:
            semi += 1

    corners = [
        out[3],
        out[(width - 1) * 4 + 3],
        out[(total - width) * 4 + 3],
        out[(total - 1) * 4 + 3],
    ]

    print(f"file                 {path}")
    print(f"bytes                {len(raw):,}")
    print(f"dimensions           {width}x{height}   ({total:,} pixels)")
    print(f"colortype            {colortype}  <- REPORTED, NOT USED to decide anything")
    print(f"fully transparent    {transparent:>10,}  {transparent / total * 100:6.2f}%")
    print(f"semi transparent     {semi:>10,}  {semi / total * 100:6.2f}%")
    print(f"fully opaque         {opaque:>10,}  {opaque / total * 100:6.2f}%")
    print(f"corner alphas        {corners}")
    print()
    print("VERDICT:", "REAL ALPHA" if transparent > 0 else "OPAQUE — the false positive this guards against")

    return 0 if transparent > 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
