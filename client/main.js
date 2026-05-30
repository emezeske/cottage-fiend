// Main client. Connects to the server, sends input, renders snapshots.

import { loadAssets, getDeliverySprite, getMallenSprite, hueToHex, hexToHue } from './assets.js';
import { initAudio, playEvent, playSound, setMusic, suspendAudio, resumeAudio, prefetchAudio, playLoop, stopLoop, duckMusic } from './audio.js';
import { render, addSplat, addConfetti, addBam, addChomp, addPoof, addGoldenCurd, addCurdBurst, addNukeExplosion, AD_H } from './render.js';

const MSG = {
  JOIN: 'join', INPUT: 'input', PICKUP: 'pickup', CHARGE: 'charge',
  RELEASE: 'release', AIM: 'aim', NUKE_LAUNCH: 'nukeLaunch',
  PUNCH: 'punch', READY: 'ready', WELCOME: 'welcome', STATE: 'state',
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
const joystick = document.getElementById('joystick');
const joystickKnob = document.getElementById('joystickKnob');
const audioUnlockModal = document.getElementById('audioUnlockModal');
const audioUnlockPlayer = document.getElementById('audioUnlockPlayer');
const adInterstitial = document.getElementById('adInterstitial');
const adSkip = document.getElementById('adSkip');
const customize = document.getElementById('customize');
const customizeTitle = document.getElementById('customizeTitle');
const previewCanvas = document.getElementById('previewCanvas');
const vestColor = document.getElementById('vestColor');
const pantsColor = document.getElementById('pantsColor');
const mallenColor = document.getElementById('mallenColor');
const pantsPicker = document.getElementById('pantsPicker');
const mallenPicker = document.getElementById('mallenPicker');
const readyBtn = document.getElementById('readyBtn');
const backBtn = document.getElementById('backBtn');

let ws = null;
let selfId = null;
let playerName = null;          // remembered so we can auto-rejoin after a drop
let reconnectAttempts = 0;
let state = null;
let prevPos = {};   // last-snapshot positions per player id, to detect movement
let invLoopOn = false; // is the local invincibility theme looping
let danceLoopOn = false; // is the local dance-party theme looping
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
const charge = { active: false, x: 0, y: 0, dir: { x: 1, y: 0 }, aim: null,
                 power: THROW.minPower, minPower: THROW.minPower, maxPower: THROW.maxPower };
// twin-stick aim: while charging, drag the thumb past a small deadzone in any
// direction to set the throw direction independent of where you're running.
const AIM_DEADZONE = 14;             // px from touchdown before aim kicks in
let aimOrigin = null;                // { x, y } client px at touchdown
let aimPid = null;
// nuke: local-only reticle while the buff is held + the thumb is dragging on the
// throw button. The reticle sits at a FIXED world distance from the player in
// the thumb's direction (no magnitude — close enough to always be on-screen).
// Server commits on release via MSG.NUKE_LAUNCH with world coords.
const NUKE_RETICLE_RADIUS = 220;     // matches server NUKE.reticleRadius
let nukeAim = null;                  // {x, y} in world coords, or null when not aiming
let lastAimSent = { x: null, y: null, ts: 0 };
function sendAim(x, y) {
  const now = performance.now();
  const changed = lastAimSent.x == null ||
    Math.abs(x - lastAimSent.x) > 0.03 || Math.abs(y - lastAimSent.y) > 0.03;
  if (!changed && now - lastAimSent.ts < 100) return;
  lastAimSent = { x, y, ts: now };
  send(MSG.AIM, { x, y });
}

// Two regimes:
//   - Normal (no zoom): CSS handles layout (100dvh / inset:0 / bottom:28px).
//     fitCanvas only updates the canvas backing store. innerHeight under-reports
//     on some iPad Safari builds, so use the max of every viewport signal we
//     have. This is what makes the play area actually fill the window.
//   - Pinch-zoom active: CSS anchors to the (now too-large) layout viewport,
//     so fitCanvas takes over and pins canvas + overlays + buttons to
//     visualViewport's offset/size so they track the visible region.
const LAYOUT_MARGIN = 28;
const OVERLAY_IDS = ['overlay', 'customize', 'audioUnlockModal', 'adInterstitial'];
function clearJsPos(el) {
  el.style.left = ''; el.style.top = '';
  el.style.right = ''; el.style.bottom = '';
  el.style.width = ''; el.style.height = '';
}

// iOS Chrome under-reports innerHeight / 100dvh against the real visible
// window. Probe 100lvh (largest viewport, the maximum a browser will give us)
// by laying out a 1px column with that height and measuring it. That value is
// derived after CSS layout runs, so it matches whatever the browser actually
// thinks the biggest viewport is — even when innerHeight is wrong.
const _hProbe = (() => {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:100lvh;' +
    'visibility:hidden;pointer-events:none;z-index:-1;';
  document.body.appendChild(el);
  return el;
})();
function maxViewportSize() {
  const vv = window.visualViewport;
  // 100lvh probe — fixed positioning + 100lvh resolves to the largest viewport
  const probedH = _hProbe.getBoundingClientRect().height || 0;
  return {
    w: Math.max(window.innerWidth,  document.documentElement.clientWidth,  vv ? vv.width  : 0),
    h: Math.max(window.innerHeight, document.documentElement.clientHeight, vv ? vv.height : 0, probedH),
  };
}

function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vv = window.visualViewport;
  const zoomed = !!(vv && (vv.scale > 1.02 || vv.offsetTop > 0.5 || vv.offsetLeft > 0.5));

  if (!zoomed) {
    // Let CSS run the layout. Strip any inline overrides from a previous zoom.
    clearJsPos(canvas);
    for (const id of OVERLAY_IDS) { const el = document.getElementById(id); if (el) clearJsPos(el); }
    clearJsPos(joystick); clearJsPos(actionBtn); clearJsPos(goBtn);
    // Use the largest viewport signal we can get (including a 100lvh probe).
    // innerHeight under-reports on iOS Chrome; lvh is the real ceiling.
    const { w, h } = maxViewportSize();
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width  = w + 'px';     // pin so computeCamera's dpr math works
    canvas.style.height = h + 'px';
    return;
  }

  // Zoomed: pin everything to the visible viewport instead of the layout one.
  const w = vv.width, h = vv.height, ox = vv.offsetLeft, oy = vv.offsetTop;
  canvas.width  = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.left = ox + 'px';
  canvas.style.top  = oy + 'px';
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';

  for (const id of OVERLAY_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.left = ox + 'px';  el.style.top    = oy + 'px';
    el.style.width = w + 'px';  el.style.height = h  + 'px';
    el.style.right = 'auto';    el.style.bottom = 'auto';
  }
  const jh = joystick.offsetHeight || 110;
  joystick.style.left = (ox + LAYOUT_MARGIN) + 'px';
  joystick.style.top  = (oy + h - jh - LAYOUT_MARGIN) + 'px';
  joystick.style.right = 'auto'; joystick.style.bottom = 'auto';

  const aw = actionBtn.offsetWidth  || 116;
  const ah = actionBtn.offsetHeight || 116;
  actionBtn.style.left = (ox + w - aw - LAYOUT_MARGIN) + 'px';
  actionBtn.style.top  = (oy + h - ah - LAYOUT_MARGIN) + 'px';
  actionBtn.style.right = 'auto'; actionBtn.style.bottom = 'auto';

  const gh = goBtn.offsetHeight || 60;
  goBtn.style.left = (ox + w / 2) + 'px';
  goBtn.style.top  = (oy + h - gh - 24) + 'px';
  goBtn.style.right = 'auto'; goBtn.style.bottom = 'auto';
}
window.addEventListener('resize', fitCanvas);
window.addEventListener('orientationchange', fitCanvas);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitCanvas);
  window.visualViewport.addEventListener('scroll', fitCanvas);
}

