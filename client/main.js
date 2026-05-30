// Main client. Connects to the server, sends input, renders snapshots.

import { loadAssets, getDeliverySprite, getMallenSprite, hueToHex, hexToHue, images } from './assets.js';
import { initAudio, playEvent, playSound, setMusic, suspendAudio, resumeAudio, prefetchAudio, playLoop, stopLoop, duckMusic } from './audio.js';
import { render, addSplat, addConfetti, addBam, addChomp, addPoof, addGoldenCurd, addBummer, addCurdBurst, addNukeExplosion, AD_H } from './render.js';

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
const shirtColor = document.getElementById('shirtColor');
const pantsColor = document.getElementById('pantsColor');
const mallenColor = document.getElementById('mallenColor');
const pantsPicker = document.getElementById('pantsPicker');
const mallenPicker = document.getElementById('mallenPicker');
const readyBtn = document.getElementById('readyBtn');
const nukeBanner = document.getElementById('nukeBanner');
let _nukeBannerTimer = null;
function showNukeBanner() {
  if (!nukeBanner) return;
  nukeBanner.style.display = 'block';
  if (_nukeBannerTimer) clearTimeout(_nukeBannerTimer);
  _nukeBannerTimer = setTimeout(() => { nukeBanner.style.display = 'none'; }, 3000);
}

let ws = null;
let selfId = null;
let playerName = null;          // remembered so we can auto-rejoin after a drop
let reconnectAttempts = 0;
let state = null;
let prevPos = {};   // last-snapshot positions per player id, to detect movement
let invLoopOn = false; // is the local invincibility theme looping
let danceLoopOn = false; // is the local dance-party theme looping
const PREVIEW = new URLSearchParams(location.search).get('preview'); // admin screen preview

// Single audio-unlock entry point — call from any user gesture (joinBtn, title
// overlay tap, keypress). On iOS, the AudioContext must be resumed AND a real
// <audio> element must play during the gesture; doing both here covers every
// path. The fullscreen modal is now a fallback only (hidden by default).
let _audioUnlocked = false;
function unlockAudio() {
  if (_audioUnlocked) return;
  _audioUnlocked = true;
  initAudio();
  try {
    audioUnlockPlayer.currentTime = 0;
    const p = audioUnlockPlayer.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
  audioUnlockModal.style.display = 'none';
}
function hideAudioUnlockModal() {
  audioUnlockModal.style.display = 'none';
}
// keep the modal click as a backup if it ever ends up shown
audioUnlockModal.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  unlockAudio();
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
  // Cap the canvas backing store at 1x device-pixel-ratio. The sprite art is
  // already pixel-art with `image-rendering: pixelated`, so 1x looks correct
  // (intentional pixelation, not blurry). On a 3x phone this is ~9x less
  // rasterization per frame — a major battery win with no visible quality loss.
  const dpr = Math.min(window.devicePixelRatio || 1, 1);
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

// Player-chosen colors. Persist to localStorage on every picker change so a
// mid-customize refresh keeps the in-progress look. First-time load (no saved
// colors) gets random hues so people don't see the same defaults every time.
// Older cf_*_hue keys auto-migrate to the new cf_*_color hex format.
function _loadColor(colorKey, hueKey, fallbackHex) {
  const saved = localStorage.getItem(colorKey);
  if (saved) return saved;
  const hueStr = localStorage.getItem(hueKey);
  if (hueStr != null) {
    const h = Number(hueStr);
    if (Number.isFinite(h)) return hueToHex(h);
  }
  return fallbackHex || hueToHex(Math.floor(Math.random() * 360));
}
let playerColors = {
  shirt:  _loadColor('cf_shirt_color',  'cf_shirt_hue'),                  // random first time
  pants:  _loadColor('cf_pants_color',  'cf_pants_hue'),                  // random first time
  mallen: _loadColor('cf_mallen_color', 'cf_mallen_hue', '#cd2a2a'),      // Mallen default is always red
};
// persist the seed colors so a refresh before pressing READY keeps the look
localStorage.setItem('cf_shirt_color',   playerColors.shirt);
localStorage.setItem('cf_pants_color',  playerColors.pants);
localStorage.setItem('cf_mallen_color', playerColors.mallen);

function connect(name) {
  playerName = name;
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    reconnectAttempts = 0;
    ws.send(JSON.stringify({
      type: MSG.JOIN,
      name: playerName,
      shirtColor:   playerColors.shirt,
      pantsColor:  playerColors.pants,
      mallenColor: playerColors.mallen,
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
        // total bummer: also a global moment — everyone sees the "-1 POINT" + hears it
        else if (e.type === 'presentClaim' && e.fx === 'total_bummer') { playSound('total_bummer'); addBummer(e.id); }
        else if (e.type === 'presentClaim' && e.id === selfId) {
          // portal claim picks one of three random portal SFX
          const name = e.fx === 'portal' ? `portal_${(Math.random() * 3) | 0}` : e.fx;
          playSound(name);
        }
        if (e.type === 'presentClaim' && e.id === selfId && e.fx === 'interstitial') showInterstitial();
        if (e.type === 'explosion') addCurdBurst(e.x, e.y); // curds radiate outward in timed rings
        // nuke: global "launch detected" SFX on commit + a big visual + boom on detonation
        if (e.type === 'nukeLaunch') { playSound('nuke_launch'); showNukeBanner(); }
        if (e.type === 'nukeDetonate') { playSound('nuke_explosion'); addNukeExplosion(e.x, e.y); }
      }
      updateButtons();
    }
  };
  ws.onclose = () => {
    // Reset any client-side audio loop / state that won't survive a fresh
    // session — otherwise the local invincibility / dance themes can wedge as
    // "playing" after a reconnect even though their source nodes were torn
    // down with the old context. Also drop the old ws so a slow GC doesn't
    // hold a reference to ten dead sockets.
    if (invLoopOn)   { try { stopLoop('invincible_theme'); } catch {}; invLoopOn = false; }
    if (danceLoopOn) { try { stopLoop('dance_party_theme'); } catch {}; danceLoopOn = false; }
    try { duckMusic(false); } catch {}
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    ws = null;
    // Auto-reconnect: a Wi-Fi blip or the phone backgrounding shouldn't kick
    // you for good. Cap retries so we don't reconnect-spam if the server is
    // permanently gone — reconnectAttempts is only zeroed by a SUCCESSFUL
    // onopen below (NOT by reaching here), so the cap actually holds.
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
  if (!p || p.stunned) return;
  // If a buff arrived during a held charge (carrying -> nukeArmed), allow the
  // new press to enter nuke-aim mode instead of being eaten by `charge.active`.
  if (p.nukeArmed) {
    if (charge.active) { charge.active = false; charge.aim = null; }
    startNukeAim(e); return;
  }
  if (charge.active) return;
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
  // If a charge was somehow still active when we entered nuke-arm mode (race
  // between the buff arriving on a snapshot and the player still holding the
  // throw button), clear the local charge state without firing a release —
  // the server already disarmed our throw on the snapshot transition.
  if (p && p.nukeArmed && charge.active) { charge.active = false; charge.aim = null; }
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
  unlockAudio();          // joinBtn IS a user gesture — kick off iOS audio unlock from here
  fitCanvas();
  localStorage.setItem('cf_name', name);
  showCustomizeScreen(name);
};
nameInput.addEventListener('input', updateJoinEnabled);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });

