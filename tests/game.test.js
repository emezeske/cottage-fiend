import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, _resetIds } from '../server/game/game.js';
import {
  PHASE, MALLEN, ROUND, LOCI, THROW, FRENZY, PLAYER, FX, EFFECT, ONE_SHOT, DEBUFF_POOL, BUFF_POOL,
} from '../server/game/constants.js';
import { seededRng } from './helpers.js';

function newGame(seed = 42) {
  _resetIds();
  return new Game({ rng: seededRng(seed) });
}

// advance the sim by ms in fixed ~33ms steps
function advance(game, ms, step = 33) {
  for (let t = 0; t < ms; t += step) game.tick(step);
}

// Helper: put a ready tub at the player's location and have them grab it.
// Mirrors tapping a tub on the truck without depending on truck geometry.
function giveTub(game, id) {
  const p = game.players.get(id);
  const t = game._spawnTub(p.x, p.y, 'ready');
  game.pickup(id, 0);
  return t;
}

test('addPlayer assigns ids and starts in lobby', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  assert.equal(g.phase, PHASE.LOBBY);
  assert.equal(g.players.size, 1);
  assert.equal(g.players.get(id).name, 'alice');
});

test('player named mallen (any case) becomes The Mallen', () => {
  const g = newGame();
  const id = g.addPlayer('MaLLeN');
  const p = g.players.get(id);
  assert.equal(p.isMallen, true);
  assert.equal(g.mallenId, id);
  assert.equal(p.radius, MALLEN.radius);
});

test('non-mallen players are not mallen', () => {
  const g = newGame();
  const id = g.addPlayer('bob');
  assert.equal(g.players.get(id).isMallen, false);
});

test('removePlayer drops carried tub as loose', () => {
  const g = newGame();
  const id = g.addPlayer('carrier');
  const p = g.players.get(id);
  // place at truck and pick up
  giveTub(g, id);
  assert.equal(p.carryingTubId != null, true);
  g.removePlayer(id);
  assert.equal(g.tubs.length, 1);
  assert.equal(g.tubs[0].state, 'loose');
});

test('only one Mallen — a second "mallen" joins as a delivery player', () => {
  const g = newGame();
  const a = g.addPlayer('mallen');
  const b = g.addPlayer('mallen');
  assert.equal(g.mallenId, a);
  assert.equal(g.players.get(a).isMallen, true);
  assert.equal(g.players.get(b).isMallen, false); // not a dead-weight duplicate Mallen
  g.removePlayer(a);
  assert.equal(g.mallenId, null); // no other Mallen to promote
});

test('startRound never creates a Mallen — someone must join as one', () => {
  const g = newGame();
  const a = g.addPlayer('alice');
  const b = g.addPlayer('bob');
  g.startRound();
  assert.equal(g.mallenId, null); // a Mallen-less round is fine
  assert.equal(g.players.get(a).isMallen, false);
  assert.equal(g.players.get(b).isMallen, false);
});

test('tapping a ready tub on the truck picks it up', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  const p = g.players.get(id);
  const t = g._spawnTub(p.x, p.y, 'ready');
  g.pickup(id, 0);
  assert.equal(p.carryingTubId, t.id);
  assert.equal(t.state, 'carried');
});

test('mallen cannot pick up tubs', () => {
  const g = newGame();
  const id = g.addPlayer('mallen');
  const p = g.players.get(id);
  g._spawnTub(p.x, p.y, 'ready');
  g.pickup(id, 0);
  assert.equal(p.carryingTubId, null);
});

test('carried tub follows the carrier', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  const p = g.players.get(id);
  giveTub(g, id);
  g.setInput(id, 1, 0);
  g.phase = PHASE.PLAYING;
  advance(g, 200);
  const tub = g.tubs.find(t => t.state === 'carried');
  // tub should sit roughly carryOffset in front along +x
  assert.ok(Math.abs(tub.y - p.y) < 2);
  assert.ok(tub.x > p.x);
});

test('charge + release launches the tub as a projectile', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  const p = g.players.get(id);
  giveTub(g, id);
  g.setInput(id, 1, 0); // face +x
  g.startCharge(id, 0);
  // release at a quarter period for a mid-range power
  const periodMs = 1000 / THROW.oscillationHz;
  g.release(id, periodMs * 0.25);
  const tub = g.tubs.find(t => t.state === 'flying');
  assert.ok(tub);
  assert.ok(tub.vx > 0);
  assert.equal(p.carryingTubId, null);
});