// FULL zoom-lockdown. The video-game viewport is the viewport, period. iOS
// Safari/Chrome ignore `user-scalable=no` and `touch-action: none` for
// pinch-zoom (Apple's accessibility decision), so we have to cancel every
// browser-level zoom path from JS instead. We layer several blocks because
// different browsers/devices route the gesture through different events.
const _no = (e) => e.preventDefault();
// 1) iOS-only pinch/rotate gesture events — only fire for actual multi-finger
//    gestures, not for two independent button taps, so safe to blanket-cancel.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, _no, { passive: false });
  window.addEventListener(ev, _no, { passive: false });
}
// 2) Multi-touch on the canvas (or anywhere off the UI buttons) is a page
//    pinch/pan. Allow only when EACH finger is on the joystick or action
//    button — that's how the dual-stick uses two thumbs simultaneously.
function _onUI(t) {
  const el = document.elementFromPoint(t.clientX, t.clientY);
  return el && (joystick.contains(el) || actionBtn.contains(el));
}
function _blockMultiTouch(e) {
  if (e.touches && e.touches.length > 1) {
    let offUI = 0;
    for (const t of e.touches) if (!_onUI(t)) offUI++;
    if (offUI >= 1) e.preventDefault();         // any non-UI finger in a multi-touch = page gesture
  }
  if (e.scale !== undefined && e.scale !== 1) e.preventDefault();
}
document.addEventListener('touchstart', _blockMultiTouch, { passive: false });
document.addEventListener('touchmove',  _blockMultiTouch, { passive: false });
// 3) Double-tap-to-zoom on iOS — cancel the second tap if it lands within ~350ms.
let _lastTapTs = 0;
document.addEventListener('touchend', (e) => {
  const now = performance.now();
  if (now - _lastTapTs < 350) e.preventDefault();
  _lastTapTs = now;
}, { passive: false });
// 4) Desktop Ctrl+wheel and Ctrl+0/+/- (in case the game is ever run on a laptop).
window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
    e.preventDefault();
  }
});

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

