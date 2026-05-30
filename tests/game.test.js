import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Game, _resetIds } from '../server/game/game.js';
import {
  PHASE, MALLEN, ROUND, LOCI, THROW, FRENZY, PLAYER, FX, EFFECT, ONE_SHOT, DEBUFF_POOL, BUFF_POOL, WILDCARD_POOL, MALLEN_BUFF_POOL, PRESENT, TICK_MS,
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

test('corgi attack spawns a hunter that stuns others but never its owner', () => {
  assert.ok(ONE_SHOT.has(FX.CORGI_ATTACK), 'corgi attack is a one-shot');
  assert.ok(BUFF_POOL.some(e => e.fx === FX.CORGI_ATTACK), 'corgi attack is a buff');
  const g = newGame();
  const owner = g.addPlayer('owner');
  const victim = g.addPlayer('victim');
  g.startRound();
  advance(g, 3200);
  const o = g.players.get(owner), v = g.players.get(victim);
  o.x = 800; o.y = 800; v.x = 880; v.y = 800;
  g._applyOneShot(o, FX.CORGI_ATTACK, g._clock);
  assert.equal(g.corgis.length, 1);
  const c = g.corgis[0];
  assert.equal(c.ownerId, owner);
  // park the corgi on the victim — it should charge + run through + stun them
  c.x = v.x; c.y = v.y;
  advance(g, 100);
  assert.ok(g.players.get(victim).stunnedUntilMs > g._clock, 'victim is stunned');
  assert.ok(c.attacked.has(victim), 'victim recorded as attacked (no repeat)');
  // it never stuns its owner, even sitting right on top of them
  c.x = o.x; c.y = o.y; c.targetId = null;
  const ownerBefore = g.players.get(owner).stunnedUntilMs;
  advance(g, 200);
  assert.equal(g.players.get(owner).stunnedUntilMs, ownerBefore, 'owner never attacked');
});

test('presents never land on top of the truck or fridge', () => {
  const g = newGame(3);
  g.addPlayer('alice');
  g.startRound();
  for (let i = 0; i < 200; i++) g._spawnPresent(0);
  const clearT = LOCI.truckRadius + PRESENT.radius + PLAYER.radius;
  const clearF = LOCI.fridgeRadius + PRESENT.radius + PLAYER.radius;
  const d = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  for (const p of g.presents) {
    assert.ok(d(p.landX, p.landY, g.loci.truck.x, g.loci.truck.y) >= clearT, 'clear of truck');
    assert.ok(d(p.landX, p.landY, g.loci.fridge.x, g.loci.fridge.y) >= clearF, 'clear of fridge');
  }
});

test('dance party: a moving aura forces anyone in radius to dance and drop their tub', () => {
  assert.ok(BUFF_POOL.some(e => e.fx === FX.DANCE_PARTY), 'dance party is a buff');
  assert.ok(ONE_SHOT.has(FX.DANCE_PARTY), 'dance party is a one-shot');
  const g = newGame();
  const dj = g.addPlayer('dj');
  const near = g.addPlayer('near');
  const far = g.addPlayer('far');
  g.startRound();
  advance(g, 3200);
  const d = g.players.get(dj), n = g.players.get(near), f = g.players.get(far);
  d.x = 800; d.y = 800; n.x = 900; n.y = 800; f.x = 800; f.y = 1400; // near in range, far out
  giveTub(g, near);
  assert.notEqual(n.carryingTubId, null);
  g._applyOneShot(d, FX.DANCE_PARTY, g._clock);
  advance(g, 50);
  assert.ok(d.dancePartyHostUntilMs > g._clock, 'dj is the host');
  assert.ok(g._clock >= d.danceUntilMs, 'dj roams free (not dancing)');
  assert.ok(n.danceUntilMs > g._clock && n.stunnedUntilMs > g._clock, 'near is dancing/stunned');
  assert.equal(n.carryingTubId, null, 'the dance stun dropped near\'s tub');
  assert.ok(g._clock >= f.danceUntilMs, 'far not yet dancing');
  // far wanders into the aura later -> starts dancing
  f.x = 850; f.y = 800;
  advance(g, 50);
  assert.ok(g.players.get(far).danceUntilMs > g._clock, 'far joins once inside the radius');
});

test('twin-stick aim: a charging player throws in the streamed aim direction, not their facing dir', () => {
  const g = newGame();
  const id = g.addPlayer('thrower');
  g.startRound();
  advance(g, 3200);
  const p = g.players.get(id);
  giveTub(g, id);
  // facing east (movement direction), but aim straight south
  p.dir = { x: 1, y: 0 };
  g.startCharge(id, g._clock);
  g.setAim(id, 0, 10);                            // not a unit vector — server normalizes
  assert.deepEqual(p.aim, { x: 0, y: 1 }, 'aim stored as a unit vector');
  advance(g, 200);                                // charge a bit
  g.release(id, g._clock);
  const t = g.tubs.find(t => t.state === 'flying');
  assert.ok(t, 'tub is flying');
  assert.ok(Math.abs(t.vx) < 1e-6 && t.vy > 0, `expected south throw, got (${t.vx}, ${t.vy})`);
  assert.equal(p.aim, null, 'aim cleared after release');
});

test('twin-stick aim: setAim is ignored outside of an active charge', () => {
  const g = newGame();
  const id = g.addPlayer('thrower');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  g.setAim(id, 1, 0);                              // not charging
  assert.equal(p.aim, null, 'stale aim cannot be set without a charge');
});

test('twin-stick aim: a stun mid-charge cancels the aim too', () => {
  const g = newGame();
  const id = g.addPlayer('thrower');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  giveTub(g, id);
  g.startCharge(id, g._clock);
  g.setAim(id, 1, 0);
  assert.ok(p.aim, 'aim is set');
  g._stunPlayer(p, g._clock, 500);                 // any stun also clears the charge
  assert.equal(p.charging, false);
  assert.equal(p.aim, null, 'cancelled charge cancels the aim');
});

test('nuke: claim arms; launch latches a countdown and freezes the launcher', () => {
  assert.ok(BUFF_POOL.some(e => e.fx === FX.NUKE), 'nuke is a buff');
  assert.ok(ONE_SHOT.has(FX.NUKE), 'nuke is a one-shot');
  const g = newGame();
  const id = g.addPlayer('alice');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  g._applyOneShot(p, FX.NUKE, g._clock);
  assert.equal(p.nukeArmed, true, 'armed after claim');
  assert.equal(p.effect, FX.NUKE, 'HUD shows the buff');
  // launch at a target
  const launchClock = g._clock;
  g.launchNuke(id, launchClock, 800, 800);
  assert.equal(g.activeNukes.length, 1, 'nuke queued');
  assert.equal(p.nukeArmed, false, 'disarmed after launch');
  assert.ok(p.stunnedUntilMs >= launchClock + 2900, 'frozen for the countdown');
  // countdown elapses -> detonate -> nuke leaves the list
  advance(g, 3200);
  assert.equal(g.activeNukes.length, 0, 'detonated and cleaned up');
});

test('nuke: detonation flings nearby players outward and knocks their tubs loose', () => {
  const g = newGame();
  const launcher = g.addPlayer('launcher');
  const victim = g.addPlayer('victim');
  const farPlayer = g.addPlayer('farPlayer');
  g.startRound(); advance(g, 3200);
  const L = g.players.get(launcher), v = g.players.get(victim), fp = g.players.get(farPlayer);
  L.x = 200; L.y = 200;
  v.x = 800; v.y = 800;                 // within blast radius (600) of (820, 820)
  fp.x = 200; fp.y = 1500;              // far from blast
  giveTub(g, victim);                   // victim is carrying
  g._applyOneShot(L, FX.NUKE, g._clock);
  g.launchNuke(launcher, g._clock, 820, 820);
  advance(g, 3300);                     // past countdown -> detonate
  const v2 = g.players.get(victim);
  assert.equal(v2.carryingTubId, null, 'victim dropped their tub from the blast');
  assert.ok(v2.dashUntilMs > g._clock, 'victim was flung (dash override active)');
  const fp2 = g.players.get(farPlayer);
  assert.equal(fp2.dashUntilMs, 0, 'far player untouched');
});

test('nuke: launch is rejected while the player is stunned', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  g._applyOneShot(p, FX.NUKE, g._clock);
  p.stunnedUntilMs = g._clock + 2000;  // stunned by something
  g.launchNuke(id, g._clock, 800, 800);
  assert.equal(g.activeNukes.length, 0, 'no nuke queued while stunned');
  assert.equal(p.nukeArmed, true, 'still armed for later');
});