// --- custom HSV color picker -------------------------------------------------
// Firefox Android's built-in <input type="color"> is a tiny preset palette,
// not a real picker. We render our own SV plane + hue strip in canvas so every
// browser gets the same experience. Each "swatch" is a <button> that owns its
// hex value via a .value property and emits an 'input' CustomEvent when the
// picker writes a new color — existing onPickerChange wiring keeps working.
function _hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function _rgbToHex(r, g, b) {
  const h = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
function _rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx };
}
function _hsvToRgb(h, s, v) {
  const c = v * s;
  const hh = (h / 60) % 6;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hh < 1)      { r = c; g = x; }
  else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; }
  else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; }
  else             { r = c; b = x; }
  const m = v - c;
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

function _setSwatch(sw, hex) {
  sw.value = hex;
  sw.style.background = hex;
}

const colorPicker = (() => {
  const modal     = document.getElementById('colorPickerModal');
  const sv        = document.getElementById('cpSV');
  const hue       = document.getElementById('cpHue');
  const preview   = document.getElementById('cpPreview');
  const hexLabel  = document.getElementById('cpHex');
  const cancelBtn = document.getElementById('cpCancel');
  const okBtn     = document.getElementById('cpOk');
  const svCtx     = sv.getContext('2d');
  const hueCtx    = hue.getContext('2d');

  let target = null;
  let originalHex = '#ffffff';
  let hsv = { h: 0, s: 1, v: 1 };

  function drawSV() {
    const W = sv.width, H = sv.height;
    const base = _hsvToRgb(hsv.h, 1, 1);
    svCtx.fillStyle = `rgb(${base.r | 0},${base.g | 0},${base.b | 0})`;
    svCtx.fillRect(0, 0, W, H);
    const gx = svCtx.createLinearGradient(0, 0, W, 0);
    gx.addColorStop(0, 'rgba(255,255,255,1)');
    gx.addColorStop(1, 'rgba(255,255,255,0)');
    svCtx.fillStyle = gx; svCtx.fillRect(0, 0, W, H);
    const gy = svCtx.createLinearGradient(0, 0, 0, H);
    gy.addColorStop(0, 'rgba(0,0,0,0)');
    gy.addColorStop(1, 'rgba(0,0,0,1)');
    svCtx.fillStyle = gy; svCtx.fillRect(0, 0, W, H);
    const cx = hsv.s * W, cy = (1 - hsv.v) * H;
    svCtx.lineWidth = 2; svCtx.strokeStyle = '#000';
    svCtx.beginPath(); svCtx.arc(cx, cy, 8, 0, Math.PI * 2); svCtx.stroke();
    svCtx.strokeStyle = '#fff';
    svCtx.beginPath(); svCtx.arc(cx, cy, 7, 0, Math.PI * 2); svCtx.stroke();
  }
  function drawHue() {
    const W = hue.width, H = hue.height;
    const g = hueCtx.createLinearGradient(0, 0, W, 0);
    for (let i = 0; i <= 6; i++) {
      const rgb = _hsvToRgb(i * 60, 1, 1);
      g.addColorStop(i / 6, `rgb(${rgb.r | 0},${rgb.g | 0},${rgb.b | 0})`);
    }
    hueCtx.fillStyle = g; hueCtx.fillRect(0, 0, W, H);
    const x = (hsv.h / 360) * W;
    hueCtx.lineWidth = 2; hueCtx.strokeStyle = '#000';
    hueCtx.strokeRect(x - 5, 1, 10, H - 2);
    hueCtx.strokeStyle = '#fff';
    hueCtx.strokeRect(x - 4, 2, 8, H - 4);
  }
  function commitToTarget() {
    const rgb = _hsvToRgb(hsv.h, hsv.s, hsv.v);
    const hex = _rgbToHex(rgb.r, rgb.g, rgb.b);
    preview.style.background = hex;
    hexLabel.textContent = hex.toUpperCase();
    if (target) {
      _setSwatch(target, hex);
      target.dispatchEvent(new CustomEvent('input'));   // keep onPickerChange wiring intact
    }
  }
  function pointerToSV(e) {
    const rect = sv.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    hsv.s = x / rect.width;
    hsv.v = 1 - y / rect.height;
    drawSV(); commitToTarget();
  }
  function pointerToHue(e) {
    const rect = hue.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    hsv.h = (x / rect.width) * 360;
    drawSV(); drawHue(); commitToTarget();
  }
  function bindDrag(el, handler) {
    let active = false;
    el.addEventListener('pointerdown', (e) => {
      active = true;
      try { el.setPointerCapture(e.pointerId); } catch {}
      handler(e);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => { if (active) { handler(e); e.preventDefault(); } });
    el.addEventListener('pointerup',     (e) => { active = false; try { el.releasePointerCapture(e.pointerId); } catch {} });
    el.addEventListener('pointercancel', ()  => { active = false; });
  }
  bindDrag(sv, pointerToSV);
  bindDrag(hue, pointerToHue);

  cancelBtn.addEventListener('click', () => {
    if (target) {
      _setSwatch(target, originalHex);
      target.dispatchEvent(new CustomEvent('input'));
    }
    modal.style.display = 'none';
    target = null;
  });
  okBtn.addEventListener('click', () => {
    modal.style.display = 'none';
    target = null;
  });

  return {
    open(swatch) {
      target = swatch;
      originalHex = swatch.value || '#ffffff';
      const rgb = _hexToRgb(originalHex);
      hsv = _rgbToHsv(rgb.r, rgb.g, rgb.b);
      // A neutral gray has no defined hue — keep whatever hsv.h was set to
      // (it'll be 0 from rgbToHsv) so the SV plane has a basis to draw.
      drawSV(); drawHue(); commitToTarget();
      modal.style.display = 'flex';
    }
  };
})();

// initialize each swatch from its data-color attribute and wire it to the picker
for (const sw of [shirtColor, pantsColor, mallenColor]) {
  _setSwatch(sw, sw.dataset.color || '#ffffff');
  sw.addEventListener('click', () => colorPicker.open(sw));
}

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
  shirtColor.parentElement.style.display = _pendingMallen ? 'none' : '';
  mallenPicker.style.display = _pendingMallen ? '' : 'none';
  // hydrate pickers from saved hex (keeps swatch background in sync)
  _setSwatch(shirtColor,  playerColors.shirt);
  _setSwatch(pantsColor,  playerColors.pants);
  _setSwatch(mallenColor, playerColors.mallen);
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
  const W = previewCanvas.width;
  pctx.imageSmoothingEnabled = false;
  pctx.clearRect(0, 0, W, W);

  if (_pendingMallen) {
    // Body fills ~70% of the preview and sits low, leaving the upper area for
    // the bobblehead face overlay — matches the in-game faceY = cy - 0.32*size.
    const bodySize = W * 0.70;
    const bodyCx = W / 2;
    const bodyCy = W * 0.60;
    const body = getMallenSprite(mallenColor.value, false, 's', _previewFrame);
    if (body) pctx.drawImage(body, bodyCx - bodySize / 2, bodyCy - bodySize / 2, bodySize, bodySize);
    const face = images.mallen_face;
    if (face) {
      const faceH = bodySize * 0.62;
      const faceW = faceH * (face.width / face.height);
      const faceY = bodyCy - bodySize * 0.32;            // matches render.js
      pctx.drawImage(face, bodyCx - faceW / 2, faceY - faceH / 2, faceW, faceH);
    }
    return;
  }

  const sprite = getDeliverySprite(shirtColor.value, pantsColor.value, 's', _previewFrame);
  if (sprite) pctx.drawImage(sprite, 0, 0, W, W);
}
// live update + persist on every color tweak so a refresh before READY keeps the look
function _onPickerChange() {
  playerColors = {
    shirt: shirtColor.value, pants: pantsColor.value, mallen: mallenColor.value,
  };
  localStorage.setItem('cf_shirt_color',   playerColors.shirt);
  localStorage.setItem('cf_pants_color',  playerColors.pants);
  localStorage.setItem('cf_mallen_color', playerColors.mallen);
  drawPreview();
}
shirtColor.addEventListener('input',   _onPickerChange);
pantsColor.addEventListener('input',  _onPickerChange);
mallenColor.addEventListener('input', _onPickerChange);

