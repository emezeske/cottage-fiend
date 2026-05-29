// All tunable game parameters live here. Server is authoritative; client reads a
// subset for rendering only. Keep this file dependency-free so tests can import it.

export const TICK_RATE = 30;                 // server simulation ticks per second
export const TICK_MS = 1000 / TICK_RATE;

export const ARENA = {
  width: 1600,
  height: 1600,
};

// --- Players ---------------------------------------------------------------
export const PLAYER = {
  radius: 22,
  speed: 230,                // px/sec for delivery folk
  carryOffset: 26,           // how far in front the carried tub sits
};

export const MALLEN = {
  name: 'mallen',            // case-insensitive match claims the role
  radius: 34,                // bigger than everyone
  speed: 230,                // same as deliveries (frenzy still makes him faster)
  attackRange: 70,           // auto-attack proximity (center distance)
  attackCooldownMs: 600,     // time between auto hits
  hitsToDrop: 2,             // hits before a victim drops their tub
  eatRange: 50,              // how close a loose tub must be to be devoured
  eatDurationMs: 900,        // chomp animation lock
};

export const FRENZY = {
  durationMs: 4000,
  sizeMult: 1.5,
  speedMult: 1.35,
  attackCdMult: 0.6,         // attacks faster (lower cooldown)
};

// When the Mallen devours a tub, everyone nearby is stunned: frozen + drops their
// tub for a couple seconds. Invincible players resist.
export const STUN = {
  radius: 240,               // shockwave radius at default power (scaled by MALLEN_POWER)
  durationMs: 2000,          // freeze length at default power (scaled by MALLEN_POWER)
};

// Live-tunable Mallen difficulty (admin dashboard). Level 3 is the default; each
// preset multiplies his base stats. Higher = harder for the delivery crew.
// Frenzy multipliers stack on top of these (so frenzy auto-scales with power).
export const MALLEN_POWER = {
  1: { speed: 0.85, attackCd: 1.45, dash: 0.80, stunRadius: 0.55, stunDur: 0.70 },
  2: { speed: 0.92, attackCd: 1.20, dash: 0.90, stunRadius: 0.75, stunDur: 0.85 },
  3: { speed: 1.00, attackCd: 1.00, dash: 1.00, stunRadius: 1.00, stunDur: 1.00 },
  4: { speed: 1.10, attackCd: 0.80, dash: 1.12, stunRadius: 1.30, stunDur: 1.15 },
  5: { speed: 1.22, attackCd: 0.62, dash: 1.25, stunRadius: 1.60, stunDur: 1.30 },
};
export const MALLEN_POWER_DEFAULT = 3;

// --- Tubs / throwing -------------------------------------------------------
export const TUB = {
  radius: 14,
  friction: 0.90,            // per-tick velocity damping when sliding
  minSlideSpeed: 20,         // below this, a sliding tub comes to rest (loose)
  bump: 16,                  // px a non-catching player is shoved by a tub that hits them
};

// Punching (delivery players steal tubs; the Mallen attacks). One punch knocks a
// carried tub loose, launched in the puncher's facing direction, for a scramble.
export const PUNCH = {
  reach: 46,                 // added to the puncher's radius for delivery players
  cooldownMs: 450,           // min time between delivery punches (Mallen uses MALLEN.attackCooldownMs)
  launchSpeed: 520,          // px/sec the knocked-loose tub flies
  knockback: 26,             // px the punched player is shoved
  mallenDash: 285,           // px the Mallen lunges forward when he punches (skill-based)
  dashMs: 200,               // duration of that lunge (animated, not a teleport)
};

// Player-vs-player contact: the mover shoves whoever they run into.
export const COLLISION = {
  shove: 6,                  // px per tick of contact, scaled by the mover's input
};

// The truck "pickup zone": a rectangle around the truck that the Mallen cannot
// enter, so it can't camp the truck. Delivery players grab tubs here safely.
export const SAFE_ZONE = {
  halfW: 150,                // half width of the zone
  halfH: 115,                // half height of the zone
  offsetY: 30,               // shift down so the zone covers the ready tubs below the truck
};