test('portal: claiming spawns a paired set (one near, one far, opposite colors)', () => {
  assert.ok(BUFF_POOL.some(e => e.fx === FX.PORTAL), 'portal is a buff');
  assert.ok(ONE_SHOT.has(FX.PORTAL), 'portal is a one-shot');
  const g = newGame();
  const id = g.addPlayer('alice');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  p.x = 1000; p.y = 1000;
  g._applyOneShot(p, FX.PORTAL, g._clock);
  assert.equal(g.portals.length, 2, 'two portals spawned');
  const [a, b] = g.portals;
  assert.equal(a.pairId, b.pairId, 'shared pair id');
  assert.notEqual(a.color, b.color, 'opposite colors');
  // one of them is near the claimer; the other is far away
  const dA = Math.hypot(a.x - p.x, a.y - p.y);
  const dB = Math.hypot(b.x - p.x, b.y - p.y);
  const near = Math.min(dA, dB), far = Math.max(dA, dB);
  assert.ok(near < 200, `near portal within ~110px ish, got ${near}`);
  assert.ok(far > 600, `far portal at least ~700px away, got ${far}`);
});

test('portal: a player walking into a portal is teleported to its pair', () => {
  const g = newGame();
  const id = g.addPlayer('victim');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  // hand-place a portal pair so we don't depend on RNG spawn positions
  const now = g._clock;
  g.portals = [
    { id: 1, pairId: 99, color: 'orange', x: 300,  y: 300,  expiresAt: now + 5000 },
    { id: 2, pairId: 99, color: 'blue',   x: 1200, y: 1200, expiresAt: now + 5000 },
  ];
  p.x = 305; p.y = 300; p.portalCooldownUntilMs = 0;
  p.vx = 0; p.vy = 0;
  g._updatePortals(g._clock);
  // teleported near the blue portal (within radius+offset)
  assert.ok(Math.hypot(p.x - 1200, p.y - 1200) < 60, `expected teleport near (1200,1200), got (${p.x},${p.y})`);
  assert.ok(p.portalCooldownUntilMs > g._clock, 'cooldown set');
});