test('thrown tub landing near fridge scores a point for the carrier', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  const p = g.players.get(id);
  g.phase = PHASE.PLAYING;
  // give the player a tub, then move them right next to the fridge
  p.x = g.loci.fridge.x - 60; p.y = g.loci.fridge.y;
  const tub = giveTub(g, id);
  tub.x = p.x; tub.y = p.y;
  g.setInput(id, 1, 0);
  g.startCharge(id, 0);
  g.release(id, 1000 / THROW.oscillationHz * 0.5); // max power toward fridge
  advance(g, 1000);
  assert.equal(g.players.get(id).score, 1);
  // the thrown tub was consumed by the fridge
  assert.equal(g.tubs.some(t => t.id === tub.id), false);
});

test('taking a ready tub from the truck triggers a 1s refill', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.startRound();                 // stocks one ready tub
  g.phase = PHASE.PLAYING;        // skip countdown for the test
  const p = g.players.get(id);
  // move onto the ready tub and grab it
  const ready = g.tubs.find(t => t.state === 'ready');
  p.x = ready.x; p.y = ready.y;
  const grabAt = g._clock || 0;
  g.pickup(id, grabAt);
  assert.equal(g.tubs.filter(t => t.state === 'ready').length, 0, 'no ready tub right after grab');
  // before 1s: still no replacement
  advance(g, 800);
  assert.equal(g.tubs.filter(t => t.state === 'ready').length, 0, 'no refill before 1s');
  // after 1s total: a replacement ready tub appears
  advance(g, 400);
  assert.ok(g.tubs.filter(t => t.state === 'ready').length >= 1, 'refill after 1s');
});

test('many players can each carry a tub at once', () => {
  const g = newGame();
  const ids = ['a', 'b', 'c', 'd'].map(n => g.addPlayer(n));
  g.phase = PHASE.PLAYING;
  for (const id of ids) giveTub(g, id);
  const carrying = ids.filter(id => g.players.get(id).carryingTubId != null);
  assert.equal(carrying.length, 4);
});

test('mallen punch knocks the carried tub loose in one hit', () => {
  const g = newGame();
  const victim = g.addPlayer('victim');
  const mid = g.addPlayer('mallen');
  g.phase = PHASE.PLAYING;
  const v = g.players.get(victim), m = g.players.get(mid);
  giveTub(g, victim);
  v.x = 400; v.y = 400; m.x = 420; m.y = 400; m.dir = { x: -1, y: 0 }; // face the victim (punch lunges that way)
  g.punch(mid, 0);
  assert.equal(g.players.get(victim).carryingTubId, null, 'victim lost the tub in one punch');
  // the tub is now in play (flying away, or already loose/devoured by the mallen)
  const inPlay = g.tubs.some(t => t.state === 'flying' || t.state === 'loose');
  const ate = g.players.get(mid).eaten >= 1;
  assert.ok(inPlay || ate, 'knocked-loose tub should be flying/loose/devoured');
});

test('punching a carrier launches their tub in the punch direction', () => {
  const g = newGame();
  const a = g.addPlayer('puncher');
  const b = g.addPlayer('carrier');
  g.phase = PHASE.PLAYING;
  const pa = g.players.get(a), pb = g.players.get(b);
  giveTub(g, b);
  pa.x = 400; pa.y = 400; pb.x = 420; pb.y = 400; pa.dir = { x: 1, y: 0 };
  g.punch(a, 0);
  assert.equal(g.players.get(b).carryingTubId, null);
  const t = g.tubs.find(t => t.state === 'flying');
  assert.ok(t && t.vx > 0, 'tub launched along +x (the punch direction)');
});

test('punch respects its cooldown', () => {
  const g = newGame();
  const a = g.addPlayer('a');
  const b = g.addPlayer('b');
  g.phase = PHASE.PLAYING;
  const pa = g.players.get(a), pb = g.players.get(b);
  giveTub(g, b);
  pa.x = 400; pa.y = 400; pb.x = 420; pb.y = 400; pa.dir = { x: 1, y: 0 };
  g.punch(a, 0);                       // knocks the tub out
  giveTub(g, b);                       // give them another
  g.punch(a, 100);                     // within cooldown: ignored
  assert.equal(g.players.get(b).carryingTubId != null, true, 'second punch was on cooldown');
});

test('an empty-handed player catches a thrown tub that hits them', () => {
  const g = newGame();
  const thrower = g.addPlayer('thrower');
  const catcher = g.addPlayer('catcher');
  g.phase = PHASE.PLAYING;
  const pt = g.players.get(thrower), pc = g.players.get(catcher);
  pt.x = 200; pt.y = 200; pc.x = 320; pc.y = 200;
  giveTub(g, thrower);
  pt.dir = { x: 1, y: 0 };
  g.startCharge(thrower, 0);
  g.release(thrower, (1000 / THROW.oscillationHz) * 0.5); // strong throw toward catcher
  advance(g, 800);
  assert.equal(g.players.get(catcher).carryingTubId != null, true, 'catcher caught the thrown tub');
});

