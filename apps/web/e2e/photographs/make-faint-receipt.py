#!/usr/bin/env python3
"""Draws the fixture `faint-receipt.jpg`: a till receipt as a phone
photographs one, with nothing real on it.

It has to carry the two properties that make the defect it stands for visible,
and no more:

  * the print is grey on grey, not black on white, which is what thermal paper
    fades to;
  * the light falls unevenly across the page, as it does in any hand-held shot.

What it does NOT carry is the defect itself. Drawn text is too clean: the
recogniser reads this page about equally well whichever illumination estimate
is in place (38 of 38 printed words against 37). Several attempts at making it
harder - fainter ink, tighter leading, dense bands where a receipt has its
barcode - moved the two numbers to 18 and 21, which is noise rather than a
regression. The defect needed real thermal print, real paper texture and real
camera softness. So the test that uses this file is a smoke test for the
filter-to-recogniser path, and the regression for the defect itself lives in
docscan-filters as a unit test on the illumination estimate.

Re-run after editing:  python3 make-faint-receipt.py
"""
import pathlib
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 348, 640   # the page ends where the print does, as a short receipt does
PAPER, INK = 206, 128          # 78 levels apart: faint, but legible
FONT = "/System/Library/Fonts/Menlo.ttc"

LINES = [
    ("  SAMPLE STORE NUMBER 0241", 13),
    ("  WESTGATE BRANCH  COUNTER 3", 11),
    ("  INVOICE 8821-004  TILL 06", 11),
    ("", 8),
    ("1192004   QUANTITY 2    14.80", 11),
    ("  GREEN TEA LOOSE LEAF 200G", 11),
    ("1192117   QUANTITY 1     9.25", 11),
    ("  OAT BISCUITS PLAIN 300G", 11),
    ("1192330   QUANTITY 3    21.00", 11),
    ("  SPARKLING WATER 1L", 11),
    ("", 8),
    ("  SUBTOTAL              45.05", 11),
    ("  DISCOUNT APPLIED       3.50", 11),
    ("  BALANCE DUE           41.55", 12),
    ("  PAYMENT CARD APPROVED", 11),
    ("  CHANGE                 0.00", 11),
    ("", 10),
    ("  NO SIGNATURE REQUIRED", 10),
    ("  RETAIN FOR REFUND OR", 10),
    ("  EXCHANGE AT THE SERVICE", 10),
    ("  COUNTER WITHIN 30 DAYS", 10),
    ("", 10),
    ("  THANK YOU FOR YOUR", 10),
    ("  PURCHASE  PLEASE VISIT", 10),
    ("  AGAIN SOON", 10),
]

page = Image.new("L", (W, H), PAPER)
draw = ImageDraw.Draw(page)
y = 40
for text, size in LINES:
    if text:
        try:
            font = ImageFont.truetype(FONT, size)
        except OSError:
            font = ImageFont.load_default()
        draw.text((10, y), text, fill=INK, font=font)
    y += size + 9

# The light: a corner is brighter than the opposite one, as a hand-held shot of
# a small page always is.
light = Image.new("L", (W, H))
lp = light.load()
for yy in range(H):
    for xx in range(W):
        lp[xx, yy] = int(118 + 92 * (1 - (xx / W) * 0.45 - (yy / H) * 0.55))
page = Image.fromarray(
    (__import__("numpy").asarray(page, dtype=float)
     * __import__("numpy").asarray(light, dtype=float) / 190.0)
    .clip(0, 255).astype("uint8"))

# A phone's own softness, and its sensor noise.
page = page.filter(ImageFilter.GaussianBlur(0.6))
random.seed(234)
pp = page.load()
for yy in range(H):
    for xx in range(W):
        pp[xx, yy] = max(0, min(255, pp[xx, yy] + random.randint(-4, 4)))

# Next to this script, not next to whoever ran it.
out = pathlib.Path(__file__).resolve().parent / "faint-receipt.jpg"
page.convert("RGB").save(out, quality=92)
print(out.name, page.size)
