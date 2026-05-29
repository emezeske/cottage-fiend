// Loads all sprite PNGs and exposes them by key. Returns a promise.

export const DIRS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
export const PLAYER_VARIANTS = 12;

const MANIFEST = {
  bg: 'bg.png',                            // arena floor (rotates per round: street -> grass -> desert)
  bg2: 'bg2.png',
  bg3: 'bg3.png',
  truck: 'truck.png',
  fridge: 'fridge.png',
  tub: 'tub.png',
  present: 'present.png',
  parachute: 'parachute.png',
  birthday_tub: 'birthday_tub.png',
  ad_app_icon: 'ad_app_icon.png',
  interstitial_ad: 'interstitial_ad.png',  // also drawn small above ad-stunned players
  golden_curd: 'golden_curd.png',          // golden-curd buff celebration (big + kaleidoscope copies)
  splat_0: 'splat_0.png', splat_1: 'splat_1.png', splat_2: 'splat_2.png',
  mallen_face: 'mallen_face.png',          // composited onto the Mallen's head
  mallen_face_fiend: 'mallen_face_fiend.png', // ...during frenzy
};
// delivery_{variant}_{dir}_{frame}  (grayscale recolored into 12 player colors)
for (let v = 0; v < PLAYER_VARIANTS; v++)
  for (const d of DIRS)
    for (let f = 0; f < 2; f++)
      MANIFEST[`delivery_${v}_${d}_${f}`] = `delivery_${v}_${d}_${f}.png`;
// mallen_{dir}_{frame} (normal) and mallen_frenzy_{dir}_{frame} (frenzy)
for (const d of DIRS)
  for (let f = 0; f < 2; f++) {
    MANIFEST[`mallen_${d}_${f}`] = `mallen_${d}_${f}.png`;
    MANIFEST[`mallen_frenzy_${d}_${f}`] = `mallen_frenzy_${d}_${f}.png`;
  }
// ferrari_{dir} — shown instead of the crew sprite while they have 2X SPEED
for (const d of DIRS) MANIFEST[`ferrari_${d}`] = `ferrari_${d}.png`;
// corgi_{dir} — the CORGI_ATTACK hunter
for (const d of DIRS) MANIFEST[`corgi_${d}`] = `corgi_${d}.png`;
// disc_{0..7} — spin frames for the DISC_GOLF projectiles
for (let i = 0; i < 8; i++) MANIFEST[`disc_${i}`] = `disc_${i}.png`;

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
