// Main client. Connects to the server, sends input, renders snapshots.

import { loadAssets } from './assets.js';
import { initAudio, playEvent, playSound, setMusic, suspendAudio, resumeAudio, prefetchAudio, playLoop, stopLoop, duckMusic } from './audio.js';
import { render, addSplat, addConfetti, addBam, addChomp, addPoof, AD_H } from './render.js';
import { setupInput } from './input.js';
import { screenToWorld } from './camera.js';

const MSG = {
  JOIN: 'join', INPUT: 'input', PICKUP: 'pickup', CHARGE: 'charge',
  RELEASE: 'release', PUNCH: 'punch', READY: 'ready', WELCOME: 'welcome', STATE: 'state',
};
// throw tuning mirrored from server constants for the visual arc only
const THROW = { minPower: 40, maxPower: 1600, oscillationHz: 1.0 };

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const nameInput = document.getElementById('name');
const joinBtn = document.getElementById('joinBtn');
const goBtn = document.getElementById('goBtn');
const actionBtn = document.getElementById('actionBtn');
const audioUnlockModal = document.getElementById('audioUnlockModal');
const audioUnlockPlayer = document.getElementById('audioUnlockPlayer');
const adInterstitial = document.getElementById('adInterstitial');
const adSkip = document.getElementById('adSkip');

let ws = null;
let selfId = null;
let playerName = null;          // remembered so we can auto-rejoin after a drop
let reconnectAttempts = 0;
let state = null;
let prevPos = {};   // last-snapshot positions per player id, to detect movement
let invLoopOn = false; // is the local invincibility theme looping
const PREVIEW = new URLSearchParams(location.search).get('preview'); // admin screen preview

function hideAudioUnlockModal() {
  audioUnlockModal.hidden = true;
}

audioUnlockModal.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  audioUnlockPlayer.currentTime = 0;
  const p = audioUnlockPlayer.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
  initAudio();
  hideAudioUnlockModal();
}, { once: true });

// Forced ad-break debuff: a full-screen interstitial whose SKIP button stays
// grayed for 3s (YouTube-pre-roll style). The server stuns the claimer for the
// same 3s, so they're frozen and vulnerable while it plays.
let adShowing = false;
let adSkipReady = false;
let adTimer = null;
function showInterstitial() {
  if (adShowing) return;
  adShowing = true;
  adInterstitial.style.display = 'flex';
  // the ad jingle plays via the standard per-effect cue (playSound('interstitial'))
  adSkipReady = false;
  adSkip.disabled = true;
  let remaining = 3;
  adSkip.textContent = `Skip in ${remaining}`;
  if (adTimer) clearInterval(adTimer);
  adTimer = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      adSkip.textContent = `Skip in ${remaining}`;
    } else {
      clearInterval(adTimer); adTimer = null;
      adSkip.disabled = false; adSkipReady = true;
      adSkip.textContent = 'Skip ▶';
    }
  }, 1000);
}
function hideInterstitial() {
  adShowing = false;
  adSkipReady = false;
  adInterstitial.style.display = 'none';
  if (adTimer) { clearInterval(adTimer); adTimer = null; }
}
adSkip.addEventListener('click', () => { if (adSkipReady) hideInterstitial(); });