test('portal: a flying tub keeps its velocity through the portal', () => {
  const g = newGame();
  g.addPlayer('a');
  g.startRound(); advance(g, 3200);
  const t = g._spawnTub(300, 300, 'flying');
  t.vx = 320; t.vy = 0;
  g.portals = [
    { id: 1, pairId: 7, color: 'orange', x: 300,  y: 300,  expiresAt: g._clock + 5000 },
    { id: 2, pairId: 7, color: 'blue',   x: 1200, y: 1200, expiresAt: g._clock + 5000 },
  ];
  g._updatePortals(g._clock);
  // popped out near the blue portal, still moving east
  assert.ok(Math.hypot(t.x - 1200, t.y - 1200) < 80, 'tub landed near pair');
  assert.equal(t.vx, 320, 'velocity x preserved');
  assert.equal(t.vy, 0, 'velocity y preserved');
});

test('magnet rips a carried tub out of a nearby player and pulls it toward the holder', () => {
  const g = newGame();
  const holder = g.addPlayer('holder');
  const victim = g.addPlayer('victim');
  const farPlayer = g.addPlayer('farPlayer');
  g.startRound();
  advance(g, 3200);
  const h = g.players.get(holder), v = g.players.get(victim), fp = g.players.get(farPlayer);
  h.x = 800; h.y = 800; v.x = 900; v.y = 800; fp.x = 800; fp.y = 1400; // victim in range, far out
  const vt = giveTub(g, victim); giveTub(g, farPlayer);
  h.effect = FX.MAGNET; h.effectUntilMs = g._clock + 6000;
  const before = vt.x;
  advance(g, 50);
  assert.equal(v.carryingTubId, null, 'victim lost their tub');
  assert.equal(vt.state, 'loose', 'tub is loose again');
  assert.ok(vt.x < before, 'tub is being pulled toward the magnet holder');
  assert.notEqual(fp.carryingTubId, null, 'far player keeps their tub');
});

