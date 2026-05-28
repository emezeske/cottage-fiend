// Authoritative game simulation. No networking, no real timers — everything is
// driven by tick(dtMs) and input methods so it is fully unit-testable.
//
// The Game owns all truth: players, tubs, loci, scores, phase, frenzy. The
// server wraps this with a WebSocket layer and a setInterval calling tick().

import {
  ARENA, PLAYER, MALLEN, FRENZY, TUB, THROW, LOCI, ROUND, PHASE, MSG,
  PRESENT, EFFECT, FX, ONE_SHOT,
} from './constants.js';
import { dist, normalize, resolveCircleOverlap, clampToArena, chargePower } from './vec.js';
import { placeLoci, randSpawn } from './spawn.js';
import { rollEffect } from './effects.js';

let _nextId = 1;
export function _resetIds() { _nextId = 1; } // test helper

export class Game {
  constructor({ rng = Math.random } = {}) {
    this.rng = rng;
    this.phase = PHASE.LOBBY;
    this.players = new Map();   // id -> player
    this.tubs = [];             // active tubs (carried, flying, or loose)
    this.loci = placeLoci(ARENA, LOCI, rng);
    this.countdownMs = 0;
    this.events = [];           // one-shot events drained each broadcast
    this.mallenId = null;       // id of the player currently acting as Mallen
    this.roundWinner = null;    // {type:'player'|'mallen', name}
    this._tubSeq = 1;
    this.presents = [];         // parachuting gift boxes
    this._presentSeq = 1;
    this._nextPresentAt = null; // clock time of next present spawn (null = unscheduled)
  }

  // ---- lifecycle ----------------------------------------------------------
  addPlayer(name) {
    const id = _nextId++;
    const isMallen = name.trim().toLowerCase() === MALLEN.name;
    const spawn = randSpawn(ARENA, LOCI.edgePadding, this.rng);
    const p = {
      id, name,
      x: spawn.x, y: spawn.y,
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
      lastAttackMs: 0,
      eatingUntilMs: 0,
      spriteIndex: (id % 6),      // which delivery sprite variant
      // power-up/debuff state:
      effect: null,               // active FX id or null
      effectUntilMs: 0,           // clock time the effect ends
      cannonArmed: false,         // curd cannon: next throw auto-scores
      greaseGrabMs: -1,           // clock time greased player grabbed (-1 = none)
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
    if (this.mallenId === id) {
      // promote another mallen-named player if present, else no mallen
      this.mallenId = null;
      for (const [pid, pp] of this.players) {
        if (pp.isMallen) { this.mallenId = pid; break; }
      }
    }
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
    // tap grabs the nearest tappable tub within reach: a 'ready' tub on the
    // truck, or a 'loose' tub on the ground. First come, first serve.
    const reach = p.radius + TUB.radius + 28;
    let best = null, bestD = Infinity;
    for (const t of this.tubs) {
      if (t.state !== 'loose' && t.state !== 'ready') continue;
      const d = dist(p.x, p.y, t.x, t.y);
      if (d < reach && d < bestD) { best = t; bestD = d; }
    }
    if (best) {
      const wasReady = best.state === 'ready';
      best.state = 'carried';
      best.carrierId = id;
      best.lastCarrierId = id;
      p.carryingTubId = best.id;
      if (p.effect === FX.GREASED) p.greaseGrabMs = this._clock || 0;
      this.events.push({ type: 'pickup', x: p.x, y: p.y });
      // taking a ready tub off the truck schedules a 1s refill
      if (wasReady) this._scheduleTruckRefill(nowMs);
    }
  }

  startCharge(id, nowMs) {
    const p = this.players.get(id);
    if (!p || p.carryingTubId == null) return;
    p.charging = true;
    p.chargeStartMs = nowMs;
  }

  release(id, nowMs) {
    const p = this.players.get(id);
    if (!p || !p.charging || p.carryingTubId == null) return;
    const elapsed = nowMs - p.chargeStartMs;
    const power = chargePower(elapsed, THROW);
    const t = this.tubs.find(t => t.id === p.carryingTubId);
    p.charging = false;
    p.carryingTubId = null;
    if (!t) return;
    t.state = 'flying';
    t.carrierId = null;
    t.vx = p.dir.x * power;
    t.vy = p.dir.y * power;
    // curd cannon: this throw gets an enlarged fridge score radius, then disarms
    t.cannon = !!p.cannonArmed;
    if (p.cannonArmed) { p.cannonArmed = false; if (p.effect === FX.CURD_CANNON) this._clearEffect(p); }
    this.events.push({ type: 'throw', x: p.x, y: p.y, power, cannon: t.cannon });
  }

  setReady(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.ready = true;
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

  // Position ready tubs in a little cluster on top of the truck.
  _positionReadyTubs() {
    const ready = this.tubs.filter(t => t.state === 'ready');
    const { truck } = this.loci;
    ready.forEach((t, i) => {
      const angle = (i / Math.max(1, ready.length)) * Math.PI * 2;
      const r = ready.length <= 1 ? 0 : LOCI.truckTubGap;
      t.x = truck.x + Math.cos(angle) * r;
      t.y = truck.y + Math.sin(angle) * r;
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
  _scheduleNextPresent(now) {
    const span = PRESENT.spawnMaxMs - PRESENT.spawnMinMs;
    this._nextPresentAt = now + PRESENT.spawnMinMs + this.rng() * span;
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
    if (now >= this._nextPresentAt && this.presents.length < PRESENT.maxOnField) {
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
          this.events.push({ type: 'presentClaim', x: g.x, y: g.y, fx: p._lastFx });
          break;
        }
      }
    }
    this.presents = this.presents.filter(g => !g._claimed);
  }

  _applyPresent(p, now) {
    const fx = rollEffect(p.isMallen, this.rng);
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
          if (t.state === 'ready') t.state = 'loose'; // pulled off the truck
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
      // mallen locked during eat animation
      const locked = p.isMallen && now < p.eatingUntilMs;
      if (!locked) {
        p.x += p.moveInput.x * speed * dt;
        p.y += p.moveInput.y * speed * dt;
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
      this._updatePresents(dt, now);
      this._applyMagnets(dt);
      this._mallenLogic(now);
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
        if (fix) { a.x = fix.a.x; a.y = fix.a.y; b.x = fix.b.x; b.y = fix.b.y; }
      }
    }
    // player vs loci (solid obstacles)
    for (const p of arr) {
      this._pushOutOf(p, this.loci.truck, LOCI.truckRadius);
      this._pushOutOf(p, this.loci.fridge, LOCI.fridgeRadius);
      const c = clampToArena(p.x, p.y, p.radius, ARENA);
      p.x = c.x; p.y = c.y;
    }
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
        t.x += t.vx * dt;
        t.y += t.vy * dt;
        t.vx *= TUB.friction;
        t.vy *= TUB.friction;

        // tub hits a player => splat, knockback that player a touch
        for (const p of this.players.values()) {
          if (dist(t.x, t.y, p.x, p.y) < p.radius + TUB.radius) {
            this.events.push({ type: 'splat', x: t.x, y: t.y });
            t.vx *= -0.3; t.vy *= -0.3;
          }
        }
        // tub reaches the fridge? curd cannon enlarges the effective radius.
        const dFridge = dist(t.x, t.y, this.loci.fridge.x, this.loci.fridge.y);
        const scoreR = t.cannon ? LOCI.scoreRadius * EFFECT.cannonScoreMult : LOCI.scoreRadius;
        if (dFridge < scoreR) {
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
        }
      }
    }
    this.tubs = this.tubs.filter(t => !t._dead);
  }