// Player-chosen colors (set from the customize screen). Persist to localStorage
// so reload pre-fills the customize pickers + auto-reconnects use the same.
let playerColors = {
  vestHue:   Number(localStorage.getItem('cf_vest_hue'))   || 0,
  pantsHue:  Number(localStorage.getItem('cf_pants_hue'))  || 220,
  mallenHue: Number(localStorage.getItem('cf_mallen_hue')) || 4,
};

function connect(name) {
  playerName = name;
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    reconnectAttempts = 0;
    ws.send(JSON.stringify({
      type: MSG.JOIN,
      name: playerName,
      vestHue: playerColors.vestHue,
      pantsHue: playerColors.pantsHue,
      mallenHue: playerColors.mallenHue,
    }));
  };
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
      // dance-party music: loops for the initiator + dancers, ducking the bg theme
      const dance = !!(meNow && meNow.danceParty);
      if (dance && !danceLoopOn) { playLoop('dance_party_theme', 0.6); duckMusic(true); danceLoopOn = true; }
      else if (!dance && danceLoopOn) { stopLoop('dance_party_theme'); duckMusic(false); danceLoopOn = false; }
      // first-curd cue is exclusive with the regular score cue: when the round's
      // first score lands, the scorer hears only the global FIRST CURD sound.
      const firstCurd = (m.events || []).some((e) => e.type === 'firstCurd');
      // likewise, if this score is what made you dominate, play only DOMINATING
      // (not the score cue) so they don't muddy each other.
      const dominatingMe = (m.events || []).some((e) => e.type === 'dominating' && e.id === selfId);
      for (const e of m.events || []) {
        playEvent(e.type);
        if (e.type === 'splat' || e.type === 'drop' ||
            e.type === 'pinata' || e.type === 'presentClaim')
          addSplat(e.x, e.y);
        if (e.type === 'chomp') addChomp(e.x, e.y);   // ravaging-curds burst
        if (e.type === 'score') addConfetti(e.x, e.y);
        if (e.type === 'bam') addBam(e.x, e.y);
        if (e.type === 'corgiHit') addBam(e.x, e.y);                 // corgi tackle
        if (e.type === 'corgiSpawn' || e.type === 'corgiGone') addPoof(e.x, e.y);
        if (e.type === 'discHit') addBam(e.x, e.y);                  // frisbee bonk
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
        if ((e.type === 'score' || e.type === 'chomp') && e.id === selfId && !firstCurd && !dominatingMe) {
          playSound(e.type === 'score' && e.thrown ? 'dunk' : 'score');
        }
        if (e.type === 'dominating' && e.id === selfId) playSound('dominating'); // you're 5+ ahead
        // golden curd: a global celebration — everyone sees the animation and hears it
        if (e.type === 'presentClaim' && e.fx === 'golden_curd') { playSound('golden_curd'); addGoldenCurd(e.id); }
        else if (e.type === 'presentClaim' && e.id === selfId) {
          // portal claim picks one of three random portal SFX
          const name = e.fx === 'portal' ? `portal_${(Math.random() * 3) | 0}` : e.fx;
          playSound(name);
        }
        if (e.type === 'presentClaim' && e.id === selfId && e.fx === 'interstitial') showInterstitial();
        if (e.type === 'explosion') addCurdBurst(e.x, e.y); // curds radiate outward in timed rings
        // nuke: global "launch detected" SFX on commit + a big visual + boom on detonation
        if (e.type === 'nukeLaunch') playSound('nuke_launch');
        if (e.type === 'nukeDetonate') { playSound('nuke_explosion'); addNukeExplosion(e.x, e.y); }
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

// Movement: an analog virtual joystick (bottom-left). The knob's offset from
// center is sent as a {-1..1, -1..1} vector — direction is heading, magnitude
// scales speed. Pickup is automatic on contact; throwing is the action button.
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
  lastVec = { x: 0, y: 0 }; lastSendTs = performance.now();
  send(MSG.INPUT, { x: 0, y: 0 });   // the server coasts to a stop if 'slidey' is active
}