// A fake snapshot for the /admin preview links — renders a screen with dummy
// data, no server connection, so it never disturbs a live game.
function fakeSnapshot(preview) {
  const phase = preview === 'score' ? 'leaderboard' : preview; // map link name -> game phase
  const mk = (id, name, isMallen, x, y, o = {}) => ({
    id, name, x, y, dir: { x: 0, y: 1 }, isMallen, radius: isMallen ? 34 : 22,
    score: o.score || 0, eaten: o.eaten || 0, carrying: false, charging: false,
    frenzy: false, ready: !!o.ready, stunned: false, dashing: false,
    spriteIndex: o.spriteIndex || 0, effect: null, effectMs: 0, moving: false,
  });
  return {
    phase, round: 1,
    arena: { width: 1600, height: 1600 },
    loci: { truck: { x: 480, y: 800 }, fridge: { x: 1120, y: 800 } },
    safeZone: { x: 330, y: 715, w: 300, h: 230 },
    roundWinner: phase === 'leaderboard' ? { type: 'player', name: 'Curd Lord' } : null,
    countdownMs: phase === 'countdown' ? 3000 : 0,
    players: [
      mk(1, 'Curd Lord', false, 760, 820, { score: 10, ready: true, spriteIndex: 0 }),
      mk(2, 'mallen', true, 900, 760, { eaten: 6 }),
      mk(3, 'Whey', false, 840, 880, { score: 7, spriteIndex: 2 }),
      mk(4, 'Gouda', false, 700, 770, { score: 4, ready: true, spriteIndex: 7 }),
    ],
    tubs: [],
    presents: [],
  };
}
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
  playerName = name;
  ws = new WebSocket(wsUrl());
  ws.onopen = () => { reconnectAttempts = 0; ws.send(JSON.stringify({ type: MSG.JOIN, name: playerName })); };
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
      // background music per screen (crossfades on change)
      setMusic(snap.phase === 'leaderboard' ? 'score'
        : (snap.phase === 'countdown' || snap.phase === 'playing') ? 'gameplay'
        : 'title');
      // invincibility theme: loops locally while you're invincible
      const meNow = snap.players.find((p) => p.id === selfId);
      const inv = !!(meNow && meNow.effect === 'invincible');
      if (inv && !invLoopOn) { playLoop('invincible_theme', 0.5); duckMusic(true); invLoopOn = true; }
      else if (!inv && invLoopOn) { stopLoop('invincible_theme'); duckMusic(false); invLoopOn = false; }
      // first-curd cue is exclusive with the regular score cue: when the round's
      // first score lands, the scorer hears only the global FIRST CURD sound.
      const firstCurd = (m.events || []).some((e) => e.type === 'firstCurd');
      for (const e of m.events || []) {
        playEvent(e.type);
        if (e.type === 'splat' || e.type === 'drop' ||
            e.type === 'pinata' || e.type === 'presentClaim')
          addSplat(e.x, e.y);
        if (e.type === 'chomp') addChomp(e.x, e.y);   // ravaging-curds burst
        if (e.type === 'score') addConfetti(e.x, e.y);
        if (e.type === 'bam') addBam(e.x, e.y);
        if (e.type === 'attack') {
          addPoof(e.x + (e.dx || 0) * 30, e.y + (e.dy || 0) * 30); // whiff cloud
          if (e.id === selfId && e.cd) { actionCdUntil = performance.now() + e.cd; actionCdMs = e.cd; }
        }
        // dash: heard by everyone but attenuated by distance from the Mallen
        // (inverse-square falloff), so far-away players barely hear it
        if (e.type === 'dash') {
          const p = me();
          let g = 0.6;
          if (p) g = 0.6 / (1 + ((Math.hypot(p.x - e.x, p.y - e.y)) / 350) ** 2);
          if (g > 0.02) playSound('dash', g);
        }
        if (e.type === 'firstCurd') playSound('firstCurd');
        if (e.type === 'roundStart') playSound('round');
        // local SFX (only the affected player hears)
        if ((e.type === 'score' || e.type === 'chomp') && e.id === selfId && !firstCurd) playSound('score');
        if (e.type === 'presentClaim' && e.id === selfId) playSound(e.fx); // per-effect sound
        if (e.type === 'presentClaim' && e.id === selfId && e.fx === 'interstitial') showInterstitial();
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
  ws.onclose = () => {
    // Auto-reconnect: a Wi-Fi blip or the phone backgrounding shouldn't kick you
    // for good. Keep retrying (~30s) and rejoin with the same name; only fall back
    // to the manual-refresh overlay if the server is truly gone.
    if (reconnectAttempts < 30) {
      reconnectAttempts++;
      setTimeout(() => connect(playerName), 1000);
    } else {
      overlay.style.display = 'flex';
      document.getElementById('status').textContent = 'Disconnected. Refresh to rejoin.';
    }
  };
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
  lastVec = { x: 0, y: 0 }; lastSendTs = performance.now();
  send(MSG.INPUT, { x: 0, y: 0 });   // the server coasts to a stop if 'slidey' is active
}

function steer() {
  const p = me();
  if (!p || !dragPos) return;
  if (adShowing) return;   // forced to watch the ad
  if (p.stunned) return;   // frozen — can't move
  const target = screenToWorld(dragPos.x, dragPos.y);
  let vx = target.x - p.x, vy = target.y - p.y;
  const len = Math.hypot(vx, vy);
  if (len < 12) { sendInput(0, 0); return; } // finger on the character => hold still
  vx /= len; vy /= len;
  if (p.effect === 'backwards') { vx = -vx; vy = -vy; }
  sendInput(vx, vy);
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
  if (!p || charge.active || p.stunned) return;
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

// tapping (not dragging through) the top ad banner plays its (very important) jingle
let adTapStart = null;
canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  adTapStart = (e.clientY - r.top <= AD_H) ? { x: e.clientX, y: e.clientY } : null;
});
canvas.addEventListener('pointerup', (e) => {
  if (!adTapStart) return;
  const moved = Math.hypot(e.clientX - adTapStart.x, e.clientY - adTapStart.y);
  const r = canvas.getBoundingClientRect();
  if (moved < 12 && e.clientY - r.top <= AD_H) playSound(['ad1', 'ad2', 'ad3'][Math.random() * 3 | 0]);
  adTapStart = null;
});

