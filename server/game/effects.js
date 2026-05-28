// Pure effect-selection logic. Injectable RNG so tests are deterministic.

import {
  BUFF_POOL, DEBUFF_POOL, WILDCARD_POOL, FX,
} from './constants.js';

// Weighted pick from [{fx, w}]. rng() in [0,1).
export function weightedPick(pool, rng) {
  const total = pool.reduce((s, e) => s + e.w, 0);
  let r = rng() * total;
  for (const e of pool) {
    if (r < e.w) return e.fx;
    r -= e.w;
  }
  return pool[pool.length - 1].fx; // float-safety fallback
}

// Roll an effect for a claimer. Mallen => buffs only. Everyone else draws from
// the combined buff+debuff+wildcard pool (weighted).
export function rollEffect(isMallen, rng = Math.random) {
  if (isMallen) return weightedPick(BUFF_POOL, rng);
  const combined = [...BUFF_POOL, ...DEBUFF_POOL, ...WILDCARD_POOL];
  return weightedPick(combined, rng);
}