// Joystick: thumb-drag the knob to steer (distance from center scales speed).
const JOY_R = 36;                    // max thumb travel (px) from base center
let joyPid = null;
function joyVecFromEvent(e) {
  const r = joystick.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let dx = e.clientX - cx, dy = e.clientY - cy;
  const len = Math.hypot(dx, dy);
  if (len > JOY_R) { dx = dx / len * JOY_R; dy = dy / len * JOY_R; }
  return { dx, dy };
}
function setKnob(dx, dy) { joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`; }
function sendJoy(dx, dy) {
  const p = me();
  let x = dx / JOY_R, y = dy / JOY_R;          // -1..1 with magnitude 0..1 = analog speed
  if (p && p.effect === 'backwards') { x = -x; y = -y; }
  sendInput(x, y);
}
function joyDown(e) {
  if (joyPid != null) return;
  e.preventDefault();
  joyPid = e.pointerId;
  try { joystick.setPointerCapture(e.pointerId); } catch {}
  joystick.classList.add('active');
  const v = joyVecFromEvent(e); setKnob(v.dx, v.dy); sendJoy(v.dx, v.dy);
}
function joyMove(e) {
  if (joyPid == null || e.pointerId !== joyPid) return;
  e.preventDefault();
  const v = joyVecFromEvent(e); setKnob(v.dx, v.dy); sendJoy(v.dx, v.dy);
}
function joyUp(e) {
  if (joyPid == null || (e.pointerId != null && e.pointerId !== joyPid)) return;
  e.preventDefault();
  joyPid = null;
  joystick.classList.remove('active');
  setKnob(0, 0);
  stopMoving();
}
joystick.addEventListener('pointerdown', joyDown);
joystick.addEventListener('pointermove', joyMove);
joystick.addEventListener('pointerup', joyUp);
joystick.addEventListener('pointercancel', joyUp);

// Action button: PUNCH when empty-handed (or Mallen), HOLD-TO-THROW when carrying.
function startThrow(e) {
  // keep the gesture on the button even if the finger drifts off it
  if (e && e.pointerId != null && actionBtn.setPointerCapture)
    try { actionBtn.setPointerCapture(e.pointerId); } catch {}
  stopMoving();                // don't keep walking while you aim/throw
  charge.active = true;
  chargeStartTs = performance.now();
  charge.aim = null;
  aimOrigin = e ? { x: e.clientX, y: e.clientY } : null;
  aimPid = e ? e.pointerId : null;
  lastAimSent = { x: null, y: null, ts: 0 };
  send(MSG.CHARGE);
}
function endThrow() {
  if (!charge.active) return;
  charge.active = false;
  send(MSG.RELEASE);            // server uses the last-known aim (streamed via MSG.AIM)
  charge.aim = null; aimOrigin = null; aimPid = null;
}
function startNukeAim(e) {
  if (e && e.pointerId != null && actionBtn.setPointerCapture)
    try { actionBtn.setPointerCapture(e.pointerId); } catch {}
  aimOrigin = e ? { x: e.clientX, y: e.clientY } : null;
  aimPid = e ? e.pointerId : null;
  nukeAim = null;                              // reticle shows once the thumb passes deadzone
}
function onActionDown(e) {
  if (e) e.preventDefault();
  const p = me();
  if (!p || charge.active || p.stunned) return;
  if (p.nukeArmed) { startNukeAim(e); return; }   // nuke armed: throw button is the launcher
  if (p.carrying) startThrow(e);                  // hold to charge a throw
  else send(MSG.PUNCH);                           // empty-handed (or Mallen): punch
}
function onActionMove(e) {
  if (aimOrigin == null) return;
  if (e.pointerId != null && aimPid != null && e.pointerId !== aimPid) return;
  const p = me();
  if (!p) return;
  e.preventDefault();
  const dx = e.clientX - aimOrigin.x, dy = e.clientY - aimOrigin.y;
  const len = Math.hypot(dx, dy);
  // nuke aim: thumb direction only — reticle sits at a fixed world distance so
  // the launcher can always see it (no magnitude scaling).
  if (p.nukeArmed) {
    if (len < AIM_DEADZONE) { nukeAim = null; return; }
    const ux = dx / len, uy = dy / len;
    nukeAim = { x: p.x + ux * NUKE_RETICLE_RADIUS, y: p.y + uy * NUKE_RETICLE_RADIUS };
    return;
  }
  // throw aim (existing twin-stick): thumb direction = throw direction
  if (!charge.active) return;
  if (len < AIM_DEADZONE) {
    if (charge.aim) { charge.aim = null; sendAim(0, 0); }
    return;
  }
  charge.aim = { x: dx / len, y: dy / len };
  sendAim(charge.aim.x, charge.aim.y);
}
function onActionUp(e) {
  if (e) e.preventDefault();
  const p = me();
  // nuke release: commit the launch if there was a valid aim
  if (p && p.nukeArmed && aimOrigin != null) {
    if (nukeAim) send(MSG.NUKE_LAUNCH, { x: nukeAim.x, y: nukeAim.y });
    nukeAim = null; aimOrigin = null; aimPid = null;
    return;
  }
  if (charge.active) endThrow();
}
actionBtn.addEventListener('pointerdown', onActionDown);
actionBtn.addEventListener('pointermove', onActionMove);
actionBtn.addEventListener('pointerup', onActionUp);
actionBtn.addEventListener('pointercancel', onActionUp);
// (no pointerleave: aiming intentionally drifts off the button visual)

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
// Auto-fill name from prior session if we have one.
const _savedName = localStorage.getItem('cf_name');
if (_savedName) nameInput.value = _savedName.slice(0, 16);

// JOIN button: leave the title overlay and go to the customize screen. The
// READY button on the customize screen does the actual connect/MSG.JOIN.
joinBtn.onclick = () => {
  const name = nameInput.value.trim().slice(0, 16);
  if (!name) { nameInput.focus(); return; }
  initAudio();
  fitCanvas();
  localStorage.setItem('cf_name', name);
  showCustomizeScreen(name);
};
nameInput.addEventListener('input', updateJoinEnabled);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });

// --- character customize screen ---------------------------------------------
// Single-player preview of the south-facing sprite with live color pickers.
// "mallen" gets one picker (the demon body color); everyone else gets two
// (vest + hat/pants). READY commits the colors and connects to the server.
let _previewFrame = 0;
let _previewTimer = null;
let _pendingMallen = false;
function showCustomizeScreen(name) {
  overlay.style.display = 'none';
  customize.style.display = 'flex';
  customizeTitle.textContent = `${name}, customize your character`;
  _pendingMallen = name.trim().toLowerCase() === 'mallen';
  pantsPicker.style.display = _pendingMallen ? 'none' : '';
  vestColor.parentElement.style.display = _pendingMallen ? 'none' : '';
  mallenPicker.style.display = _pendingMallen ? '' : 'none';
  // hydrate pickers from saved hues
  vestColor.value   = hueToHex(playerColors.vestHue);
  pantsColor.value  = hueToHex(playerColors.pantsHue);
  mallenColor.value = hueToHex(playerColors.mallenHue);
  _previewFrame = 0;
  drawPreview();
  if (_previewTimer) clearInterval(_previewTimer);
  _previewTimer = setInterval(() => { _previewFrame = (_previewFrame + 1) % 2; drawPreview(); }, 320);
}
function hideCustomizeScreen() {
  customize.style.display = 'none';
  if (_previewTimer) { clearInterval(_previewTimer); _previewTimer = null; }
}
function drawPreview() {
  const pctx = previewCanvas.getContext('2d');
  pctx.imageSmoothingEnabled = false;
  pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  const sprite = _pendingMallen
    ? getMallenSprite(hexToHue(mallenColor.value), false, 's', _previewFrame)
    : getDeliverySprite(hexToHue(vestColor.value), hexToHue(pantsColor.value), 's', _previewFrame);
  if (sprite) {
    const s = previewCanvas.width;
    pctx.drawImage(sprite, 0, 0, s, s);
  }
}
// live update on every color tweak
vestColor.addEventListener('input',   drawPreview);
pantsColor.addEventListener('input',  drawPreview);
mallenColor.addEventListener('input', drawPreview);

readyBtn.onclick = () => {
  const vH = hexToHue(vestColor.value);
  const pH = hexToHue(pantsColor.value);
  const mH = hexToHue(mallenColor.value);
  playerColors = { vestHue: vH, pantsHue: pH, mallenHue: mH };
  localStorage.setItem('cf_vest_hue',   String(Math.round(vH)));
  localStorage.setItem('cf_pants_hue',  String(Math.round(pH)));
  localStorage.setItem('cf_mallen_hue', String(Math.round(mH)));
  hideCustomizeScreen();
  connect(nameInput.value.trim().slice(0, 16));
};
backBtn.onclick = () => { hideCustomizeScreen(); overlay.style.display = 'flex'; };

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
    joystick.style.display = 'block';
    const mode = p.nukeArmed ? 'nuke'
               : (p.carrying ? 'throw' : (p.isMallen ? 'attack' : 'punch'));
    if (mode !== lastActionMode) {
      lastActionMode = mode;
      if (mode === 'nuke')        { actionBtn.innerHTML = '☢ AIM &<br>RELEASE'; baseActionColor = '#ff2330'; }
      else if (mode === 'throw')  { actionBtn.innerHTML = 'HOLD TO<br>THROW';   baseActionColor = '#ffb43d'; }
      else if (mode === 'attack') { actionBtn.innerHTML = 'ATTACK';             baseActionColor = '#ff6b5d'; }
      else                        { actionBtn.innerHTML = 'PUNCH';              baseActionColor = '#ff6b5d'; }
    }
  } else {
    actionBtn.style.display = 'none';
    joystick.style.display = 'none';
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
    charge.x = p.x; charge.y = p.y;
    let d = charge.aim || p.dir;               // twin-stick: local aim overrides facing dir
    if (p.effect === 'backwards') d = { x: -d.x, y: -d.y };  // backwards flips the throw too
    charge.dir = d;
    charge.power = chargePower(performance.now() - chargeStartTs);
  }
  render(ctx, canvas, state, selfId, charge, nukeAim);
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
