# Cottage Fiend — Art Asset Specification

This is a hand-off spec for generating the game's art with an image model. Each
asset lists its **filename**, **canvas size**, **transparency**, and a
**description**. Drop the finished PNGs into `client/assets/sprites/` using the
exact filenames below — the game's asset loader already references them, and any
file you replace is picked up automatically (the loader tolerates missing files
and falls back to drawn shapes, so you can deliver them incrementally).

---

## Global art direction

- **Style:** 16-bit, **Streets of Rage 2** era. Hand-pixeled look: chunky pixels,
  bold dark outlines, dithered shading, limited per-sprite palette. NOT smooth
  vector, NOT 3D, NOT modern flat illustration.
- **Mood:** gritty, dark, grimy. Think a rain-slick back-alley at night. Deep
  shadows, muted base tones, scuffed surfaces.
- **Cyberpunk accents:** neon rim-light (electric cyan, hot magenta, acid green),
  faint scanlines/glow, the occasional flickering sign or chrome detail. The
  grit is the base; neon is the highlight, not the whole palette.
- **The cheese is COTTAGE cheese — never cheddar.** No yellow/orange wedges
  anywhere. Cottage cheese = off-white/cream lumpy curds in a milky liquid.
- **Brand:** the tubs are **Lucerne cottage cheese** — a white plastic tub, red
  "Lucerne" script, blue "COTTAGE CHEESE" text, with a clear/white lid you can
  see the curds through. Match that real-world look, just pixel-art-ified.
- **Cottage gore:** lean into wet, messy curd splatter as if it were gore —
  globs, drips, spray, chunks. Off-white curds flung across dark surfaces. This
  is the game's signature visual; be generous and grimy with it.
- **Perspective:** top-down / slight 3/4 overhead (characters seen from above
  and slightly in front, like a SoR2 brawler viewed from higher up). Consistent
  across all character and prop sprites.

## Technical constraints

- **Format:** PNG, RGBA, **transparent background** for every sprite except the
  ad/banner art (those can be opaque).
- **Centering:** the engine draws each sprite centered on a world point, then
  scales it to a target size. Keep the subject centered with a little margin.
- **Resolution:** deliver at **~3× the in-game draw size** for crispness (sizes
  given below), or larger. The canvas uses nearest-neighbor scaling
  (`image-rendering: pixelated`), so true pixel-art at the listed native size
  also looks great — your call. Keep a consistent pixel grid within each sprite.
- **Facing:** characters are drawn facing the viewer/neutral; the engine does not
  flip them per-direction (yet), so a slight forward-facing pose reads best.
- **Animation:** where "2 frames" is noted, deliver a 2-frame walk cycle (e.g.
  opposite legs forward). Frames must register (same center, same scale).

---

## 1. Delivery crew (the protagonists)

Six cottage-cheese delivery workers, each a different color, each with a 2-frame
walk. They haul Lucerne tubs from the truck to the fridge.

- **Files:** `delivery_{V}_{F}.png` for variant `V` = 0–5 and frame `F` = 0,1
  (12 files total).
- **Native size:** 64×64 px (drawn in-game ~53×53).
- **Subject:** a wiry, grimy delivery worker in a courier/uniform jersey, cap or
  beanie, work boots, a Lucerne-branded apron or patch. Cottage-cheese stains
  splattered on the uniform. Tough, scrappy SoR2 pedestrian vibe. Neon trim on
  the uniform (each variant a different neon: cyan, magenta, lime, amber,
  violet, teal — matching its base color). Frame 0 / frame 1 = mid-stride
  opposite legs.
- **Variant colors (base jersey):** 0 red, 1 blue, 2 green, 3 gold, 4 purple,
  5 teal. Keep silhouette identical across variants; only recolor.

## 2. The Mallen (the boss)

The villain: a hulking cottage-cheese fiend, bigger than everyone, who pummels
the crew and devours dropped tubs. Goes into a flashing **frenzy** when he eats.

- **Files:** `mallen_0.png`, `mallen_1.png` (normal, 2-frame walk),
  `mallen_frenzy_0.png`, `mallen_frenzy_1.png` (frenzy, 2-frame walk).
- **Native size:** 96×96 px (drawn in-game ~82×82, ~122 in frenzy).
- **Subject:** a massive, menacing brute — bloated and powerful, dripping with
  cottage cheese like a creature made of curds and muscle. Dark, grimy, a little
  monstrous. Cyberpunk menace: maybe a chrome augment, a glowing eye, neon veins.
  **Leave the head/face area as a neutral blank oval** (see asset 3) OR deliver
  with your own face — see the face note below.
- **Frenzy variant:** same pose, but enraged — engorged, color-shifted toward
  hot red/magenta, crackling neon energy, curds flying off him, eyes blazing.
- **Face note:** by default the engine composites a separate face image (asset 3)
  onto the Mallen's head, so the body sprite should have an empty head zone. If
  you'd rather bake a full face into the body, that's fine — just say so and we
  remove the compositing step.

## 3. The Mallen's face

Composited onto the Mallen's head each frame (and replaceable to give him a real
face / multiple expressions later).