test('magnet does NOT rip a tub from an invincible carrier', () => {
  const g = newGame();
  const holder = g.addPlayer('holder');
  const tank = g.addPlayer('tank');
  g.startRound();
  advance(g, 3200);
  const h = g.players.get(holder), t = g.players.get(tank);
  h.x = 800; h.y = 800; t.x = 900; t.y = 800;
  giveTub(g, tank);
  t.effect = FX.INVINCIBLE; t.effectUntilMs = g._clock + 6000;
  h.effect = FX.MAGNET;     h.effectUntilMs = g._clock + 6000;
  advance(g, 50);
  assert.notEqual(t.carryingTubId, null, 'invincible carrier keeps their tub');
});

test('dominating cue fires once (for the leader) when 5+ points ahead', () => {
  const g = newGame();
  const a = g.addPlayer('alice');
  const b = g.addPlayer('bob');
  g.startRound();
  advance(g, 3200);
  g.drainEvents();
  // alice pulls to a 4-point lead: not dominating yet
  g.players.get(a).score = 4; g.players.get(b).score = 0;
  advance(g, 33);
  assert.ok(!g.drainEvents().some(e => e.type === 'dominating'), 'no cue at +4');
  // 5-point lead: fires once, for alice
  g.players.get(a).score = 5;
  advance(g, 33);
  let evs = g.drainEvents().filter(e => e.type === 'dominating');
  assert.equal(evs.length, 1, 'one cue at +5');
  assert.equal(evs[0].id, a, 'cue is for the leader');
  // still dominating next tick -> does not re-fire
  advance(g, 33);
  assert.ok(!g.drainEvents().some(e => e.type === 'dominating'), 'no repeat while still ahead');
});

test('disc golf flings discs that stun others but never the owner', () => {
  assert.ok(BUFF_POOL.some(e => e.fx === FX.DISC_GOLF), 'disc golf is a buff');
  assert.ok(!ONE_SHOT.has(FX.DISC_GOLF), 'disc golf is a duration buff, not one-shot');
  const g = newGame();
  const owner = g.addPlayer('owner');
  const victim = g.addPlayer('victim');
  g.startRound();
  advance(g, 3200);
  const now = g._clock;
  const o = g.players.get(owner), v = g.players.get(victim);
  o.x = 800; o.y = 800; v.x = 1200; v.y = 800;        // victim far, won't catch random discs
  o.effect = FX.DISC_GOLF; o.effectUntilMs = now + 6000; o.nextDiscAt = now;
  advance(g, 300);
  assert.ok(g.discs.length >= 1, 'discs are being flung');
  // a disc parked on the victim stuns them
  g.discs.push({ id: 9001, x: v.x, y: v.y, vx: 0, vy: 0, ownerId: owner, expiresAt: g._clock + 1000, hit: new Set() });
  advance(g, 50);
  assert.ok(g.players.get(victim).stunnedUntilMs > g._clock, 'victim bonked');
  // a disc parked on the owner never stuns them
  const ownerBefore = g.players.get(owner).stunnedUntilMs;
  g.discs.push({ id: 9002, x: o.x, y: o.y, vx: 0, vy: 0, ownerId: owner, expiresAt: g._clock + 1000, hit: new Set() });
  advance(g, 50);
  assert.equal(g.players.get(owner).stunnedUntilMs, ownerBefore, 'owner immune to own discs');
});

