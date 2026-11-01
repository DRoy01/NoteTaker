"""Render the app icons with Pillow: python scripts/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw

BG, AMBER, DARK = "#11141b", "#f2a93b", "#1a1409"
OUT = Path(__file__).resolve().parent.parent / "icons"
OUT.mkdir(exist_ok=True)


def render(size, rounded):
    s = 4  # supersample for smooth edges
    big = size * s
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0) if rounded else BG)
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big // 5, fill=BG)
    r = big * 0.28
    c = big / 2
    d.ellipse([c - r, c - r, c + r, c + r], fill=AMBER)
    w = max(2, int(big * 0.045))
    pts = [(c - r * 0.45, c + r * 0.02), (c - r * 0.1, c + r * 0.38), (c + r * 0.5, c - r * 0.32)]
    d.line(pts, fill=DARK, width=w, joint="curve")
    for x, y in (pts[0], pts[2]):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=DARK)
    return img.resize((size, size), Image.LANCZOS)


# maskable icons need the full square filled, so only the SVG is rounded
render(192, False).save(OUT / "icon-192.png")
render(512, False).save(OUT / "icon-512.png")
render(180, False).convert("RGB").save(OUT / "apple-touch-icon.png")
print("icons written to", OUT)