- **File:** `mallen_face_placeholder.png` (replace this exact name).
- **Native size:** 160×160 px (drawn in-game ~40×40 on the head).
- **Subject:** a single menacing face/head — gritty, intense, cyberpunk-tinged.
  Transparent background, roughly head-shaped (square-ish is fine). This is the
  one asset you may want to make a real character portrait.

## 4. Lucerne cottage cheese tub (THE hero prop)

The single most important object. It is the deliverable, the score item, the
thing the Mallen eats, AND the game's menu/HUD icon. Get this one right.

- **File:** `tub.png`
- **Native size:** 40×40 px (drawn in-game ~30–34; also shown small in menus).
- **Subject:** a **Lucerne cottage cheese tub** — white plastic tub, red
  "Lucerne" script across the front, blue "COTTAGE CHEESE" beneath it, a
  clear/white domed lid heaped with visible off-white curds. Top-down-ish so both
  the lid (curds) and the front label read. Must look unmistakably like a tub of
  white cottage cheese, never a cheese wedge. Crisp at small sizes — this gets
  rendered tiny, so keep the silhouette and label legible.

## 5. Delivery truck (the spawn point)

Where ready tubs appear. A grimy refrigerated box truck plastered with Lucerne
branding.

- **File:** `truck.png`
- **Native size:** 160×120 px.
- **Subject:** a beat-up 16-bit delivery truck, side/three-quarter view, dark and
  weathered, neon underglow. A giant **Lucerne cottage cheese tub** mural on the
  box (white tub, red script, curds), grime streaks, mismatched panels. Reads as
  "cheese delivery rig that's seen some things."

## 6. Fridge (the goal)

Where tubs are delivered to score. A big industrial/commercial fridge.

- **File:** `fridge.png`
- **Native size:** 110×130 px.
- **Subject:** a tall grimy commercial refrigerator, double-door, chrome handles,
  a flickering neon "OPEN"/cooler glow leaking from the door seam. Lucerne
  stickers/magnets, curd drips down the front. Dark, industrial, cyberpunk-lit.

## 7. Cottage gore splatter (3 frames)

The signature effect — sprayed on hits, chomps, drops, explosions. Make it nasty.

- **Files:** `splat_0.png`, `splat_1.png`, `splat_2.png` (3 variations).
- **Native size:** 64×64 px (drawn in-game ~48×48).
- **Subject:** a wet burst of cottage-cheese "gore" — off-white/cream curd chunks,
  milky liquid, stringy drips and spray radiating from center. Three distinct
  splat shapes so repeated splats don't look identical. Transparent background,
  no surface under it (it's overlaid on the scene). Grimy, visceral, a little
  gross — like curdled gore.

## 8. Parachuting present (power-up box)

Gift boxes parachute in carrying random power-ups/curses.

- **Files:** `present.png` (the box), `parachute.png` (the canopy above it).
- **Native sizes:** present 52×52 px, parachute 96×96 px.
- **Subject (present):** a gift-wrapped box, dark grimy wrapping with a neon
  ribbon and bow, a stray curd or two stuck to it. SoR2 item-drop energy.
- **Subject (parachute):** a tattered military/cargo parachute canopy with cords,
  grimy fabric, faint neon panel lines. Drawn above the box while it descends.

## 9. Birthday tub (leaderboard centerpiece)

It's the Mallen's birthday — shown big on the end-of-round leaderboard.

- **File:** `birthday_tub.png`
- **Native size:** 220×200 px (drawn ~200×182).
- **Subject:** a giant **Lucerne cottage cheese tub** as a birthday "cake" —
  heaped curds on top with three lit candles stuck in the curds, the Lucerne
  label on front, a few festive (grimy/neon) touches. Celebratory but still in
  the dark/gritty world. Transparent background.

---

## Optional / nice-to-have

### Fake mobile-game "ad" art (optional)
The game shows ONE ridiculous fake mobile-game ad banner pinned at the top of the
screen (currently drawn procedurally in code using the tub as the app icon). If
you want a custom look, you could supply:

- **File:** `ad_app_icon.png`, ~96×96, transparent — a rounded "app icon" for a
  fake, absurd cottage-cheese mobile game (e.g. "CURD CLASH", "MERGE CHEESE
  EMPIRE"). Glossy mobile-game-icon style but about cottage cheese. Optional;
  if absent, the tub art is used as the icon.

The previous `ad_0.png`…`ad_6.png` banner files are **no longer used** (the ad is
now a single code-drawn banner) — you can ignore/delete them.

---

## Filename checklist

```
delivery_0_0.png  delivery_0_1.png   ... delivery_5_0.png  delivery_5_1.png   (12)
mallen_0.png  mallen_1.png  mallen_frenzy_0.png  mallen_frenzy_1.png          (4)
mallen_face_placeholder.png                                                   (1)
tub.png                                                                       (1)
truck.png                                                                     (1)
fridge.png                                                                    (1)
splat_0.png  splat_1.png  splat_2.png                                         (3)
present.png  parachute.png                                                    (2)
birthday_tub.png                                                              (1)
ad_app_icon.png  (optional)
```
