# Cottage Fiend — Design & Handoff Document

> Read this top to bottom before changing code. It describes the current design,
> the network protocol, every tunable, the art/audio pipelines, and known gaps.
> Companion docs: **ART.md** (asset spec) and **SOUND.md** (sound spec).

---

## 1. Concept

**Cottage Fiend** — a deliberately silly multiplayer browser game themed entirely
around cottage cheese. Overhead 2D arena with a following camera, Streets-of-Rage-2
flavored art (gritty, a little cyberpunk). It is The Mallen's birthday, hence the
birthday leaderboard and the rule that The Mallen only rolls buffs from presents.

- **Delivery players**: carry cottage cheese tubs from a **truck** to a **fridge**.
  Each delivery = 1 point. First to `pointsToWin` (10) ends the round.
- **The Mallen**: the single player named `mallen` (case-insensitive). A bigger
  fiend, **equal speed** to deliveries (frenzy makes him faster). He **attacks via
  the same PUNCH/ATTACK button** as everyone (no auto-attack). His attack is a
  forward **dash/lunge** that plows through the crowd, knocking carried tubs loose.
  He **devours loose tubs**; each devour triggers a **frenzy** (+50% size, color
  flash, faster) AND a **shockwave that stuns every nearby player** (they freeze and
  drop their tub for ~2s). He wins by devouring `mallenEatsToWin` (10) tubs.
- **Presents**: gift boxes parachute in and land at a random spot. The first player
  to walk onto a landed present claims a random effect (§5.5). The Mallen only rolls
  buffs that actually apply to him (never the throw-only curd cannon).