test('mallen devours a loose tub, gains frenzy and eaten count', () => {
  const g = newGame();
  const mid = g.addPlayer('mallen');
  g.phase = PHASE.PLAYING;
  const m = g.players.get(mid);
  m.x = 400; m.y = 400;
  const tub = g._spawnTub(400, 400); // loose tub right on him
  g.tick(33);
  assert.equal(m.eaten, 1);
  assert.ok(m.frenzyMs > 0, 'should be in frenzy');
  assert.ok(m.radius > MALLEN.radius, 'should have grown');
  // the loose tub he ate is gone (a ready tub may appear on the truck via the
  // restock safety net, which is fine — just assert the eaten one is gone)
  assert.equal(g.tubs.some(t => t.id === tub.id), false);
});

test('mallen devouring stuns nearby players and makes them drop their tubs', () => {
  const g = newGame();
  const victim = g.addPlayer('victim');
  const mid = g.addPlayer('mallen');
  const faraway = g.addPlayer('far');
  g.phase = PHASE.PLAYING;
  const v = g.players.get(victim), m = g.players.get(mid), fp = g.players.get(faraway);
  m.x = 800; m.y = 800;
  v.x = 850; v.y = 800;          // near the mallen
  fp.x = 1500; fp.y = 1500;      // far away
  giveTub(g, victim);
  g._spawnTub(800, 800);         // a loose tub on the mallen to devour
  g.tick(33);
  const now = g._clock;
  assert.ok(g.players.get(mid).eaten >= 1, 'mallen devoured');
  assert.ok(g.players.get(victim).stunnedUntilMs > now, 'nearby victim is stunned');
  assert.equal(g.players.get(victim).carryingTubId, null, 'stunned victim dropped their tub');
  assert.ok(!(g.players.get(faraway).stunnedUntilMs > now), 'far-away player is not stunned');
});

test('frenzy expires and mallen returns to normal size', () => {
  const g = newGame();
  const mid = g.addPlayer('mallen');
  g.phase = PHASE.PLAYING;
  const m = g.players.get(mid);
  m.x = 400; m.y = 400;
  g._spawnTub(400, 400);
  g.tick(33);
  assert.ok(m.frenzyMs > 0);
  advance(g, FRENZY.durationMs + 200);
  assert.equal(m.frenzyMs <= 0, true);
  assert.equal(Math.round(m.radius), MALLEN.radius);
});

test('round ends when a delivery player reaches pointsToWin', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.phase = PHASE.PLAYING;
  g.players.get(id).score = ROUND.pointsToWin;
  g.tick(33);
  assert.equal(g.phase, PHASE.LEADERBOARD);
  assert.equal(g.roundWinner.type, 'player');
  assert.equal(g.roundWinner.name, 'alice');
});

test('round ends when mallen eats mallenEatsToWin', () => {
  const g = newGame();
  const mid = g.addPlayer('mallen');
  g.phase = PHASE.PLAYING;
  g.players.get(mid).eaten = ROUND.mallenEatsToWin;
  g.tick(33);
  assert.equal(g.phase, PHASE.LEADERBOARD);
  assert.equal(g.roundWinner.type, 'mallen');
});

test('readyFractionMet requires the configured fraction', () => {
  const g = newGame();
  const a = g.addPlayer('a');
  const b = g.addPlayer('b');
  const c = g.addPlayer('c');
  assert.equal(g.readyFractionMet(), false);
  g.setReady(a);
  // 1/3 < 0.5
  assert.equal(g.readyFractionMet(), false);
  g.setReady(b);
  // 2/3 >= 0.5
  assert.equal(g.readyFractionMet(), true);
});

test('startRound re-randomizes loci and resets scores', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.players.get(id).score = 5;
  const before = { ...g.loci.truck };
  g.startRound();
  assert.equal(g.players.get(id).score, 0);
  assert.equal(g.phase, PHASE.COUNTDOWN);
  // loci object should be freshly generated (likely different position)
  assert.ok('truck' in g.loci && 'fridge' in g.loci);
});

test('countdown transitions to playing', () => {
  const g = newGame();
  g.addPlayer('alice');
  g.startRound();
  assert.equal(g.phase, PHASE.COUNTDOWN);
  advance(g, ROUND.startCountdownMs + 100);
  assert.equal(g.phase, PHASE.PLAYING);
});

