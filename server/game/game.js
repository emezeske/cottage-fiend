// Authoritative game simulation. No networking, no real timers — everything is
// driven by tick(dtMs) and input methods so it is fully unit-testable.
//
// The Game owns all truth: players, tubs, loci, scores, phase, frenzy. The
// server wraps this with a WebSocket layer and a setInterval calling tick().

import {
  ARENA, PLAYER, MALLEN, FRENZY, TUB, THROW, LOCI, ROUND, PHASE, MSG,
  PRESENT, EFFECT, FX, ONE_SHOT, PUNCH, COLLISION, SAFE_ZONE, STUN, DEBUFF_POOL,
  MALLEN_POWER, MALLEN_POWER_DEFAULT, CORGI, DISC, DANCE, PORTAL, NUKE,
} from './constants.js';

const DEBUFF_FX = new Set(DEBUFF_POOL.map((e) => e.fx)); // for buff-vs-curse SFX
const FX_VALUES = new Set(Object.values(FX));            // valid effect ids (admin force-present)
import { dist, normalize, resolveCircleOverlap, clampToArena, chargePower } from './vec.js';
import { placeLoci, randSpawn } from './spawn.js';
import { rollEffect } from './effects.js';

let _nextId = 1;
export function _resetIds() { _nextId = 1; } // test helper

// shortest distance from point (px,py) to the segment (ax,ay)-(bx,by)
function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let u = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return Math.hypot(px - (ax + abx * u), py - (ay + aby * u));
}

export class Game {
  constructor({ rng = Math.random } = {}) {
    this.rng = rng;
    this.phase = PHASE.LOBBY;
    this.players = new Map();   // id -> player
    this.tubs = [];             // active tubs (carried, flying, or loose)
    this.loci = placeLoci(ARENA, LOCI, rng);
    this._computeSafeZone();
    this.countdownMs = 0;
    this.events = [];           // one-shot events drained each broadcast
    this.mallenId = null;       // id of the player currently acting as Mallen
    this.roundWinner = null;    // {type:'player'|'mallen', name}
    this._tubSeq = 1;
    this.presents = [];         // parachuting gift boxes
    this._presentSeq = 1;
    this._nextPresentAt = null; // clock time of next present spawn (null = unscheduled)
    this.roundNumber = 0;       // increments each round (for the ROUND N intro)
    this._firstScored = false;  // has anyone scored yet this round (for FIRST CURD)
    this.forcedFx = null;       // admin testing: force every present to this effect (null = random)
    this.mallenPower = MALLEN_POWER_DEFAULT; // admin: live difficulty knob for the Mallen (1-5)
    this.presentRate = 1;       // admin: present-frequency multiplier (1 = normal, higher = more)
    this.corgis = [];           // active CORGI_ATTACK hunters
    this._corgiSeq = 1;
    this.discs = [];            // active DISC_GOLF projectiles
    this._discSeq = 1;
    this.portals = [];          // active PORTAL pairs (orange + blue, paired by pairId)
    this._portalSeq = 1;
    this.activeNukes = [];      // committed nuke launches counting down to detonation
    this._nukeSeq = 1;
    this._dominating = false;   // has the current 5+ point lead already been announced
  }

  // Fire a one-shot "dominating" cue (local to the leader) the first time a crew
  // member pulls 5+ points ahead of the next-best crew member.
  _checkDominating() {
    const crew = [...this.players.values()].filter(p => !p.isMallen);
    if (crew.length < 2) { this._dominating = false; return; }
    crew.sort((a, b) => b.score - a.score);
    const lead = crew[0].score - crew[1].score;
    if (lead >= 5 && !this._dominating) {
      this._dominating = true;
      this.events.push({ type: 'dominating', id: crew[0].id });
    } else if (lead < 5) {
      this._dominating = false;
    }
  }

  // Admin/testing: force every claimed present to roll a specific effect, or pass
  // a falsy/'random'/invalid value to restore normal random rolls.
  setForcedPresent(fx) {
    this.forcedFx = FX_VALUES.has(fx) ? fx : null;
  }

  // Admin: set the Mallen difficulty level (1-5). Invalid values are ignored.
  setMallenPower(level) {
    const n = Math.round(Number(level));
    if (MALLEN_POWER[n]) this.mallenPower = n;
  }
  _mallenPow() { return MALLEN_POWER[this.mallenPower] || MALLEN_POWER[MALLEN_POWER_DEFAULT]; }

  // Admin: multiply how often presents drop (1 = normal). Clamped to a sane range.
  setPresentRate(rate) {
    const r = Number(rate);
    if (Number.isFinite(r) && r > 0) this.presentRate = Math.min(8, Math.max(0.25, r));
  }

  // Emit the global FIRST CURD cue the first time anyone scores in a round.
  _maybeFirstCurd() {
    if (this._firstScored) return;
    this._firstScored = true;
    this.events.push({ type: 'firstCurd' });
  }

  // ---- lifecycle ----------------------------------------------------------
  addPlayer(name, colors) {
    const id = _nextId++;
    // Only ONE Mallen: a second person typing "mallen" joins as a normal delivery
    // player (otherwise they'd be a dead-weight character that can't eat/score/win).
    const isMallen = name.trim().toLowerCase() === MALLEN.name && this.mallenId == null;
    const spawn = randSpawn(ARENA, LOCI.edgePadding, this.rng);
    const norm = (v, fallback) => (typeof v === 'number' && Number.isFinite(v))
      ? ((v % 360) + 360) % 360 : fallback;
    const vestHue  = norm(colors && colors.vestHue,  (id * 53) % 360);
    const pantsHue = norm(colors && colors.pantsHue, (vestHue + 180) % 360);
    const mallenHue = norm(colors && colors.mallenHue, 4);    // default = source red
    const p = {
      id, name,
      x: spawn.x, y: spawn.y,
      vx: 0, vy: 0,               // velocity (used for the 'slidey'/banana effect)
      dir: { x: 0, y: 1 },        // facing, for throw direction
      moveInput: { x: 0, y: 0 },
      isMallen,
      radius: isMallen ? MALLEN.radius : PLAYER.radius,
      score: 0,                   // deliveries (for delivery players)
      carryingTubId: null,
      charging: false,
      chargeStartMs: 0,
      aim: null,                  // twin-stick: thrown direction during a charge (else uses .dir)
      hitsTaken: 0,               // toward dropping a tub
      vestHue, pantsHue, mallenHue,   // player-chosen sprite tints (hues in 0..360)
      // mallen-only:
      eaten: 0,
      frenzyMs: 0,
      lastAttackMs: -1e9,         // "never attacked" (clock 0 is a valid attack time)
      eatingUntilMs: 0,
      spriteIndex: (id % 12),     // legacy: still used as a stable seed in a couple places
      // power-up/debuff state:
      effect: null,               // active FX id or null
      effectUntilMs: 0,           // clock time the effect ends
      cannonArmed: false,         // curd cannon: next throw auto-scores
      greaseGrabMs: -1,           // clock time greased player grabbed (-1 = none)
      noPickupUntilMs: 0,         // auto-pickup suppressed until this clock time (after a forced drop)
      stunnedUntilMs: 0,          // frozen (can't act) until this clock time (Mallen devour shockwave)
      adStunUntilMs: 0,           // frozen specifically by the interstitial-ad debuff (for the above-head icon)
      danceUntilMs: 0,            // forced to dance (stunned, rendered dancing) until this clock time
      dancePartyHostUntilMs: 0,   // you're HOSTING a dance party (a moving aura + your music) until this
      portalCooldownUntilMs: 0,   // brief teleport immunity so portals don't ping-pong you
      nukeArmed: false,           // NUKE buff is currently held — right-stick aims, release commits
      dashUntilMs: 0,             // Mallen lunge active until this clock time
      dashVx: 0, dashVy: 0,       // lunge velocity
    };
    this.players.set(id, p);
    if (isMallen && this.mallenId == null) this.mallenId = id;
    this.events.push({ type: 'join', name });
    return id;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    // drop any carried tub as loose
    if (p.carryingTubId != null) {
      const t = this.tubs.find(t => t.id === p.carryingTubId);
      if (t) { t.state = 'loose'; t.carrierId = null; }
    }
    this.players.delete(id);
    // Only one player is ever the Mallen, so there's no one to promote — the
    // round simply runs Mallen-less until someone joins as "mallen".
    if (this.mallenId === id) this.mallenId = null;
  }

