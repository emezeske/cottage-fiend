# 🧀 Cottage Fiend

A multiplayer joke game, themed entirely around cottage cheese. Delivery people
haul **Lucerne/Daisy cottage cheese tubs** from a truck to a fridge. **The Mallen**
— whoever joins with the name `mallen` — is a hulking cottage-cheese fiend who
beats up the delivery crew, devours dropped tubs, and goes into a flashing, growing
frenzy. First delivery player to 10 deliveries wins the round; The Mallen wins by
devouring 10 tubs. Gift-wrapped **presents** parachute in for random power-ups and
curses (it's The Mallen's birthday, so he only ever gets buffs that apply to him).
Streets-of-Rage-flavored, gritty, loud, and absolutely covered in cottage cheese.
There are ads.

Built to run as a **single Node service** (authoritative WebSocket game server +
static client) so it deploys to Railway in one shot.

## Quick start (local)

```bash
npm install
npm start      # http://localhost:8080 — also prints your LAN URL for phones
npm run dev    # same, with --watch auto-restart
```

Open the URL in two tabs (or phones on the same Wi-Fi). Name one player `mallen`
to be The Mallen; everyone else is a delivery person. Press **LET'S GO** once 50%
of players are ready to start a round.

## Controls (touch + mouse)

- **Drag** anywhere to move — your character walks toward your finger, and the
  camera follows you around the arena.
- **Run over a tub** to grab it automatically (ready tubs sit at the truck; loose
  tubs lie on the ground). No tapping needed.
- **HOLD-TO-THROW button** (lower-left, appears while carrying): hold to charge —
  a power bar oscillates along your facing direction — and **release** to fling the
  tub. Or just **walk a carried tub into the fridge** to deliver it.
- **PUNCH / ATTACK button** (lower-left, when empty-handed): knocks a carried tub
  out of a nearby player's hands, launched in your facing direction, for a scramble.
  The Mallen's ATTACK lunges him forward and plows through the crowd.
- A small **arrow at your feet** shows your current facing (punch/throw direction).
- **Walk onto a landed present** to claim a random power-up or curse.

The Mallen does **not** auto-attack — he uses the same ATTACK button. When he
devours a tub, everyone nearby is **stunned** and drops their tub.

## Deploy to Railway

1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo**, pick this repo.
3. No env vars. Railway sets `PORT`; the server reads it automatically.
4. Open the public URL, **Settings → Networking → Generate Domain** for a share link.

`railway.json` sets the start command (`npm start`) and restart policy. The server
serves the client from `/client`, so one service does everything — no separate
frontend host, no CORS. The static server currently sends `Cache-Control: no-store`
(handy during iteration; relax it for production if you care about caching).

## Admin

`/admin` (no auth — it's a joke game) has **preview links** that render each screen
with fake data (`?preview=score|countdown|playing|lobby`, no server connection) and
a **POST-only RESET SERVER STATE** button that wipes all state and kicks players.

## Tests

```bash
npm test          # 63 unit tests (Node built-in runner, no deps)
npm run test:watch
```

All game logic lives in pure, testable modules under `server/game/`. The networking
layer (`server/index.js`) is a thin wrapper around the tested `Game` class — keep it
that way (don't put game logic in `index.js`).

## Art

Real art is segmented from hand-provided sheets in `art-source/` by
`scripts/segment_art.py` (Python + Pillow; not needed at runtime) into the PNGs in
`client/assets/sprites/`: 12 color-recolored delivery crew × 8 directions × 2 walk
frames, the Mallen (red "fiend" frenzy + desaturated normal) × 8 directions × 2
frames, the Mallen's composited face (normal + cottage-cheese fiend), the tub,
truck, fridge, splatters, present, parachute, birthday tub, the street-scene floor
(`bg.png`), and the title logo. **`ART.md`** is the asset spec to hand to an image
model. (The old `scripts/generate-art.py` procedural baker is legacy/unused.)

## Audio

Real `.mp3` files in `client/assets/sounds/` (SFX) and `client/assets/music/` (per-
screen looping music, crossfaded). Everything is preloaded before the JOIN button
enables; a first-load native `<audio>` tap primes iOS/WebKit before Web Audio starts.
A few incidental events still fall back to in-browser Web Audio synthesis.
**`SOUND.md`** documents every sound file and exactly when it triggers — read it
before recording replacements.

## Architecture at a glance

```
server/
  index.js          WebSocket + static server + 30Hz tick loop + /admin (thin wrapper)
  game/
    constants.js    ALL tunable parameters
    game.js         authoritative simulation (pure, fully tested)
    effects.js      weighted power-up/curse roller (injectable RNG)
    vec.js          geometry + charge oscillator (pure)
    spawn.js        randomized loci/spawns (injectable RNG)
client/
  index.html        title screen (logo) + canvas
  main.js           WS client, input wiring, audio triggers, render loop
  render.js         canvas rendering + all the juice (pure draw from snapshot)
  camera.js         following camera + screen↔world transform
  input.js          touch/mouse: drag-to-move, tap
  audio.js          file SFX + looping music (preloaded) + procedural fallback
  assets.js         sprite manifest/loader
  admin.html        /admin preview links + server reset
  assets/sprites|music|sounds/   real art + audio
scripts/segment_art.py   art segmenter (art-source/ sheets -> sprites)
tests/*.test.js          unit tests
ART.md / SOUND.md / DESIGN.md   asset spec / sound spec / full design doc
```

See **DESIGN.md** for the complete design, network protocol, every tunable, and the
current state.
