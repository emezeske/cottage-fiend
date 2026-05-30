// Pure effect-selection logic. Injectable RNG so tests are deterministic.

import {
  BUFF_POOL, DEBUFF_POOL, WILDCARD_POOL,
  MALLEN_BUFF_POOL, MALLEN_DEBUFF_POOL, MALLEN_WILDCARD_POOL,
  FX,
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

// Roll an effect for a claimer. Mallen draws from his own (slightly trimmed)
// versions of every pool — he gets buffs AND debuffs, just nothing that has
// no actual effect on him (curd cannon needs a throw, greased needs a carry).
export function rollEffect(isMallen, rng = Math.random) {
  const combined = isMallen
    ? [...MALLEN_BUFF_POOL, ...MALLEN_DEBUFF_POOL, ...MALLEN_WILDCARD_POOL]
    : [...BUFF_POOL,        ...DEBUFF_POOL,        ...WILDCARD_POOL];
  return weightedPick(combined, rng);
}
