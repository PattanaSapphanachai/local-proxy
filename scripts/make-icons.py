#!/usr/bin/env python3
"""Generate the app icon (build/icon.png, build/icon.icns) and the macOS tray template icons.

Pure Python PNG writer, no Pillow required. Design: rounded square gradient with a white
hub glyph (center node linked to three outer nodes), i.e. a local proxy fanning out to models.
"""
import math, os, pathlib, shutil, struct, subprocess, sys, zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
ASSETS = ROOT / "electron" / "assets"

def png(path, size, pixel):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            raw.extend(pixel(x + 0.5, y + 0.5))
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))

def clamp(v): return 0.0 if v < 0 else 1.0 if v > 1 else v
def sd_round_rect(x, y, cx, cy, half, r):
    qx, qy = abs(x - cx) - half + r, abs(y - cy) - half + r
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r
def sd_segment(px, py, ax, ay, bx, by):
    abx, aby = bx - ax, by - ay
    t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby))
    return math.hypot(px - (ax + abx * t), py - (ay + aby * t))

def hub_alpha(x, y, cx, cy, scale):
    """Coverage of the hub glyph in [0,1]. scale = glyph radius in px."""
    outer = [(cx + scale * math.cos(a), cy + scale * math.sin(a)) for a in (-math.pi / 2, math.pi / 6, 5 * math.pi / 6)]
    d = math.hypot(x - cx, y - cy) - scale * 0.26
    for ox, oy in outer:
        d = min(d, math.hypot(x - ox, y - oy) - scale * 0.17)
        d = min(d, sd_segment(x, y, cx, cy, ox, oy) - scale * 0.065)
    return clamp(0.5 - d)

def app_pixel(size):
    cx = cy = size / 2; half = size * 0.46; radius = size * 0.225
    def pixel(x, y):
        bg = clamp(0.5 - sd_round_rect(x, y, cx, cy, half, radius))
        if bg <= 0: return (0, 0, 0, 0)
        t = clamp((x + y) / (2 * size))
        r, g, b = 79 + (14 - 79) * t, 70 + (165 - 70) * t, 229 + (233 - 229) * t
        glyph = hub_alpha(x, y, cx, cy, size * 0.27)
        r, g, b = r + (255 - r) * glyph, g + (255 - g) * glyph, b + (255 - b) * glyph
        return (int(r), int(g), int(b), int(255 * bg))
    return pixel

def tray_pixel(size):
    cx = cy = size / 2
    def pixel(x, y):
        return (0, 0, 0, int(255 * hub_alpha(x, y, cx, cy, size * 0.36)))
    return pixel

def main():
    BUILD.mkdir(exist_ok=True); ASSETS.mkdir(parents=True, exist_ok=True)
    master = BUILD / "icon.png"
    png(master, 1024, app_pixel(1024)); print("wrote", master)
    iconset = BUILD / "icon.iconset"
    if iconset.exists(): shutil.rmtree(iconset)
    iconset.mkdir()
    for base in (16, 32, 128, 256, 512):
        for mult, suffix in ((1, ""), (2, "@2x")):
            px = base * mult; out = iconset / f"icon_{base}x{base}{suffix}.png"
            if px == 1024: shutil.copy(master, out)
            else: subprocess.run(["sips", "-z", str(px), str(px), str(master), "--out", str(out)], check=True, capture_output=True)
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(BUILD / "icon.icns")], check=True)
    shutil.rmtree(iconset); print("wrote", BUILD / "icon.icns")
    png(ASSETS / "trayTemplate@2x.png", 44, tray_pixel(44))
    png(ASSETS / "trayTemplate.png", 22, tray_pixel(22))
    print("wrote tray icons in", ASSETS)

if __name__ == "__main__":
    main()
