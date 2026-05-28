# Cottage Fiend — Design & Handoff Document

> This document is written to be fed to **Claude Code** (or any developer) to
> continue the project. It describes the full intended design, what is already
> built, the network protocol, every tunable, known gaps, and a prioritized
> backlog. Read this top to bottom before changing code.

---

## 1. Concept

**Cottage Fiend** — a deliberately silly multiplayer browser game themed entirely
around cottage cheese. Overhead 2D arena, Streets-of-Rage-ish chunky pixel art.
It is The Mallen's birthday, hence the birthday leaderboard and the fact that The
Mallen only ever receives buffs from presents (never debuffs).

- **Delivery players**: carry cottage cheese tubs from a **truck** to a **fridge**.
  Each tub successfully delivered = 1 point. First to `pointsToWin` (10) ends the round.
- **The Mallen**: the single player whose name is `mallen` (case-insensitive).
  A larger, slightly slower cottage-cheese fiend. Auto-attacks nearby delivery
  players; after `hitsToDrop` (2) hits they drop their carried tub. The Mallen
  devours loose tubs (animal SFX, messy splatter), and each devour triggers a
  **frenzy**: +50% size, color flashing, faster movement and attacks for a few
  seconds. The Mallen wins the round by eating `mallenEatsToWin` (10) tubs.
- **Presents**: gift-wrapped boxes parachute in periodically and land at a random
  spot. The first player to walk onto a landed present claims a random power-up or
  debuff (see §5.5). The Mallen, on its birthday, only ever rolls buffs.
