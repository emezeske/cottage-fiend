// Loads all sprite PNGs and exposes them by key. Returns a promise.

const MANIFEST = {
  truck: 'truck.png',
  fridge: 'fridge.png',
  tub: 'tub.png',
  mallenFace: 'mallen_face_placeholder.png', // user replaces this file
  splat_0: 'splat_0.png', splat_1: 'splat_1.png', splat_2: 'splat_2.png',
  mallen_0: 'mallen_0.png', mallen_1: 'mallen_1.png',
  mallen_frenzy_0: 'mallen_frenzy_0.png', mallen_frenzy_1: 'mallen_frenzy_1.png',
  ad_0: 'ad_0.png', ad_1: 'ad_1.png', ad_2: 'ad_2.png',
  ad_3: 'ad_3.png', ad_4: 'ad_4.png', ad_5: 'ad_5.png', ad_6: 'ad_6.png',
  present: 'present.png', parachute: 'parachute.png', birthday_tub: 'birthday_tub.png',
};
// delivery_{variant}_{frame}
for (let v = 0; v < 6; v++) for (let f = 0; f < 2; f++)
  MANIFEST[`delivery_${v}_${f}`] = `delivery_${v}_${f}.png`;

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

export const AD_KEYS = ['ad_0', 'ad_1', 'ad_2', 'ad_3', 'ad_4', 'ad_5', 'ad_6'];
