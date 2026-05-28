// Input handling: drag to move, tap to pick up, double-tap-and-hold to charge a
// throw (release sets power). Works with touch and mouse. Emits callbacks; the
// main client decides what to send to the server.

export function setupInput(canvas, handlers) {
  // handlers: { onMove(dx,dy), onStop(), onTap(x,y), onChargeStart(), onRelease() }
  let dragging = false;
  let origin = null;       // where the current drag/press started (canvas coords)
  let moved = false;
  let lastTapTime = 0;
  let holdTimer = null;
  let charging = false;

  const DOUBLE_TAP_MS = 280;
  const HOLD_MS = 160;       // after a quick second tap, holding this long => charge
  const MOVE_DEADZONE = 14;  // px before a press counts as a drag

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return {
      x: (t.clientX - r.left) * (canvas.width / r.width),
      y: (t.clientY - r.top) * (canvas.height / r.height),
    };
  }

  function start(e) {
    e.preventDefault();
    const p = pos(e);
    origin = p;
    moved = false;
    dragging = true;

    const now = performance.now();
    const isDouble = now - lastTapTime < DOUBLE_TAP_MS;
    lastTapTime = now;

    if (isDouble) {
      // second tap: if held, begin charging a throw
      holdTimer = setTimeout(() => {
        charging = true;
        handlers.onChargeStart && handlers.onChargeStart();
      }, HOLD_MS);
    }
  }

  function move(e) {
    if (!dragging) return;
    e.preventDefault();
    const p = pos(e);
    const dx = p.x - origin.x, dy = p.y - origin.y;
    if (Math.hypot(dx, dy) > MOVE_DEADZONE) {
      moved = true;
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      handlers.onMove && handlers.onMove(dx, dy);
    }
  }

  function end(e) {
    e.preventDefault();
    dragging = false;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }

    if (charging) {
      charging = false;
      handlers.onRelease && handlers.onRelease();
      handlers.onStop && handlers.onStop();
      return;
    }
    if (!moved) {
      // a stationary press => tap (pick up nearest tub at that point)
      const p = origin;
      handlers.onTap && handlers.onTap(p.x, p.y);
    }
    handlers.onStop && handlers.onStop();
  }

  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end, { passive: false });
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseup', end);

  return { isCharging: () => charging };
}
