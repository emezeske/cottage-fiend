// Main client. Connects to the server, sends input, renders snapshots.

import { loadAssets } from './assets.js';
import { initAudio, playEvent } from './audio.js';
import { render, addSplat } from './render.js';
import { setupInput } from './input.js';

const MSG = {
  JOIN: 'join', INPUT: 'input', PICKUP: 'pickup', CHARGE: 'charge',
  RELEASE: 'release', READY: 'ready', WELCOME: 'welcome', STATE: 'state',
};
// throw tuning mirrored from server constants for the visual arc only
const THROW = { minPower: 260, maxPower: 820, oscillationHz: 2.4 };

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const nameInput = document.getElementById('name');
const joinBtn = document.getElementById('joinBtn');
const goBtn = document.getElementById('goBtn');

let ws = null;
let selfId = null;
let state = null;
let chargeStartTs = 0;
const charge = { active: false, x: 0, y: 0, dir: { x: 1, y: 0 },
                 power: THROW.minPower, minPower: THROW.minPower, maxPower: THROW.maxPower };

function fitCanvas() {
  const ratio = 1280 / 720;
  let w = window.innerWidth, h = window.innerHeight;
  if (w / h > ratio) w = h * ratio; else h = w / ratio;
  canvas.width = 1280; canvas.height = 720;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
}
window.addEventListener('resize', fitCanvas);

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
      state = m.snapshot;
      for (const e of m.events || []) {
        playEvent(e.type);
        if (e.type === 'splat' || e.type === 'chomp' || e.type === 'drop' ||
            e.type === 'pinata' || e.type === 'presentClaim')
          addSplat(e.x, e.y);
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

// client-only effect: banana gives slidey momentum. We keep a smoothed vector
// and send that instead of the raw drag, so direction changes feel sluggish.
let bananaVec = { x: 0, y: 0 };

function sendMove(dx, dy) {
  const p = me();
  let vx = dx, vy = dy;
  // backwards controls: invert the drag direction
  if (p && p.effect === 'backwards') { vx = -vx; vy = -vy; }
  // banana: ease toward the target vector instead of snapping
  if (p && p.effect === 'banana') {
    bananaVec.x += (vx - bananaVec.x) * 0.06;
    bananaVec.y += (vy - bananaVec.y) * 0.06;
    vx = bananaVec.x; vy = bananaVec.y;
  } else {
    bananaVec.x = vx; bananaVec.y = vy;
  }
  send(MSG.INPUT, { x: vx, y: vy });
}

// input wiring
setupInput(canvas, {
  onMove: (dx, dy) => sendMove(dx, dy),
  onStop: () => { bananaVec = { x: 0, y: 0 }; send(MSG.INPUT, { x: 0, y: 0 }); },
  onTap: () => send(MSG.PICKUP),
  onChargeStart: () => {
    const p = me();
    if (!p || !p.carrying) return;
    charge.active = true;
    chargeStartTs = performance.now();
    send(MSG.CHARGE);
  },
  onRelease: () => {
    if (!charge.active) return;
    charge.active = false;
    send(MSG.RELEASE);
  },
});

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

function updateButtons() {
  if (!state) return;
  // show LET'S GO during lobby/leaderboard
  const show = state.phase === 'lobby' || state.phase === 'leaderboard';
  goBtn.style.display = show ? 'block' : 'none';
}

// render loop
function loop() {
  const p = me();
  if (charge.active && p) {
    charge.x = p.x; charge.y = p.y; charge.dir = p.dir;
    charge.power = chargePower(performance.now() - chargeStartTs);
  }
  render(ctx, canvas, state, selfId, charge);
  requestAnimationFrame(loop);
}

loadAssets().then(() => { fitCanvas(); loop(); });
