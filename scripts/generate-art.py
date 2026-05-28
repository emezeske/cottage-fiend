#!/usr/bin/env python3
"""Procedurally generate all Cottage Quest art as PNGs.

Streets-of-Rage-ish chunky pixel look, heavy on cottage cheese.
Outputs to client/assets/sprites/. Re-runnable & deterministic.

NOTE: This is a JS project; this Python script is a one-shot art baker so the
generated PNGs ship in the repo. You do not need Python at runtime.
"""
import os, math, random
from PIL import Image, ImageDraw, ImageFont

random.seed(7)
OUT = os.path.join(os.path.dirname(__file__), '..', 'client', 'assets', 'sprites')
os.makedirs(OUT, exist_ok=True)

# palette
CC_WHITE = (245, 244, 230)
CC_CREAM = (228, 224, 196)
CC_SHADOW = (180, 176, 150)
OUTLINE = (30, 24, 20)


def new(w, h):
    return Image.new('RGBA', (w, h), (0, 0, 0, 0))


def save(img, name):
    img.save(os.path.join(OUT, name))
    print('  wrote', name)


def outline_ellipse(d, box, fill, ow=3):
    d.ellipse(box, fill=OUTLINE)
    x0, y0, x1, y1 = box
    d.ellipse((x0+ow, y0+ow, x1-ow, y1-ow), fill=fill)


def cottage_blobs(d, box, n=10, base=CC_WHITE):
    """scatter little cottage-cheese curds inside a box"""
    x0, y0, x1, y1 = box
    for _ in range(n):
        cx = random.randint(int(x0), int(x1))
        cy = random.randint(int(y0), int(y1))
        r = random.randint(2, 5)
        c = random.choice([base, CC_CREAM, CC_SHADOW])
        d.ellipse((cx-r, cy-r, cx+r, cy+r), fill=c)


# --- delivery person sprites (6 color variants, 2 walk frames each) ---------
DELIVERY_COLORS = [
    (210, 90, 70), (70, 140, 200), (90, 180, 110),
    (200, 160, 60), (160, 100, 190), (90, 190, 190),
]

