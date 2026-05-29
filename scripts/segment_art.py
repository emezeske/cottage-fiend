#!/usr/bin/env python3
"""Segment the hand-provided art sheets in art-source/ into the individual sprite
PNGs the game loads from client/assets/sprites/.

Sources (art-source/):
  general.png        labeled grid: truck, fridge, birthday tub, present, parachute,
                     splats, ad icon (delivery + mallen cells are ignored)
  delivery_gray.png  grayscale 8-direction "Marcus" walk sheet -> recolor x6 variants
  mallen_demon.png   red demon 8-direction walk sheet -> Mallen (frenzy=red, normal=desat)
  tub_hero.png       standalone Daisy cottage cheese tub -> tub.png

The provided PNGs have an OPAQUE checkerboard baked in (no real alpha), so we key it
out via a flood-fill from the border that stops at the sprites' dark outlines.

Run:  python scripts/segment_art.py
"""
import os
import numpy as np
from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'art-source')
OUT = os.path.join(ROOT, 'client', 'assets', 'sprites')
os.makedirs(OUT, exist_ok=True)


def load(name):
    return np.array(Image.open(os.path.join(SRC, name)).convert('RGBA'))


def save(arr, name):
    Image.fromarray(arr, 'RGBA').save(os.path.join(OUT, name))
    print('  wrote', name, arr.shape[1], 'x', arr.shape[0])


# --- checkerboard keyout ----------------------------------------------------
def _checker_levels(rgb):
    """The 1-3 dominant near-gray levels along the border = the checkerboard."""
    h, w, _ = rgb.shape
    border = np.concatenate([
        rgb[:5].reshape(-1, 3), rgb[-5:].reshape(-1, 3),
        rgb[:, :5].reshape(-1, 3), rgb[:, -5:].reshape(-1, 3),
    ]).astype(int)
    sat = border.max(1) - border.min(1)
    gray = border[sat <= 12]
    if len(gray) == 0:
        return []
    lvl = gray.mean(1).astype(int)
    vals, counts = np.unique(lvl, return_counts=True)
    order = np.argsort(-counts)
    # cluster the top values into distinct levels (>=20 apart)
    levels = []
    for v in vals[order]:
        if all(abs(int(v) - L) > 18 for L in levels):
            levels.append(int(v))
        if len(levels) >= 3:
            break
    return levels


def keyout_checker(arr, tol=16, levels=None, gray_range=None):
    """Return arr (RGBA) with the baked checkerboard background made transparent.
    Flood-fills the background from the border so enclosed sprite pixels of a
    similar gray are preserved.
      - levels: discrete checker grays to match within `tol` (light sheets)
      - gray_range: (lo, hi) — treat the whole desaturated band as background,
        bridging anti-aliased gaps between checker squares (dark character sheets);
        relies on the sprites' near-black outlines (< lo) to contain the flood."""
    rgb = arr[:, :, :3].astype(int)
    h, w, _ = rgb.shape
    sat = rgb.max(2) - rgb.min(2)
    gray = rgb.mean(2)
    cand = sat <= 18
    if gray_range is not None:
        lo, hi = gray_range
        cand &= (gray >= lo) & (gray <= hi)
    else:
        if levels is None:
            levels = _checker_levels(rgb)
        lvlmask = np.zeros((h, w), bool)
        for L in levels:
            lvlmask |= np.abs(gray - L) <= tol
        cand &= lvlmask

    # flood from the border within the candidate mask
    reach = np.zeros((h, w), bool)
    reach[0] = cand[0]; reach[-1] = cand[-1]
    reach[:, 0] = cand[:, 0]; reach[:, -1] = cand[:, -1]
    while True:
        new = reach.copy()
        new[1:] |= reach[:-1]; new[:-1] |= reach[1:]
        new[:, 1:] |= reach[:, :-1]; new[:, :-1] |= reach[:, 1:]
        new &= cand
        if np.array_equal(new, reach):
            break
        reach = new

    out = arr.copy()
    out[reach, 3] = 0
    return out


# --- geometry helpers -------------------------------------------------------
def content_bbox(arr, athresh=8):
    a = arr[:, :, 3] > athresh
    ys, xs = np.where(a)
    if len(xs) == 0:
        return None
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


def trim(arr, pad=2):
    bb = content_bbox(arr)
    if not bb:
        return arr
    x0, y0, x1, y1 = bb
    x0 = max(0, x0 - pad); y0 = max(0, y0 - pad)
    x1 = min(arr.shape[1], x1 + pad); y1 = min(arr.shape[0], y1 + pad)
    return arr[y0:y1, x0:x1]