test('corgi expires after its lifespan', () => {
  const g = newGame();
  const id = g.addPlayer('owner');
  g.startRound();
  advance(g, 3200);
  g._applyOneShot(g.players.get(id), FX.CORGI_ATTACK, g._clock);
  assert.equal(g.corgis.length, 1);
  advance(g, 8200); // past CORGI.lifeMs (8000)
  assert.equal(g.corgis.length, 0, 'corgi vanished');
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

// Load floor: 20 players (max realistic party size + Mallen) running ~60s of
// chaotic mixed-effect play must stay well under the 33ms tick budget. This
// pins down the perf headroom so we notice if a future feature blows it up.
test('load: 20 players churning effects keeps ticks well under the 33ms budget', () => {
  const g = newGame();
  const crew = [];
  for (let i = 0; i < 19; i++) crew.push(g.addPlayer('crew' + i));
  g.addPlayer('mallen');                       // 20th player — the Mallen AI runs on its own
  g.setForcedPresent('');                      // random across the full buff/debuff pool
  g.startRound();
  advance(g, 3200);                            // out of the countdown -> PLAYING

  const rng = seededRng(7);
  const tickTimes = new Array(2000);
  const snapBytes = [];
  for (let i = 0; i < tickTimes.length; i++) {
    const now = g._clock || 0;
    // simulate realistic input churn: wiggle direction, fire actions occasionally
    for (const id of crew) {
      if (rng() < 0.12) { const a = rng() * Math.PI * 2; g.setInput(id, Math.cos(a), Math.sin(a)); }
      if (rng() < 0.05) g.pickup(id, now);
      if (rng() < 0.04) g.startCharge(id, now);
      if (rng() < 0.04) g.release(id, now);
      if (rng() < 0.05) g.punch(id, now);
    }
    const t0 = performance.now();
    g.tick(TICK_MS);
    tickTimes[i] = performance.now() - t0;
    // sample the broadcast payload roughly once a second
    if (i % 30 === 0) {
      const snap = g.snapshot();
      snapBytes.push(JSON.stringify({ type: 'state', snapshot: snap, events: g.drainEvents() }).length);
    } else {
      g.drainEvents();                         // don't let the queue balloon
    }
  }
  tickTimes.sort((a, b) => a - b);
  const avg = tickTimes.reduce((s, t) => s + t, 0) / tickTimes.length;
  const p50 = tickTimes[Math.floor(tickTimes.length * 0.50)];
  const p99 = tickTimes[Math.floor(tickTimes.length * 0.99)];
  const maxT = tickTimes[tickTimes.length - 1];
  const maxSnap = Math.max(...snapBytes);
  console.log(`  20-player load: avg ${avg.toFixed(2)}ms  p50 ${p50.toFixed(2)}ms  p99 ${p99.toFixed(2)}ms  max ${maxT.toFixed(2)}ms  snap<=${maxSnap}B`);
  // 33ms is the per-tick budget at 30Hz; demand serious headroom
  assert.ok(avg < 5,    `avg tick ${avg.toFixed(2)}ms exceeds 5ms budget`);
  assert.ok(p99 < 15,   `p99 tick ${p99.toFixed(2)}ms exceeds 15ms budget`);
  assert.ok(maxSnap < 32 * 1024, `snapshot json ${maxSnap}B is too large to broadcast comfortably`);
});

test('gift deck: a new player sees every gift type once before any repeats', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  // expected pool: buffs + debuffs + wildcards (no Mallen-only filter)
  const expected = new Set([...BUFF_POOL, ...DEBUFF_POOL, ...WILDCARD_POOL].map((e) => e.fx));
  const seen = [];
  // drain exactly |pool| presents by directly invoking the present-apply path
  for (let i = 0; i < expected.size; i++) {
    g._applyPresent(p, g._clock);
    seen.push(p._lastFx);
  }
  assert.equal(new Set(seen).size, expected.size, `expected ${expected.size} unique fx, saw ${new Set(seen).size}: ${seen.join(',')}`);
  for (const fx of seen) assert.ok(expected.has(fx), `unknown fx ${fx} appeared`);
  // deck drained — next pickup must be allowed to repeat (true random)
  assert.equal(p.giftDeck.length, 0, 'deck drained after one full cycle');
});

test('gift deck: Mallen draws only from his own buff pool, also unique-first', () => {
  const g = newGame();
  g.addPlayer('crew');                              // ensure Mallen slot is open
  const mid = g.addPlayer('mallen');
  g.startRound(); advance(g, 3200);
  const m = g.players.get(mid);
  assert.ok(m.isMallen);
  const expected = new Set(MALLEN_BUFF_POOL.map((e) => e.fx));
  const seen = new Set();
  for (let i = 0; i < expected.size; i++) {
    g._applyPresent(m, g._clock);
    seen.add(m._lastFx);
    assert.ok(expected.has(m._lastFx), `Mallen drew non-Mallen fx ${m._lastFx}`);
  }
  assert.equal(seen.size, expected.size, 'Mallen saw every buff before any repeat');
});

test('gift deck: forced-present admin override bypasses the deck', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  g.setForcedPresent(FX.MAGNET);
  for (let i = 0; i < 3; i++) g._applyPresent(p, g._clock);
  assert.equal(p._lastFx, FX.MAGNET, 'forced-present overrides the deck');
});

