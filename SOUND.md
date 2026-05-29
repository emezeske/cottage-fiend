# Cottage Fiend — Sound Effects

All sound files live in **`client/assets/sounds/`**. To replace a sound, just
**record your clip and overwrite the file with the same name** — no code changes
needed. Keep filenames exactly as listed.

- **Format:** `.mp3` (also fine: `.wav`, `.ogg` — but keep the `.mp3` filename, or
  tell me and I'll change the mapping in `client/audio.js`).
- **Length:** the SFX are short one-shots (most ≈ 0.3–1.5s, play once). The
  invincibility theme and the music tracks **loop**, so they can be longer.
- **Most SFX are real audio.** Still placeholders to record (silent for now):
  `sfx_corgi_attack` and `sfx_disc_golf`. To fill any clip, drop an mp3 with the
  same name in `client/assets/sounds/` (or hand me a `.wav` and I'll convert it).
- All audio is **preloaded** before the JOIN button enables (so the first round is
  smooth).

---

## The six main SFX (record these)

| File | Triggers when… | Who hears it |
|------|----------------|--------------|
| `sfx_dash.mp3` | The Mallen **dashes** (his ATTACK lunge) | Everyone, but **volume falls off with distance** from the Mallen — loud up close, silent across the map |
| `sfx_first_curd.mp3` | The **first score of the round** by anyone — a delivery player delivering OR the Mallen devouring his first tub. Fires **once per round** | **Global** (everyone, full volume) |
| `sfx_round.mp3` | A **round starts** (the "ROUND N: CURD" intro, during the countdown) | **Global** |
| `sfx_round_over.mp3` | A **round ends** (the leaderboard "round over" sting) | **Global** |
| `sfx_score.mp3` | **You score** — a delivery player delivering a tub to the fridge, or the Mallen devouring a tub | **Local** — only the scorer |
| `sfx_ad_1.mp3` / `_2` / `_3` | **You tap the top ad banner** — one of the three is picked at random | **Local** — only the tapper |

Presents play a **per-effect** sound (see the next section) instead of one generic powerup/curse cue.

Notes:
- **Global** = the same sound plays for every connected player.
- **Local** = only the one affected player's device plays it.
- **Distance-attenuated** (dash only): gain ≈ `0.6 / (1 + (distance/350)²)`. Tunable
  in `client/main.js` (the `350` reference distance).
- On the **first** score of a round the scorer hears both `sfx_score` (local) and
  everyone hears `sfx_first_curd` (global) — that's expected.

---

## Per-effect present sounds (one each)

When **you** walk onto a parachuting present, you (and only you) hear the sound for
the specific effect you rolled. The Mallen only ever rolls buffs (never the
debuffs, and never curd cannon since he can't throw).

**Buffs (good):**

| File | Effect |
|------|--------|
| `sfx_double_speed.mp3` | move twice as fast |
| `sfx_two_x_points.mp3` | next delivery / devour counts double |
| `sfx_invincible.mp3` | can't be attacked, shoved, or stunned |
| `sfx_explosion.mp3` | one-shot blast that knocks everyone back |
| `sfx_magnet.mp3` | pulls loose tubs toward you |
| `sfx_curd_cannon.mp3` | next throw flies ~10× as far (delivery only) |
| `sfx_golden_curd.mp3` | instant +1 point with the big celebration |
| `sfx_corgi_attack.mp3` | spawns a hunter corgi *(placeholder — record this one)* |
| `sfx_disc_golf.mp3` | periodically flings frisbees that bonk others *(placeholder — record this one)* |

**Curses (bad):**

| File | Effect |
|------|--------|
| `sfx_half_speed.mp3` | move at half speed |
| `sfx_backwards.mp3` | controls are inverted |
| `sfx_greased.mp3` | you drop a carried tub ~1s after grabbing it |
| `sfx_tiny.mp3` | you shrink |
| `sfx_blindness.mp3` | screen splattered with cottage cheese |
| `sfx_banana.mp3` | slidey/ice-physics movement |
| `sfx_interstitial.mp3` | forced full-screen ad; you're stunned ~3s |

**Wildcards (chaotic, anyone):**

| File | Effect |
|------|--------|
| `sfx_swap.mp3` | swap positions with a random player |
| `sfx_pinata.mp3` | drops a few loose tubs around you |

---

## Looping audio (theme + music)

These **loop** while active, so they can be longer clips.

| File | Folder | Plays when… | Who hears it |
|------|--------|-------------|--------------|
| `invincible.mp3` | `client/assets/sounds/` | **You** are invincible (the buff is active); stops when it wears off | **Local** — only the invincible player |
| `title.mp3` | `client/assets/music/` | On the **lobby / title** screen | Everyone (each on their own device) |
| `gameplay.mp3` | `client/assets/music/` | During the **countdown + active round** | Everyone |
| `score.mp3` | `client/assets/music/` | On the **leaderboard / score** screen | Everyone |

The three music tracks crossfade into each other on screen changes (~0.7s) and play
at a low background volume (`MUSIC_VOL` in `client/audio.js`). Overwrite any file
with the same name to replace it.

---

## Optional: replacing the other in-game sounds

Everything else is currently **synthesized in-browser** (no file needed) in
`client/audio.js`. To swap any of them for a real recording, drop a file in
`client/assets/sounds/` and add a line to the `FILE_SOUNDS` map at the top of
`client/audio.js`, e.g. `chomp: 'chomp.mp3',`. A present file overrides the
synthesized version. These play **globally** (every player) when their event fires:

| Event | Fires when… |
|-------|-------------|
| `pickup` | a tub is picked up / caught |
| `throw` | a tub is thrown |
| `score` | a delivery is scored at the fridge (plays a synth cheer for everyone — separate from the local `sfx_score`) |
| `attack` | a punch/attack swing |
| `bam` | a punch connects (the "BAM!" hit) — *(no synth sound yet; add to `FILE_SOUNDS` to give it one)* |
| `drop` | a carried tub is knocked loose |
| `chomp` | the Mallen devours a tub |
| `stun` | the Mallen's devour shockwave stuns nearby players |
| `splat` | a tub splatters (hit/landing) |
| `discHit` | a disc-golf frisbee bonks any player or the Mallen (synth "bonk") |
| `presentDrop` | a present parachutes in |
| `presentClaim` | a present is claimed (synth sparkle for everyone — separate from the local `sfx_powerup`/`sfx_curse`) |
| `explosion` | the explosion power-up knockback |
| `swap` | the swap-positions wildcard |
| `pinata` | the tub-piñata wildcard |
| `roundEnd` | a round is won — **now wired to `sfx_round_over.mp3`** (overrides the synth) |
| `join` | a player joins |

> Want any of these promoted to a dedicated named slot (like the six above) or
> made local/distance-attenuated? Say which and I'll wire it up.
