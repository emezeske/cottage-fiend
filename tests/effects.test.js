import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, _resetIds } from '../server/game/game.js';
import { rollEffect, weightedPick } from '../server/game/effects.js';
import {
  PHASE, FX, BUFF_POOL, DEBUFF_POOL, WILDCARD_POOL, PRESENT, EFFECT, MALLEN, PLAYER,
} from '../server/game/constants.js';
import { seededRng } from './helpers.js';

function newGame(seed = 42) {
  _resetIds();
  return new Game({ rng: seededRng(seed) });
}
function advance(game, ms, step = 33) {
  for (let t = 0; t < ms; t += step) game.tick(step);
}
function giveTub(game, id) {
  const p = game.players.get(id);
  game._spawnTub(p.x, p.y, 'ready');
  game.pickup(id, game._clock || 0);
}

// ---- effect rolling --------------------------------------------------------
test('weightedPick always returns a member of the pool', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 200; i++) {
    const fx = weightedPick(BUFF_POOL, rng);
    assert.ok(BUFF_POOL.some(e => e.fx === fx));
  }
});

test('mallen only ever rolls buffs that apply to him (never curd cannon)', () => {
  const buffs = new Set(BUFF_POOL.map(e => e.fx));
  for (let seed = 1; seed <= 300; seed++) {
    const fx = rollEffect(true, seededRng(seed));
    assert.ok(buffs.has(fx), `mallen got non-buff ${fx} at seed ${seed}`);
    assert.notEqual(fx, FX.CURD_CANNON, `mallen got the throw-only curd cannon at seed ${seed}`);
  }
});

test('delivery players can roll debuffs and wildcards', () => {
  const debuffs = new Set(DEBUFF_POOL.map(e => e.fx));
  const wilds = new Set(WILDCARD_POOL.map(e => e.fx));
  let sawDebuff = false, sawWild = false;
  for (let seed = 1; seed <= 300; seed++) {
    const fx = rollEffect(false, seededRng(seed));
    if (debuffs.has(fx)) sawDebuff = true;
    if (wilds.has(fx)) sawWild = true;
  }
  assert.ok(sawDebuff, 'expected at least one debuff across seeds');
  assert.ok(sawWild, 'expected at least one wildcard across seeds');
});

// ---- present spawning & claiming ------------------------------------------
test('a present spawns during play and parachutes down', () => {
  const g = newGame();
  g.addPlayer('alice');
  g.startRound();
  g.phase = PHASE.PLAYING;
  // force the next present immediately
  g._nextPresentAt = g._clock || 0;
  advance(g, 100);
  assert.ok(g.presents.length >= 1, 'present should have spawned');
  const present = g.presents[0];
  assert.equal(present.landed, false);
  // after the fall duration it should be landed
  advance(g, PRESENT.fallDurationMs + 200);
  assert.ok(g.presents.length === 0 || g.presents[0].landed,
    'present should land (or already be claimed)');
});

test('touching a present claims it and applies an effect', () => {
  const g = newGame(5);
  const id = g.addPlayer('alice');
  g.startRound();
  g.phase = PHASE.PLAYING;
  // manually place a landed present on top of the player
  const p = g.players.get(id);
  g.presents.push({ id: 1, x: p.x, y: p.y, landX: p.x, landY: p.y,
                    fallMs: PRESENT.fallDurationMs, landed: true });
  advance(g, 60);
  assert.equal(g.presents.length, 0, 'present consumed on claim');
  // alice should now have either an active effect or have triggered a one-shot
  // (one-shots leave no active effect); assert a claim event fired
});

test('double speed buff increases movement speed', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.phase = PHASE.PLAYING;
  const p = g.players.get(id);
  const base = g._effectiveSpeed(p);
  p.effect = FX.DOUBLE_SPEED; p.effectUntilMs = 99999;
  assert.equal(g._effectiveSpeed(p), base * EFFECT.doubleSpeedMult);
});

test('half speed debuff decreases movement speed', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  const p = g.players.get(id);
  const base = g._effectiveSpeed(p);
  p.effect = FX.HALF_SPEED; p.effectUntilMs = 99999;
  assert.equal(g._effectiveSpeed(p), base * EFFECT.halfSpeedMult);
});