- **Round flow**: lobby → countdown → playing → leaderboard → (50% press LET'S GO) → next round.
  The leaderboard shows a birthday cottage-cheese tub with candles and
  "HAPPY BIRTHDAY MALLEN!".
- Players can join at any time and spawn into a running round.

This is a joke project. It does not need to be secure, abuse-resistant, or
horizontally scalable. It needs to be fun once, at a party, over a shared URL.

---

## 2. Tech & hosting

- **Single Node service** (Node 20+, ESM). `server/index.js` runs an HTTP server
  that (a) serves the static client from `/client` and (b) hosts a WebSocket
  server on the same port. This is intentional: one Railway service does
  everything, no separate frontend host, no CORS.
- **Why not Vercel**: Vercel is serverless and cannot hold long-lived WebSocket
  connections. We chose a single always-on box (Railway). If you ever want
  Vercel for the frontend, you'd split the client out and point its `wsUrl()` at
  the Railway server; not necessary today.
- **Authoritative server**: the server owns all truth and runs the simulation at
  `TICK_RATE` (30Hz). Clients send inputs and render snapshots. No client-side
  prediction (not needed at LAN/party latencies; add later if desired).
- **No database**. All state is in memory and resets on restart. Fine for the use case.

---

## 3. Repo map

```
server/index.js          Networking + static serving + tick loop. THIN wrapper.
server/game/constants.js ALL tunables. Change gameplay feel here first.
server/game/game.js       The Game class: authoritative sim. Pure (no IO/timers).
server/game/effects.js    Pure weighted power-up/debuff roller (injectable RNG).
server/game/vec.js        Geometry + charge oscillator. Pure functions.
server/game/spawn.js      Randomized loci/spawn placement. Injectable RNG.
client/index.html         Join overlay + canvas + styling.
client/main.js            WS client, input wiring, requestAnimationFrame loop.
client/render.js          Canvas drawing from a snapshot. No game logic.
client/input.js           Touch/mouse: drag-move, tap-pickup, hold-charge-release.
client/audio.js           Procedural Web Audio SFX + optional file overrides.
client/assets.js          Sprite manifest + loader.
client/assets/sprites/    Pre-baked PNGs (see scripts/generate-art.py).
tests/*.test.js           Unit tests (Node built-in runner).
scripts/generate-art.py   One-shot Python/Pillow art baker. Not needed at runtime.
```

**Design rule to preserve**: keep `game.js` free of networking and real timers.
Everything is driven by `tick(dtMs)` and input methods that take an explicit
`nowMs`. This is what makes it fully unit-testable. Do not call `Date.now()`
inside the Game; the server passes time in.

---

## 4. Game state model

### Player object (server-side, see `Game.addPlayer`)
```
id, name, x, y,
dir {x,y}            facing unit vector (last nonzero move), used for throw direction
moveInput {x,y}      current input unit vector
isMallen             name === 'mallen' (case-insensitive)
radius               PLAYER.radius, or MALLEN.radius (grows in frenzy)
score                deliveries (delivery players)
carryingTubId        id of carried tub or null
charging, chargeStartMs
hitsTaken            toward dropping (reset on drop)
eaten                tubs devoured (Mallen)
frenzyMs             remaining frenzy time (Mallen)
lastAttackMs         attack cooldown bookkeeping (Mallen)
eatingUntilMs        eat-animation movement lock (Mallen)
spriteIndex          which delivery sprite variant (0..5)
ready                pressed LET'S GO
```

### Tub object
```
id, x, y, vx, vy,
state    'ready' (on truck, tappable) | 'carried' | 'flying' | 'loose'
carrierId, lastCarrierId   lastCarrierId credits the delivery on a score
```

### Tub lifecycle / truck restock (IMPORTANT, recently added)
- The truck always shows at least one **ready** tub (rendered in a small cluster
  via `_positionReadyTubs`).
- Tapping a ready tub picks it up (first come, first serve). Taking a ready tub
  calls `_scheduleTruckRefill(now)`, which pushes `now + LOCI.truckRefillMs`
  (1000ms) onto `_truckRefillQueue`.
- `_processTruckRefills(now)` (called each tick while PLAYING) spawns a
  replacement ready tub when a timer elapses. Stock is **unlimited**.
- A safety net in `_processTruckRefills` guarantees the truck is never completely
  empty during play.
- Many players can carry tubs simultaneously; many tubs can be flying/loose/scored
  at once. (Tested in `tests/game.test.js`.)

### Phases (`PHASE` in constants.js)
`lobby`, `countdown`, `playing`, `leaderboard`. Round starts when
`readyFractionMet()` is true (≥ `ROUND.readyFraction` = 50% of connected players
pressed ready). `startRound()` re-randomizes loci, resets players, stocks the truck.

---

## 5. Network protocol

JSON messages over a single WebSocket. Types in `constants.js` (`MSG`).

### Client → server
| type      | payload          | meaning |
|-----------|------------------|---------|
| `join`    | `{name}`         | join the game; server replies `welcome` |
| `input`   | `{x,y}`          | raw movement vector (server normalizes); `{0,0}` = stop |
| `pickup`  | —                | tap: grab nearest ready/loose tub in reach |
| `charge`  | —                | begin charging a throw (must be carrying) |
| `release` | —                | release throw at current oscillator value |
| `ready`   | —                | pressed LET'S GO |

### Server → client
| type      | payload                | meaning |
|-----------|------------------------|---------|
| `welcome` | `{id}`                 | assigns the client its player id |
| `state`   | `{snapshot, events}`   | full snapshot + drained one-shot events, every tick |

`snapshot` shape: `{phase, countdownMs, loci:{truck,fridge}, roundWinner,
players:[...], tubs:[{id,x,y,state}], presents:[{id,x,y,landed}]}`. Each player in
the snapshot also carries `effect` (active FX id or null) and `effectMs` (ms
remaining). See `Game.snapshot()`.

`events` is an array of one-shot events for SFX/juice, drained each broadcast:
`join, pickup, throw, splat, score, attack, drop, chomp, restock, roundEnd,
presentDrop, presentClaim, explosion, swap, pinata`.
The client plays a sound per event (`client/audio.js`) and spawns splatters for
`splat`/`chomp`/`drop`/`pinata`/`presentClaim`, plus a ring of splatters for
`explosion` (`render.js addSplat`, wired in `main.js`).

**Note on time**: the server uses `game._clock` (accumulated tick time) as `nowMs`
for input handlers. This is monotonic per process and resets at round start.

---

## 5.5 Presents & power-up/debuff system

Files: `server/game/effects.js` (pure weighted roller), present/effect logic in
`server/game/game.js`, tuning in `constants.js` (`PRESENT`, `EFFECT`, `FX`,
`BUFF_POOL`, `DEBUFF_POOL`, `WILDCARD_POOL`, `ONE_SHOT`, `CLIENT_FX`).

**Spawning** (`_updatePresents`): every `PRESENT.spawnMinMs`–`spawnMaxMs`
(12–20s, randomized), if fewer than `PRESENT.maxOnField` (2) presents exist, one
spawns above the arena and parachutes down over `fallDurationMs` to a random
landing spot. **A present is only claimable once `landed === true`** (walk onto
it). First player within `radius` claims it (Mallen included).

**Effect roll** (`effects.js rollEffect`): Mallen draws ONLY from `BUFF_POOL`
(birthday rule). Everyone else draws from buffs + debuffs + wildcards, weighted.
Claiming replaces any current effect. Timed effects last `EFFECT.defaultDurationMs`
(6s); one-shots (`ONE_SHOT`) apply instantly with no active duration.

**Effects** (`FX`):
- `double_speed` / `half_speed` — speed multipliers in `_effectiveSpeed`.
- `two_x_points` — doubles a delivery (`_scoreDelivery`) or a Mallen devour.
- `invincible` — Mallen skips this player as an attack target (`_mallenLogic`).
- `magnet` — pulls loose/ready tubs toward the holder (`_applyMagnets`).
- `curd_cannon` — arms the next throw; that tub gets an enlarged fridge score
  radius (`EFFECT.cannonScoreMult`) and the effect disarms on release.
- `tiny` — shrinks radius via `_computeRadius` (`EFFECT.tinyMult`).
- `greased` — drops the carried tub ~1s after grabbing (`_tickEffects`).
- `explosion` (one-shot) — knocks back nearby players; if claimer is Mallen,
  victims also drop tubs (`_applyOneShot`).
- `swap` (one-shot) — exchanges positions with a random player.
- `pinata` (one-shot) — drops `EFFECT.pinataCount` loose tubs around the claimer.
- **CLIENT-ONLY** (`CLIENT_FX`): `backwards` (inverts drag in `main.js sendMove`),
  `blindness` (screen splatter overlay in `render.js drawBlindness`), `banana`
  (slidey momentum smoothing in `main.js sendMove`). The server still tracks these
  as the player's `effect` so the client can read its own and react.

**Radius is computed, not mutated** (`_computeRadius`): base × tiny × frenzy. This
is the single source of truth — do NOT mutate `p.radius` from multiple places, or
frenzy and tiny will fight (this was a fixed bug; see §10 tests).

---

## 6. Controls (client)

Implemented in `client/input.js`:
- **Drag**: movement vector from drag origin → current point (deadzone 14px).
  Sent as `input`. Releasing sends `input {0,0}`.
- **Tap** (stationary press, no drag): `pickup`. Server grabs nearest tappable tub.
- **Double-tap and hold**: second tap within 280ms, then hold 160ms → `charge`.
  A power bar oscillates (triangle wave, `THROW.oscillationHz` = 2.4Hz) along the
  facing direction. Releasing sends `release`; server recomputes authoritative
  power from its own clock.

The charge oscillator is mirrored client-side **for the visual arc only**
(`chargePower` in `main.js`); the server is authoritative on release timing.
There is unavoidable minor visual/authoritative mismatch due to latency — fine
for a joke; if it matters, send the charge-start timestamp and reconcile.

---

## 7. Tunables (server/game/constants.js)

Everything that affects feel is here. Highlights:
- `TICK_RATE` 30
- `PLAYER.speed` 230, `MALLEN.speed` 190 (Mallen slower)
- `MALLEN.attackRange` 70, `attackCooldownMs` 600, `hitsToDrop` 2, `eatRange` 50
- `FRENZY`: `durationMs` 4000, `sizeMult` 1.5, `speedMult` 1.35, `attackCdMult` 0.6
- `THROW`: `minPower` 260, `maxPower` 820, `oscillationHz` 2.4
- `LOCI`: `scoreRadius` 80 (landing tolerance — raise to make scoring easier),
  `minSeparation` 520, `truckRefillMs` 1000
- `ROUND`: `pointsToWin` 10, `mallenEatsToWin` 10, `readyFraction` 0.5,
  `startCountdownMs` 3000

If you change `THROW` here, also update the mirrored constant in `client/main.js`
(`THROW`) so the visual arc matches. (TODO below proposes serving constants to
the client to remove this duplication.)

---

## 8. Art

Pre-baked PNGs in `client/assets/sprites/`, generated by
`scripts/generate-art.py` (Python + Pillow). Deterministic (seeded). Includes:
6 delivery variants × 2 walk frames, Mallen body × 2 frames (normal + frenzy),
tub, truck, fridge, 3 splatter frames, 6 cottage-cheese ad banners, and a
`mallen_face_placeholder.png`.

### Mallen face system
The renderer composites `images.mallenFace` onto the Mallen's head each frame
(`render.js drawPlayer`). Replace `mallen_face_placeholder.png` with a real face
PNG (transparent bg ideal). **Backlog item**: support directional/expression
faces — e.g. `mallen_face_left/right/eat.png` selected by `dir` and eating state.

---

## 9. Audio

`client/audio.js` synthesizes every SFX with Web Audio (oscillators + noise
bursts), so there are no audio files to ship. Events map to sounds in
`PROCEDURAL`. To use real CC0 files, populate `FILE_SOUNDS` and drop files in
`client/assets/sounds/`; a present file overrides the procedural version.
Audio context is created on first user gesture (join/ready) to satisfy browser
autoplay policies.

---

## 10. Tests

`npm test` (Node built-in runner, no deps) — 55 tests. Coverage:
- `vec.test.js`: geometry + charge oscillator bounds.
- `spawn.test.js`: loci separation/padding invariants (50 seeds), spawn bounds.
- `game.test.js`: join, Mallen role assignment + promotion on disconnect,
  pickup of ready tubs, **1s truck refill timing**, **many simultaneous carriers**,
  carry-follow, charge/release projectile, scoring at fridge, Mallen attack→drop,
  devour→frenzy→expire, round-end (both win conditions), ready fraction, countdown,
  player–player collision, player–truck collision, snapshot serialization,
  event draining.
- `effects.test.js`: weighted pick membership, **Mallen-only-buffs (300 seeds)**,
  delivery debuffs/wildcards appear, present spawn+parachute, claim-on-touch,
  each effect's mechanic (double/half speed, 2x points, invincibility, explosion
  knockback, pinata, swap, tiny shrink/restore, curd cannon ranged score, greased
  drop, expiry), snapshot includes presents+effect, startRound clears effects, and
  the **frenzy+tiny radius regression** (radius is computed, never corrupted).