  // ---- input handlers (called from network layer) ------------------------
  setInput(id, x, y) {
    const p = this.players.get(id);
    if (!p) return;
    // Preserve magnitude (clamp to <=1) so an analog stick can scale speed.
    // Unit-vector clients (legacy tap-and-drag) keep behaving as before.
    let m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; m = 1; }
    p.moveInput = { x, y };
    if (m > 0) p.dir = { x: x / m, y: y / m };
  }

  pickup(id, nowMs) {
    const p = this.players.get(id);
    if (!p || p.isMallen || p.carryingTubId != null) return;
    if (nowMs < p.stunnedUntilMs) return;
    // grab the nearest tappable tub within reach: a 'ready' tub on the truck, or
    // a 'loose' tub on the ground. First come, first serve.
    const reach = p.radius + TUB.radius + 28;
    const best = this._nearestGrabbableTub(p, reach);
    if (best) this._grabTub(p, best, nowMs);
  }

  _nearestGrabbableTub(p, reach) {
    let best = null, bestD = Infinity;
    for (const t of this.tubs) {
      if (t.state !== 'loose' && t.state !== 'ready') continue;
      const d = dist(p.x, p.y, t.x, t.y);
      if (d < reach && d < bestD) { best = t; bestD = d; }
    }
    return best;
  }

  _grabTub(p, t, now) {
    const wasReady = t.state === 'ready';
    t.state = 'carried';
    t.carrierId = p.id;
    t.lastCarrierId = p.id;
    p.carryingTubId = t.id;
    if (p.effect === FX.GREASED) p.greaseGrabMs = now;
    this.events.push({ type: 'pickup', x: p.x, y: p.y });
    // taking a ready tub off the truck schedules a 1s refill
    if (wasReady) this._scheduleTruckRefill(now);
  }

  // Auto-pickup: a delivery player who runs over a tub grabs it (no tap needed).
  // Suppressed briefly after a forced drop so the Mallen can eat it / greased works.
  _autoPickup(now) {
    const reach = PLAYER.radius + TUB.radius + 6; // must actually run onto it
    for (const p of this.players.values()) {
      if (p.isMallen || p.carryingTubId != null) continue;
      if (now < p.noPickupUntilMs || now < p.stunnedUntilMs) continue;
      const best = this._nearestGrabbableTub(p, reach);
      if (best) this._grabTub(p, best, now);
    }
  }

  startCharge(id, nowMs) {
    const p = this.players.get(id);
    if (!p || p.carryingTubId == null) return;
    if (nowMs < p.stunnedUntilMs) return;
    p.charging = true;
    p.chargeStartMs = nowMs;
    p.aim = null;                              // start each charge with no aim override
  }

  // Twin-stick aim: clients stream the throw direction independently of movement
  // while charging. Stored as a unit vector; the throw uses it on release. The
  // server ignores aim outside a charge window so stale messages can't replay it.
  setAim(id, x, y) {
    const p = this.players.get(id);
    if (!p || !p.charging) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const m = Math.hypot(x, y);
    p.aim = m < 0.01 ? null : { x: x / m, y: y / m };
  }

  release(id, nowMs) {
    const p = this.players.get(id);
    if (!p || !p.charging || p.carryingTubId == null) return;
    if (nowMs < p.stunnedUntilMs) return;
    const elapsed = nowMs - p.chargeStartMs;
    let power = chargePower(elapsed, THROW);
    const t = this.tubs.find(t => t.id === p.carryingTubId);
    p.charging = false;
    p.carryingTubId = null;
    if (!t) { p.aim = null; return; }
    // curd cannon: this throw flies ~10x as far, then disarms
    const cannon = !!p.cannonArmed;
    if (cannon) {
      power *= EFFECT.cannonRangeMult;
      p.cannonArmed = false;
      if (p.effect === FX.CURD_CANNON) this._clearEffect(p);
    }
    // twin-stick: throw the aim direction if the client set one this charge,
    // otherwise fall back to the facing dir (movement-driven). The BACKWARDS
    // debuff also flips the throw — your tubs go opposite where you're pointed.
    let dx = p.aim ? p.aim.x : p.dir.x;
    let dy = p.aim ? p.aim.y : p.dir.y;
    if (p.effect === FX.BACKWARDS) { dx = -dx; dy = -dy; }
    p.aim = null;
    t.state = 'flying';
    t.carrierId = null;
    t.vx = dx * power;
    t.vy = dy * power;
    t.thrownBy = id;                 // the thrower can't instantly re-catch their own throw
    t.thrownGraceUntil = nowMs + 400;
    t.cannon = cannon;
    this.events.push({ type: 'throw', x: p.x, y: p.y, power, cannon });
  }

  setReady(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.ready = true;
  }

  // Punch: shove the nearest other player and, if they're carrying, knock their
  // tub loose — launched in the puncher's facing direction so both can scramble.
  // The Mallen uses the same action as its attack.
  punch(id, now) {
    const p = this.players.get(id);
    if (!p) return;
    if (now < p.stunnedUntilMs) return;              // stunned: can't act
    if (p.isMallen && now < p.eatingUntilMs) return; // mid-chomp
    let cd;
    if (p.isMallen) {
      cd = MALLEN.attackCooldownMs * this._mallenPow().attackCd;
      if (p.frenzyMs > 0) cd *= FRENZY.attackCdMult;
    } else {
      cd = PUNCH.cooldownMs;
    }
    if (now - p.lastAttackMs < cd) return;
    p.lastAttackMs = now;
    // id + facing (for the puncher's whiff poof) + cd (drives the cooldown clock)
    this.events.push({ type: 'attack', x: p.x, y: p.y, id: p.id, dx: p.dir.x, dy: p.dir.y, cd });

    // The Mallen lunges forward when he punches — an ANIMATED dash (velocity over
    // dashMs, applied in the movement loop), and we resolve the hit at where the
    // lunge will land so the dash actually extends his reach.
    let px = p.x, py = p.y;
    if (p.isMallen) {
      const dashDist = PUNCH.mallenDash * this._mallenPow().dash;
      const dashSpeed = dashDist / (PUNCH.dashMs / 1000);
      p.dashVx = p.dir.x * dashSpeed;
      p.dashVy = p.dir.y * dashSpeed;
      p.dashUntilMs = now + PUNCH.dashMs;
      px = p.x + p.dir.x * dashDist;
      py = p.y + p.dir.y * dashDist;
      this.events.push({ type: 'dash', x: p.x, y: p.y });
    }

    // The lunge sweeps from (p.x,p.y) to (px,py); hit everyone it plows through
    // (not just the endpoint), so a long Mallen dash bowls over the whole crowd.
    const range = p.isMallen ? MALLEN.attackRange : p.radius + PUNCH.reach;
    for (const o of this.players.values()) {
      if (o.id === p.id || o.effect === FX.INVINCIBLE) continue;
      if (segDist(o.x, o.y, p.x, p.y, px, py) >= range + o.radius) continue;

      this.events.push({ type: 'bam', x: o.x, y: o.y });   // comic BAM at impact
      o.x += p.dir.x * PUNCH.knockback;                     // shove in the punch direction
      o.y += p.dir.y * PUNCH.knockback;

      // knock their tub loose, launched the way you punched
      if (o.carryingTubId != null) {
        const t = this.tubs.find((t) => t.id === o.carryingTubId);
        if (t) {
          t.state = 'flying';
          t.carrierId = null;
          t.lastCarrierId = null;          // a punched-loose tub credits nobody if it lands
          t.vx = p.dir.x * PUNCH.launchSpeed;
          t.vy = p.dir.y * PUNCH.launchSpeed;
          t.thrownBy = o.id;               // the victim can't instantly re-catch it
          t.thrownGraceUntil = now + 400;
        }
        o.carryingTubId = null;
        o.hitsTaken = 0;
        this.events.push({ type: 'drop', x: o.x, y: o.y });
        this.events.push({ type: 'splat', x: o.x, y: o.y });
      }
    }
  }

  // ---- tub helpers --------------------------------------------------------
  _spawnTub(x, y, state = 'loose') {
    const t = {
      id: this._tubSeq++,
      x, y, vx: 0, vy: 0,
      state,                // loose | ready | carried | flying
      carrierId: null,
    };
    this.tubs.push(t);
    return t;
  }

  // Number of tubs currently sitting ready on the truck.
  _readyCount() {
    let n = 0;
    for (const t of this.tubs) if (t.state === 'ready') n++;
    return n;
  }

  // Position ready tubs in a visible row in front of (below) the truck, so they
  // never hide under the truck sprite — even when there's only one.
  _positionReadyTubs() {
    const ready = this.tubs.filter(t => t.state === 'ready');
    const { truck } = this.loci;
    const n = ready.length;
    const baseY = truck.y + LOCI.truckRadius + 20;
    const rowWidth = (n - 1) * LOCI.truckTubGap;
    ready.forEach((t, i) => {
      t.x = truck.x - rowWidth / 2 + i * LOCI.truckTubGap;
      t.y = baseY;
    });
  }

  // Place an initial ready tub on the truck (called at round start).
  _stockTruck() {
    this._spawnTub(this.loci.truck.x, this.loci.truck.y, 'ready');
    this._truckRefillQueue = [];
    this._positionReadyTubs();
  }

  // Schedule a replacement ready tub to appear truckRefillMs after a grab.
  _scheduleTruckRefill(nowMs) {
    if (!this._truckRefillQueue) this._truckRefillQueue = [];
    this._truckRefillQueue.push(nowMs + LOCI.truckRefillMs);
  }

  // Process due refills. Unlimited stock: each elapsed timer adds a ready tub.
  _processTruckRefills(now) {
    if (!this._truckRefillQueue || this._truckRefillQueue.length === 0) {
      // safety net: the truck should never be completely empty of ready tubs
      if (this.phase === PHASE.PLAYING && this._readyCount() === 0) {
        this._spawnTub(this.loci.truck.x, this.loci.truck.y, 'ready');
        this._positionReadyTubs();
      }
      return;
    }
    let spawned = false;
    this._truckRefillQueue = this._truckRefillQueue.filter(due => {
      if (now >= due) {
        this._spawnTub(this.loci.truck.x, this.loci.truck.y, 'ready');
        spawned = true;
        return false;
      }
      return true;
    });
    if (spawned) {
      this._positionReadyTubs();
      this.events.push({ type: 'restock', x: this.loci.truck.x, y: this.loci.truck.y });
    }
  }

  // ---- presents & effects -------------------------------------------------
  // Presents arrive proportionally to the player count: the interval is divided
  // by the number of players so each player sees ~the same present rate whether
  // it's a 2-player or a 12-player game.
  _scheduleNextPresent(now) {
    const span = PRESENT.spawnMaxMs - PRESENT.spawnMinMs;
    const base = PRESENT.spawnMinMs + this.rng() * span;
    this._nextPresentAt = now + base / (Math.max(1, this.players.size) * this.presentRate);
  }

  _spawnPresent(now) {
    // keep presents off the truck/fridge — a present landing on a solid locus can
    // never be reached (players get shoved out) and would sit there forever.
    const clearT = LOCI.truckRadius + PRESENT.radius + PLAYER.radius;
    const clearF = LOCI.fridgeRadius + PRESENT.radius + PLAYER.radius;
    let landX, landY;
    for (let i = 0; i < 24; i++) {
      landX = LOCI.edgePadding + this.rng() * (ARENA.width - 2 * LOCI.edgePadding);
      landY = LOCI.edgePadding + this.rng() * (ARENA.height - 2 * LOCI.edgePadding);
      if (dist(landX, landY, this.loci.truck.x, this.loci.truck.y) >= clearT &&
          dist(landX, landY, this.loci.fridge.x, this.loci.fridge.y) >= clearF) break;
    }
    this.presents.push({
      id: this._presentSeq++,
      x: landX, y: PRESENT.fallStartY, // starts above arena, drifts to landY
      landX, landY,
      fallMs: 0,                       // elapsed descent
      landed: false,
    });
    this.events.push({ type: 'presentDrop', x: landX, y: landY });
  }

  _updatePresents(dt, now) {
    if (this._nextPresentAt == null) this._scheduleNextPresent(now);
    // raise the on-field cap with player count + present rate so it never throttles
    // the faster spawn rate (presents get claimed quickly when there are many players).
    const cap = Math.min(16, Math.max(PRESENT.maxOnField,
      Math.ceil((this.players.size / 2) * this.presentRate)));
    if (now >= this._nextPresentAt && this.presents.length < cap) {
      this._spawnPresent(now);
      this._scheduleNextPresent(now);
    }
    for (const g of this.presents) {
      if (!g.landed) {
        g.fallMs += dt * 1000;
        const t = Math.min(1, g.fallMs / PRESENT.fallDurationMs);
        g.y = PRESENT.fallStartY + (g.landY - PRESENT.fallStartY) * t;
        g.x = g.landX;
        if (t >= 1) { g.landed = true; g.y = g.landY; }
      }
    }
    // claim check: first player to touch a LANDED present claims it
    for (const g of this.presents) {
      if (g._claimed || !g.landed) continue;
      for (const p of this.players.values()) {
        if (dist(p.x, p.y, g.x, g.y) < p.radius + PRESENT.radius) {
          g._claimed = true;
          this._applyPresent(p, now);
          this.events.push({ type: 'presentClaim', x: g.x, y: g.y, fx: p._lastFx,
                             id: p.id, buff: !DEBUFF_FX.has(p._lastFx) });
          break;
        }
      }
    }
    this.presents = this.presents.filter(g => !g._claimed);
  }

  _applyPresent(p, now) {
    const fx = this.forcedFx || rollEffect(p.isMallen, this.rng);
    p._lastFx = fx;
    if (ONE_SHOT.has(fx)) {
      this._applyOneShot(p, fx, now);
      return;
    }
    // duration effect: replace any current effect
    p.effect = fx;
    p.effectUntilMs = now + EFFECT.defaultDurationMs;
    if (fx === FX.CURD_CANNON) p.cannonArmed = true;
    if (fx === FX.TINY) p.radius = this._computeRadius(p);
    if (fx === FX.GREASED) p.greaseGrabMs = p.carryingTubId != null ? now : -1;
    if (fx === FX.DISC_GOLF) p.nextDiscAt = now; // start flinging discs right away
  }

  // Disc-golf buff: each holder periodically flings a spinning disc in a random
  // direction; a disc bonks any other player it flies through with a brief stun,
  // then keeps going. Discs vanish after their (randomized) lifespan.
  _updateDiscGolf(dt, now) {
    for (const p of this.players.values()) {
      if (p.effect !== FX.DISC_GOLF || now < (p.nextDiscAt || 0)) continue;
      const a = this.rng() * Math.PI * 2;
      const speed = DISC.minSpeed + this.rng() * (DISC.maxSpeed - DISC.minSpeed);
      const life = DISC.minLifeMs + this.rng() * (DISC.maxLifeMs - DISC.minLifeMs);
      this.discs.push({
        id: this._discSeq++, x: p.x, y: p.y,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        ownerId: p.id, expiresAt: now + life, hit: new Set(),
      });
      p.nextDiscAt = now + DISC.spawnIntervalMs;
    }
    for (const d of this.discs) {
      d.x += d.vx * dt; d.y += d.vy * dt;
      if (d.x < DISC.radius || d.x > ARENA.width - DISC.radius) d.vx = -d.vx;
      if (d.y < DISC.radius || d.y > ARENA.height - DISC.radius) d.vy = -d.vy;
      const cc = clampToArena(d.x, d.y, DISC.radius, ARENA); d.x = cc.x; d.y = cc.y;
      for (const p of this.players.values()) {
        if (p.id === d.ownerId || d.hit.has(p.id)) continue;
        if (dist(d.x, d.y, p.x, p.y) < DISC.radius + p.radius && this._stunPlayer(p, now, DISC.stunMs)) {
          d.hit.add(p.id);
          this.events.push({ type: 'discHit', x: p.x, y: p.y });
        }
      }
    }
    this.discs = this.discs.filter((d) => now < d.expiresAt);
  }

  _applyOneShot(p, fx, now) {
    if (fx === FX.EXPLOSION) {
      this.events.push({ type: 'explosion', x: p.x, y: p.y });
      for (const o of this.players.values()) {
        if (o.id === p.id) continue;
        const d = dist(p.x, p.y, o.x, o.y);
        if (d < EFFECT.explosionRadius) {
          const n = d === 0 ? { x: 1, y: 0 } : { x: (o.x - p.x) / d, y: (o.y - p.y) / d };
          // shove via direct position bump (no persistent velocity on players)
          o.x += n.x * EFFECT.explosionKnockback * 0.12;
          o.y += n.y * EFFECT.explosionKnockback * 0.12;
          // if the claimer is Mallen, victims also drop their tubs
          if (p.isMallen && o.carryingTubId != null) {
            const t = this.tubs.find(t => t.id === o.carryingTubId);
            if (t) { t.state = 'loose'; t.carrierId = null; }
            o.carryingTubId = null; o.hitsTaken = 0;
            o.noPickupUntilMs = now + 1200;
          }
        }
      }
    } else if (fx === FX.SWAP) {
      const others = [...this.players.values()].filter(o => o.id !== p.id);
      if (others.length) {
        const o = others[(this.rng() * others.length) | 0];
        const tx = p.x, ty = p.y;
        p.x = o.x; p.y = o.y; o.x = tx; o.y = ty;
        this.events.push({ type: 'swap', x: p.x, y: p.y });
      }
    } else if (fx === FX.PINATA) {
      for (let i = 0; i < EFFECT.pinataCount; i++) {
        const a = (i / EFFECT.pinataCount) * Math.PI * 2;
        const t = this._spawnTub(p.x + Math.cos(a) * 40, p.y + Math.sin(a) * 40, 'loose');
      }
      this.events.push({ type: 'pinata', x: p.x, y: p.y });
    } else if (fx === FX.INTERSTITIAL) {
      // forced ad break: freeze the claimer (the client shows a skippable
      // full-screen ad) and knock their tub loose like any other stun.
      this._stunPlayer(p, now, EFFECT.interstitialMs);
      p.adStunUntilMs = now + EFFECT.interstitialMs; // drives the above-head ad icon for others
    } else if (fx === FX.GOLDEN_CURD) {
      // instant point + a brief celebratory freeze (the client plays the big
      // zoom/kaleidoscope animation, visible to everyone, for the same duration)
      if (p.isMallen) p.eaten += 1; else p.score += 1;
      p.stunnedUntilMs = now + EFFECT.goldenCurdMs;
      p.vx = 0; p.vy = 0;
      p.charging = false;
    } else if (fx === FX.CORGI_ATTACK) {
      // spawn a hunter corgi that never attacks its owner (a buff for the spawner)
      this.corgis.push({
        id: this._corgiSeq++,
        x: p.x, y: p.y, vx: 0, vy: 0,
        ownerId: p.id,
        targetId: null,
        attacked: new Set(),
        expiresAt: now + CORGI.lifeMs,
        retargetAt: 0,
        dir: { x: p.dir.x, y: p.dir.y },
      });
      this.events.push({ type: 'corgiSpawn', x: p.x, y: p.y });
    } else if (fx === FX.DANCE_PARTY) {
      // become a dance-party HOST for the duration: the initiator is free to roam
      // (with lights + disco ball above their head), and each tick anyone within
      // radius — whether they were near at the start or wandered in / got rolled
      // over later — is forced to dance. Handled in _updateDanceParty.
      p.dancePartyHostUntilMs = now + DANCE.durationMs;
      this.events.push({ type: 'danceParty', x: p.x, y: p.y });
    } else if (fx === FX.PORTAL) {
      // Spawn a paired set of portals (one near the claimer, one elsewhere). The
      // claimer gets a brief teleport-cooldown so the near portal doesn't yank
      // them right back through it the moment it appears under their feet.
      this._spawnPortalPair(p, now);
      p.portalCooldownUntilMs = Math.max(p.portalCooldownUntilMs, now + PORTAL.teleportCooldownMs);
      this.events.push({ type: 'portal', x: p.x, y: p.y });
    } else if (fx === FX.NUKE) {
      // Arm a nuke: the claimer aims via the right joystick (client-only reticle)
      // and the LAUNCH commits a target. Track the arm via the effect so the HUD
      // can show it; expires if not launched within NUKE.armDurationMs.
      p.nukeArmed = true;
      p.effect = FX.NUKE;
      p.effectUntilMs = now + NUKE.armDurationMs;
    }
  }

  // Client commits a nuke launch. Validates state, clamps the target, latches
  // it into activeNukes for the countdown, freezes the launcher for the duration.
  launchNuke(id, nowMs, x, y) {
    const p = this.players.get(id);
    if (!p || !p.nukeArmed) return;
    if (nowMs < p.stunnedUntilMs) return;            // can't trigger while stunned
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    // clamp target to the arena (no nuking the void)
    const tx = this._clamp(x, 0, ARENA.width);
    const ty = this._clamp(y, 0, ARENA.height);
    this.activeNukes.push({
      id: this._nukeSeq++,
      launcherId: id,
      x: tx, y: ty,
      detonateAt: nowMs + NUKE.countdownMs,
    });
    // disarm the buff and freeze the launcher for the countdown
    p.nukeArmed = false;
    p.effect = null;
    p.effectUntilMs = 0;
    p.stunnedUntilMs = Math.max(p.stunnedUntilMs, nowMs + NUKE.countdownMs);
    p.vx = 0; p.vy = 0;
    p.charging = false; p.aim = null;
    // global SFX cue ("nuclear launch detected") + lets clients latch the red dot
    this.events.push({ type: 'nukeLaunch', x: tx, y: ty, id });
  }

  _updateNukes(now) {
    if (!this.activeNukes.length) return;
    const detonated = [];
    this.activeNukes = this.activeNukes.filter((n) => {
      if (now < n.detonateAt) return true;
      detonated.push(n); return false;
    });
    for (const n of detonated) this._applyNukeBlast(n, now);
  }

  // Blow up at (n.x, n.y): everything inside NUKE.blastRadius gets a randomized
  // outward shove. Players and their carried tubs get knocked loose; loose /
  // flying tubs, corgis, and discs all gain outward velocity too.
  _applyNukeBlast(n, now) {
    const cx = n.x, cy = n.y;
    const R = NUKE.blastRadius;
    const dir = (ox, oy) => {
      const dx = ox - cx, dy = oy - cy;
      const m = Math.hypot(dx, dy) || 1;
      // jitter the angle a little so the cloud reads as chaotic, not a starburst
      const baseA = Math.atan2(dy, dx);
      const a = baseA + (this.rng() * 2 - 1) * NUKE.flingAngleNoise;
      return { x: Math.cos(a), y: Math.sin(a) };
    };
    const speedIn = (mn, mx) => mn + this.rng() * (mx - mn);

    for (const p of this.players.values()) {
      if (p.effect === FX.INVINCIBLE) continue;          // invincible shrugs it off
      const d = dist(p.x, p.y, cx, cy);
      if (d > R) continue;
      // drop carried tub AND send it flying with the blast
      if (p.carryingTubId != null) {
        const t = this.tubs.find((t) => t.id === p.carryingTubId);
        if (t) {
          const v = dir(t.x, t.y);
          const sp = speedIn(NUKE.tubFlingMinSpeed, NUKE.tubFlingMaxSpeed);
          t.state = 'flying'; t.carrierId = null;
          t.vx = v.x * sp; t.vy = v.y * sp;
          t.thrownBy = null; t.thrownGraceUntil = 0;
        }
        p.carryingTubId = null;
        p.hitsTaken = 0;
        p.noPickupUntilMs = now + 600;
      }
      // launch the player outward using the dash override (cleanest way to
      // override their input + carry them through the air for ~a second)
      const v = dir(p.x, p.y);
      const sp = speedIn(NUKE.playerFlingMinSpeed, NUKE.playerFlingMaxSpeed);
      p.dashVx = v.x * sp; p.dashVy = v.y * sp;
      p.dashUntilMs = Math.max(p.dashUntilMs, now + NUKE.playerFlingMs);
      p.charging = false; p.aim = null;
      this.events.push({ type: 'drop', x: p.x, y: p.y });
    }

    for (const t of this.tubs) {
      if (t.state === 'carried') continue;                // already handled via carrier above
      if (dist(t.x, t.y, cx, cy) > R) continue;
      const v = dir(t.x, t.y);
      const sp = speedIn(NUKE.tubFlingMinSpeed, NUKE.tubFlingMaxSpeed);
      t.state = 'flying';
      t.vx = v.x * sp; t.vy = v.y * sp;
      t.thrownBy = null; t.thrownGraceUntil = 0;
    }
    for (const c of this.corgis) {
      if (dist(c.x, c.y, cx, cy) > R) continue;
      const v = dir(c.x, c.y);
      const sp = speedIn(NUKE.playerFlingMinSpeed, NUKE.playerFlingMaxSpeed);
      c.vx = v.x * sp; c.vy = v.y * sp;
    }
    for (const d of this.discs) {
      if (dist(d.x, d.y, cx, cy) > R) continue;
      const v = dir(d.x, d.y);
      const sp = speedIn(NUKE.tubFlingMinSpeed, NUKE.tubFlingMaxSpeed);
      d.vx = v.x * sp; d.vy = v.y * sp;
    }

    this.events.push({ type: 'nukeDetonate', x: cx, y: cy });
  }

  // Spawn a matched portal pair: one (color A) about PORTAL.nearOffset px from
  // the claimer at a random angle, the other (color B) at a random arena point.
  // Both share a pairId; teleporting from one drops you at the other.
  _spawnPortalPair(p, now) {
    const expiresAt = now + PORTAL.durationMs;
    const pairId = this._portalSeq++;
    // randomize which color spawns near the player
    const nearColor = this.rng() < 0.5 ? 'orange' : 'blue';
    const farColor  = nearColor === 'orange' ? 'blue' : 'orange';

    // near portal: try a few random angles to find a spot clear of truck/fridge
    let nearPos = null;
    for (let tries = 0; tries < 12; tries++) {
      const a = this.rng() * Math.PI * 2;
      const x = p.x + Math.cos(a) * PORTAL.nearOffset;
      const y = p.y + Math.sin(a) * PORTAL.nearOffset;
      if (!this._portalSpotOK(x, y)) continue;
      nearPos = { x, y }; break;
    }
    if (!nearPos) nearPos = { x: this._clamp(p.x + 60, PORTAL.arenaMargin, ARENA.width - PORTAL.arenaMargin),
                              y: this._clamp(p.y + 60, PORTAL.arenaMargin, ARENA.height - PORTAL.arenaMargin) };

    // far portal: random arena point at least minPairDistance away
    let farPos = null;
    for (let tries = 0; tries < 40; tries++) {
      const x = PORTAL.arenaMargin + this.rng() * (ARENA.width  - 2 * PORTAL.arenaMargin);
      const y = PORTAL.arenaMargin + this.rng() * (ARENA.height - 2 * PORTAL.arenaMargin);
      if (!this._portalSpotOK(x, y)) continue;
      if (dist(x, y, nearPos.x, nearPos.y) < PORTAL.minPairDistance) continue;
      farPos = { x, y }; break;
    }
    if (!farPos) farPos = { x: ARENA.width - nearPos.x, y: ARENA.height - nearPos.y };

    this.portals.push({ id: this._portalSeq++, pairId, color: nearColor,
                        x: nearPos.x, y: nearPos.y, expiresAt });
    this.portals.push({ id: this._portalSeq++, pairId, color: farColor,
                        x: farPos.x,  y: farPos.y,  expiresAt });
  }

  _portalSpotOK(x, y) {
    if (x < PORTAL.arenaMargin || x > ARENA.width  - PORTAL.arenaMargin) return false;
    if (y < PORTAL.arenaMargin || y > ARENA.height - PORTAL.arenaMargin) return false;
    if (dist(x, y, this.loci.truck.x,  this.loci.truck.y)  < PORTAL.lociClear) return false;
    if (dist(x, y, this.loci.fridge.x, this.loci.fridge.y) < PORTAL.lociClear) return false;
    return true;
  }

  _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Each tick: expire portals, then for every player / tub / corgi / disc that
  // touches a portal, snap it to the paired portal and carry its velocity over.
  _updatePortals(now) {
    // expire pairs together so you don't end up with a one-sided portal
    if (this.portals.length) {
      const livePairs = new Set();
      for (const pr of this.portals) if (now < pr.expiresAt) livePairs.add(pr.pairId);
      this.portals = this.portals.filter((pr) => livePairs.has(pr.pairId) && now < pr.expiresAt);
    }
    if (!this.portals.length) return;
    const byPair = new Map();
    for (const pr of this.portals) {
      if (!byPair.has(pr.pairId)) byPair.set(pr.pairId, []);
      byPair.get(pr.pairId).push(pr);
    }
    const pairFor = (pr) => {
      const pair = byPair.get(pr.pairId);
      return pair && pair.find((o) => o.id !== pr.id);
    };

    // players
    for (const p of this.players.values()) {
      if (now < p.portalCooldownUntilMs) continue;
      for (const pr of this.portals) {
        if (dist(p.x, p.y, pr.x, pr.y) > PORTAL.radius) continue;
        const pair = pairFor(pr);
        if (!pair) break;
        // place them on the OUT side of the destination portal (their motion
        // direction) so they don't immediately re-trigger the entry portal.
        const m = Math.hypot(p.vx || 0, p.vy || 0);
        const ox = m > 1 ? (p.vx / m) * (PORTAL.radius + 12) : 0;
        const oy = m > 1 ? (p.vy / m) * (PORTAL.radius + 12) : 0;
        p.x = pair.x + ox; p.y = pair.y + oy;
        const c = clampToArena(p.x, p.y, p.radius, ARENA);
        p.x = c.x; p.y = c.y;
        p.portalCooldownUntilMs = now + PORTAL.teleportCooldownMs;
        this.events.push({ type: 'portalEnter', x: pr.x, y: pr.y, id: p.id });
        break;
      }
    }

    // anything else with momentum that should keep its trajectory through the
    // portal: tubs (loose / flying / ready), corgis, discs.
    const teleportObj = (obj) => {
      for (const pr of this.portals) {
        if (dist(obj.x, obj.y, pr.x, pr.y) > PORTAL.radius) continue;
        if (obj._portalCooldownUntil && now < obj._portalCooldownUntil) continue;
        const pair = pairFor(pr);
        if (!pair) return false;
        const m = Math.hypot(obj.vx || 0, obj.vy || 0);
        const ox = m > 1 ? (obj.vx / m) * (PORTAL.radius + 12) : 0;
        const oy = m > 1 ? (obj.vy / m) * (PORTAL.radius + 12) : 0;
        obj.x = pair.x + ox; obj.y = pair.y + oy;
        obj._portalCooldownUntil = now + PORTAL.teleportCooldownMs;
        return true;
      }
      return false;
    };
    for (const t of this.tubs) if (t.state !== 'carried') teleportObj(t);
    for (const c of this.corgis) teleportObj(c);
    for (const d of this.discs)  teleportObj(d);
  }

  // Continuous dance-party aura: each active host forces every eligible player
  // currently within radius to dance (a stun — drops their tub). Refreshed each
  // tick, so dancers stop shortly after they leave the floor (or the host stops).
  _updateDanceParty(now) {
    for (const h of this.players.values()) {
      if (now >= h.dancePartyHostUntilMs) continue;
      for (const o of this.players.values()) {
        if (o.id === h.id || o.effect === FX.INVINCIBLE) continue;
        if (dist(h.x, h.y, o.x, o.y) > DANCE.radius) continue;
        this._stunPlayer(o, now, DANCE.refreshMs); // stun + drop tub (first catch only)
        o.danceUntilMs = now + DANCE.refreshMs;
      }
    }
  }

  // Freeze one player for durMs (drop their tub too). Invincible players resist.
  // Returns true if the player was actually stunned.
  _stunPlayer(p, now, durMs) {
    if (p.effect === FX.INVINCIBLE) return false;
    p.stunnedUntilMs = now + durMs;
    p.vx = 0; p.vy = 0;
    p.charging = false;
    p.aim = null;                              // a cancelled charge can't aim anything
    if (p.carryingTubId != null) {
      const t = this.tubs.find((t) => t.id === p.carryingTubId);
      if (t) { t.state = 'loose'; t.carrierId = null; }
      p.carryingTubId = null;
      p.hitsTaken = 0;
      p.noPickupUntilMs = now + durMs;
      this.events.push({ type: 'drop', x: p.x, y: p.y });
    }
    return true;
  }

  // The CORGI_ATTACK hunters: wander fast, charge any eligible player in range,
  // run through them with a stun, then pick a new victim. Never the owner, never
  // the same person twice. They vanish when their lifespan ends.
  _updateCorgis(dt, now) {
    for (const c of this.corgis) {
      let target = c.targetId != null ? this.players.get(c.targetId) : null;
      if (target && target.effect === FX.INVINCIBLE) { target = null; c.targetId = null; }
      if (!target) {
        let best = null, bestD = Infinity;
        for (const p of this.players.values()) {
          if (p.id === c.ownerId || c.attacked.has(p.id) || p.effect === FX.INVINCIBLE) continue;
          const d = dist(c.x, c.y, p.x, p.y);
          if (d < CORGI.detectRadius && d < bestD) { best = p; bestD = d; }
        }
        if (best) { c.targetId = best.id; target = best; }
      }
      if (target) {
        const dx = target.x - c.x, dy = target.y - c.y;
        const m = Math.hypot(dx, dy) || 1;
        c.vx = (dx / m) * CORGI.chargeSpeed;
        c.vy = (dy / m) * CORGI.chargeSpeed;
      } else if (now >= c.retargetAt) {
        const a = this.rng() * Math.PI * 2;
        c.vx = Math.cos(a) * CORGI.speed;
        c.vy = Math.sin(a) * CORGI.speed;
        c.retargetAt = now + CORGI.wanderRetargetMs * (0.6 + this.rng() * 0.8);
      }
      c.x += c.vx * dt; c.y += c.vy * dt;
      if (c.vx || c.vy) c.dir = normalize(c.vx, c.vy);
      if (c.x < CORGI.radius || c.x > ARENA.width - CORGI.radius) { c.vx = -c.vx; c.retargetAt = 0; }
      if (c.y < CORGI.radius || c.y > ARENA.height - CORGI.radius) { c.vy = -c.vy; c.retargetAt = 0; }
      const cc = clampToArena(c.x, c.y, CORGI.radius, ARENA); c.x = cc.x; c.y = cc.y;
      // contact: run through the victim, stun them, and never hit them again
      if (target && dist(c.x, c.y, target.x, target.y) < CORGI.touchRadius + target.radius) {
        this._stunPlayer(target, now, CORGI.stunMs);
        c.attacked.add(target.id);
        c.targetId = null;
        c.retargetAt = 0;
        this.events.push({ type: 'corgiHit', x: target.x, y: target.y });
      }
    }
    this.corgis = this.corgis.filter((c) => {
      if (now >= c.expiresAt) { this.events.push({ type: 'corgiGone', x: c.x, y: c.y }); return false; }
      return true;
    });
  }

  _tickEffects(now) {
    for (const p of this.players.values()) {
      if (!p.effect) continue;
      // greased: drop carried tub ~1s after grabbing
      if (p.effect === FX.GREASED && p.carryingTubId != null && p.greaseGrabMs >= 0 &&
          now - p.greaseGrabMs > 1000) {
        const t = this.tubs.find(t => t.id === p.carryingTubId);
        if (t) { t.state = 'loose'; t.carrierId = null; }
        p.carryingTubId = null;
        p.greaseGrabMs = -1;
        p.noPickupUntilMs = now + 1200;
        this.events.push({ type: 'drop', x: p.x, y: p.y });
      }
      if (now >= p.effectUntilMs) this._clearEffect(p);
    }
  }

  _clearEffect(p) {
    const had = p.effect;
    p.effect = null;
    p.effectUntilMs = 0;
    p.cannonArmed = false;
    if (had === FX.TINY) p.radius = p.isMallen ? MALLEN.radius : PLAYER.radius;
    if (had === FX.NUKE) p.nukeArmed = false;          // unused nuke just fizzles
  }

  _applyMagnets(dt) {
    const now = this._clock || 0;
    for (const p of this.players.values()) {
      if (p.effect !== FX.MAGNET) continue;
      for (const t of this.tubs) {
        // rip a tub out of another player's hands if they're inside the pull range
        // (invincible players are immune, matching the rest of the game)
        if (t.state === 'carried' && t.carrierId !== p.id) {
          const o = this.players.get(t.carrierId);
          if (o && o.effect !== FX.INVINCIBLE && dist(p.x, p.y, o.x, o.y) < EFFECT.magnetRadius) {
            t.state = 'loose'; t.carrierId = null;
            t.x = o.x; t.y = o.y;
            o.carryingTubId = null;
            // brief grace so the victim doesn't instantly snatch it back as it flies off
            o.noPickupUntilMs = Math.max(o.noPickupUntilMs || 0, now + 400);
            this.events.push({ type: 'drop', x: o.x, y: o.y });
          }
        }
        if (t.state !== 'loose' && t.state !== 'ready') continue;
        const d = dist(p.x, p.y, t.x, t.y);
        if (d > 0 && d < EFFECT.magnetRadius) {
          const n = { x: (p.x - t.x) / d, y: (p.y - t.y) / d };
          t.x += n.x * EFFECT.magnetPull * dt;
          t.y += n.y * EFFECT.magnetPull * dt;
          if (t.state === 'ready') {
            // pulled off the truck — refill on the normal 1s timer (not the
            // instant safety-net respawn), so the magnet can't spawn infinite tubs
            t.state = 'loose';
            this._scheduleTruckRefill(now);
          }
        }
      }
    }
  }

  // ---- main tick ----------------------------------------------------------
  tick(dtMs) {
    const dt = dtMs / 1000;
    const now = (this._clock = (this._clock || 0) + dtMs);

    if (this.phase === PHASE.COUNTDOWN) {
      this.countdownMs -= dtMs;
      if (this.countdownMs <= 0) this.phase = PHASE.PLAYING;
    }

    // movement (all phases let you wander, but scoring only in PLAYING)
    for (const p of this.players.values()) {
      const speed = this._effectiveSpeed(p);
      // locked = mallen mid-chomp, or anyone stunned by a Mallen devour
      const locked = (p.isMallen && now < p.eatingUntilMs) || now < p.stunnedUntilMs;
      if (locked) {
        p.vx = 0; p.vy = 0;          // frozen: no coasting through a stun
      } else if (now < p.dashUntilMs) {
        p.vx = p.dashVx; p.vy = p.dashVy;  // Mallen lunge overrides input
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      } else {
        const tvx = p.moveInput.x * speed, tvy = p.moveInput.y * speed;
        if (p.effect === FX.BANANA) {
          // 'slidey': ease velocity toward input, and coast to a stop on release
          const k = Math.min(1, EFFECT.bananaAccel * dt);
          p.vx += (tvx - p.vx) * k;
          p.vy += (tvy - p.vy) * k;
        } else {
          p.vx = tvx; p.vy = tvy;  // normal: instant (kept in sync for a clean handoff into slidey)
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      const c = clampToArena(p.x, p.y, p.radius, ARENA);
      p.x = c.x; p.y = c.y;
      if (p.isMallen && p.frenzyMs > 0) p.frenzyMs -= dtMs;
      // radius is a single computed value (avoids frenzy/tiny fighting over it)
      p.radius = this._computeRadius(p);
    }

    this._resolveCollisions();
    this._updateTubs(dt, now);
    this._tickEffects(now);

    if (this.phase === PHASE.PLAYING) {
      this._processTruckRefills(now);
      this._autoPickup(now);
      this._updatePresents(dt, now);
      this._applyMagnets(dt);
      this._mallenLogic(now);
      this._updateCorgis(dt, now);
      this._updateDiscGolf(dt, now);
      this._updateDanceParty(now);
      this._updatePortals(now);
      this._updateNukes(now);
      this._checkCarriedDeliveries();
      this._capTubs();
      this._checkDominating();
      this._checkRoundEnd();
    }
  }

  _effectiveSpeed(p) {
    let base;
    if (p.isMallen) {
      base = MALLEN.speed * this._mallenPow().speed;
      if (p.frenzyMs > 0) base *= FRENZY.speedMult;
    } else {
      base = PLAYER.speed;
    }
    if (p.effect === FX.DOUBLE_SPEED) base *= EFFECT.doubleSpeedMult;
    else if (p.effect === FX.HALF_SPEED) base *= EFFECT.halfSpeedMult;
    else if (p.effect === FX.BANANA) base *= EFFECT.bananaSpeedMult;   // slidey is fast AND uncontrollable
    return base;
  }

  // Single source of truth for a player's radius. Combines base size, frenzy
  // growth, and the Tiny debuff so these systems can't stomp each other.
  _computeRadius(p) {
    let r = p.isMallen ? MALLEN.radius : PLAYER.radius;
    if (p.effect === FX.TINY) r *= EFFECT.tinyMult;
    if (p.isMallen && p.frenzyMs > 0) r *= FRENZY.sizeMult;
    return r;
  }

  _resolveCollisions() {
    const arr = [...this.players.values()];
    // player-player (chaos!)
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        const fix = resolveCircleOverlap(a, a.radius, b, b.radius);
        if (!fix) continue;
        a.x = fix.a.x; a.y = fix.a.y; b.x = fix.b.x; b.y = fix.b.y;
        // running into someone shoves them: each mover nudges the other along
        // the contact normal, scaled by how hard they're moving into them.
        const nx = b.x - a.x, ny = b.y - a.y;
        const len = Math.hypot(nx, ny) || 1;
        const ux = nx / len, uy = ny / len;
        const aMove = Math.hypot(a.moveInput.x, a.moveInput.y);
        const bMove = Math.hypot(b.moveInput.x, b.moveInput.y);
        b.x += ux * COLLISION.shove * aMove; b.y += uy * COLLISION.shove * aMove;
        a.x -= ux * COLLISION.shove * bMove; a.y -= uy * COLLISION.shove * bMove;
      }
    }
    // player vs loci (solid obstacles)
    for (const p of arr) {
      this._pushOutOf(p, this.loci.truck, LOCI.truckRadius);
      this._pushOutOf(p, this.loci.fridge, LOCI.fridgeRadius);
      if (p.isMallen) this._pushMallenOutOfZone(p); // no camping the truck
      const c = clampToArena(p.x, p.y, p.radius, ARENA);
      p.x = c.x; p.y = c.y;
    }
  }

  // The no-Mallen pickup rectangle around the truck (top-left x/y + w/h).
  _computeSafeZone() {
    const t = this.loci.truck;
    this.safeZone = {
      x: t.x - SAFE_ZONE.halfW,
      y: t.y + SAFE_ZONE.offsetY - SAFE_ZONE.halfH,
      w: SAFE_ZONE.halfW * 2,
      h: SAFE_ZONE.halfH * 2,
    };
  }

  // Push the Mallen to the nearest edge if it's inside the pickup zone.
  _pushMallenOutOfZone(m) {
    const z = this.safeZone;
    const left = z.x - m.radius, right = z.x + z.w + m.radius;
    const top = z.y - m.radius, bottom = z.y + z.h + m.radius;
    if (m.x <= left || m.x >= right || m.y <= top || m.y >= bottom) return;
    const dl = m.x - left, dr = right - m.x, dt = m.y - top, db = bottom - m.y;
    const min = Math.min(dl, dr, dt, db);
    if (min === dl) m.x = left;
    else if (min === dr) m.x = right;
    else if (min === dt) m.y = top;
    else m.y = bottom;
  }

  _pushOutOf(p, center, r) {
    const d = dist(p.x, p.y, center.x, center.y);
    const minD = p.radius + r;
    if (d < minD) {
      let nx, ny;
      if (d === 0) { nx = 1; ny = 0; }        // coincident: pick an arbitrary axis
      else { nx = (p.x - center.x) / d; ny = (p.y - center.y) / d; }
      p.x = center.x + nx * minD;
      p.y = center.y + ny * minD;
    }
  }

  _updateTubs(dt, now) {
    for (const t of this.tubs) {
      if (t.state === 'carried') {
        const carrier = this.players.get(t.carrierId);
        if (carrier) {
          t.x = carrier.x + carrier.dir.x * PLAYER.carryOffset;
          t.y = carrier.y + carrier.dir.y * PLAYER.carryOffset;
        } else {
          t.state = 'loose'; t.carrierId = null;
        }
      } else if (t.state === 'flying') {
        const ox = t.x, oy = t.y;       // remember the start of this step (for segment scoring)
        t.x += t.vx * dt;
        t.y += t.vy * dt;
        t.vx *= TUB.friction;
        t.vy *= TUB.friction;

        // tub hits a player: an empty-handed delivery player CATCHES it; anyone
        // else (carrying, or the Mallen) gets bumped in the tub's travel direction.
        let caught = false;
        for (const p of this.players.values()) {
          if (dist(t.x, t.y, p.x, p.y) >= p.radius + TUB.radius) continue;
          if (t.thrownBy === p.id && now < (t.thrownGraceUntil || 0)) continue; // ignore thrower briefly
          const canCatch = !p.isMallen && p.carryingTubId == null && now >= p.noPickupUntilMs;
          if (canCatch) {
            t.state = 'carried';
            t.carrierId = p.id;
            t.lastCarrierId = p.id;
            p.carryingTubId = t.id;
            if (p.effect === FX.GREASED) p.greaseGrabMs = now;
            this.events.push({ type: 'pickup', x: p.x, y: p.y });
            caught = true;
            break;
          }
          const sp = Math.hypot(t.vx, t.vy) || 1;
          p.x += (t.vx / sp) * TUB.bump;
          p.y += (t.vy / sp) * TUB.bump;
          this.events.push({ type: 'splat', x: t.x, y: t.y });
          t.vx *= -0.3; t.vy *= -0.3;
        }
        if (caught) continue;

        // score if the tub's flight path this step passed within the fridge zone.
        // Using the whole segment (not just the endpoint) means fast cannon throws
        // can't tunnel straight past the fridge between ticks.
        const f = this.loci.fridge;
        const abx = t.x - ox, aby = t.y - oy;
        const len2 = abx * abx + aby * aby;
        let u = len2 > 0 ? ((f.x - ox) * abx + (f.y - oy) * aby) / len2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const cx = ox + abx * u, cy = oy + aby * u;
        if (Math.hypot(f.x - cx, f.y - cy) < LOCI.scoreRadius) {
          this._scoreDelivery(t, true);                            // thrown delivery
          t._dead = true;
          continue;
        }
        // bounce off arena edges
        if (t.x < TUB.radius || t.x > ARENA.width - TUB.radius) t.vx *= -0.5;
        if (t.y < TUB.radius || t.y > ARENA.height - TUB.radius) t.vy *= -0.5;
        const c = clampToArena(t.x, t.y, TUB.radius, ARENA);
        t.x = c.x; t.y = c.y;

        if (Math.hypot(t.vx, t.vy) < TUB.minSlideSpeed) {
          t.state = 'loose'; t.vx = 0; t.vy = 0;
          if (this.rng() < 0.5) this.events.push({ type: 'splat', x: t.x, y: t.y }); // leaves a mess where it lands
        }
      }
    }
    this.tubs = this.tubs.filter(t => !t._dead);
  }

  // Walking a carried tub up to the fridge delivers it (throwing is optional).
  _checkCarriedDeliveries() {
    const f = this.loci.fridge;
    let scored = false;
    for (const p of this.players.values()) {
      if (p.isMallen || p.carryingTubId == null) continue;
      if (dist(p.x, p.y, f.x, f.y) < LOCI.fridgeRadius + p.radius + 8) {
        const t = this.tubs.find((t) => t.id === p.carryingTubId);
        p.carryingTubId = null;
        if (t) { t._dead = true; this._scoreDelivery(t); scored = true; }
      }
    }
    if (scored) this.tubs = this.tubs.filter((t) => !t._dead);
  }

  _scoreDelivery(tub, thrown) {
    // credit the last carrier if we tracked one; else nobody (still counts as gone)
    const scorer = tub.lastCarrierId != null ? this.players.get(tub.lastCarrierId) : null;
    if (scorer) {
      const pts = scorer.effect === FX.TWO_X_POINTS ? 2 : 1;
      scorer.score += pts;
    }
    this.events.push({ type: 'score', x: this.loci.fridge.x, y: this.loci.fridge.y,
                       thrown: !!thrown,                       // client picks SFX off this
                       name: scorer ? scorer.name : null, id: scorer ? scorer.id : null });
    this._maybeFirstCurd();
  }

  // Mallen devour shockwave: stun every nearby delivery player (freeze + drop
  // their tub) for a couple seconds. Invincible players resist.
  _stunNearby(m, now) {
    const pw = this._mallenPow();
    const radius = STUN.radius * pw.stunRadius;
    const durMs = STUN.durationMs * pw.stunDur;
    let hit = false;
    for (const p of this.players.values()) {
      if (p.isMallen) continue;
      if (dist(m.x, m.y, p.x, p.y) > radius) continue;
      if (this._stunPlayer(p, now, durMs)) hit = true; // skips invincible
    }
    if (hit) this.events.push({ type: 'stun', x: m.x, y: m.y });
  }

  // The Mallen attacks via the same PUNCH action as everyone (see punch()); this
  // only handles auto-devouring loose tubs it walks over.
  _mallenLogic(now) {
    const m = this.players.get(this.mallenId);
    if (!m) return;
    if (now < m.eatingUntilMs) return; // mid-chomp

    // devour a loose tub within reach
    for (const t of this.tubs) {
      if (t.state !== 'loose') continue;
      if (dist(m.x, m.y, t.x, t.y) < MALLEN.eatRange) {
        t._dead = true;
        m.eaten += (m.effect === FX.TWO_X_POINTS ? 2 : 1);
        m.eatingUntilMs = now + MALLEN.eatDurationMs;
        m.frenzyMs = FRENZY.durationMs;
        m.radius = this._computeRadius(m); // reflect frenzy growth immediately
        this.events.push({ type: 'chomp', x: m.x, y: m.y, id: m.id });
        this._maybeFirstCurd();
        this._stunNearby(m, now);
        break;
      }
    }
    this.tubs = this.tubs.filter(t => !t._dead);
  }

  _checkRoundEnd() {
    let winner = null;
    for (const p of this.players.values()) {
      if (!p.isMallen && p.score >= ROUND.pointsToWin) {
        winner = { type: 'player', name: p.name }; break;
      }
    }
    const m = this.players.get(this.mallenId);
    if (!winner && m && m.eaten >= ROUND.mallenEatsToWin) {
      winner = { type: 'mallen', name: m.name };
    }
    if (winner) {
      this.roundWinner = winner;
      this.phase = PHASE.LEADERBOARD;
      this.events.push({ type: 'roundEnd', winner });
      for (const p of this.players.values()) p.ready = false;
    }
  }

  // Called by server when enough players press LET'S GO.
  readyFractionMet() {
    if (this.players.size === 0) return false;
    let ready = 0;
    for (const p of this.players.values()) if (p.ready) ready++;
    return ready / this.players.size >= ROUND.readyFraction;
  }

  // Safety valve against unbounded tub growth (piñatas, misses, fast present rate
  // with many players): cull the oldest LOOSE tubs past a generous cap. Active
  // tubs (ready/carried/flying) are never culled.
  _capTubs() {
    const MAX_LOOSE = 24;
    const loose = this.tubs.filter(t => t.state === 'loose');
    if (loose.length <= MAX_LOOSE) return;
    const cull = new Set(loose.sort((a, b) => a.id - b.id)
      .slice(0, loose.length - MAX_LOOSE).map(t => t.id));
    this.tubs = this.tubs.filter(t => !cull.has(t.id));
  }

  startRound() {
    this.roundNumber += 1;
    this._firstScored = false;
    this.loci = placeLoci(ARENA, LOCI, this.rng);
    this._computeSafeZone();
    this.tubs = [];
    this._dominating = false;
    this.roundWinner = null;
    for (const p of this.players.values()) {
      const s = randSpawn(ARENA, LOCI.edgePadding, this.rng);
      p.x = s.x; p.y = s.y;
      p.score = 0; p.eaten = 0; p.hitsTaken = 0;
      p.carryingTubId = null; p.charging = false;
      p.frenzyMs = 0; p.eatingUntilMs = 0; p.lastAttackMs = -1e9;
      p.radius = p.isMallen ? MALLEN.radius : PLAYER.radius;
      p.ready = false;
      p.effect = null; p.effectUntilMs = 0; p.cannonArmed = false; p.greaseGrabMs = -1;
      p.noPickupUntilMs = 0; p.stunnedUntilMs = 0; p.adStunUntilMs = 0; p.vx = 0; p.vy = 0;
      p.danceUntilMs = 0; p.dancePartyHostUntilMs = 0;
      p.dashUntilMs = 0; p.dashVx = 0; p.dashVy = 0;
      p.portalCooldownUntilMs = 0;
      p.nukeArmed = false;
    }
    this.phase = PHASE.COUNTDOWN;
    this.countdownMs = ROUND.startCountdownMs;
    this._clock = 0;
    this._truckRefillQueue = [];
    this.presents = [];
    this.corgis = [];
    this.discs = [];
    this.portals = [];
    this.activeNukes = [];
    this._nextPresentAt = null;
    this._stockTruck();
    this.events.push({ type: 'roundStart', n: this.roundNumber });
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // Serializable snapshot for clients.
  snapshot() {
    return {
      phase: this.phase,
      round: this.roundNumber,
      countdownMs: Math.max(0, Math.round(this.countdownMs)),
      arena: { width: ARENA.width, height: ARENA.height },
      loci: this.loci,
      safeZone: this.safeZone,
      roundWinner: this.roundWinner,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y),
        dir: p.dir, isMallen: p.isMallen, radius: Math.round(p.radius),
        score: p.score, eaten: p.eaten, carrying: p.carryingTubId != null,
        charging: p.charging, aim: p.charging ? p.aim : null,
        nukeArmed: !!p.nukeArmed,
        // when this player launched a nuke that's still counting down, expose
        // its target + countdown so other clients can render the laser line +
        // the "hold still" indicator above their head, and skip stun visuals.
        nukeLaunching: this.activeNukes.some(n => n.launcherId === p.id),
        nukeAim: (() => { const n = this.activeNukes.find(x => x.launcherId === p.id);
                          return n ? { x: n.x, y: n.y } : null; })(),
        nukeMs: (() => { const n = this.activeNukes.find(x => x.launcherId === p.id);
                         return n ? Math.max(0, Math.round(n.detonateAt - (this._clock || 0))) : 0; })(),
        frenzy: p.frenzyMs > 0, ready: !!p.ready,
        stunned: (this._clock || 0) < p.stunnedUntilMs,
        adStunned: (this._clock || 0) < p.adStunUntilMs,
        dancing: (this._clock || 0) < p.danceUntilMs, // stunned dancers (bob/sway)
        // host OR dancer: gets the lights, hovering disco ball, and the music
        danceParty: (this._clock || 0) < p.danceUntilMs || (this._clock || 0) < p.dancePartyHostUntilMs,
        dashing: (this._clock || 0) < p.dashUntilMs,
        spriteIndex: p.spriteIndex,
        vestHue: p.vestHue, pantsHue: p.pantsHue, mallenHue: p.mallenHue,
        effect: p.effect,
        effectMs: p.effect ? Math.max(0, Math.round(p.effectUntilMs - (this._clock || 0))) : 0,
      })),
      tubs: this.tubs.map(t => ({
        id: t.id, x: Math.round(t.x), y: Math.round(t.y), state: t.state,
      })),
      presents: this.presents.map(g => ({
        id: g.id, x: Math.round(g.x), y: Math.round(g.y), landed: g.landed,
      })),
      corgis: this.corgis.map(c => ({
        id: c.id, x: Math.round(c.x), y: Math.round(c.y), dir: c.dir,
      })),
      discs: this.discs.map(d => ({ id: d.id, x: Math.round(d.x), y: Math.round(d.y) })),
      portals: this.portals.map(pr => ({
        id: pr.id, x: Math.round(pr.x), y: Math.round(pr.y), color: pr.color,
        msRemaining: Math.max(0, Math.round(pr.expiresAt - (this._clock || 0))),
      })),
      nukes: this.activeNukes.map(n => ({
        id: n.id, x: Math.round(n.x), y: Math.round(n.y),
        msUntilDetonate: Math.max(0, Math.round(n.detonateAt - (this._clock || 0))),
      })),
    };
  }
}
