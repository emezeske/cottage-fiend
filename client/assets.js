// Loads all sprite PNGs and exposes them by key. Returns a promise.

// players + Mallen use 4 cardinal directions (artwork is N/S/W with E mirrored);
// the corgi and ferrari still have full 8-direction art.
const DIRS_4 = ['s', 'e', 'n', 'w'];
const DIRS_8 = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
export const PLAYER_VARIANTS = 12;

// Per-player accent colors. Used both as the foot-arrow color in render.js and
// as the VEST tint when we recolor the delivery sprite at load time.
export const PLAYER_COLORS = [
  '#cd3c34', '#3a6ecd', '#46af5c', '#d7a834', '#9650c3', '#3ab6b2',
  '#eb7d23', '#ee5faa', '#46cde1', '#a0cd37', '#8c5f37', '#cdcdd7',
];

const MANIFEST = {
  bg: 'bg.webp',                            // arena floor (rotates per round: street -> grass -> desert)
  bg2: 'bg2.webp',
  bg3: 'bg3.webp',
  truck: 'truck.webp',
  fridge: 'fridge.webp',
  tub: 'tub.webp',
  present: 'present.webp',
  parachute: 'parachute.webp',
  birthday_tub: 'birthday_tub.webp',
  ad_app_icon: 'ad_app_icon.webp',
  interstitial_ad: 'interstitial_ad.webp',  // also drawn small above ad-stunned players
  golden_curd: 'golden_curd.webp',          // golden-curd buff celebration (big + kaleidoscope copies)
  splat_0: 'splat_0.webp', splat_1: 'splat_1.webp', splat_2: 'splat_2.webp',
  mallen_face: 'mallen_face.webp',          // composited onto the Mallen's head
  mallen_face_fiend: 'mallen_face_fiend.webp', // ...during frenzy
};
// delivery_{dir}_{frame} — the shared source artwork. After load, we tint these
// into 12 per-variant canvases (delivery_${v}_${dir}_${frame}) — vest brown ->
// player's accent hue, blue pants/hat -> complementary hue.
for (const d of DIRS_4)
  for (let f = 0; f < 2; f++)
    MANIFEST[`delivery_${d}_${f}`] = `delivery_${d}_${f}.webp`;
// mallen_{dir}_{frame} — used for both normal AND frenzy (frenzy keeps the
// bigger size + colorful glow but reuses the normal body sprites).
for (const d of DIRS_4)
  for (let f = 0; f < 2; f++)
    MANIFEST[`mallen_${d}_${f}`] = `mallen_${d}_${f}.webp`;
// ferrari_{dir} — full 8-direction art, shown during 2X SPEED
for (const d of DIRS_8) MANIFEST[`ferrari_${d}`] = `ferrari_${d}.webp`;
// corgi_{dir} — full 8-direction art for the CORGI_ATTACK hunter
for (const d of DIRS_8) MANIFEST[`corgi_${d}`] = `corgi_${d}.webp`;
// disc_{0..7} — spin frames for the DISC_GOLF projectiles
for (let i = 0; i < 8; i++) MANIFEST[`disc_${i}`] = `disc_${i}.webp`;
// discoball_{0..2} — shimmer frames hovering over dance-party players
for (let i = 0; i < 3; i++) MANIFEST[`discoball_${i}`] = `discoball_${i}.webp`;
// portal_{color}_{0..2} — paired teleport portals (orange + blue), 3-frame animation
for (let i = 0; i < 3; i++) {
  MANIFEST[`portal_orange_${i}`] = `portal_orange_${i}.webp`;
  MANIFEST[`portal_blue_${i}`]   = `portal_blue_${i}.webp`;
}
// nuke reticle + 3-frame explosion animation
MANIFEST.nuke_reticle      = 'nuke_reticle.webp';
for (let i = 0; i < 3; i++) MANIFEST[`nuke_explosion_${i}`] = `nuke_explosion_${i}.webp`;

export const images = {};

export function loadAssets() {
  const entries = Object.entries(MANIFEST);
  return Promise.all(entries.map(([key, file]) => new Promise((res) => {
    const img = new Image();
    img.onload = () => { images[key] = img; res(); };
    img.onerror = () => { images[key] = null; res(); }; // missing art shouldn't block
    img.src = `assets/sprites/${file}`;
  })));
}

// --- per-player tinting ----------------------------------------------------

