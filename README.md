# 🧀 Cottage Fiend

A multiplayer joke game. Delivery people haul cottage cheese tubs from a truck to
a fridge. **The Mallen** — whoever joins with the name `mallen` — is a giant
cottage-cheese fiend who beats up the delivery crew, devours dropped tubs, and
goes into a flashing, growing frenzy. First delivery player to 10 deliveries wins;
The Mallen wins by eating 10 tubs. Gift-wrapped **presents** parachute in for
random power-ups and curses (it's The Mallen's birthday, so he only ever gets
buffs). Everything is cottage cheese. There are ads.

Built to run as a **single Node service** (authoritative WebSocket game server +
static client) so it deploys to Railway in one shot.

## Quick start (local)

```bash
npm install
npm start
# open http://localhost:8080 in two browser tabs/phones
```

Name one player `mallen` to be The Mallen. Everyone else is a delivery person.

## Controls

- **Drag** anywhere to move your character (direction from your drag).
- **Tap** a tub to pick it up (tubs sit ready on the truck; loose tubs on the ground).
- **Double-tap and hold** to charge a throw. A power bar oscillates fast in your
  facing direction — **release** to throw. Land it within range of the fridge to score.
- The Mallen auto-attacks nearby delivery people; two hits and they drop their tub.
- **Walk onto a landed present** to claim a random power-up or debuff.

## Deploy to Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
3. No env vars needed. Railway sets `PORT`; the server reads it automatically.
4. Once deployed, open the public URL. Share it. Chaos ensues.

`railway.json` already sets the start command and restart policy. The server serves
the client from `/client`, so one service does everything — no separate frontend host.

## Tests

```bash
npm test          # runs all unit tests (Node built-in test runner)
npm run test:watch
```

All game logic lives in pure, testable modules under `server/game/`. The networking
layer (`server/index.js`) is a thin wrapper around the tested `Game` class.

## Regenerating art

Art is pre-baked into `client/assets/sprites/`. To regenerate (requires Python +
Pillow, NOT needed at runtime):

```bash
python3 scripts/generate-art.py
```

### Adding The Mallen's real face

Replace `client/assets/sprites/mallen_face_placeholder.png` with your own
square-ish PNG (transparent background works best). The renderer composites it
onto The Mallen's head automatically. To use multiple expressions later, see
`DESIGN.md` → "Mallen face system".

### Adding real sound effects (optional)

The game synthesizes all SFX in-browser via Web Audio, so it works with zero audio
files. To use real CC0 clips instead, drop files in `client/assets/sounds/` and map
them in `client/audio.js` → `FILE_SOUNDS`. Good CC0 sources: Freesound (CC0 filter),
Kenney.nl, OpenGameArt (CC0). Suggested shopping list: a wet squelch, a cartoon
chomp, a whoosh, a ding, a crowd cheer.

## Architecture at a glance

```
server/
  index.js          WebSocket + static server + 30Hz tick loop (thin wrapper)
  game/
    constants.js    ALL tunable parameters
    game.js         authoritative simulation (pure, fully tested)
    vec.js          geometry/oscillator helpers (pure)
    spawn.js        randomized loci/spawns (injectable RNG)
client/
  index.html        join screen + canvas
  main.js           WS client, input wiring, render loop
  render.js         canvas rendering (pure draw from snapshot)
  input.js          touch/mouse: drag-move, tap-pickup, hold-charge-release
  audio.js          procedural Web Audio SFX (+ optional file overrides)
  assets.js         sprite manifest/loader
  assets/sprites/   pre-baked PNGs
tests/              unit tests for all game logic
scripts/
  generate-art.py   one-shot art baker
DESIGN.md           full design doc — feed this to Claude Code to continue
```

See **DESIGN.md** for the complete design, current state, known gaps, and a
prioritized backlog written specifically to hand off to Claude Code.
