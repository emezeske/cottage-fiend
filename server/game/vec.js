// Tiny dependency-free vector & geometry helpers. Pure functions only.

export function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

export function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Normalize a vector; returns {x,y} unit vector (or {0,0} if zero-length).
export function normalize(x, y) {
  const m = Math.hypot(x, y);
  if (m === 0) return { x: 0, y: 0 };
  return { x: x / m, y: y / m };
}

// Resolve overlap between two circles by pushing them apart equally.
// Mutates nothing; returns the corrected positions.
export function resolveCircleOverlap(a, ra, b, rb) {
  const dx = b.x - a.x, dy = b.y - a.y;
  let d = Math.hypot(dx, dy);
  const minD = ra + rb;
  if (d >= minD || d === 0) return null; // no overlap (or perfectly coincident)
  const overlap = minD - d;
  const nx = dx / d, ny = dy / d;
  const push = overlap / 2;
  return {
    a: { x: a.x - nx * push, y: a.y - ny * push },
    b: { x: b.x + nx * push, y: b.y + ny * push },
  };
}

// Keep a circle of radius r inside the arena bounds.
export function clampToArena(x, y, r, arena) {
  return {
    x: clamp(x, r, arena.width - r),
    y: clamp(y, r, arena.height - r),
  };
}

// Charge oscillator: maps elapsed charge time to a power value that ramps
// min->max->min->max... as a triangle wave. Deterministic => testable.
export function chargePower(elapsedMs, { minPower, maxPower, oscillationHz }) {
  const periodMs = 1000 / oscillationHz;
  const phase = (elapsedMs % periodMs) / periodMs; // 0..1
  // triangle wave: 0 -> 1 -> 0
  const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  return minPower + (maxPower - minPower) * tri;
}
