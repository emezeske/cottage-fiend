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
// mallen_{dir}_{frame} (normal) and mallen_frenzy_{dir}_{frame} (frenzy)
for (const d of DIRS_4)
  for (let f = 0; f < 2; f++) {
    MANIFEST[`mallen_${d}_${f}`] = `mallen_${d}_${f}.webp`;
    MANIFEST[`mallen_frenzy_${d}_${f}`] = `mallen_frenzy_${d}_${f}.webp`;
  }
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
  }))).then(() => { buildPlayerVariants(); });
}

// --- per-player tinting ----------------------------------------------------

// Color bands derived from sampling the source sprite. Brown vest sits at
// H~26 S~0.89, blue pants/hat at H~220 S~0.92, and skin sits at the same
// hue as brown but S~0.10 — so S>=0.40 cleanly excludes skin from the
// vest replacement.
const VEST_H_LO = 10,  VEST_H_HI = 45;
const PANTS_H_LO = 195, PANTS_H_HI = 245;
const TINT_S_MIN = 0.40;
const TINT_V_MIN = 0.15;

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
function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return rgbToHsv(r, g, b)[0];
}

// 12 (vest, pants) hue pairs — vest matches PLAYER_COLORS, pants is the
// complement (180° around the wheel). Saturation is bumped a bit so the
// recolor reads vividly even where the source pixels were a bit muted.
const PLAYER_PALETTE = PLAYER_COLORS.map(hex => {
  const vh = hexToHue(hex);
  return { vestH: vh, pantsH: (vh + 180) % 360 };
});

function recolorSprite(srcImg, vestH, pantsH) {
  const w = srcImg.naturalWidth || srcImg.width;
  const h = srcImg.naturalHeight || srcImg.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(srcImg, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 16) continue;                                 // transparent
    const [hue, sat, val] = rgbToHsv(d[i], d[i + 1], d[i + 2]);
    if (sat < TINT_S_MIN || val < TINT_V_MIN) continue;          // skin / outline / white
    let targetH = null;
    if (hue >= VEST_H_LO && hue <= VEST_H_HI) targetH = vestH;
    else if (hue >= PANTS_H_LO && hue <= PANTS_H_HI) targetH = pantsH;
    if (targetH === null) continue;
    // preserve the source's saturation + value (the shading) but swap the hue
    const [r, g, b] = hsvToRgb(targetH, Math.max(sat, 0.65), val);
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function buildPlayerVariants() {
  for (let v = 0; v < PLAYER_VARIANTS; v++) {
    const { vestH, pantsH } = PLAYER_PALETTE[v];
    for (const d of DIRS_4) {
      for (let f = 0; f < 2; f++) {
        const src = images[`delivery_${d}_${f}`];
        if (!src) { images[`delivery_${v}_${d}_${f}`] = null; continue; }
        images[`delivery_${v}_${d}_${f}`] = recolorSprite(src, vestH, pantsH);
      }
    }
  }
}
