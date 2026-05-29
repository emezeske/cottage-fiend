// Main client. Connects to the server, sends input, renders snapshots.

import { loadAssets } from './assets.js';
import { initAudio, playEvent } from './audio.js';
import { render, addSplat, addConfetti, addBam } from './render.js';
import { setupInput } from './input.js';
import { screenToWorld } from './camera.js';

const MSG = {
  JOIN: 'join', INPUT: 'input', PICKUP: 'pickup', CHARGE: 'charge',
  RELEASE: 'release', PUNCH: 'punch', READY: 'ready', WELCOME: 'welcome', STATE: 'state',
};
// throw tuning mirrored from server constants for the visual arc only
const THROW = { minPower: 260, maxPower: 820, oscillationHz: 2.4 };

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const nameInput = document.getElementById('name');
const joinBtn = document.getElementById('joinBtn');
const goBtn = document.getElementById('goBtn');
const actionBtn = document.getElementById('actionBtn');

let ws = null;
let selfId = null;
let state = null;
let prevPos = {};   // last-snapshot positions per player id, to detect movement
let chargeStartTs = 0;
const charge = { active: false, x: 0, y: 0, dir: { x: 1, y: 0 },
                 power: THROW.minPower, minPower: THROW.minPower, maxPower: THROW.maxPower };

// Fill the whole screen; render at devicePixelRatio (capped) for crisp pixels.
function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
}
window.addEventListener('resize', fitCanvas);
window.addEventListener('orientationchange', fitCanvas);

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

function connect(name) {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => ws.send(JSON.stringify({ type: MSG.JOIN, name }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === MSG.WELCOME) { selfId = m.id; }
    else if (m.type === MSG.STATE) {
      // mark which players actually moved since the last snapshot (drives walk anim)
      const snap = m.snapshot;
      for (const p of snap.players) {
        const pv = prevPos[p.id];
        p.moving = pv ? Math.hypot(p.x - pv.x, p.y - pv.y) > 1.5 : false;
      }
      prevPos = {};
      for (const p of snap.players) prevPos[p.id] = { x: p.x, y: p.y };
      state = snap;
      for (const e of m.events || []) {
        playEvent(e.type);
        if (e.type === 'splat' || e.type === 'chomp' || e.type === 'drop' ||
            e.type === 'pinata' || e.type === 'presentClaim')
          addSplat(e.x, e.y);
        if (e.type === 'score') addConfetti(e.x, e.y);
        if (e.type === 'bam') addBam(e.x, e.y);
        if (e.type === 'explosion') {
          // a ring of splatters for the super-saiyan blast
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            addSplat(e.x + Math.cos(a) * 60, e.y + Math.sin(a) * 60);
          }
        }
      }
      updateButtons();
    }
  };
  ws.onclose = () => { overlay.style.display = 'flex';
    document.getElementById('status').textContent = 'Disconnected. Refresh to rejoin.'; };
}

function send(type, extra = {}) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...extra }));
}

// charge oscillator (visual only; server recomputes authoritatively on release)
function chargePower(elapsedMs) {
  const periodMs = 1000 / THROW.oscillationHz;
  const phase = (elapsedMs % periodMs) / periodMs;
  const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  return THROW.minPower + (THROW.maxPower - THROW.minPower) * tri;
}

function me() { return state && state.players.find(p => p.id === selfId); }

// Movement: the character walks toward wherever your finger currently is. We
// store the finger's screen position while dragging and re-steer every frame
// (so a held finger keeps the character moving, and the camera pans to follow).
let dragPos = null;                 // {x,y} in CSS px, or null when not dragging
let bananaVec = { x: 0, y: 0 };     // smoothed vector for the slidey 'banana' debuff
let lastVec = { x: 0, y: 0 };
let lastSendTs = 0;

function sendInput(x, y) {
  const now = performance.now();
  const changed = Math.abs(x - lastVec.x) > 0.02 || Math.abs(y - lastVec.y) > 0.02;
  if (!changed && now - lastSendTs < 150) return; // dedupe steady-state spam
  lastVec = { x, y }; lastSendTs = now;
  send(MSG.INPUT, { x, y });
}

