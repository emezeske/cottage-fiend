import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeLoci, randSpawn, randPoint } from '../server/game/spawn.js';
import { ARENA, LOCI } from '../server/game/constants.js';
import { dist } from '../server/game/vec.js';
import { seededRng } from './helpers.js';

test('placeLoci always separates truck and fridge by minSeparation', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const { truck, fridge } = placeLoci(ARENA, LOCI, seededRng(seed));
    const d = dist(truck.x, truck.y, fridge.x, fridge.y);
    assert.ok(d >= LOCI.minSeparation, `seed ${seed}: separation ${d} < ${LOCI.minSeparation}`);
  }
});

test('placeLoci keeps loci within padded bounds', () => {
  const { truck, fridge } = placeLoci(ARENA, LOCI, seededRng(7));
  for (const p of [truck, fridge]) {
    assert.ok(p.x >= LOCI.edgePadding && p.x <= ARENA.width - LOCI.edgePadding);
    assert.ok(p.y >= LOCI.edgePadding && p.y <= ARENA.height - LOCI.edgePadding);
  }
});

test('randPoint respects padding', () => {
  const rng = seededRng(3);
  for (let i = 0; i < 100; i++) {
    const p = randPoint(rng, ARENA, 120);
    assert.ok(p.x >= 120 && p.x <= ARENA.width - 120);
    assert.ok(p.y >= 120 && p.y <= ARENA.height - 120);
  }
});

test('randSpawn stays inside arena', () => {
  const s = randSpawn(ARENA, LOCI.edgePadding, seededRng(9));
  assert.ok(s.x >= 0 && s.x <= ARENA.width && s.y >= 0 && s.y <= ARENA.height);
});