def to_square(arr):
    h, w = arr.shape[:2]
    s = max(h, w)
    canvas = np.zeros((s, s, 4), np.uint8)
    oy, ox = (s - h) // 2, (s - w) // 2
    canvas[oy:oy + h, ox:ox + w] = arr
    return canvas


def resize(arr, size):
    im = Image.fromarray(arr, 'RGBA').resize((size, size), Image.LANCZOS)
    return np.array(im)


def resize_max(arr, maxdim):
    h, w = arr.shape[:2]
    s = maxdim / max(h, w)
    im = Image.fromarray(arr, 'RGBA').resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    return np.array(im)


# --- tub --------------------------------------------------------------------
def do_tub():
    print('tub...')
    a = load('tub_hero.png')
    a = keyout_checker(a)
    a = trim(a)
    a = to_square(a)
    a = resize(a, 256)
    save(a, 'tub.png')


# --- connected components (no scipy) ----------------------------------------
def connected_components(fg):
    from collections import deque
    h, w = fg.shape
    lab = np.zeros((h, w), np.int32)
    cur = 0
    coords = np.argwhere(fg)
    for (y, x) in coords:
        if lab[y, x]:
            continue
        cur += 1
        dq = deque([(y, x)]); lab[y, x] = cur
        while dq:
            cy, cx = dq.popleft()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < h and 0 <= nx < w and fg[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = cur; dq.append((ny, nx))
    return lab, cur


def big_blobs(arr, min_area=1500, min_side=40):
    """Return list of (bbox, centroid, area) for large opaque components."""
    fg = arr[:, :, 3] > 16
    lab, n = connected_components(fg)
    out = []
    for i in range(1, n + 1):
        ys, xs = np.where(lab == i)
        area = len(xs)
        if area < min_area:
            continue
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        if (x1 - x0) < min_side or (y1 - y0) < min_side:
            continue
        out.append(((x0, y0, x1, y1), ((x0 + x1) // 2, (y0 + y1) // 2), area))
    return out


def do_general_debug():
    print('general (debug)...')
    a = keyout_checker(load('general.png'))
    blobs = big_blobs(a)
    # reading order: top-to-bottom rows, left-to-right
    blobs.sort(key=lambda b: (b[1][1] // 110, b[1][0]))
    from PIL import ImageDraw
    tiles = []
    for (bb, c, area) in blobs:
        x0, y0, x1, y1 = bb
        tiles.append((a[y0:y1, x0:x1], bb, area))
    cols = 5
    ts = 200
    rows = (len(tiles) + cols - 1) // cols
    mont = Image.new('RGBA', (cols * ts, rows * ts), (40, 40, 50, 255))
    d = ImageDraw.Draw(mont)
    for i, (img, bb, area) in enumerate(tiles):
        t = Image.fromarray(trim(img), 'RGBA')
        t.thumbnail((ts - 16, ts - 40))
        gx, gy = (i % cols) * ts, (i // cols) * ts
        mont.alpha_composite(t, (gx + 8, gy + 28))
        d.text((gx + 6, gy + 4), f'#{i} {bb} a={area}', fill=(255, 230, 90, 255))
    mont.save(os.path.join(SRC, '_general_blobs.png'))
    print('  wrote art-source/_general_blobs.png with', len(tiles), 'blobs')


def do_general():
    print('general...')
    a = keyout_checker(load('general.png'))
    blobs = big_blobs(a)
    blobs.sort(key=lambda b: (b[1][1] // 110, b[1][0]))
    names = {
        14: 'truck', 15: 'fridge', 16: 'splat_0', 17: 'splat_1',
        18: 'present', 19: 'parachute', 20: 'birthday_tub', 21: 'ad_app_icon',
    }
    for idx, name in names.items():
        (x0, y0, x1, y1), c, area = blobs[idx]
        crop = trim(a[y0:y1, x0:x1])
        save(resize_max(crop, 256), name + '.png')
    # splat_2: a distinct third splat from a rotated splat_1
    s1 = Image.open(os.path.join(OUT, 'splat_1.png'))
    s2 = s1.rotate(63, resample=Image.BICUBIC, expand=False)
    save(np.array(s2.convert('RGBA')), 'splat_2.png')


# --- directional sheet calibration ------------------------------------------
SHEET_RANGE = (60, 118)   # desaturated band = the (flat dark-gray) character-sheet background


# The AI prints a small direction label in each cell's top-left corner; erase it.
# The sprite is centered, so this corner is clear of the character.
LABEL_CLEAR_H = 42
LABEL_CLEAR_W = 50


def sheet_cells(name, header, rows=4, cols=8):
    """Yield (r, c, cell_rgba) for each grid cell: background keyed out, the
    top-left label corner erased, then trimmed to the sprite."""
    a = load(name)
    h, w = a.shape[:2]
    cw = w / cols
    ch = (h - header) / rows
    for r in range(rows):
        for c in range(cols):
            x0 = round(c * cw); x1 = round((c + 1) * cw)
            y0 = round(header + r * ch); y1 = round(header + (r + 1) * ch)
            cell = keyout_checker(a[y0:y1, x0:x1].copy(), gray_range=SHEET_RANGE)
            cell[:LABEL_CLEAR_H, :LABEL_CLEAR_W, 3] = 0
            yield r, c, trim(cell)


def collect_cells(name, header):
    return {(r, c): cell for r, c, cell in sheet_cells(name, header)}


# Best-guess (row, col) -> direction, 2 frames each. Tune after viewing preview.
DIR_MAP = {
    's':  [(0, 1), (0, 2)],   # down / front
    'n':  [(0, 4), (0, 5)],   # up / back
    'w':  [(1, 2), (1, 6)],   # left profile
    'e':  [(2, 2), (2, 5)],   # right profile
    'se': [(2, 1), (2, 3)],   # down-right (3/4)
    'ne': [(0, 6), (0, 7)],   # up-right (back 3/4)
    'sw': [(3, 1), (3, 2)],   # down-left (3/4)
    'nw': [(1, 4), (1, 5)],   # up-left (back 3/4)
}
COMPASS = {'nw': (0, 0), 'n': (0, 1), 'ne': (0, 2),
           'w': (1, 0), 'e': (1, 2),
           'sw': (2, 0), 's': (2, 1), 'se': (2, 2)}


def do_dir_preview(name, header):
    print(f'direction preview {name}...')
    from PIL import ImageDraw
    cells = collect_cells(name, header)
    ts = 130
    mont = Image.new('RGBA', (3 * 2 * ts, 3 * ts), (35, 35, 48, 255))
    d = ImageDraw.Draw(mont)
    for dr, (gr, gc) in COMPASS.items():
        for fi, rc in enumerate(DIR_MAP[dr]):
            cell = cells.get(rc)
            if cell is None or cell.shape[0] < 4:
                continue
            t = Image.fromarray(cell, 'RGBA'); t.thumbnail((ts - 10, ts - 20))
            gx = (gc * 2 + fi) * ts; gy = gr * ts
            mont.alpha_composite(t, (gx + 5, gy + 16))
            d.text((gx + 4, gy + 2), f'{dr}{fi} {rc}', fill=(255, 230, 90, 255))
    mont.save(os.path.join(SRC, f'_{name[:-4]}_compass.png'))
    print(f'  wrote _{name[:-4]}_compass.png')


DIRS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw']
DELIVERY_COLORS = [
    (205, 60, 52), (58, 110, 205), (70, 175, 92), (215, 168, 52),
    (150, 80, 195), (58, 182, 178), (235, 125, 35), (238, 95, 170),
    (70, 205, 225), (160, 205, 55), (140, 95, 55), (205, 205, 215),
]


def place_bottom_center(cell, S, margin=3):
    h, w = cell.shape[:2]
    canv = np.zeros((S, S, 4), np.uint8)
    ox = (S - w) // 2
    oy = max(0, S - h - margin)
    canv[oy:oy + h, ox:ox + w] = cell[:S - oy]
    return canv


def colorize_gray(cell, color):
    from PIL import ImageOps
    L = Image.fromarray(cell, 'RGBA').convert('L')
    L = ImageOps.autocontrast(L, cutoff=2)            # spread tones so the tint reads
    rgb = ImageOps.colorize(L, black=(22, 18, 16), white=(240, 238, 232), mid=color)
    return np.dstack([np.array(rgb), cell[:, :, 3]]).astype(np.uint8)


def adjust(cell, sat=1.0, bright=1.0):
    """Scale saturation (around per-pixel gray) and brightness, keep alpha."""
    rgb = cell[:, :, :3].astype(float)
    g = rgb.mean(2, keepdims=True)
    out = np.clip((g + (rgb - g) * sat) * bright, 0, 255).astype(np.uint8)
    return np.dstack([out, cell[:, :, 3]])


def _frames_for(name, header):
    cells = collect_cells(name, header)
    fr, mx, my = {}, 0, 0
    for dr, rcs in DIR_MAP.items():
        fr[dr] = [cells[rc] for rc in rcs]
        for c in fr[dr]:
            my = max(my, c.shape[0]); mx = max(mx, c.shape[1])
    return fr, max(mx, my) + 6


def _clean(prefix):
    import glob
    for p in glob.glob(os.path.join(OUT, prefix)):
        os.remove(p)


SHEET_HEADER = 84   # grid starts below the title + "8 DIRECTIONS" subtitle bars


def do_delivery():
    print('delivery (recolor x12, 8-dir)...')
    _clean('delivery_*_*.png')  # drop old 2-frame sprites + any prior run
    fr, S = _frames_for('delivery_new.png', SHEET_HEADER)
    for v, color in enumerate(DELIVERY_COLORS):
        for dr in DIRS:
            for fi, cell in enumerate(fr[dr]):
                canv = place_bottom_center(cell, S)
                save(resize(colorize_gray(canv, color), 120), f'delivery_{v}_{dr}_{fi}.png')
    print('  delivery: 6 x 8 x 2 = 96 sprites')


def do_mallen():
    print('mallen (normal + frenzy, 8-dir)...')
    _clean('mallen_*.png')
    fr, S = _frames_for('mallen_new.png', SHEET_HEADER)
    for dr in DIRS:
        for fi, cell in enumerate(fr[dr]):
            canv = place_bottom_center(cell, S)
            frenzy = adjust(canv, sat=1.35, bright=1.12)   # vivid, hot
            normal = adjust(canv, sat=0.92, bright=0.9)    # the red demon, slightly muted
            save(resize(frenzy, 150), f'mallen_frenzy_{dr}_{fi}.png')
            save(resize(normal, 150), f'mallen_{dr}_{fi}.png')
    print('  mallen: 8 x 2 x 2 = 32 sprites')


def do_sheet_debug(name, header):
    print(f'sheet debug {name} header={header}...')
    from PIL import ImageDraw
    # 1) grid overlay on the original
    base = Image.open(os.path.join(SRC, name)).convert('RGBA')
    ov = base.copy(); d = ImageDraw.Draw(ov)
    h, w = base.height, base.width
    cw = w / 8; ch = (h - header) / 4
    for c in range(9):
        d.line([(c * cw, header), (c * cw, h)], fill=(255, 80, 80, 255), width=2)
    for r in range(5):
        d.line([(0, header + r * ch), (w, header + r * ch)], fill=(255, 80, 80, 255), width=2)
    ov.save(os.path.join(SRC, f'_{name[:-4]}_grid.png'))
    # 2) montage of extracted cells, indexed by (r,c)
    cells = list(sheet_cells(name, header))
    ts = 150
    mont = Image.new('RGBA', (8 * ts, 4 * ts), (35, 35, 48, 255))
    md = ImageDraw.Draw(mont)
    for (r, c, cell) in cells:
        if cell.shape[0] < 4 or cell.shape[1] < 4:
            continue
        t = Image.fromarray(cell, 'RGBA'); t.thumbnail((ts - 12, ts - 26))
        gx, gy = c * ts, r * ts
        mont.alpha_composite(t, (gx + 6, gy + 22))
        md.text((gx + 4, gy + 4), f'{r},{c}', fill=(255, 230, 90, 255))
    mont.save(os.path.join(SRC, f'_{name[:-4]}_cells.png'))
    print(f'  wrote _{name[:-4]}_grid.png and _{name[:-4]}_cells.png')


def do_faces():
    print('mallen faces...')
    # these already have real alpha — just trim margins and normalize size
    for src, out in [('mallen_face_src.png', 'mallen_face.png'),
                     ('mallen_face_fiend_src.png', 'mallen_face_fiend.png')]:
        save(resize_max(trim(load(src)), 256), out)


if __name__ == '__main__':
    import sys
    stages = sys.argv[1:] or ['tub']
    if 'faces' in stages:
        do_faces()
    if 'tub' in stages:
        do_tub()
    if 'general_debug' in stages:
        do_general_debug()
    if 'general' in stages:
        do_general()
    H = int(os.environ.get('HDR', SHEET_HEADER))
    if 'delivery_debug' in stages:
        do_sheet_debug('delivery_new.png', header=H)
    if 'mallen_debug' in stages:
        do_sheet_debug('mallen_new.png', header=H)
    if 'delivery_compass' in stages:
        do_dir_preview('delivery_new.png', header=H)
    if 'mallen_compass' in stages:
        do_dir_preview('mallen_new.png', header=H)
    if 'delivery' in stages:
        do_delivery()
    if 'mallen' in stages:
        do_mallen()
    print('done.')