readyBtn.onclick = () => {
  playerColors = {
    shirt: shirtColor.value, pants: pantsColor.value, mallen: mallenColor.value,
  };
  localStorage.setItem('cf_shirt_color',   playerColors.shirt);
  localStorage.setItem('cf_pants_color',  playerColors.pants);
  localStorage.setItem('cf_mallen_color', playerColors.mallen);
  hideCustomizeScreen();
  connect(nameInput.value.trim().slice(0, 16));
};

// Audio can't autoplay, so the title theme can't start on its own while the
// title overlay is showing. Kick it off on the player's first interaction with
// the title screen (tap or keypress) — that gesture unlocks audio.
let audioPrimed = false;
function primeTitleAudio() {
  if (audioPrimed) return;
  audioPrimed = true;
  unlockAudio();
  setMusic('title');
}
overlay.addEventListener('pointerdown', primeTitleAudio);
nameInput.addEventListener('keydown', primeTitleAudio);
goBtn.onclick = () => { unlockAudio(); send(MSG.READY); };

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
// the punch/attack is on cooldown. Skips the style.background write when the value
// is unchanged so the idle case (no cooldown) costs nothing.
let _lastBtnBg = null;
function paintActionButton() {
  const now = performance.now();
  let bg;
  if (now < actionCdUntil && actionCdMs > 0) {
    const deg = ((actionCdUntil - now) / actionCdMs) * 360;
    bg = `conic-gradient(rgba(0,0,0,0.45) ${deg}deg, rgba(0,0,0,0) ${deg}deg), ${baseActionColor}`;
  } else {
    bg = baseActionColor;
  }
  if (bg !== _lastBtnBg) {
    actionBtn.style.background = bg;
    _lastBtnBg = bg;
  }
}