export const THROW = {
  minPower: 40,              // px/sec at weakest release (basically drops at your feet)
  maxPower: 1600,            // px/sec at strongest release (~2x the old reach)
  oscillationHz: 1.0,        // full charge cycles per second (lower = easier to time)
  // power oscillates min->max->min; release timing picks the value
};

// --- Loci (truck + fridge) -------------------------------------------------
export const LOCI = {
  truckRadius: 60,
  fridgeRadius: 54,
  scoreRadius: 80,           // a tub landing within this of fridge center scores
  minSeparation: 700,        // truck and fridge spawn at least this far apart
  edgePadding: 120,          // keep loci away from arena edges
  truckRefillMs: 1000,       // a new ready tub appears 1s after one is taken
  truckTubGap: 26,           // spacing of the ready tubs shown on the truck
};

// --- Round -----------------------------------------------------------------
export const ROUND = {
  pointsToWin: 10,           // a delivery player reaching this ends the round
  mallenEatsToWin: 10,       // Mallen devouring this many tubs ends the round
  startCountdownMs: 3000,    // brief countdown before a round goes live
  readyFraction: 0.5,        // fraction of players who must press LET'S GO
};

export const PHASE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  LEADERBOARD: 'leaderboard',
};

// Network message types (client <-> server)
export const MSG = {
  // client -> server
  JOIN: 'join',
  INPUT: 'input',           // movement vector
  PICKUP: 'pickup',         // tap to grab nearest tub
  CHARGE: 'charge',         // begin charging a throw
  RELEASE: 'release',       // release throw at current oscillator value
  PUNCH: 'punch',           // punch button: knock a tub loose / Mallen attack
  READY: 'ready',           // LET'S GO button
  // server -> client
  WELCOME: 'welcome',       // assigns id, sends constants
  STATE: 'state',           // full snapshot
  EVENT: 'event',           // one-shot events for SFX/juice (chomp, splat, score)
};

// --- Presents (parachuting gift boxes) -------------------------------------
export const PRESENT = {
  spawnMinMs: 12000,        // randomized spawn interval lower bound
  spawnMaxMs: 20000,        // upper bound
  maxOnField: 2,            // max unclaimed presents at once
  fallDurationMs: 2600,     // parachute descent time before it's claimable
  radius: 26,               // claim radius (touch to claim)
  fallStartY: -60,          // spawns above the arena and drifts down
};

// Effect durations (ms). One-shot effects use duration 0.
export const EFFECT = {
  defaultDurationMs: 6000,
  explosionRadius: 220,     // super-saiyan knockback radius
  explosionKnockback: 480,  // px/sec imparted
  magnetRadius: 260,        // pull loose/ready tubs within this
  magnetPull: 520,          // px/sec toward the player
  cannonRangeMult: 10,      // curd cannon: next throw flies ~10x as far
  pinataCount: 3,           // tubs dropped by tub piñata
  tinyMult: 0.6,            // size multiplier while 'tiny'
  doubleSpeedMult: 2.0,
  halfSpeedMult: 0.5,
  bananaAccel: 0.7,         // 'slidey': how fast velocity eases toward input (lower = more slippery; also the coast-to-stop rate). low = chaotic ice
  interstitialMs: 3000,     // forced ad-break debuff: you're stunned this long while the skip timer counts down
  goldenCurdMs: 3000,       // golden-curd buff: brief freeze while the celebration plays (also the client anim length)
};

// Effect ids. Server-authoritative unless noted CLIENT (input/render only).
export const FX = {
  DOUBLE_SPEED: 'double_speed',
  TWO_X_POINTS: 'two_x_points',
  INVINCIBLE: 'invincible',
  EXPLOSION: 'explosion',        // one-shot
  MAGNET: 'magnet',
  CURD_CANNON: 'curd_cannon',
  HALF_SPEED: 'half_speed',
  BACKWARDS: 'backwards',        // CLIENT: inverts input
  GREASED: 'greased',            // drops carried tub after ~1s
  TINY: 'tiny',
  BLINDNESS: 'blindness',        // CLIENT: screen splatter overlay
  BANANA: 'banana',              // slidey ice-physics movement (server-side momentum)
  SWAP: 'swap',                  // one-shot wildcard
  PINATA: 'pinata',              // one-shot wildcard
  INTERSTITIAL: 'interstitial',  // debuff: forced full-screen ad; you're stunned ~3s
  GOLDEN_CURD: 'golden_curd',    // buff: instant +1 point with a big celebration (brief freeze)
  CORGI_ATTACK: 'corgi_attack',  // buff: spawns a corgi that hunts and stuns everyone else
  DISC_GOLF: 'disc_golf',        // buff: periodically flings frisbees that bonk + stun others
  DANCE_PARTY: 'dance_party',    // buff: nearby players are forced to dance (stunned) while music plays
};

