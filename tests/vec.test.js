import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dist, dist2, clamp, normalize, resolveCircleOverlap, clampToArena, chargePower,
} from '../server/game/vec.js';

test('dist and dist2', () => {
  assert.equal(dist(0, 0, 3, 4), 5);
  assert.equal(dist2(0, 0, 3, 4), 25);
});

test('clamp', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test('normalize produces unit vector', () => {
  const n = normalize(3, 4);
  assert.ok(Math.abs(Math.hypot(n.x, n.y) - 1) < 1e-9);
  const z = normalize(0, 0);
  assert.deepEqual(z, { x: 0, y: 0 });
});

test('resolveCircleOverlap separates overlapping circles', () => {
  const a = { x: 0, y: 0 }, b = { x: 5, y: 0 };
  const fix = resolveCircleOverlap(a, 10, b, 10); // overlap of 15
  assert.ok(fix);
  const newDist = Math.hypot(fix.b.x - fix.a.x, fix.b.y - fix.a.y);
  assert.ok(Math.abs(newDist - 20) < 1e-6, `expected ~20 got ${newDist}`);
});

test('resolveCircleOverlap returns null when not overlapping', () => {
  const a = { x: 0, y: 0 }, b = { x: 100, y: 0 };
  assert.equal(resolveCircleOverlap(a, 10, b, 10), null);
});

test('clampToArena keeps circle inside bounds', () => {
  const arena = { width: 100, height: 100 };
  assert.deepEqual(clampToArena(-5, 200, 10, arena), { x: 10, y: 90 });
});

test('chargePower oscillates between min and max', () => {
  const cfg = { minPower: 100, maxPower: 200, oscillationHz: 2 };
  // period = 500ms. phase 0 -> min, phase 0.25 (125ms) -> midpoint of up ramp.
  assert.ok(Math.abs(chargePower(0, cfg) - 100) < 1e-6);
  assert.ok(Math.abs(chargePower(125, cfg) - 150) < 1e-6); // halfway up
  assert.ok(Math.abs(chargePower(250, cfg) - 200) < 1e-6); // peak at half period
  assert.ok(Math.abs(chargePower(375, cfg) - 150) < 1e-6); // halfway down
});

test('chargePower never exceeds bounds across a sweep', () => {
  const cfg = { minPower: 260, maxPower: 820, oscillationHz: 2.4 };
  for (let ms = 0; ms < 5000; ms += 7) {
    const p = chargePower(ms, cfg);
    assert.ok(p >= 260 - 1e-6 && p <= 820 + 1e-6);
  }
});