// Color bands derived from sampling the source sprite. Brown vest sits at
// H~26 S~0.89, blue pants/hat at H~220 S~0.92, and skin sits at the same
// hue as brown but S~0.10 — so S>=0.40 cleanly excludes skin from the
// vest replacement.
// We tint the white SHIRT and the blue HAT/PANTS, not the brown vest. White is
// trivially separable from everything else in the sprite — it sits at very low
// saturation (S<=0.06) and very high value (V>=0.79) across every direction,
// with no skin or cloth pixels intruding. Cool-blue pants are isolated by hue.
const SHIRT_S_MAX = 0.20;
const SHIRT_V_MIN = 0.30;     // catches the deepest gray shirt shadows; outlines sit below V=0.20
const PANTS_H_LO = 200, PANTS_H_HI = 238;
const PANTS_S_MIN = 0.55;
const TINT_V_MIN  = 0.15;

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const v = mx;
  const s = mx === 0 ? 0 : d / mx;
  let h;
  if (d === 0) h = 0;
  else if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, v];
}
function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if      (h < 60)  { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
// hue picker round-trip: clamp to 0-360 and back.
export function hueToHex(hue) {
  const [r, g, b] = hsvToRgb(((hue % 360) + 360) % 360, 0.78, 0.85);
  return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return rgbToHsv(r, g, b)[0];
}

// Recolor uses the FULL target color (hue + sat + value), so picking dark red
// vs bright red vs pink in the picker actually gives you different vests.
// Source brightness variation is preserved as a scale relative to the band's
// reference V so highlights / shadows survive the swap.
// Reference Vs for the brightness-scaling step (source pixel V is scaled by
// target V / refV). Sampled from delivery_s_0: shirt ~0.82, pants ~0.40,
// and from mallen_s_0: body red ~0.59.
const SHIRT_REF_V = 0.82;
const PANTS_REF_V = 0.40;
const MALLEN_REF_V = 0.55;

// LRU-style sprite cache. Each entry is a 120x120 RGBA canvas (~58 KB),
// 8 per unique (shirt,pants) combo — at this cap the cache tops out around
// ~12 MB, plenty of headroom for 20 players + a few extra combos.
const SPRITE_CACHE_MAX = 192;
const _spriteCache = new Map();
function _cacheGet(map, key, cap) {
  if (!map.has(key)) return null;
  const v = map.get(key);
  map.delete(key); map.set(key, v);                   // re-insert => most recently used
  return v;
}
function _cachePut(map, key, value, cap) {
  map.set(key, value);
  while (map.size > cap) { const oldest = map.keys().next().value; map.delete(oldest); }
}
export function getDeliverySprite(shirtHex, pantsHex, dir, frame) {
  const s = normalizeHex(shirtHex), p = normalizeHex(pantsHex);
  const key = `${s}|${p}|${dir}|${frame}`;
  let canvas = _cacheGet(_spriteCache, key, SPRITE_CACHE_MAX);
  if (canvas) return canvas;
  const src = images[`delivery_${dir}_${frame}`];
  if (!src) return null;
  canvas = recolorDelivery(src, hexToHsv(s), hexToHsv(p));
  _cachePut(_spriteCache, key, canvas, SPRITE_CACHE_MAX);
  return canvas;
}

// Mallen body is dominantly red (H~4 S~0.95) with frenzy adding pink/purple
// at H~280. Tint everything in the warm-arc so frenzy shifts with the body.
const MALLEN_CACHE_MAX = 64;
const _mallenCache = new Map();
// Frenzy keeps its larger size + colorful glow in render.js, but reuses the
// normal body art (no frenzy-specific webp). The `frenzy` arg is accepted for
// call-site clarity but currently ignored in the source lookup.
export function getMallenSprite(mallenHex, _frenzy, dir, frame) {
  const m = normalizeHex(mallenHex);
  const key = `${m}|${dir}|${frame}`;
  let canvas = _cacheGet(_mallenCache, key, MALLEN_CACHE_MAX);
  if (canvas) return canvas;
  const src = images[`mallen_${dir}_${frame}`];
  if (!src) return null;
  canvas = recolorMallen(src, hexToHsv(m));
  _cachePut(_mallenCache, key, canvas, MALLEN_CACHE_MAX);
  return canvas;
}

function normalizeHex(hex) {
  return typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : '#cd3c34';
}
function hexToHsv(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return rgbToHsv(r, g, b);
}

function recolorDelivery(srcImg, shirtHsv, pantsHsv) {
  const w = srcImg.naturalWidth || srcImg.width;
  const h = srcImg.naturalHeight || srcImg.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(srcImg, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [sH, sS, sV] = shirtHsv;
  const [pH, pS, pV] = pantsHsv;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 16) continue;
    const [hue, sat, val] = rgbToHsv(d[i], d[i + 1], d[i + 2]);
    if (val < TINT_V_MIN) continue;
    let tH, tS, tRef;
    // SHIRT band: very white pixels — no hue requirement.
    if (sat <= SHIRT_S_MAX && val >= SHIRT_V_MIN) {
      tH = sH; tS = sS; tRef = sV / SHIRT_REF_V;
    // PANTS / HAT band: cool blue cloth.
    } else if (hue >= PANTS_H_LO && hue <= PANTS_H_HI && sat >= PANTS_S_MIN) {
      tH = pH; tS = pS; tRef = pV / PANTS_REF_V;
    } else continue;
    const newV = Math.min(1, Math.max(0, val * tRef));
    const [r, g, b] = hsvToRgb(tH, tS, newV);
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function recolorMallen(srcImg, targetHsv) {
  const w = srcImg.naturalWidth || srcImg.width;
  const h = srcImg.naturalHeight || srcImg.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(srcImg, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [tH, tS, tV] = targetHsv;
  // Body is at H~4. Shift hue by (target - 4) so the frenzy purple keeps its
  // distance from the body color even after the swap.
  const SOURCE_BODY_H = 4;
  const offset = ((tH - SOURCE_BODY_H) + 360) % 360;
  const tRef = tV / MALLEN_REF_V;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 16) continue;
    const [hue, sat, val] = rgbToHsv(d[i], d[i + 1], d[i + 2]);
    if (val < 0.15 || sat < 0.45) continue;             // outline / detail
    if (hue >= 60 && hue <= 240) continue;              // cool accents (eyes etc.) — leave
    const newH = (hue + offset) % 360;
    // blend in target sat: take the larger of source-sat and target-sat so a
    // fully-saturated target lifts mid-sat source areas, while desaturated
    // targets still bring everything down toward gray.
    const newS = Math.min(1, Math.max(sat * 0.5 + tS * 0.5, 0));
    const newV = Math.min(1, Math.max(0, val * tRef));
    const [r, g, b] = hsvToRgb(newH, newS, newV);
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

