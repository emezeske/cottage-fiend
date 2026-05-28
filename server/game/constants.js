// All tunable game parameters live here. Server is authoritative; client reads a
// subset for rendering only. Keep this file dependency-free so tests can import it.

export const TICK_RATE = 30;                 // server simulation ticks per second
export const TICK_MS = 1000 / TICK_RATE;

export const ARENA = {
  width: 1280,
  height: 720,
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
  speed: 190,                // a little slower than deliveries
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

// --- Tubs / throwing -------------------------------------------------------
export const TUB = {
  radius: 14,
  friction: 0.90,            // per-tick velocity damping when sliding
  minSlideSpeed: 20,         // below this, a sliding tub comes to rest (loose)
};

export const THROW = {
  minPower: 260,             // px/sec at weakest release
  maxPower: 820,             // px/sec at strongest release
  oscillationHz: 2.4,        // full charge cycles per second (fast = hard)
  // power oscillates min->max->min; release timing picks the value
};

// --- Loci (truck + fridge) -------------------------------------------------
export const LOCI = {
  truckRadius: 60,
  fridgeRadius: 54,
  scoreRadius: 80,           // a tub landing within this of fridge center scores
  minSeparation: 520,        // truck and fridge spawn at least this far apart
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
  cannonScoreMult: 3.2,     // curd cannon enlarges the fridge score radius
  pinataCount: 3,           // tubs dropped by tub piñata
  tinyMult: 0.6,            // size multiplier while 'tiny'
  doubleSpeedMult: 2.0,
  halfSpeedMult: 0.5,
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
  BANANA: 'banana',              // CLIENT: slidey momentum feel
  SWAP: 'swap',                  // one-shot wildcard
  PINATA: 'pinata',              // one-shot wildcard
};

// Pools with weights. Mallen draws ONLY from buffs (it's his birthday).
export const BUFF_POOL = [
  { fx: FX.DOUBLE_SPEED, w: 3 },
  { fx: FX.TWO_X_POINTS, w: 3 },
  { fx: FX.INVINCIBLE,   w: 2 },
  { fx: FX.EXPLOSION,    w: 2 },
  { fx: FX.MAGNET,       w: 2 },
  { fx: FX.CURD_CANNON,  w: 2 },
];
export const DEBUFF_POOL = [
  { fx: FX.HALF_SPEED, w: 3 },
  { fx: FX.BACKWARDS,  w: 3 },
  { fx: FX.GREASED,    w: 2 },
  { fx: FX.TINY,       w: 2 },
  { fx: FX.BLINDNESS,  w: 2 },
  { fx: FX.BANANA,     w: 2 },
];
export const WILDCARD_POOL = [
  { fx: FX.SWAP,    w: 1 },
  { fx: FX.PINATA,  w: 2 },
];

// One-shot effects (applied instantly, no active duration).
export const ONE_SHOT = new Set([FX.EXPLOSION, FX.SWAP, FX.PINATA]);
// Client-only effects (server still tracks them so the client can read its own).
export const CLIENT_FX = new Set([FX.BACKWARDS, FX.BLINDNESS, FX.BANANA]);