// UI buttons
// JOIN is enabled only once everything has preloaded AND a name has been typed —
// players must name themselves, there is no default.
let assetsLoaded = false;
function updateJoinEnabled() {
  joinBtn.disabled = !assetsLoaded || nameInput.value.trim() === '';
}
joinBtn.onclick = () => {
  const name = nameInput.value.trim().slice(0, 16);
  if (!name) { nameInput.focus(); return; }
  initAudio();
  fitCanvas();
  overlay.style.display = 'none';
  connect(name);
};
nameInput.addEventListener('input', updateJoinEnabled);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });

// Audio can't autoplay, so the title theme can't start on its own while the
// title overlay is showing. Kick it off on the player's first interaction with
// the title screen (tap or keypress) — that gesture unlocks audio.
let audioPrimed = false;
function primeTitleAudio() {
  if (audioPrimed) return;
  audioPrimed = true;
  initAudio();
  setMusic('title');
}
overlay.addEventListener('pointerdown', primeTitleAudio);
nameInput.addEventListener('keydown', primeTitleAudio);
goBtn.onclick = () => { initAudio(); send(MSG.READY); };

let lastActionMode = null;
let baseActionColor = '#ff6b5d';
let actionCdUntil = 0, actionCdMs = 0;   // punch/attack cooldown clock
function updateButtons() {
  if (!state) return;
  // show LET'S GO during lobby/leaderboard
  const show = state.phase === 'lobby' || state.phase === 'leaderboard';
  goBtn.style.display = show ? 'block' : 'none';
  // action button during play: THROW when carrying, PUNCH otherwise
  const p = me();
  if (state.phase === 'playing' && p) {
    actionBtn.style.display = 'block';
    const mode = p.carrying ? 'throw' : (p.isMallen ? 'attack' : 'punch');
    if (mode !== lastActionMode) {
      lastActionMode = mode;
      if (mode === 'throw') { actionBtn.innerHTML = 'HOLD TO<br>THROW'; baseActionColor = '#ffb43d'; }
      else if (mode === 'attack') { actionBtn.innerHTML = 'ATTACK'; baseActionColor = '#ff6b5d'; }
      else { actionBtn.innerHTML = 'PUNCH'; baseActionColor = '#ff6b5d'; }
    }
  } else {
    actionBtn.style.display = 'none';
    lastActionMode = null;
  }
}

// paint the action button each frame, overlaying a depleting pie-clock wedge while
// the punch/attack is on cooldown
function paintActionButton() {
  const now = performance.now();
  if (now < actionCdUntil && actionCdMs > 0) {
    const deg = ((actionCdUntil - now) / actionCdMs) * 360;
    actionBtn.style.background =
      `conic-gradient(rgba(0,0,0,0.45) ${deg}deg, rgba(0,0,0,0) ${deg}deg), ${baseActionColor}`;
  } else {
    actionBtn.style.background = baseActionColor;
  }
}

// Pause audio + skip rendering while the tab/screen is hidden, to stop burning
// CPU on the phone when the screen is off.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspendAudio(); else resumeAudio();
});

// render loop — capped at ~60fps. Uncapped, this redraws at the display's native
// rate (120Hz on many phones), which doubled CPU/GPU work, heat, and battery drain
// for no visible benefit (and made time-based effects run 2x fast on those screens).
const TARGET_FRAME_MS = 1000 / 60;
let lastFrameTs = 0;
function loop(ts = 0) {
  requestAnimationFrame(loop);
  if (document.hidden) return;
  if (ts - lastFrameTs < TARGET_FRAME_MS - 1) return; // skip extra frames on hi-refresh screens
  lastFrameTs = ts;
  const p = me();
  if (charge.active && p) {
    charge.x = p.x; charge.y = p.y; charge.dir = p.dir;
    charge.power = chargePower(performance.now() - chargeStartTs);
  } else if (dragPos && p) {
    steer();
  }
  render(ctx, canvas, state, selfId, charge);
  paintActionButton();
}

// Preload everything (sprites + all audio bytes) so the first round is smooth.
// Gate the JOIN button until it's all ready; start rendering once sprites are in.
const assetsReady = loadAssets();
const audioReady = prefetchAudio();
const joinLabel = joinBtn.textContent;
joinBtn.disabled = true;
joinBtn.textContent = 'LOADING…';
Promise.all([assetsReady, audioReady]).then(() => {
  assetsLoaded = true;
  joinBtn.textContent = joinLabel;
  updateJoinEnabled();                   // stays disabled until a name is entered
});
assetsReady.then(() => {
  fitCanvas();
  if (PREVIEW) {                       // admin preview: render a fake screen, no server
    overlay.style.display = 'none';
    selfId = 1;
    state = fakeSnapshot(PREVIEW);
  }
  loop();
});