Tests use a seeded RNG (`tests/helpers.js`) and drive the sim with explicit
`tick(dtMs)` steps — no real timers, no network. **Keep new game logic in
`game.js`/pure modules and add tests there.** Do not put logic in `index.js`.

Also validated (not in the suite): a 90-second in-process soak with 5 bots across
multiple rounds — zero runtime/snapshot errors — and an offline HTTP smoke test
of static serving. The one thing not verifiable offline is the live browser↔server
WebSocket round-trip; confirm two clients see each other move as the first check on Railway.

---

## 11. Known gaps / not yet built

> The present/power-up system, birthday leaderboard, client-only effects
> (backwards/blindness/banana), and the Cottage Fiend rename are all DONE and
> tested. The items below are what remains.

1. **No client-side prediction or interpolation.** Movement is rendered straight
   from snapshots at 30Hz; on a bad connection it will look choppy. Add entity
   interpolation (render ~100ms in the past, lerp between last two snapshots) for
   smoothness. This is the highest-value polish item if latency is noticeable.
2. **Constants duplicated** between server and `client/main.js` (THROW, and the
   effect id strings in `render.js`/`main.js`). Serve a constants subset in the
   `welcome` message and have the client use it.
3. **No reconnect.** A dropped socket ends the session (overlay prompts refresh).
   Could add rejoin-by-name.