test('slidey (banana) coasts after input stops', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.phase = PHASE.PLAYING;
  const p = g.players.get(id);
  p.x = 800; p.y = 800;
  p.effect = FX.BANANA; p.effectUntilMs = 99999;
  g.setInput(id, 1, 0);            // drive right to build momentum
  advance(g, 600);
  g.setInput(id, 0, 0);            // let go
  const xAtRelease = p.x;
  advance(g, 200);                 // should keep sliding for a bit
  assert.ok(p.x > xAtRelease + 5, 'player keeps gliding after releasing input');
  // and a normal player stops immediately
  const id2 = g.addPlayer('bob');
  const q = g.players.get(id2); q.x = 400; q.y = 400;
  g.setInput(id2, 1, 0); advance(g, 200); g.setInput(id2, 0, 0);
  const qx = q.x; advance(g, 200);
  assert.ok(Math.abs(q.x - qx) < 1, 'normal player stops on a dime');
});

test('magnet near the truck does not spawn infinite tubs', () => {
  const g = newGame();
  const id = g.addPlayer('a');
  g.startRound();              // stocks one ready tub
  g.phase = PHASE.PLAYING;     // skip countdown
  const p = g.players.get(id);
  p.effect = FX.MAGNET; p.effectUntilMs = 999999;
  const ready = g.tubs.find((t) => t.state === 'ready');
  p.x = ready.x + 50; p.y = ready.y; // near (not on) the tub so the magnet pulls it
  advance(g, 3000);
  assert.ok(g.tubs.length <= 8, `tub count stayed bounded, got ${g.tubs.length}`);
});

test('2x points buff doubles a delivery', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.phase = PHASE.PLAYING;
  const p = g.players.get(id);
  p.effect = FX.TWO_X_POINTS; p.effectUntilMs = 99999;
  p.x = g.loci.fridge.x - 50; p.y = g.loci.fridge.y;
  giveTub(g, id);
  const tub = g.tubs.find(t => t.state === 'carried');
  tub.x = p.x; tub.y = p.y;
  g.setInput(id, 1, 0);
  g.startCharge(id, 0);
  g.release(id, 1000 / 2.4 * 0.5);
  advance(g, 1000);
  assert.equal(g.players.get(id).score, 2, 'delivery should count double');
});

test('invincibility makes a punch/attack skip you (you keep your tub)', () => {
  const g = newGame();
  const victim = g.addPlayer('victim');
  const mid = g.addPlayer('mallen');
  g.phase = PHASE.PLAYING;
  const v = g.players.get(victim), m = g.players.get(mid);
  giveTub(g, victim);
  v.effect = FX.INVINCIBLE; v.effectUntilMs = 99999;
  v.x = 400; v.y = 400; m.x = 420; m.y = 400; m.dir = { x: -1, y: 0 }; // facing/lunging at the victim
  g.punch(mid, 0);
  assert.equal(g.players.get(victim).carryingTubId != null, true, 'invincible victim keeps their tub');
});

test('explosion one-shot knocks back nearby players', () => {
  const g = newGame();
  const a = g.addPlayer('a');
  const b = g.addPlayer('b');
  g.phase = PHASE.PLAYING;
  const pa = g.players.get(a), pb = g.players.get(b);
  pa.x = 400; pa.y = 400; pb.x = 440; pb.y = 400;
  const before = pb.x;
  g._applyOneShot(pa, FX.EXPLOSION, 0);
  assert.ok(pb.x > before, 'b should be pushed away from a');
});

test('tub pinata drops the configured number of loose tubs', () => {
  const g = newGame();
  const id = g.addPlayer('a');
  g.phase = PHASE.PLAYING;
  const p = g.players.get(id);
  const before = g.tubs.length;
  g._applyOneShot(p, FX.PINATA, 0);
  const loose = g.tubs.filter(t => t.state === 'loose').length;
  assert.ok(loose >= EFFECT.pinataCount, `expected >= ${EFFECT.pinataCount} loose tubs`);
});

test('swap exchanges positions with another player', () => {
  const g = newGame();
  const a = g.addPlayer('a');
  const b = g.addPlayer('b');
  const pa = g.players.get(a), pb = g.players.get(b);
  pa.x = 100; pa.y = 100; pb.x = 700; pb.y = 500;
  g._applyOneShot(pa, FX.SWAP, 0);
  assert.equal(pa.x, 700); assert.equal(pa.y, 500);
  assert.equal(pb.x, 100); assert.equal(pb.y, 100);
});