// Dance-party buff: everyone within radius of the initiator is stunned into dancing
// for the duration (the initiator is unaffected). They + the initiator hear the music.
export const DANCE = {
  radius: 260,
  durationMs: 6000,
};

// Disc-golf buff: while active, the player periodically flings a spinning disc in a
// random direction. A disc bonks any OTHER player it flies through with a brief stun.
export const DISC = {
  radius: 18,
  minSpeed: 340, maxSpeed: 520,  // launch speed (randomized) -> distance
  minLifeMs: 850, maxLifeMs: 1450,
  spawnIntervalMs: 650,          // a new disc roughly this often while the buff lasts
  stunMs: 1300,                  // brief stun on hitting another player
};

// The corgi spawned by the CORGI_ATTACK buff: a fast NPC that wanders, charges any
// player it detects, runs through them and stuns them, then picks a new victim. It
// never attacks the same person twice or the player who spawned it.
export const CORGI = {
  radius: 22,
  speed: 252,            // px/sec while wandering
  chargeSpeed: 315,      // px/sec while charging a victim
  detectRadius: 340,     // start charging an eligible player within this range
  touchRadius: 40,       // corgi-center -> player-center distance that lands a hit
  stunMs: 2000,          // victim stun duration
  lifeMs: 8000,          // lifespan (≈ the buff duration)
  wanderRetargetMs: 600, // re-randomize the wander heading roughly this often
};

// Pools with weights. Mallen draws ONLY from buffs (it's his birthday).
export const BUFF_POOL = [
  { fx: FX.DOUBLE_SPEED, w: 3 },
  { fx: FX.TWO_X_POINTS, w: 3 },
  { fx: FX.INVINCIBLE,   w: 2 },
  { fx: FX.EXPLOSION,    w: 2 },
  { fx: FX.MAGNET,       w: 2 },
  { fx: FX.CURD_CANNON,  w: 2 },
  { fx: FX.GOLDEN_CURD,  w: 2 },
  { fx: FX.CORGI_ATTACK, w: 2 },
  { fx: FX.DISC_GOLF,    w: 2 },
  { fx: FX.DANCE_PARTY,  w: 2 },
];
export const DEBUFF_POOL = [
  { fx: FX.HALF_SPEED, w: 3 },
  { fx: FX.BACKWARDS,  w: 3 },
  { fx: FX.GREASED,    w: 2 },
  { fx: FX.TINY,       w: 2 },
  { fx: FX.BLINDNESS,  w: 2 },
  { fx: FX.BANANA,     w: 2 },
  { fx: FX.INTERSTITIAL, w: 2 },
];
export const WILDCARD_POOL = [
  { fx: FX.SWAP,    w: 1 },
  { fx: FX.PINATA,  w: 2 },
];

// The Mallen only rolls buffs that actually apply to him — he can't throw, so the
// curd cannon (a throw buff) is excluded.
export const MALLEN_BUFF_POOL = BUFF_POOL.filter((e) => e.fx !== FX.CURD_CANNON);

// One-shot effects (applied instantly, no active duration).
export const ONE_SHOT = new Set([FX.EXPLOSION, FX.SWAP, FX.PINATA, FX.INTERSTITIAL, FX.GOLDEN_CURD, FX.CORGI_ATTACK, FX.DANCE_PARTY]);
// Client-only effects (server still tracks them so the client can read its own).
export const CLIENT_FX = new Set([FX.BACKWARDS, FX.BLINDNESS]);