test('players collide and are pushed apart', () => {
  const g = newGame();
  const a = g.addPlayer('a');
  const b = g.addPlayer('b');
  g.phase = PHASE.PLAYING;
  const pa = g.players.get(a), pb = g.players.get(b);
  pa.x = 400; pa.y = 400; pb.x = 405; pb.y = 400;
  g.tick(33);
  const d = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  assert.ok(d >= pa.radius + pb.radius - 1, `players should not overlap, dist=${d}`);
});

test('the Mallen is kept out of the truck pickup zone', () => {
  const g = newGame();
  const mid = g.addPlayer('mallen');
  g.phase = PHASE.PLAYING;
  const m = g.players.get(mid);
  g.loci.truck = { x: 800, y: 800 };
  g._computeSafeZone();
  const z = g.safeZone;
  m.x = z.x + z.w / 2; m.y = z.y + z.h / 2; // drop the Mallen in the middle of the zone
  g.tick(33);
  const inside = m.x > z.x - m.radius && m.x < z.x + z.w + m.radius &&
                 m.y > z.y - m.radius && m.y < z.y + z.h + m.radius;
  assert.equal(inside, false, 'mallen should be pushed out of the pickup zone');
});

test('a delivery player CAN stand in the pickup zone', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.phase = PHASE.PLAYING;
  const p = g.players.get(id);
  g.loci.truck = { x: 800, y: 800 };
  g._computeSafeZone();
  const z = g.safeZone;
  // stand below the truck where the ready tubs are (inside the zone, clear of the truck circle)
  p.x = z.x + z.w / 2; p.y = z.y + z.h - 20;
  g.tick(33);
  const inside = p.x > z.x && p.x < z.x + z.w && p.y > z.y && p.y < z.y + z.h;
  assert.equal(inside, true, 'delivery players are allowed in the pickup zone');
});

test('player cannot stand inside the truck obstacle', () => {
  const g = newGame();
  const id = g.addPlayer('a');
  g.phase = PHASE.PLAYING;
  const p = g.players.get(id);
  p.x = g.loci.truck.x; p.y = g.loci.truck.y;
  g.tick(33);
  const d = Math.hypot(p.x - g.loci.truck.x, p.y - g.loci.truck.y);
  assert.ok(d >= LOCI.truckRadius + p.radius - 1, `pushed out of truck, dist=${d}`);
});

test('snapshot is JSON-serializable and contains expected shape', () => {
  const g = newGame();
  g.addPlayer('alice');
  g.addPlayer('mallen');
  const snap = g.snapshot();
  const round = JSON.parse(JSON.stringify(snap));
  assert.equal(round.players.length, 2);
  assert.ok('phase' in round && 'loci' in round && 'tubs' in round);
  assert.ok(round.players.every(p => 'x' in p && 'y' in p && 'isMallen' in p));
});

test('drainEvents empties the event queue', () => {
  const g = newGame();
  g.addPlayer('alice'); // pushes a join event
  const e1 = g.drainEvents();
  assert.ok(e1.length >= 1);
  const e2 = g.drainEvents();
  assert.equal(e2.length, 0);
});

// Regression: claiming present after present in a single round must roll a
// VARIETY of effects (not the same one repeatedly) — guards the randomization.
test('presents roll varied effects within a round', () => {
  const g = newGame(42);
  const a = g.addPlayer('alice');
  g.addPlayer('bob'); // a second player so the SWAP wildcard has a target
  g.startRound();
  advance(g, 3200); // run out the countdown so the round is PLAYING
  const fxs = [];
  for (let i = 0; i < 15; i++) {
    const pa = g.players.get(a);
    // drop a landed present right on alice and tick so she claims it
    g.presents.push({ id: 9000 + i, x: pa.x, y: pa.y, landX: pa.x, landY: pa.y, fallMs: 9e9, landed: true });
    g.tick(33);
    for (const e of g.drainEvents()) if (e.type === 'presentClaim' && e.id === a) fxs.push(e.fx);
  }
  assert.equal(fxs.length, 15, 'every forced present should be claimed');
  assert.ok(new Set(fxs).size >= 4, `expected varied rolls, got: ${fxs.join(', ')}`);
});