def delivery_sprite(color, frame):
    S = 64
    img = new(S, S)
    d = ImageDraw.Draw(img)
    bob = 0 if frame == 0 else 2
    # legs
    legx = 6 if frame == 0 else -6
    d.rounded_rectangle((24, 44, 32, 60+0), 3, fill=OUTLINE)
    d.rounded_rectangle((32, 44, 40, 60-0), 3, fill=OUTLINE)
    leg = tuple(max(0, c-40) for c in color)
    d.rounded_rectangle((25+legx//3, 45, 31+legx//3, 58), 2, fill=leg)
    d.rounded_rectangle((33-legx//3, 45, 39-legx//3, 58), 2, fill=leg)
    # body (delivery uniform)
    d.rounded_rectangle((18, 26+bob, 46, 48+bob), 5, fill=OUTLINE)
    d.rounded_rectangle((20, 28+bob, 44, 46+bob), 4, fill=color)
    # cottage cheese stain on uniform
    cottage_blobs(d, (22, 34+bob, 42, 45+bob), 5)
    # head
    outline_ellipse(d, (24, 10+bob, 40, 26+bob), (235, 200, 170))
    # cap
    d.rounded_rectangle((22, 9+bob, 42, 16+bob), 3, fill=OUTLINE)
    d.rounded_rectangle((23, 10+bob, 41, 15+bob), 2, fill=color)
    # little "CC" delivery badge
    d.rectangle((30, 32+bob, 36, 38+bob), fill=CC_WHITE, outline=OUTLINE)
    return img

print('delivery sprites...')
for i, col in enumerate(DELIVERY_COLORS):
    for f in (0, 1):
        save(delivery_sprite(col, f), f'delivery_{i}_{f}.png')


# --- The Mallen (placeholder body; face PNG is dropped in by the user) -------
def mallen_sprite(frame, frenzy=False):
    S = 96
    img = new(S, S)
    d = ImageDraw.Draw(img)
    bob = 0 if frame == 0 else 3
    body = (120, 60, 160) if not frenzy else (220, 60, 90)
    # big legs
    d.rounded_rectangle((34, 64, 46, 88), 4, fill=OUTLINE)
    d.rounded_rectangle((50, 64, 62, 88), 4, fill=OUTLINE)
    # huge body
    d.rounded_rectangle((22, 34+bob, 74, 70+bob), 8, fill=OUTLINE)
    d.rounded_rectangle((25, 37+bob, 71, 67+bob), 6, fill=body)
    cottage_blobs(d, (28, 44+bob, 68, 64+bob), 14)
    # head area placeholder ring where the face PNG will be composited
    outline_ellipse(d, (30, 8+bob, 66, 44+bob), (235, 200, 170))
    # angry brows so even the placeholder reads as The Mallen
    d.line((36, 22+bob, 46, 26+bob), fill=OUTLINE, width=3)
    d.line((60, 22+bob, 50, 26+bob), fill=OUTLINE, width=3)
    d.ellipse((40, 26+bob, 46, 32+bob), fill=(40, 30, 30))
    d.ellipse((50, 26+bob, 56, 32+bob), fill=(40, 30, 30))
    # hungry mouth
    d.chord((38, 30+bob, 58, 44+bob), 0, 180, fill=(120, 30, 30))
    # text hint
    return img

print('mallen sprites...')
for f in (0, 1):
    save(mallen_sprite(f, False), f'mallen_{f}.png')
    save(mallen_sprite(f, True), f'mallen_frenzy_{f}.png')

# face-slot guide so the user knows where to drop their face pics
face = new(160, 160)
fd = ImageDraw.Draw(face)
fd.ellipse((10, 10, 150, 150), outline=(200, 60, 60), width=4)
fd.text((28, 70), 'DROP MALLEN\n  FACE HERE', fill=(200, 60, 60))
save(face, 'mallen_face_placeholder.png')


# --- cottage cheese tub ------------------------------------------------------
def tub_sprite():
    S = 40
    img = new(S, S)
    d = ImageDraw.Draw(img)
    # tub body
    d.polygon([(8, 14), (32, 14), (29, 34), (11, 34)], fill=OUTLINE)
    d.polygon([(10, 16), (30, 16), (27.5, 32), (12.5, 32)], fill=(70, 150, 210))
    # lid heaped with cottage cheese
    d.ellipse((6, 8, 34, 18), fill=OUTLINE)
    d.ellipse((8, 9, 32, 17), fill=CC_WHITE)
    cottage_blobs(d, (9, 9, 31, 16), 9)
    # label
    d.rectangle((14, 22, 26, 30), fill=CC_WHITE, outline=OUTLINE)
    d.text((15, 23), 'CC', fill=(70, 120, 180))
    return img

print('tub...')
save(tub_sprite(), 'tub.png')


# --- truck -------------------------------------------------------------------
def truck_sprite():
    img = new(160, 120)
    d = ImageDraw.Draw(img)
    # trailer
    d.rounded_rectangle((10, 30, 120, 95), 6, fill=OUTLINE)
    d.rounded_rectangle((14, 34, 116, 91), 4, fill=(230, 226, 200))
    # giant cottage cheese tub mural on the side
    d.ellipse((34, 44, 96, 84), fill=(70, 150, 210), outline=OUTLINE, width=3)
    cottage_blobs(d, (40, 48, 90, 80), 22)
    d.text((44, 58), 'COTTAGE', fill=OUTLINE)
    d.text((52, 70), 'CHEESE', fill=OUTLINE)
    # cab
    d.rounded_rectangle((118, 48, 150, 95), 5, fill=OUTLINE)
    d.rounded_rectangle((121, 51, 147, 75), 3, fill=(200, 70, 60))
    d.rounded_rectangle((124, 54, 144, 70), 2, fill=(150, 200, 230))
    # wheels
    for wx in (34, 96, 134):
        d.ellipse((wx-12, 88, wx+12, 112), fill=OUTLINE)
        d.ellipse((wx-6, 94, wx+6, 106), fill=(90, 90, 90))
    return img

print('truck...')
save(truck_sprite(), 'truck.png')


# --- fridge ------------------------------------------------------------------
def fridge_sprite():
    img = new(110, 130)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((10, 6, 100, 124), 8, fill=OUTLINE)
    d.rounded_rectangle((14, 10, 96, 120), 6, fill=(220, 230, 235))
    # door split
    d.line((55, 16, 55, 116), fill=OUTLINE, width=3)
    # handles
    d.rounded_rectangle((48, 30, 52, 70), 2, fill=OUTLINE)
    d.rounded_rectangle((58, 30, 62, 70), 2, fill=OUTLINE)
    # cottage cheese magnet/sticker
    d.ellipse((20, 80, 46, 106), fill=(70, 150, 210), outline=OUTLINE, width=2)
    cottage_blobs(d, (24, 84, 42, 102), 8)
    d.text((20, 18), 'FRIDGE', fill=OUTLINE)
    return img

print('fridge...')
save(fridge_sprite(), 'fridge.png')


# --- splatter (3 frames) -----------------------------------------------------
def splat_sprite(seed):
    random.seed(seed)
    S = 64
    img = new(S, S)
    d = ImageDraw.Draw(img)
    for _ in range(18):
        a = random.random() * math.tau
        r = random.randint(6, 28)
        cx = 32 + math.cos(a) * r
        cy = 32 + math.sin(a) * r
        rr = random.randint(3, 8)
        c = random.choice([CC_WHITE, CC_CREAM, CC_SHADOW])
        d.ellipse((cx-rr, cy-rr, cx+rr, cy+rr), fill=c)
    d.ellipse((24, 24, 40, 40), fill=CC_WHITE)
    return img

print('splatters...')
for s in range(3):
    save(splat_sprite(100+s), f'splat_{s}.png')


# --- cottage cheese ad banners (over the top) --------------------------------
ADS = [
    ('GOT CURDS?', (70, 150, 210), CC_WHITE),
    ('CURD IS THE WORD!', (210, 90, 70), CC_WHITE),
    ('LUMPY & PROUD', (90, 180, 110), (20, 40, 20)),
    ("MALLEN'S CHOICE\u2122", (120, 60, 160), CC_WHITE),
    ('PROTEIN GO BRRR', (200, 160, 60), (40, 30, 0)),
    ('FRIDGE IT REAL GOOD', (90, 190, 190), (10, 40, 40)),
    ('HAPPY BDAY MALLEN', (230, 90, 150), CC_WHITE),
]

def ad_banner(text, bg, fg, i):
    W, H = 320, 90
    img = Image.new('RGBA', (W, H), bg + (255,))
    d = ImageDraw.Draw(img)
    cottage_blobs(d, (0, 0, W, H), 40)
    d.rectangle((0, 0, W-1, H-1), outline=OUTLINE, width=4)
    # chunky text centered-ish
    d.text((16, 18), text, fill=OUTLINE)
    d.text((14, 16), text, fill=fg)
    d.text((16, 60), 'cottage cheese forever', fill=fg)
    return img

print('ad banners...')
for i, (t, bg, fg) in enumerate(ADS):
    save(ad_banner(t, bg, fg, i), f'ad_{i}.png')


# --- parachuting present -----------------------------------------------------
def present_sprite():
    S = 52
    img = new(S, S)
    d = ImageDraw.Draw(img)
    # box
    d.rounded_rectangle((8, 22, 44, 48), 3, fill=OUTLINE)
    d.rounded_rectangle((10, 24, 42, 46), 2, fill=(210, 70, 90))
    # ribbon
    d.rectangle((23, 22, 29, 48), fill=(250, 230, 120))
    d.rectangle((10, 32, 42, 37), fill=(250, 230, 120))
    # bow
    d.ellipse((18, 14, 28, 24), fill=(250, 230, 120), outline=OUTLINE)
    d.ellipse((24, 14, 34, 24), fill=(250, 230, 120), outline=OUTLINE)
    # a curd or two for theme
    cottage_blobs(d, (12, 26, 40, 44), 4)
    return img

print('present...')
save(present_sprite(), 'present.png')

def parachute_sprite():
    S = 96
    img = new(S, S)
    d = ImageDraw.Draw(img)
    # canopy
    d.pieslice((8, 6, 88, 86), 180, 360, fill=(240, 240, 245), outline=OUTLINE, width=3)
    # panels
    for x in (28, 48, 68):
        d.line((x, 10, 48, 46), fill=OUTLINE, width=2)
    cottage_blobs(d, (16, 14, 80, 44), 18)
    # strings
    for x in (16, 48, 80):
        d.line((x, 44, 48, 70), fill=OUTLINE, width=1)
    return img

print('parachute...')
save(parachute_sprite(), 'parachute.png')


# --- birthday cake tub (for the leaderboard) --------------------------------
def birthday_tub():
    W, H = 220, 200
    img = new(W, H)
    d = ImageDraw.Draw(img)
    # big tub of cottage cheese
    d.polygon([(40, 90), (180, 90), (165, 185), (55, 185)], fill=OUTLINE)
    d.polygon([(46, 94), (174, 94), (160, 180), (60, 180)], fill=(70, 150, 210))
    # heaped cottage cheese top
    d.ellipse((34, 70, 186, 110), fill=OUTLINE)
    d.ellipse((38, 73, 182, 107), fill=CC_WHITE)
    cottage_blobs(d, (44, 76, 176, 104), 40)
    # candles
    for cx, col in [(80, (230, 90, 90)), (110, (90, 160, 230)), (140, (120, 200, 120))]:
        d.rectangle((cx-3, 36, cx+3, 80), fill=col, outline=OUTLINE)
        # flame
        d.ellipse((cx-5, 22, cx+5, 38), fill=(255, 200, 60))
        d.ellipse((cx-3, 26, cx+3, 36), fill=(255, 240, 160))
    # label
    d.rectangle((78, 130, 142, 165), fill=CC_WHITE, outline=OUTLINE, width=2)
    d.text((86, 140), 'CC', fill=(70, 120, 180))
    return img

print('birthday tub...')
save(birthday_tub(), 'birthday_tub.png')

print('DONE. Art written to', OUT)