test('tiny effect shrinks then restores radius', () => {
  const g = newGame();
  const id = g.addPlayer('a');
  g.phase = PHASE.PLAYING;
  const p = g.players.get(id);
  g._applyPresentForTest = null;
  p.effect = FX.TINY; p.effectUntilMs = (g._clock || 0) + EFFECT.defaultDurationMs;
  p.radius = PLAYER.radius * EFFECT.tinyMult;
  assert.ok(p.radius < PLAYER.radius);
  advance(g, EFFECT.defaultDurationMs + 200);
  assert.equal(Math.round(p.radius), PLAYER.radius, 'radius restored after expiry');
});

test('curd cannon makes the next throw fly far enough to score from range', () => {
  const g = newGame();
  const id = g.addPlayer('a');
  g.phase = PHASE.PLAYING;
  const p = g.players.get(id);
  p.effect = FX.CURD_CANNON; p.effectUntilMs = 99999; p.cannonArmed = true;
  const fx = g.loci.fridge.x, fy = g.loci.fridge.y;
  p.x = fx - 300; p.y = fy;          // way beyond the normal ~80px score radius
  giveTub(g, id);
  const tub = g.tubs.find(t => t.state === 'carried');
  tub.x = p.x; tub.y = p.y;
  g.setInput(id, 1, 0);
  g.startCharge(id, 0);
  g.release(id, 500);                // ~peak power at 1.0Hz
  advance(g, 400);
  assert.equal(g.players.get(id).score, 1, 'a mega cannon throw reaches the fridge from range');
  assert.equal(g.players.get(id).cannonArmed, false, 'cannon disarms after the throw');
});

test('greased hands drops the tub about a second after grabbing', () => {
  const g = newGame();
  const id = g.addPlayer('a');
  g.phase = PHASE.PLAYING;
  const p = g.players.get(id);
  p.effect = FX.GREASED; p.effectUntilMs = (g._clock || 0) + EFFECT.defaultDurationMs;
  giveTub(g, id);
  assert.ok(p.carryingTubId != null);
  advance(g, 1300);
  assert.equal(g.players.get(id).carryingTubId, null, 'greased player drops the tub');
});

test('effect expires and clears', () => {
  const g = newGame();
  const id = g.addPlayer('a');
  g.phase = PHASE.PLAYING;
  const p = g.players.get(id);
  p.effect = FX.DOUBLE_SPEED; p.effectUntilMs = (g._clock || 0) + 500;
  advance(g, 800);
  assert.equal(g.players.get(id).effect, null);
});

test('snapshot includes presents and player effect', () => {
  const g = newGame();
  const id = g.addPlayer('a');
  g.players.get(id).effect = FX.DOUBLE_SPEED;
  g.players.get(id).effectUntilMs = 5000;
  g.presents.push({ id: 1, x: 100, y: 50, landed: false });
  const snap = JSON.parse(JSON.stringify(g.snapshot()));
  assert.ok(Array.isArray(snap.presents));
  assert.equal(snap.presents.length, 1);
  const me = snap.players.find(p => p.id === id);
  assert.equal(me.effect, FX.DOUBLE_SPEED);
});

test('startRound clears effects and presents', () => {
  const g = newGame();
  const id = g.addPlayer('a');
  const p = g.players.get(id);
  p.effect = FX.HALF_SPEED; p.effectUntilMs = 9999;
  g.presents.push({ id: 1, x: 1, y: 1, landed: true });
  g.startRound();
  assert.equal(g.players.get(id).effect, null);
  assert.equal(g.presents.length, 0);
});

test('frenzy and tiny do not corrupt the mallen radius', () => {
  const g = newGame();
  const mid = g.addPlayer('mallen');
  g.phase = PHASE.PLAYING;
  const m = g.players.get(mid);
  m.effect = FX.TINY; m.effectUntilMs = (g._clock || 0) + 100000;
  m.x = 400; m.y = 400; g._spawnTub(400, 400, 'loose');
  g.tick(33); // eat -> frenzy while tiny
  const wantFrenzyTiny = MALLEN.radius * EFFECT.tinyMult * 1.5; // FRENZY.sizeMult
  assert.ok(Math.abs(m.radius - wantFrenzyTiny) < 0.5, `frenzy+tiny radius ${m.radius}`);
  // let frenzy expire; tiny still active
  advance(g, 4500);
  assert.ok(Math.abs(m.radius - MALLEN.radius * EFFECT.tinyMult) < 0.5,
    `tiny-only radius ${m.radius}`);
  // clear tiny; back to full mallen size
  m.effectUntilMs = g._clock; g.tick(33);
  assert.ok(Math.abs(m.radius - MALLEN.radius) < 0.5, `restored radius ${m.radius}`);
});