// Any of these elements covering the canvas means there's nothing useful to draw
// — game world is hidden underneath. Inline-style checks are reliable here
// because the show/hide call sites all set .style.display directly (overlay
// defaults visible via CSS and we set 'none' on JOIN; the others default to
// 'none' via CSS and we set 'flex' when showing).
function gameOverlayCovering() {
  if (overlay.style.display !== 'none') return true;       // title screen (CSS default flex)
  if (customize.style.display === 'flex') return true;     // character customize screen
  if (adInterstitial.style.display === 'flex') return true; // ad interstitial debuff
  return false;
}

// Pause audio + skip rendering while the tab/screen is hidden, to stop burning
// CPU on the phone when the screen is off.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspendAudio(); else resumeAudio();
});

// Render loop capped at 30 fps. Server simulation runs at 30 Hz, so the client
// has no new state to draw faster than that anyway. Uncapped the canvas would
// redraw at the display's native rate (60-120 Hz on phones), burning CPU/GPU
// + battery for no visible benefit. 30 also matches the snapshot cadence:
// every paint shows fresh data, no wasted frames in between.
const TARGET_FRAME_MS = 1000 / 30;
let lastFrameTs = 0;
function loop(ts = 0) {
  requestAnimationFrame(loop);
  if (document.hidden) return;
  if (ts - lastFrameTs < TARGET_FRAME_MS - 1) return; // skip extra frames on hi-refresh screens
  lastFrameTs = ts;
  // Title / customize / interstitial fully cover the canvas — drawing the game
  // world under them just burns the GPU for no visible result.
  if (gameOverlayCovering()) return;
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