// ---- Regression tests for the post-review bug fixes -----------------------

test('regression: claiming a new buff clears prior nukeArmed', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  g.setForcedPresent(FX.NUKE);
  g._applyPresent(p, g._clock);
  assert.equal(p.nukeArmed, true);
  // claim a different forced effect — nuke arm must drop
  g.setForcedPresent(FX.DOUBLE_SPEED);
  g._applyPresent(p, g._clock);
  assert.equal(p.nukeArmed, false, 'replacing the buff disarms the nuke');
});

test('regression: claiming a new buff clears prior cannonArmed', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  g.setForcedPresent(FX.CURD_CANNON);
  g._applyPresent(p, g._clock);
  assert.equal(p.cannonArmed, true);
  g.setForcedPresent(FX.DOUBLE_SPEED);
  g._applyPresent(p, g._clock);
  assert.equal(p.cannonArmed, false, 'replacing the buff disarms the cannon');
});

test('regression: dash override beats stun (nuke can fling stunned victims)', () => {
  const g = newGame();
  const id = g.addPlayer('victim');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  const startX = p.x;
  p.stunnedUntilMs = g._clock + 2000;
  p.dashUntilMs = g._clock + 800;
  p.dashVx = 400; p.dashVy = 0;
  advance(g, 100);
  assert.ok(g.players.get(id).x > startX + 10, 'dash carried the stunned player forward');
});

test('regression: portal places at-rest entity outside the destination radius (no ping-pong)', () => {
  const g = newGame();
  const id = g.addPlayer('victim');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  g.portals = [
    { id: 1, pairId: 7, color: 'orange', x: 300,  y: 300,  expiresAt: g._clock + 5000 },
    { id: 2, pairId: 7, color: 'blue',   x: 1200, y: 1200, expiresAt: g._clock + 5000 },
  ];
  p.x = 300; p.y = 300; p.vx = 0; p.vy = 0;
  p.portalCooldownUntilMs = 0;
  g._updatePortals(g._clock);
  // teleported to OUTSIDE the destination portal's radius (with a margin)
  const d = Math.hypot(p.x - 1200, p.y - 1200);
  assert.ok(d >= 38 && d <= 80, `expected place just outside portal radius (~50-60), got ${d.toFixed(1)}`);
});

test('regression: pinata clamps spawned tubs to arena', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  // place at the corner so a 40px radial spawn would otherwise escape
  p.x = 5; p.y = 5;
  g._applyOneShot(p, FX.PINATA, g._clock);
  for (const t of g.tubs.filter(t => t.state === 'loose')) {
    assert.ok(t.x >= 0 && t.x <= 1600, `tub x ${t.x} outside arena`);
    assert.ok(t.y >= 0 && t.y <= 1600, `tub y ${t.y} outside arena`);
  }
});

test('regression: stunned dance host stops auraing nearby players', () => {
  const g = newGame();
  const host = g.addPlayer('host');
  const victim = g.addPlayer('victim');
  g.startRound(); advance(g, 3200);
  const h = g.players.get(host), v = g.players.get(victim);
  h.x = 800; h.y = 800; v.x = 850; v.y = 800;        // adjacent
  g._applyOneShot(h, FX.DANCE_PARTY, g._clock);       // host arms
  advance(g, 50);
  assert.ok(v.danceUntilMs > g._clock, 'victim was caught initially');
  h.stunnedUntilMs = g._clock + 1000;                 // stun the host
  v.danceUntilMs = 0;                                  // reset the dance state
  advance(g, 50);
  assert.equal(v.danceUntilMs, 0, 'stunned host stopped pulling new dancers');
});

test('regression: Mallen with magnet does not rip tubs off the truck', () => {
  const g = newGame();
  const mid = g.addPlayer('mallen');
  g.startRound(); advance(g, 3200);
  const m = g.players.get(mid);
  assert.ok(m.isMallen);
  // put a ready tub near the Mallen
  const t = g._spawnTub(m.x + 100, m.y, 'ready');
  const x0 = t.x;
  m.effect = FX.MAGNET; m.effectUntilMs = g._clock + 6000;
  advance(g, 200);
  assert.equal(t.x, x0, 'Mallen magnet should NOT pull the ready tub');
});

