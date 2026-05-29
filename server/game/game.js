// Authoritative game simulation. No networking, no real timers — everything is
// driven by tick(dtMs) and input methods so it is fully unit-testable.
//
// The Game owns all truth: players, tubs, loci, scores, phase, frenzy. The
// server wraps this with a WebSocket layer and a setInterval calling tick().

import {
  ARENA, PLAYER, MALLEN, FRENZY, TUB, THROW, LOCI, ROUND, PHASE, MSG,
  PRESENT, EFFECT, FX, ONE_SHOT, PUNCH, COLLISION, SAFE_ZONE, STUN, DEBUFF_POOL,
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
  }

  // Admin/testing: force every claimed present to roll a specific effect, or pass
  // a falsy/'random'/invalid value to restore normal random rolls.
  setForcedPresent(fx) {
    this.forcedFx = FX_VALUES.has(fx) ? fx : null;
  }

  // Emit the global FIRST CURD cue the first time anyone scores in a round.
  _maybeFirstCurd() {
    if (this._firstScored) return;
    this._firstScored = true;
    this.events.push({ type: 'firstCurd' });
  }

  // ---- lifecycle ----------------------------------------------------------
  addPlayer(name) {
    const id = _nextId++;
    // Only ONE Mallen: a second person typing "mallen" joins as a normal delivery
    // player (otherwise they'd be a dead-weight character that can't eat/score/win).
    const isMallen = name.trim().toLowerCase() === MALLEN.name && this.mallenId == null;
    const spawn = randSpawn(ARENA, LOCI.edgePadding, this.rng);
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
      hitsTaken: 0,               // toward dropping a tub
      // mallen-only:
      eaten: 0,
      frenzyMs: 0,
      lastAttackMs: -1e9,         // "never attacked" (clock 0 is a valid attack time)
      eatingUntilMs: 0,
      spriteIndex: (id % 12),     // which delivery sprite variant (12 player colors)
      // power-up/debuff state:
      effect: null,               // active FX id or null
      effectUntilMs: 0,           // clock time the effect ends
      cannonArmed: false,         // curd cannon: next throw auto-scores
      greaseGrabMs: -1,           // clock time greased player grabbed (-1 = none)
      noPickupUntilMs: 0,         // auto-pickup suppressed until this clock time (after a forced drop)
      stunnedUntilMs: 0,          // frozen (can't act) until this clock time (Mallen devour shockwave)
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
    const n = normalize(x, y);
    p.moveInput = n;
    if (n.x !== 0 || n.y !== 0) p.dir = n;
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
    if (!t) return;
    // curd cannon: this throw flies ~10x as far, then disarms
    const cannon = !!p.cannonArmed;
    if (cannon) {
      power *= EFFECT.cannonRangeMult;
      p.cannonArmed = false;
      if (p.effect === FX.CURD_CANNON) this._clearEffect(p);
    }
    t.state = 'flying';
    t.carrierId = null;
    t.vx = p.dir.x * power;
    t.vy = p.dir.y * power;
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
    const cd = p.isMallen
      ? (p.frenzyMs > 0 ? MALLEN.attackCooldownMs * FRENZY.attackCdMult : MALLEN.attackCooldownMs)
      : PUNCH.cooldownMs;
    if (now - p.lastAttackMs < cd) return;
    p.lastAttackMs = now;
    // id + facing (for the puncher's whiff poof) + cd (drives the cooldown clock)
    this.events.push({ type: 'attack', x: p.x, y: p.y, id: p.id, dx: p.dir.x, dy: p.dir.y, cd });

    // The Mallen lunges forward when he punches — an ANIMATED dash (velocity over
    // dashMs, applied in the movement loop), and we resolve the hit at where the
    // lunge will land so the dash actually extends his reach.
    let px = p.x, py = p.y;
    if (p.isMallen) {
      const dashSpeed = PUNCH.mallenDash / (PUNCH.dashMs / 1000);
      p.dashVx = p.dir.x * dashSpeed;
      p.dashVy = p.dir.y * dashSpeed;
      p.dashUntilMs = now + PUNCH.dashMs;
      px = p.x + p.dir.x * PUNCH.mallenDash;
      py = p.y + p.dir.y * PUNCH.mallenDash;
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
    this._nextPresentAt = now + base / Math.max(1, this.players.size);
  }

  _spawnPresent(now) {
    const landX = LOCI.edgePadding + this.rng() * (ARENA.width - 2 * LOCI.edgePadding);
    const landY = LOCI.edgePadding + this.rng() * (ARENA.height - 2 * LOCI.edgePadding);
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
    // raise the on-field cap with player count so it never throttles the faster
    // spawn rate (presents get claimed quickly when there are many players).
    const cap = Math.max(PRESENT.maxOnField, Math.ceil(this.players.size / 2));
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
      // full-screen ad) — they keep their tub but can't act, so they're a sitting duck.
      p.stunnedUntilMs = now + EFFECT.interstitialMs;
      p.vx = 0; p.vy = 0;
      p.charging = false;
    }
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
  }

  _applyMagnets(dt) {
    for (const p of this.players.values()) {
      if (p.effect !== FX.MAGNET) continue;
      for (const t of this.tubs) {
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
            this._scheduleTruckRefill(this._clock || 0);
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
      this._checkCarriedDeliveries();
      this._capTubs();
      this._checkRoundEnd();
    }
  }

  _effectiveSpeed(p) {
    let base = p.isMallen
      ? (p.frenzyMs > 0 ? MALLEN.speed * FRENZY.speedMult : MALLEN.speed)
      : PLAYER.speed;
    if (p.effect === FX.DOUBLE_SPEED) base *= EFFECT.doubleSpeedMult;
    else if (p.effect === FX.HALF_SPEED) base *= EFFECT.halfSpeedMult;
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
          this._scoreDelivery(t);
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

  _scoreDelivery(tub) {
    // credit the last carrier if we tracked one; else nobody (still counts as gone)
    const scorer = tub.lastCarrierId != null ? this.players.get(tub.lastCarrierId) : null;
    if (scorer) {
      const pts = scorer.effect === FX.TWO_X_POINTS ? 2 : 1;
      scorer.score += pts;
    }
    this.events.push({ type: 'score', x: this.loci.fridge.x, y: this.loci.fridge.y,
                       name: scorer ? scorer.name : null, id: scorer ? scorer.id : null });
    this._maybeFirstCurd();
  }

  // Mallen devour shockwave: stun every nearby delivery player (freeze + drop
  // their tub) for a couple seconds. Invincible players resist.
  _stunNearby(m, now) {
    let hit = false;
    for (const p of this.players.values()) {
      if (p.isMallen || p.effect === FX.INVINCIBLE) continue;
      if (dist(m.x, m.y, p.x, p.y) > STUN.radius) continue;
      p.stunnedUntilMs = now + STUN.durationMs;
      p.vx = 0; p.vy = 0;
      p.charging = false;
      if (p.carryingTubId != null) {
        const t = this.tubs.find((t) => t.id === p.carryingTubId);
        if (t) { t.state = 'loose'; t.carrierId = null; }
        p.carryingTubId = null;
        p.hitsTaken = 0;
        p.noPickupUntilMs = now + STUN.durationMs; // can't re-grab while stunned
        this.events.push({ type: 'drop', x: p.x, y: p.y });
      }
      hit = true;
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
      p.noPickupUntilMs = 0; p.stunnedUntilMs = 0; p.vx = 0; p.vy = 0;
      p.dashUntilMs = 0; p.dashVx = 0; p.dashVy = 0;
    }
    this.phase = PHASE.COUNTDOWN;
    this.countdownMs = ROUND.startCountdownMs;
    this._clock = 0;
    this._truckRefillQueue = [];
    this.presents = [];
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
        charging: p.charging, frenzy: p.frenzyMs > 0, ready: !!p.ready,
        stunned: (this._clock || 0) < p.stunnedUntilMs,
        dashing: (this._clock || 0) < p.dashUntilMs,
        spriteIndex: p.spriteIndex,
        effect: p.effect,
        effectMs: p.effect ? Math.max(0, Math.round(p.effectUntilMs - (this._clock || 0))) : 0,
      })),
      tubs: this.tubs.map(t => ({
        id: t.id, x: Math.round(t.x), y: Math.round(t.y), state: t.state,
      })),
      presents: this.presents.map(g => ({
        id: g.id, x: Math.round(g.x), y: Math.round(g.y), landed: g.landed,
      })),
    };
  }
}
