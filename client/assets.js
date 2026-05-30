// Loads all sprite PNGs and exposes them by key. Returns a promise.

export const DIRS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
export const PLAYER_VARIANTS = 12;

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
// delivery_{variant}_{dir}_{frame} — all 12 variants currently share a single
// set of sprites (no per-player colorization yet). The manifest aliases all
// variant keys to delivery_{dir}_{frame}.webp so we don't duplicate 192 files.
for (let v = 0; v < PLAYER_VARIANTS; v++)
  for (const d of DIRS)
    for (let f = 0; f < 2; f++)
      MANIFEST[`delivery_${v}_${d}_${f}`] = `delivery_${d}_${f}.webp`;
// mallen_{dir}_{frame} (normal). The frenzy slot reuses the same art until we
// have a dedicated frenzy sheet — alias keeps render code unchanged.
for (const d of DIRS)
  for (let f = 0; f < 2; f++) {
    MANIFEST[`mallen_${d}_${f}`] = `mallen_${d}_${f}.webp`;
    MANIFEST[`mallen_frenzy_${d}_${f}`] = `mallen_${d}_${f}.webp`;
  }
// ferrari_{dir} — shown instead of the crew sprite while they have 2X SPEED
for (const d of DIRS) MANIFEST[`ferrari_${d}`] = `ferrari_${d}.webp`;
// corgi_{dir} — the CORGI_ATTACK hunter
for (const d of DIRS) MANIFEST[`corgi_${d}`] = `corgi_${d}.webp`;
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