function stopMoving() {
  dragPos = null;
  bananaVec = { x: 0, y: 0 };
  lastVec = { x: 0, y: 0 }; lastSendTs = performance.now();
  send(MSG.INPUT, { x: 0, y: 0 });
}

function steer() {
  const p = me();
  if (!p || !dragPos) return;
  const target = screenToWorld(dragPos.x, dragPos.y);
  let vx = target.x - p.x, vy = target.y - p.y;
  const len = Math.hypot(vx, vy);
  if (len < 12) { sendInput(0, 0); return; } // finger on the character => hold still
  vx /= len; vy /= len;
  if (p.effect === 'backwards') { vx = -vx; vy = -vy; }
  if (p.effect === 'banana') {
    bananaVec.x += (vx - bananaVec.x) * 0.06;
    bananaVec.y += (vy - bananaVec.y) * 0.06;
    vx = bananaVec.x; vy = bananaVec.y;
    send(MSG.INPUT, { x: vx, y: vy });   // banana eases every frame
  } else {
    bananaVec.x = vx; bananaVec.y = vy;
    sendInput(vx, vy);
  }
}

// input wiring: canvas drag steers; pickup is automatic; throwing is the button.
setupInput(canvas, {
  onMove: (x, y) => { dragPos = { x, y }; },
  onStop: () => stopMoving(),
  onTap: () => send(MSG.PICKUP), // harmless backup; pickup is automatic on contact
});

// Action button: PUNCH when empty-handed (or Mallen), HOLD-TO-THROW when carrying.
function startThrow(e) {
  // keep the gesture on the button even if the finger drifts off it
  if (e && e.pointerId != null && actionBtn.setPointerCapture)
    try { actionBtn.setPointerCapture(e.pointerId); } catch {}
  stopMoving();                // don't keep walking while you aim/throw
  charge.active = true;
  chargeStartTs = performance.now();
  send(MSG.CHARGE);
}
function endThrow() {
  if (!charge.active) return;
  charge.active = false;
  send(MSG.RELEASE);
}
function onActionDown(e) {
  if (e) e.preventDefault();
  const p = me();
  if (!p || charge.active) return;
  if (p.carrying) startThrow(e);   // hold to charge a throw
  else send(MSG.PUNCH);            // empty-handed (or Mallen): punch
}
function onActionUp(e) {
  if (e) e.preventDefault();
  if (charge.active) endThrow();
}
actionBtn.addEventListener('pointerdown', onActionDown);
actionBtn.addEventListener('pointerup', onActionUp);
actionBtn.addEventListener('pointercancel', onActionUp);
actionBtn.addEventListener('pointerleave', onActionUp);

// UI buttons
joinBtn.onclick = () => {
  const name = (nameInput.value || 'delivery').trim().slice(0, 16);
  initAudio();
  fitCanvas();
  overlay.style.display = 'none';
  connect(name);
};
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
goBtn.onclick = () => { initAudio(); send(MSG.READY); };

let lastActionMode = null;
function updateButtons() {
  if (!state) return;
  // show LET'S GO during lobby/leaderboard
  const show = state.phase === 'lobby' || state.phase === 'leaderboard';
  goBtn.style.display = show ? 'block' : 'none';
  // action button during play: THROW when carrying, PUNCH otherwise
  const p = me();
  if (state.phase === 'playing' && p) {
    actionBtn.style.display = 'block';
    const mode = p.carrying ? 'throw' : 'punch';
    if (mode !== lastActionMode) {
      lastActionMode = mode;
      if (mode === 'throw') { actionBtn.innerHTML = 'HOLD TO<br>THROW'; actionBtn.style.background = '#ffb43d'; }
      else { actionBtn.innerHTML = 'PUNCH'; actionBtn.style.background = '#ff6b5d'; }
    }
  } else {
    actionBtn.style.display = 'none';
    lastActionMode = null;
  }
}

// render loop
function loop() {
  const p = me();
  if (charge.active && p) {
    charge.x = p.x; charge.y = p.y; charge.dir = p.dir;
    charge.power = chargePower(performance.now() - chargeStartTs);
  } else if (dragPos && p) {
    steer();
  }
  render(ctx, canvas, state, selfId, charge);
  requestAnimationFrame(loop);
}

loadAssets().then(() => { fitCanvas(); loop(); });