4. **Single Mallen.** If `mallen` isn't taken, there is simply no Mallen that
   round. Decide: auto-assign a Mallen if none present? (Design choice — left to you.)
5. **Throw direction = last move direction.** You can't aim independently of
   movement. Could add aim during charge (drag during hold sets direction).
6. **Tap vs. double-tap edge cases** on some mobile browsers (300ms synthetic
   click, etc.). Test on target devices; tune `DOUBLE_TAP_MS`/`HOLD_MS` in input.js.
7. **Mallen face is a single static image.** See §8 for the directional backlog.
8. **Banana (slidey) effect** only smooths direction while actively dragging; it
   does not coast after release (that would need a per-frame input loop). Fine as a
   joke; revisit if you want true momentum.
9. **Ads are static banners.** Could rotate more aggressively, add fake video ads,
   popups, an interstitial between rounds ("THIS ROUND SPONSORED BY CURDS™").
10. **Accessibility/keyboard**: no keyboard controls (WASD) for desktop testing
    convenience. Easy add in input.js.

---

## 12. Prioritized backlog (suggested order for Claude Code)

**P0 — make it feel good live**
- [ ] Entity interpolation on the client (smooth movement between snapshots).
- [ ] Serve constants in `welcome`; remove client/server duplication (THROW + FX ids).
- [ ] Playtest pass on real phones; tune `DOUBLE_TAP_MS`, `HOLD_MS`, deadzone,
      `scoreRadius`, throw power range, Mallen speed/attack feel, present cadence.