test('regression: giftDeck persists across rounds (per-session, not per-round)', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  // drain a few in round 1
  g._applyPresent(p, g._clock);
  g._applyPresent(p, g._clock);
  g._applyPresent(p, g._clock);
  const remainingAfterR1 = p.giftDeck.length;
  const deckSnapshot = [...p.giftDeck];                // exact order of remaining cards
  g.startRound(); advance(g, 100);
  // deck must SURVIVE the round transition — "every gift once" is per-join,
  // not per-round. A player keeps draining the same shuffled deck until it's
  // empty, then switches to true-random forever.
  assert.deepEqual(p.giftDeck, deckSnapshot, 'deck and order preserved across rounds');
  g._applyPresent(p, g._clock);
  assert.equal(p.giftDeck.length, remainingAfterR1 - 1, 'next pickup pops the next deck card');
});

test('regression: setInput rejects NaN / Infinity', () => {
  const g = newGame();
  const id = g.addPlayer('alice');
  g.startRound(); advance(g, 3200);
  const p = g.players.get(id);
  const before = { x: p.x, y: p.y };
  g.setInput(id, NaN, 0);
  g.setInput(id, 0, Infinity);
  advance(g, 100);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'position never went NaN');
  // velocity stayed at 0 since both NaN inputs were rejected
  assert.equal(Math.hypot(p.x - before.x, p.y - before.y), 0, 'NaN inputs were silently rejected');
});

test('regression: explosion shove clamps victims to arena bounds', () => {
  const g = newGame();
  const claimer = g.addPlayer('a');
  const victim = g.addPlayer('b');
  g.startRound(); advance(g, 3200);
  const c = g.players.get(claimer), v = g.players.get(victim);
  c.x = 1500; c.y = 1500;          // near top-right corner
  v.x = 1580; v.y = 1500;
  g._applyOneShot(c, FX.EXPLOSION, g._clock);
  assert.ok(v.x <= 1600 - v.radius + 0.001, `victim x clamped, got ${v.x}`);
  assert.ok(v.y <= 1600 - v.radius + 0.001, `victim y clamped, got ${v.y}`);
});

// ---- Fuzz: random valid inputs across many ticks must not crash or NaN ----

test('fuzz: 200 ticks of random inputs across 8 players never produces NaN / crash', () => {
  const g = newGame();
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push(g.addPlayer('crew' + i));
  ids.push(g.addPlayer('mallen'));
  g.startRound(); advance(g, 3200);
  const rng = seededRng(11);
  for (let tick = 0; tick < 200; tick++) {
    for (const id of ids) {
      const a = rng() * Math.PI * 2;
      const r = rng() * 1.2;
      if (rng() < 0.1) g.setInput(id, NaN, 0);     // garbage in
      else if (rng() < 0.1) g.setInput(id, Infinity, 1);
      else g.setInput(id, Math.cos(a) * r, Math.sin(a) * r);
      if (rng() < 0.05) g.pickup(id, g._clock);
      if (rng() < 0.05) g.startCharge(id, g._clock);
      if (rng() < 0.05) g.release(id, g._clock);
      if (rng() < 0.05) g.punch(id, g._clock);
      if (rng() < 0.02) g.launchNuke(id, g._clock, rng() * 1600, rng() * 1600);
      if (rng() < 0.02) g.setAim(id, rng() * 2 - 1, rng() * 2 - 1);
    }
    g.tick(33);
    // invariants
    for (const p of g.players.values()) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `player ${p.id} went NaN at tick ${tick}`);
      assert.ok(p.x >= -10 && p.x <= 1610, `player ${p.id} x out of bounds (${p.x}) at tick ${tick}`);
      assert.ok(p.y >= -10 && p.y <= 1610, `player ${p.id} y out of bounds (${p.y}) at tick ${tick}`);
    }
    for (const t of g.tubs) {
      assert.ok(Number.isFinite(t.x) && Number.isFinite(t.y), `tub ${t.id} went NaN at tick ${tick}`);
    }
  }
});