// Regression: double_speed must speed you up and half_speed slow you down — i.e.
// the two effects (and the sounds keyed off their ids) are not swapped.
test('present rate shortens the spawn interval (and clamps)', () => {
  const g = newGame(7);
  g.addPlayer('alice');
  g.setPresentRate(1);
  g._scheduleNextPresent(0);
  const normal = g._nextPresentAt;
  g.setPresentRate(4);
  g._scheduleNextPresent(0);
  const fast = g._nextPresentAt;
  assert.ok(fast < normal, `4x (${fast}) should drop sooner than 1x (${normal})`);
  g.setPresentRate(100); assert.equal(g.presentRate, 8);    // clamped high
  g.setPresentRate(0);   assert.equal(g.presentRate, 8);    // non-positive ignored
  g.setPresentRate(0.1); assert.equal(g.presentRate, 0.25); // clamped low
});

test('mallen power level scales his speed (and validates 1-5)', () => {
  const g = newGame();
  assert.equal(g.mallenPower, 3); // default
  const id = g.addPlayer('mallen');
  const m = g.players.get(id);
  g.setMallenPower(1);
  const low = g._effectiveSpeed(m);
  g.setMallenPower(5);
  const high = g._effectiveSpeed(m);
  assert.ok(high > low, `level 5 (${high}) should be faster than level 1 (${low})`);
  g.setMallenPower(99); assert.equal(g.mallenPower, 5);   // invalid ignored
  g.setMallenPower(0);  assert.equal(g.mallenPower, 5);   // out of range ignored
  g.setMallenPower(3);  assert.equal(g.mallenPower, 3);
});

test('golden curd: +1 point (eaten for the Mallen) and a brief freeze (one-shot buff)', () => {
  assert.ok(ONE_SHOT.has(FX.GOLDEN_CURD), 'golden curd is a one-shot');
  assert.ok(BUFF_POOL.some(e => e.fx === FX.GOLDEN_CURD), 'golden curd is a buff');
  const g = newGame();
  const crew = g.addPlayer('alice');
  const mal = g.addPlayer('mallen');
  g.startRound();
  advance(g, 3200);
  const now = g._clock;
  const a = g.players.get(crew), m = g.players.get(mal);
  const aScore = a.score, mEaten = m.eaten;
  g._applyOneShot(a, FX.GOLDEN_CURD, now);
  assert.equal(a.score, aScore + 1);
  assert.equal(a.stunnedUntilMs, now + EFFECT.goldenCurdMs);
  g._applyOneShot(m, FX.GOLDEN_CURD, now);
  assert.equal(m.eaten, mEaten + 1); // the Mallen scores via 'eaten'
});

test('setForcedPresent overrides the random roll (admin testing)', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.setForcedPresent('banana');
  const p = g.players.get(id);
  g._applyPresent(p, 0);
  assert.equal(p._lastFx, 'banana');
  assert.equal(p.effect, 'banana');
  g.setForcedPresent('random');     // back to random
  assert.equal(g.forcedFx, null);
  g.setForcedPresent('not_a_real_fx'); // invalid is ignored
  assert.equal(g.forcedFx, null);
});

test('interstitial ad is a one-shot debuff that stuns the claimer for ~3s', () => {
  assert.ok(ONE_SHOT.has(FX.INTERSTITIAL), 'interstitial is a one-shot');
  assert.ok(DEBUFF_POOL.some(e => e.fx === FX.INTERSTITIAL), 'interstitial is a debuff');
  const g = newGame();
  const id = g.addPlayer('alice');
  g.startRound();
  advance(g, 3200);
  const p = g.players.get(id);
  const now = g._clock;
  g._applyOneShot(p, FX.INTERSTITIAL, now);
  assert.equal(p.stunnedUntilMs, now + EFFECT.interstitialMs);
  assert.equal(p.adStunUntilMs, now + EFFECT.interstitialMs);
  assert.equal(p.charging, false);
  // the snapshot exposes adStunned so other clients can draw the above-head ad
  assert.equal(g.snapshot().players.find(x => x.id === id).adStunned, true);
});

test('double_speed is faster than half_speed (effects not swapped)', () => {
  const g = newGame();
  const id = g.addPlayer('runner');
  g.startRound();
  advance(g, 3200);
  const step = (effect) => {
    const p = g.players.get(id);
    p.effect = effect;
    p.effectUntilMs = g._clock + 1e6; // don't let it expire mid-measurement
    p.x = 800; p.y = 800;
    g.setInput(id, 1, 0); // hold "move right"
    const x0 = p.x;
    g.tick(100);
    return g.players.get(id).x - x0;
  };
  const fast = step(FX.DOUBLE_SPEED);
  const slow = step(FX.HALF_SPEED);
  assert.ok(fast > slow, `double_speed (${fast}px) should exceed half_speed (${slow}px)`);
});
