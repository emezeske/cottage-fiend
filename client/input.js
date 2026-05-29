// Input handling: drag to move (steer toward the finger). Tap is a no-op grab
// hint (pickup is automatic on contact). Throwing is handled by the on-screen
// THROW button (see main.js), not a gesture. Works with touch and mouse.

export function setupInput(canvas, handlers) {
  // handlers: { onMove(cssX, cssY), onStop(), onTap() }
  let dragging = false;
  let origin = null;
  let moved = false;

  const MOVE_DEADZONE = 12; // px before a press counts as a drag

  // CSS pixels relative to the canvas (the camera works in CSS px too).
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }

  function start(e) {
    e.preventDefault();
    origin = pos(e);
    moved = false;
    dragging = true;
  }

  function move(e) {
    if (!dragging) return;
    e.preventDefault();
    const p = pos(e);
    const dx = p.x - origin.x, dy = p.y - origin.y;
    if (moved || Math.hypot(dx, dy) > MOVE_DEADZONE) {
      moved = true;
      // report the finger's ABSOLUTE position; the client steers the character
      // toward it (move toward where your finger is), camera-aware.
      handlers.onMove && handlers.onMove(p.x, p.y);
    }
  }

  function end(e) {
    e.preventDefault();
    if (!dragging) return;
    dragging = false;
    if (!moved) handlers.onTap && handlers.onTap();
    handlers.onStop && handlers.onStop();
  }

  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end, { passive: false });
  canvas.addEventListener('touchcancel', end, { passive: false });
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseup', end);
}
