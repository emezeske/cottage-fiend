// Following camera. Centers on the self player, clamps to the arena, and exposes
// a screen->world mapping so input can steer toward the finger. All math is in
// CSS pixels; the renderer applies devicePixelRatio as a separate base transform.

export const VIEW = {
  targetSpan: 380,   // world units visible across the SHORTER screen axis (lower = more zoomed in)
  minScale: 0.45,
  maxScale: 4.0,
};

const FALLBACK_ARENA = { width: 1600, height: 1600 };
let _cam = { scale: 1, offX: 0, offY: 0, dpr: 1, cssW: 0, cssH: 0 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function computeCamera(canvas, state, selfId) {
  const styleW = parseFloat(canvas.style.width) || canvas.width;
  const dpr = canvas.width / styleW || 1;
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;
  const arena = (state && state.arena) || FALLBACK_ARENA;

  const span = Math.min(cssW, cssH);
  const scale = clamp(span / VIEW.targetSpan, VIEW.minScale, VIEW.maxScale);

  // center target: the self player, else arena center
  let cx = arena.width / 2, cy = arena.height / 2;
  const me = state && state.players && state.players.find((p) => p.id === selfId);
  if (me) { cx = me.x; cy = me.y; }

  let offX = cssW / 2 - cx * scale;
  let offY = cssH / 2 - cy * scale;

  // keep the view inside the arena (center it if the arena is smaller than the view)
  const worldW = arena.width * scale, worldH = arena.height * scale;
  offX = worldW >= cssW ? clamp(offX, cssW - worldW, 0) : (cssW - worldW) / 2;
  offY = worldH >= cssH ? clamp(offY, cssH - worldH, 0) : (cssH - worldH) / 2;

  _cam = { scale, offX, offY, dpr, cssW, cssH };
  return _cam;
}

export function getCamera() { return _cam; }

// CSS-pixel screen coords -> world coords (inverse of the camera transform).
export function screenToWorld(cssX, cssY) {
  return { x: (cssX - _cam.offX) / _cam.scale, y: (cssY - _cam.offY) / _cam.scale };
}
