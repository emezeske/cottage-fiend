// Randomization helpers. Pure where possible; placement takes an injectable RNG
// so tests can pass a seeded/deterministic generator.

import { dist } from './vec.js';

export function randRange(rng, lo, hi) {
  return lo + rng() * (hi - lo);
}

// Pick a random point inside the arena respecting edge padding.
export function randPoint(rng, arena, padding) {
  return {
    x: randRange(rng, padding, arena.width - padding),
    y: randRange(rng, padding, arena.height - padding),
  };
}

// Place truck + fridge at least minSeparation apart, away from edges.
// rng defaults to Math.random but tests inject their own.
export function placeLoci(arena, loci, rng = Math.random) {
  const { minSeparation, edgePadding } = loci;
  let truck, fridge;
  for (let i = 0; i < 500; i++) {
    truck = randPoint(rng, arena, edgePadding);
    fridge = randPoint(rng, arena, edgePadding);
    if (dist(truck.x, truck.y, fridge.x, fridge.y) >= minSeparation) {
      return { truck, fridge };
    }
  }
  // Fallback: force them to opposite corners if we somehow never satisfied it.
  return {
    truck: { x: edgePadding, y: edgePadding },
    fridge: { x: arena.width - edgePadding, y: arena.height - edgePadding },
  };
}

// A random spawn point for a player, away from edges.
export function randSpawn(arena, padding, rng = Math.random) {
  return randPoint(rng, arena, padding);
}