- **Round flow**: lobby → countdown (ROUND N intro) → playing → leaderboard →
  (≥50% press LET'S GO) → next round. `roundNumber` increments each round.
- Players can join any time and spawn into a running round.

This is a joke project. It does not need to be secure, abuse-resistant, or
horizontally scalable. It needs to be fun once, at a party, over a shared URL.

---

## 2. Tech & hosting

- **Single Node service** (Node 20+, ESM). `server/index.js` serves the static
  client from `/client`, hosts the WebSocket server on the same port, runs the 30Hz
  tick loop, and exposes `/admin`. One Railway service, no separate frontend, no CORS.
- **Authoritative server** at `TICK_RATE` (30Hz). Clients send inputs and render
  snapshots. **No client-side prediction/interpolation** (still a gap — see §11).
- **No database**. All state in memory; resets on restart or via `/admin/reset`.
- On boot the server prints its LAN URL (for phones). Static responses send
  `Cache-Control: no-store` (dev-friendly; relax for production).

---

## 3. Repo map

```
server/index.js          Networking + static serving + tick loop + /admin routes. THIN.
server/game/constants.js ALL tunables. Change gameplay feel here first.
server/game/game.js      The Game class: authoritative sim. Pure (no IO/real timers).
server/game/effects.js   Weighted power-up/curse roller (injectable RNG).
server/game/vec.js       Geometry + charge oscillator. Pure.
server/game/spawn.js     Randomized loci/spawn placement. Injectable RNG.
client/index.html        Title screen (logo) + canvas + buttons.
client/main.js           WS client, input wiring, audio triggers, rAF render loop.
client/render.js         Canvas drawing + all juice (pure draw from a snapshot).
client/camera.js         Following camera + screen↔world transform.
client/input.js          Touch/mouse: drag-to-move + tap.
client/audio.js          File SFX + looping music (preloaded) + procedural fallback.
client/assets.js         Sprite manifest + loader.
client/admin.html        /admin: screen previews + server reset.
client/assets/sprites|music|sounds/   Real art + audio. game-logo.png, bg.png.
scripts/segment_art.py   Segments art-source/ sheets into sprites (Python+Pillow).
art-source/              Hand-provided source sheets + the segment script's inputs.
tests/*.test.js          Unit tests (Node built-in runner).
ART.md / SOUND.md        Asset spec / sound spec (hand-off for new art & audio).
```

**Design rule to preserve**: keep `game.js` free of networking and real timers.
Everything is driven by `tick(dtMs)` and input methods that take an explicit
`nowMs` (= `game._clock`). This is what makes it fully unit-testable. Never call
`Date.now()` inside the Game.

---

## 4. Game state model

### Player object (`Game.addPlayer`)
```
id, name, x, y
vx, vy               velocity (used by the 'slidey' ice physics; otherwise = input*speed)
dir {x,y}            facing unit vector (last nonzero move) — punch/throw direction
moveInput {x,y}      current input unit vector
isMallen             name === 'mallen'
radius               computed by _computeRadius (base × tiny × frenzy)
score                deliveries (delivery players)
eaten                tubs devoured (Mallen)
carryingTubId        id of carried tub or null
charging, chargeStartMs
lastAttackMs         punch cooldown clock (inits to -1e9 so the first punch isn't gated)
hitsTaken            vestigial (a punch now knocks the tub loose in one hit)
frenzyMs             remaining frenzy time (Mallen)
eatingUntilMs        chomp animation movement lock (Mallen)
noPickupUntilMs      auto-pickup suppressed until this clock time (after a forced drop)
stunnedUntilMs       frozen (can't act) until this clock time (Mallen devour shockwave)
dashUntilMs, dashVx, dashVy   active Mallen lunge
spriteIndex          delivery color variant (id % 12)
effect, effectUntilMs, cannonArmed, greaseGrabMs(-1 sentinel)
ready                pressed LET'S GO
```

### Tub object
```
id, x, y, vx, vy
state    'ready' (at truck) | 'carried' | 'flying' | 'loose'
carrierId, lastCarrierId      lastCarrierId credits a delivery on a score
cannon                        this throw is a curd-cannon mega-throw
thrownBy, thrownGraceUntil    the thrower can't instantly re-catch their own throw
```

### Tubs: pickup / catch / deliver / restock
- The truck always keeps ≥1 **ready** tub, positioned in a visible row in front of
  it (`_positionReadyTubs`).
- **Auto-pickup**: a delivery player who runs over a ready/loose tub grabs it
  automatically (`_autoPickup`), unless `noPickupUntilMs` is active (after a forced
  drop) so the Mallen gets a beat to eat it.
- **Catch**: a flying tub that hits an empty-handed delivery player is auto-caught;
  it bumps a carrying player or the Mallen instead.
- **Deliver**: walking a carried tub into the fridge scores it
  (`_checkCarriedDeliveries`), or throw it (`release`). Fridge scoring uses
  segment distance so fast/cannon throws can't tunnel past the fridge.
- Taking a ready tub schedules a 1s **refill** (`_scheduleTruckRefill`);
  `_processTruckRefills` spawns the replacement. A safety net keeps ≥1 ready tub.
  The **magnet** pulling a ready tub off the truck also schedules a refill (so it
  can't trigger the instant safety-net respawn → no infinite spawn).

### Phases (`PHASE`)
`lobby`, `countdown`, `playing`, `leaderboard`. A round starts when
`readyFractionMet()` (≥ `ROUND.readyFraction` = 50%). `startRound()` increments
`roundNumber`, re-randomizes loci, recomputes the no-Mallen `safeZone`, resets
players, stocks the truck, and emits a `roundStart` event.

---

## 5. Network protocol

JSON over a single WebSocket. Types in `constants.js` (`MSG`).

### Client → server
| type | payload | meaning |
|------|---------|---------|
| `join`    | `{name}` | join; server replies `welcome` |
| `input`   | `{x,y}`  | movement vector (server normalizes); `{0,0}` = stop |
| `pickup`  | — | manual grab (auto-pickup usually handles it) |
| `charge`  | — | begin charging a throw (must be carrying) |
| `release` | — | release the throw |
| `punch`   | — | PUNCH/ATTACK: knock tubs loose / Mallen lunge |
| `ready`   | — | pressed LET'S GO |

### Server → client
| type | payload | meaning |
|------|---------|---------|
| `welcome` | `{id}` | assigns the client its player id |
| `state`   | `{snapshot, events}` | full snapshot + drained one-shot events, each tick |

`snapshot`: `{phase, round, countdownMs, arena:{width,height}, loci:{truck,fridge},
safeZone:{x,y,w,h}, roundWinner, players:[...], tubs:[{id,x,y,state}],
presents:[{id,x,y,landed}]}`. Each player carries `{id,name,x,y,dir,isMallen,radius,
score,eaten,carrying,charging,frenzy,ready,stunned,dashing,spriteIndex,effect,
effectMs}`. (`moving` is **not** in the snapshot — the client synthesizes it from
position deltas; see §13.)

`events` (drained each broadcast, one-shot, for SFX/juice):
`join, pickup, throw, score{id}, attack{id,dx,dy,cd}, drop, chomp{id}, restock,
roundEnd, presentDrop, presentClaim{id,fx,buff}, explosion, swap, pinata, dash,
firstCurd, roundStart{n}, stun, bam`. All carry `x,y` where relevant. The client
plays sounds and spawns particles per event (see §9 and SOUND.md).

**Time**: input handlers receive `nowMs` = `game._clock` (monotonic per process,
reset to 0 at round start).

---

## 5.5 Presents & effects

Files: `effects.js` (roller), present/effect logic in `game.js`, tuning in
`constants.js` (`PRESENT`, `EFFECT`, `FX`, `BUFF_POOL`, `DEBUFF_POOL`,
`WILDCARD_POOL`, `MALLEN_BUFF_POOL`, `ONE_SHOT`, `CLIENT_FX`).

**Spawning** (`_updatePresents`): every `spawnMinMs`–`spawnMaxMs` (12–20s), if fewer
than `maxOnField` (2) exist, one parachutes in over `fallDurationMs` to a random
spot. Claimable only once `landed`. First player within `radius` claims it.

**Roll** (`rollEffect`): the Mallen draws from `MALLEN_BUFF_POOL` (= `BUFF_POOL`
minus `curd_cannon`, since he can't throw). Everyone else draws buffs + debuffs +
wildcards, weighted. Timed effects last `EFFECT.defaultDurationMs` (6s); one-shots
apply instantly.

**Effects** (`FX`):
- `double_speed` / `half_speed` — speed multipliers (`_effectiveSpeed`).
- `two_x_points` — doubles a delivery or a Mallen devour.
- `invincible` — punch/attack skips this player (kept their tub); also can't be
  stunned; client shows 3 tubs orbiting the head + loops the invincibility theme.
- `magnet` — pulls loose/ready tubs toward the holder (`_applyMagnets`).
- `curd_cannon` — the next throw flies **~10× as far** (`EFFECT.cannonRangeMult`),
  then disarms. (NOT an enlarged score radius anymore.)
- `tiny` — shrinks radius (`tinyMult`).
- `greased` — drops the carried tub ~1s after grabbing.
- `backwards` — CLIENT: inverts the steering direction (`main.js`).
- `blindness` — CLIENT: cottage-cheese screen overlay (`render.js drawBlindness`).
- `banana` ("slidey") — **server-side ice physics**: velocity eases toward input at
  `EFFECT.bananaAccel` (low = chaotic; slow to start, long coast/overshoot).
- `explosion` (one-shot) — knockback; if the claimer is the Mallen, victims also
  drop tubs.
- `swap` (one-shot) — swap positions with a random player.
- `pinata` (one-shot) — drops `pinataCount` loose tubs around the claimer.

`CLIENT_FX` = `{backwards, blindness}` (the client enforces these by reading its own
`effect`; the server owns assignment/duration). Note `banana` is **no longer**
client-only — it's authoritative server movement now.

**Radius is computed, never mutated piecemeal** (`_computeRadius` = base × tiny ×
frenzy) — the single source of truth (fixed bug; tested).

---

## 6. Controls (client)

`client/input.js` is just drag-to-move + tap. The buttons are HTML elements wired in
`main.js`.

- **Drag**: each frame the character steers toward the finger's world position
  (`screenToWorld` via the camera). A held finger keeps it moving; releasing sends
  `input {0,0}`. Camera follows the self player (`camera.js`).
- **Tap**: sends `pickup` (mostly redundant — pickup is automatic on contact).
- **Action button** (lower-left, `#actionBtn`): **HOLD-TO-THROW** while carrying
  (charge oscillates, release throws), else **PUNCH** (delivery) / **ATTACK**
  (Mallen). Shows a depleting cooldown pie-clock driven by the server's `attack`
  event `cd`.
- Throw/punch direction = your facing (`dir`), shown by the arrow at your feet.
- **LET'S GO** (`#goBtn`) during lobby/leaderboard.

The charge oscillator is mirrored client-side for the visual arc only; the server is
authoritative on release timing.

---

## 7. Tunables (`server/game/constants.js`)

Highlights (everything feel-related lives here):
- `ARENA` 1600×1600. `TICK_RATE` 30.
- `PLAYER.speed` 230. `MALLEN.speed` 230 (equal; frenzy ×1.35). `MALLEN.attackRange`
  70, `attackCooldownMs` 600, `eatRange` 50, `eatDurationMs` 900. (`hitsToDrop` is
  vestigial — one punch knocks loose.)
- `FRENZY` durationMs 4000, sizeMult 1.5, speedMult 1.35, attackCdMult 0.6.
- `STUN` radius 340, durationMs 2000 (Mallen devour shockwave; invincible resists).
- `PUNCH` reach 46, cooldownMs 450, launchSpeed 520, knockback 26, **mallenDash 285,
  dashMs 200** (the Mallen lunge).
- `COLLISION.shove` 6 (running into someone nudges them).
- `SAFE_ZONE` halfW 150, halfH 115, offsetY 30 (no-Mallen pickup zone around truck).
- `THROW` minPower 40 (barely travels), maxPower 1600 (~2× old reach), oscillationHz
  1.0 (slow/readable). **Mirrored in `client/main.js` — keep in sync.**
- `TUB` radius 14, friction 0.90, minSlideSpeed 20, bump 16.
- `LOCI` truckRadius 60, fridgeRadius 54, scoreRadius 80, minSeparation 700,
  edgePadding 120, truckRefillMs 1000.
- `EFFECT` defaultDurationMs 6000, cannonRangeMult 10, bananaAccel 0.7 (lower = more
  slippery), magnetRadius 260, magnetPull 520, explosionRadius 220, etc.
- `ROUND` pointsToWin 10, mallenEatsToWin 10, readyFraction 0.5, startCountdownMs 3000.

Camera tuning is client-side in `client/camera.js`: `VIEW.targetSpan` (380 — world
units across the short screen axis; lower = more zoomed), `minScale`/`maxScale`.

---

## 8. Art

Real art lives in `client/assets/sprites/`, segmented from hand-provided sheets in
`art-source/` by `scripts/segment_art.py` (Python + Pillow; not needed at runtime):

- **Delivery crew**: a grayscale 8-direction walk sheet, recolored into **12 player
  colors** (`PLAYER_COLORS` in render.js mirrors `DELIVERY_COLORS` in the script) ×
  8 directions × 2 frames → `delivery_{v}_{dir}_{f}.png`.
- **Mallen**: a demon 8-direction sheet → vivid-red **frenzy** + desaturated
  **normal** × 8 dirs × 2 frames → `mallen[_frenzy]_{dir}_{f}.png`.
- **Faces**: real head photos → `mallen_face.png` (normal) + `mallen_face_fiend.png`
  (cottage-cheese-smeared), composited bobblehead-style over the demon's head in
  `render.js drawPlayer` (mirrored by facing, bobs while walking).
- **Props**: `tub.png`, `truck.png`, `fridge.png`, `splat_0/1/2.png`, `present.png`,
  `parachute.png`, `birthday_tub.png`, `ad_app_icon.png`, the street-scene floor
  `bg.png` (tiled), and `game-logo.png` (title screen).

8-direction rendering: `drawPlayer` maps `p.dir` to one of 8 facings (`dir8`).
**ART.md** is the spec to hand an image model for new art. The old
`scripts/generate-art.py` procedural baker is legacy/unused.

---

## 9. Audio

`client/audio.js` plays **real `.mp3` files**, with a procedural Web Audio fallback
for incidental events. **SOUND.md** is the authoritative spec — read it before
recording. Summary:

- **`prefetchAudio()`** fetches all audio bytes up front; the JOIN button is gated
  until sprites + audio are ready (so the first round is smooth). A first-load
  native `<audio>` tap primes iOS/WebKit before the Web Audio context starts, then
  clips decode once from the cached bytes.
- **Named SFX** (`SFX_FILES`, played via `playSound`): global cues `dash` (distance-
  attenuated from the Mallen), `firstCurd`, `round`; local cues `score`, `ad`, and
  **one per effect** (`double_speed`, `half_speed`, `banana`, `swap`, …) keyed by the
  `presentClaim` event's `fx`.
- **Music** (`MUSIC_FILES`): looping per-screen tracks — `title` (lobby), `gameplay`
  (countdown/playing), `score` (leaderboard) — crossfaded by `setMusic`. Low volume.
- **Invincibility theme**: `playLoop('invincible_theme')` while the self player is
  invincible, stopped when it ends.
- Incidental events (chomp, splat, throw, stun, etc.) use synthesized `PROCEDURAL`
  sounds; override any via `FILE_SOUNDS`.
- On `visibilitychange→hidden` the audio engine **suspends** and rendering pauses
  (CPU saving while the screen is off); resume calls are guarded by `!document.hidden`.

---

## 10. Tests

`npm test` (Node built-in runner, no deps) — **63 tests**. Driven by seeded RNG
(`tests/helpers.js`) and explicit `tick(dtMs)` steps; no real timers/network.
Coverage includes: roles + promotion, auto/manual pickup + 1s refill, carry-follow,
charge/release projectile + scoring, **punch knock-loose + dash reach + cooldown**,
**catch a thrown tub**, **devour→frenzy→stun-nearby**, **invincibility blocks a
punch**, **slidey coasting**, **magnet doesn't spawn infinite tubs**, **curd cannon
mega-throw scores from range**, the no-Mallen pickup zone, round-end (both wins),
collisions, snapshot serialization, and the per-effect mechanics. **Keep new game
logic in `game.js`/pure modules and add tests there.**

---

## 11. Known gaps / not yet built

1. **No client-side prediction or interpolation.** Movement renders straight from
   30Hz snapshots; on a bad connection it's choppy (the Mallen dash is the most
   visible victim — it steps between snapshots). Add entity interpolation (render
   ~100ms in the past, lerp between snapshots). Highest-value polish item.
2. **Duplicated constants.** `THROW` (server vs `client/main.js`) and the 12-color
   palette (`DELIVERY_COLORS` in the Python script vs `PLAYER_COLORS` in render.js)
   are hand-maintained copies. Serve a constants subset in `welcome` to dedupe.
3. **No reconnect.** A dropped socket ends the session (overlay prompts refresh).
4. **Single Mallen.** If `mallen` isn't taken, there's no Mallen that round.
5. **No aim independent of movement.** Punch/throw fire in your last-moved facing.
6. **`no-store` on all static assets** → re-download every load. Fine for a party;
   relax for production.
7. **Per-effect SFX are placeholders** (copies of one test clip) until real
   recordings land (see SOUND.md).
8. **No keyboard controls** for desktop testing.

---

## 12. Admin

`/admin` (no auth — joke game): preview links render each screen with fake data
(`client/main.js` `fakeSnapshot`, via `?preview=score|countdown|playing|lobby`, no
server connection), and a **POST-only** `RESET SERVER STATE` button hits
`/admin/reset` which does `game = new Game()` and closes all sockets.

---

## 13. Gotchas for whoever continues this

- The Game uses `game._clock` as "now" (ms). `startRound()` resets it to 0.
- **Radius is computed by `_computeRadius`, never mutated piecemeal** (base × tiny ×
  frenzy). Add size effects there only.
- `lastAttackMs` inits to `-1e9`, `greaseGrabMs` to `-1`, `_nextPresentAt` to `null`
  — clock 0 is a valid time, so don't switch these to falsy checks.
- Only `loose` tubs are devoured; `ready` tubs are stationary; `carried`/`flying` are
  simulated. Magnet turns a pulled `ready` tub `loose` **and schedules a refill** (or
  it spawns infinitely).
- `punch()` resolves the hit along the lunge **segment** (`segDist`), so the Mallen's
  long dash hits everyone in his path; it knocks tubs loose in one hit (`hitsToDrop`
  is dead).
- Scoring credits `tub.lastCarrierId`. Fridge scoring is segment-based (anti-tunnel).
- `dir` is the punch/throw direction; the feet arrow visualizes it.
- **`moving`** is synthesized client-side (position delta between snapshots in
  `main.js`) — it is NOT in the server snapshot. Any new code that renders a snapshot
  must set it, or sprites freeze on frame 0 (the `/admin` preview sets `moving:false`).
- The Mallen never auto-attacks; he's driven by the PUNCH/ATTACK button like everyone.
  His devour stuns nearby players (invincible resists).
- Audio resume calls are guarded by `!document.hidden` so a backgrounded tab doesn't
  wake the audio thread (keeps the screen-off CPU saving).
- `index.js` uses `let game` (reassignable for `/admin/reset`); the tick loop and WS
  handlers read the module-level `game`, so they pick up the reset instance.
- Static file server normalizes paths and blocks traversal outside `/client`. Keep
  that check.
- The client tolerates missing art (`assets.js` resolves on error → drawn-circle
  fallback) and missing audio (silent), so a missing asset won't blank the game.