  _scoreDelivery(tub) {
    // credit the last carrier if we tracked one; else nobody (still counts as gone)
    const scorer = tub.lastCarrierId != null ? this.players.get(tub.lastCarrierId) : null;
    if (scorer) {
      const pts = scorer.effect === FX.TWO_X_POINTS ? 2 : 1;
      scorer.score += pts;
    }
    this.events.push({ type: 'score', x: this.loci.fridge.x, y: this.loci.fridge.y,
                       name: scorer ? scorer.name : null });
  }

  _mallenLogic(now) {
    const m = this.players.get(this.mallenId);
    if (!m) return;
    if (now < m.eatingUntilMs) return; // mid-chomp

    const cd = m.frenzyMs > 0 ? MALLEN.attackCooldownMs * FRENZY.attackCdMult
                              : MALLEN.attackCooldownMs;

    // attack nearest delivery player in range (invincible players are skipped)
    if (now - m.lastAttackMs >= cd) {
      let target = null, td = Infinity;
      for (const p of this.players.values()) {
        if (p.isMallen) continue;
        if (p.effect === FX.INVINCIBLE) continue;
        const d = dist(m.x, m.y, p.x, p.y);
        if (d < MALLEN.attackRange && d < td) { target = p; td = d; }
      }
      if (target) {
        m.lastAttackMs = now;
        target.hitsTaken += 1;
        this.events.push({ type: 'attack', x: target.x, y: target.y });
        if (target.hitsTaken >= MALLEN.hitsToDrop && target.carryingTubId != null) {
          const t = this.tubs.find(t => t.id === target.carryingTubId);
          if (t) { t.state = 'loose'; t.carrierId = null; }
          target.carryingTubId = null;
          target.hitsTaken = 0;
          this.events.push({ type: 'drop', x: target.x, y: target.y });
        }
      }
    }

    // devour a loose tub within reach
    for (const t of this.tubs) {
      if (t.state !== 'loose') continue;
      if (dist(m.x, m.y, t.x, t.y) < MALLEN.eatRange) {
        t._dead = true;
        m.eaten += (m.effect === FX.TWO_X_POINTS ? 2 : 1);
        m.eatingUntilMs = now + MALLEN.eatDurationMs;
        m.frenzyMs = FRENZY.durationMs;
        m.radius = this._computeRadius(m); // reflect frenzy growth immediately
        this.events.push({ type: 'chomp', x: m.x, y: m.y });
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

  startRound() {
    this.loci = placeLoci(ARENA, LOCI, this.rng);
    this.tubs = [];
    this.roundWinner = null;
    for (const p of this.players.values()) {
      const s = randSpawn(ARENA, LOCI.edgePadding, this.rng);
      p.x = s.x; p.y = s.y;
      p.score = 0; p.eaten = 0; p.hitsTaken = 0;
      p.carryingTubId = null; p.charging = false;
      p.frenzyMs = 0; p.eatingUntilMs = 0; p.lastAttackMs = 0;
      p.radius = p.isMallen ? MALLEN.radius : PLAYER.radius;
      p.ready = false;
      p.effect = null; p.effectUntilMs = 0; p.cannonArmed = false; p.greaseGrabMs = -1;
    }
    this.phase = PHASE.COUNTDOWN;
    this.countdownMs = ROUND.startCountdownMs;
    this._clock = 0;
    this._truckRefillQueue = [];
    this.presents = [];
    this._nextPresentAt = null;
    this._stockTruck();
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
      countdownMs: Math.max(0, Math.round(this.countdownMs)),
      loci: this.loci,
      roundWinner: this.roundWinner,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y),
        dir: p.dir, isMallen: p.isMallen, radius: Math.round(p.radius),
        score: p.score, eaten: p.eaten, carrying: p.carryingTubId != null,
        charging: p.charging, frenzy: p.frenzyMs > 0, ready: !!p.ready,
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