**P1 — depth & juice**
- [ ] Aim-during-charge (drag while holding sets throw direction).
- [ ] Directional/expression Mallen faces.
- [ ] More splatter, screen shake on chomp/explosion, frenzy screen vignette.
- [ ] Real CC0 SFX wired via `FILE_SOUNDS`.
- [ ] Between-round cottage-cheese "ad break" interstitial.
- [ ] More present effects (the pools in `constants.js` are easy to extend).

**P2 — robustness (only if it ever needs to survive more than one party)**
- [ ] Reconnect-by-name.
- [ ] Auto-assign a Mallen if none present (if desired).
- [ ] Basic rate-limiting / input sanity (it's currently trusting; fine for a joke).
- [ ] Multiple concurrent game rooms (currently one global game).

**P3 — nice-to-haves**
- [ ] Keyboard controls for desktop.
- [ ] Spectator mode / lobby player list.
- [ ] Persistent leaderboard (would require the no-DB rule to change).

---

## 13. Gotchas for whoever continues this

- The Game uses `game._clock` as its notion of "now" (ms). Input handlers receive
  `nowMs`; the server passes `game._clock`. `startRound()` resets `_clock` to 0.
- **Radius is computed by `_computeRadius`, never mutated piecemeal.** It combines
  base size, Tiny, and frenzy. If you add an effect that changes size, add it there
  — do not write `p.radius = ...` elsewhere or frenzy/tiny will desync (fixed bug).
- `ready` tubs are stationary and immune to physics and Mallen eating (only
  `loose` tubs are devoured, only `carried`/`flying` are simulated). Magnet turns a
  pulled `ready` tub into `loose`. Preserve these state checks if you refactor tubs.
- Presents are only claimable once `landed === true` (matches "walk over it").
- `greaseGrabMs` uses `-1` (not `0`) as the "none" sentinel, because clock 0 is a
  valid grab time at round start. Don't switch it back to a falsy check.
- `_nextPresentAt` uses `null` (not `0`) as "unscheduled", for the same reason.
- Scoring credits `tub.lastCarrierId` (set on pickup), so a tub thrown by someone
  who then gets attacked still credits the thrower when it lands in the fridge.
- Curd cannon stamps `tub.cannon` at release and disarms; the enlarged score
  radius lives on the flying tub, not the player.
- Client-only effects (`backwards`, `blindness`, `banana`) are enforced in
  `main.js`/`render.js` by reading the self player's `effect` from the snapshot.
  The server still owns assignment and duration.
- `_pushOutOf` handles the coincident-center case (player exactly on a locus
  center) by pushing along +x; don't reintroduce a `d > 0` guard that skips it.
- Static file server in `index.js` normalizes paths and blocks traversal outside
  `/client`. Keep that check if you touch it.
- The client tolerates missing art (`assets.js` resolves on error) and falls back
  to drawn circles, so a missing PNG won't blank the game.
