// Procedural sound effects via Web Audio. Every effect is synthesized so the
// game has sound with zero downloaded files. To use real CC0 files instead,
// drop them in client/assets/sounds/ and map them in FILE_SOUNDS below; if a
// file exists it overrides the procedural version.

const FILE_SOUNDS = {
  // event -> filename in assets/sounds/ (optional). Leave empty to stay procedural.
  // A file here overrides the procedural version and plays globally on the event.
  roundEnd: 'sfx_round_over.mp3', // "round over" sting on the leaderboard
};

// Named SFX files (placeholders — all currently the same test clip; overwrite
// each file individually later). Some are played globally, some locally — see main.js.
const SFX_FILES = {
  dash: 'sfx_dash.mp3',          // global: Mallen dash
  firstCurd: 'sfx_first_curd.mp3', // global: first score of the round
  round: 'sfx_round.mp3',        // global: round start
  score: 'sfx_score.mp3',        // local: you scored
  ad1: 'sfx_ad_1.mp3',           // local: tapped the top ad banner (one of 3 picked at random)
  ad2: 'sfx_ad_2.mp3',
  ad3: 'sfx_ad_3.mp3',
  // local: one per power-up / curse / wildcard effect (keyed by effect id)
  double_speed: 'sfx_double_speed.mp3',
  two_x_points: 'sfx_two_x_points.mp3',
  invincible: 'sfx_invincible.mp3',
  explosion: 'sfx_explosion.mp3',
  magnet: 'sfx_magnet.mp3',
  curd_cannon: 'sfx_curd_cannon.mp3',
  half_speed: 'sfx_half_speed.mp3',
  backwards: 'sfx_backwards.mp3',
  greased: 'sfx_greased.mp3',
  tiny: 'sfx_tiny.mp3',
  blindness: 'sfx_blindness.mp3',
  banana: 'sfx_banana.mp3',
  swap: 'sfx_swap.mp3',
  pinata: 'sfx_pinata.mp3',
  interstitial: 'sfx_interstitial.mp3', // local: forced ad-break debuff jingle
  invincible_theme: 'invincible.mp3', // looped locally while you're invincible
};

// Looping background music per game screen (crossfaded between).
const MUSIC_FILES = { title: 'title.mp3', gameplay: 'gameplay.mp3', score: 'score.mp3' };
const MUSIC_VOL = 0.03; // background music sits well under the SFX
const musicBuffers = {}; // name -> AudioBuffer
const musicNodes = {};   // name -> { src, g } currently playing
let desiredMusic = null;

let ctx = null;
let clipsLoading = false;
const buffers = {};
const sfx = {}; // name -> decoded AudioBuffer
const rawBytes = {}; // url -> ArrayBuffer, fetched during preload (decoded after unlock)

function url_sound(f) { return `assets/sounds/${f}`; }
function url_music(f) { return `assets/music/${f}`; }

// Fetch every audio file's bytes up front (no AudioContext / user gesture needed).
// Decoding happens after the first user gesture, instantly, from these cached bytes.
// Returns a Promise.
export function prefetchAudio() {
  const urls = [
    ...Object.values(FILE_SOUNDS).map(url_sound),
    ...Object.values(SFX_FILES).map(url_sound),
    ...Object.values(MUSIC_FILES).map(url_music),
  ];
  return Promise.all(urls.map((u) =>
    fetch(u).then((r) => r.arrayBuffer()).then((b) => { rawBytes[u] = b; }).catch(() => {})
  ));
}

function loadClip(u) {
  const bytes = rawBytes[u] ? Promise.resolve(rawBytes[u]) : fetch(u).then((r) => r.arrayBuffer());
  return bytes.then((b) => ctx.decodeAudioData(b));
}

function ensureContext() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

function resumeContext() {
  if (!ctx || ctx.state !== 'suspended' || document.hidden) return;
  const p = ctx.resume();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

function loadAllClips() {
  if (clipsLoading) return;
  clipsLoading = true;
  for (const [evt, file] of Object.entries(FILE_SOUNDS))
    loadClip(url_sound(file)).then((buf) => { buffers[evt] = buf; }).catch(() => {});
  for (const [name, file] of Object.entries(SFX_FILES))
    loadClip(url_sound(file)).then((buf) => { sfx[name] = buf; }).catch(() => {});
  for (const [name, file] of Object.entries(MUSIC_FILES))
    loadClip(url_music(file))
      .then((buf) => { musicBuffers[name] = buf; _startDesiredMusic(700); })
      .catch((e) => console.warn('music load failed:', file, e));
}

export function initAudio() {
  ensureContext();
  resumeContext();
  loadAllClips();
}

// Play a named SFX clip (see SFX_FILES). No-op until loaded.
export function playSound(name, gain = 0.9) {
  if (!ctx || !sfx[name]) return;
  resumeContext();
  playBuffer(sfx[name], gain);
}

// Looping clips (e.g. the invincibility theme). Idempotent start/stop.
const loops = {}; // name -> { src, g }
export function playLoop(name, gain = 0.5) {
  if (!ctx || !sfx[name] || loops[name]) return;
  resumeContext();
  const src = ctx.createBufferSource();
  src.buffer = sfx[name]; src.loop = true;
  const g = ctx.createGain(); g.gain.value = gain;
  src.connect(g).connect(ctx.destination);
  src.start();
  loops[name] = { src, g };
}
export function stopLoop(name) {
  const l = loops[name];
  if (!l) return;
  delete loops[name];
  try { l.src.stop(); } catch {}
}

// Pause/resume the whole audio engine (call when the page is hidden/visible to
// stop burning CPU on the audio thread while the screen is off).
export function suspendAudio() { if (ctx && ctx.state === 'running') ctx.suspend(); }
export function resumeAudio() { resumeContext(); }

// Crossfade the looping background music to `name` (title/gameplay/score).
export function setMusic(name, fadeMs = 700) {
  if (!ctx || desiredMusic === name) return;
  resumeContext();
  const old = desiredMusic;
  desiredMusic = name;
  if (old && musicNodes[old]) _fadeOutMusic(old, fadeMs);
  _startDesiredMusic(fadeMs);
}

// While a foreground loop (the invincibility theme) is playing, mute the
// background music entirely, then bring it back when the loop stops.
let musicDucked = false;
function _musicTarget() { return musicDucked ? 0 : MUSIC_VOL; }
export function duckMusic(on, fadeMs = 300) {
  musicDucked = on;
  if (!ctx) return;
  const t = ctx.currentTime;
  for (const node of Object.values(musicNodes)) {
    node.g.gain.cancelScheduledValues(t);
    node.g.gain.setValueAtTime(node.g.gain.value, t);
    node.g.gain.linearRampToValueAtTime(_musicTarget(), t + fadeMs / 1000);
  }
}

function _startDesiredMusic(fadeMs) {
  const name = desiredMusic;
  if (!name || !musicBuffers[name] || musicNodes[name]) return; // not loaded, or already playing
  const src = ctx.createBufferSource();
  src.buffer = musicBuffers[name];
  src.loop = true;
  const g = ctx.createGain();
  g.gain.value = 0;
  src.connect(g).connect(ctx.destination);
  src.start();
  const t = ctx.currentTime;
  g.gain.linearRampToValueAtTime(_musicTarget(), t + fadeMs / 1000);
  musicNodes[name] = { src, g };
}

function _fadeOutMusic(name, fadeMs) {
  const node = musicNodes[name];
  if (!node) return;
  delete musicNodes[name];
  const t = ctx.currentTime;
  node.g.gain.cancelScheduledValues(t);
  node.g.gain.setValueAtTime(node.g.gain.value, t);
  node.g.gain.linearRampToValueAtTime(0, t + fadeMs / 1000);
  try { node.src.stop(t + fadeMs / 1000 + 0.05); } catch {}
}

function playBuffer(buf, gain = 1) {
  const src = ctx.createBufferSource();
  const g = ctx.createGain();
  g.gain.value = gain;
  src.buffer = buf;
  src.connect(g).connect(ctx.destination);
  src.start();
}

function tone({ type = 'sine', freq = 440, dur = 0.15, gain = 0.2, slideTo = null }) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, ctx.currentTime);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  o.connect(g).connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + dur);
}

function noiseBurst({ dur = 0.2, gain = 0.3, lp = 2000 }) {
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = lp;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(filt).connect(g).connect(ctx.destination);
  src.start();
}

// Map each game event to a synthesized sound.
const PROCEDURAL = {
  pickup: () => tone({ type: 'square', freq: 520, dur: 0.08, gain: 0.15, slideTo: 740 }),
  throw:  () => { noiseBurst({ dur: 0.25, gain: 0.25, lp: 1200 });
                  tone({ type: 'sawtooth', freq: 300, dur: 0.2, gain: 0.1, slideTo: 120 }); },
  splat:  () => noiseBurst({ dur: 0.18, gain: 0.4, lp: 900 }),
  // score: handled entirely by the local sfx_score.mp3 cue now (see main.js)
  attack: () => tone({ type: 'square', freq: 180, dur: 0.06, gain: 0.18, slideTo: 90 }),
  drop:   () => tone({ type: 'triangle', freq: 220, dur: 0.2, gain: 0.18, slideTo: 80 }),
  chomp:  () => { // comically messy animal devour
    noiseBurst({ dur: 0.32, gain: 0.5, lp: 700 });
    tone({ type: 'sawtooth', freq: 90, dur: 0.3, gain: 0.25, slideTo: 50 });
    setTimeout(() => noiseBurst({ dur: 0.2, gain: 0.4, lp: 600 }), 120);
  },
  stun:   () => { // dazed warble (devour shockwave)
    tone({ type: 'sine', freq: 700, dur: 0.45, gain: 0.18, slideTo: 180 });
    setTimeout(() => tone({ type: 'sine', freq: 520, dur: 0.4, gain: 0.14, slideTo: 140 }), 110);
  },
  roundEnd: () => {
    [523, 659, 784, 1046].forEach((f, i) =>
      setTimeout(() => tone({ type: 'square', freq: f, dur: 0.18, gain: 0.2 }), i * 110));
  },
  join: () => tone({ type: 'sine', freq: 880, dur: 0.1, gain: 0.12 }),
  presentDrop: () => tone({ type: 'sine', freq: 1200, dur: 0.5, gain: 0.08, slideTo: 500 }),
  presentClaim: () => { // little birthday sparkle
    [784, 988, 1318].forEach((f, i) =>
      setTimeout(() => tone({ type: 'triangle', freq: f, dur: 0.12, gain: 0.18 }), i * 70));
  },
  explosion: () => {
    noiseBurst({ dur: 0.5, gain: 0.6, lp: 1400 });
    tone({ type: 'sawtooth', freq: 160, dur: 0.45, gain: 0.3, slideTo: 40 });
  },
  swap: () => tone({ type: 'sine', freq: 400, dur: 0.25, gain: 0.18, slideTo: 1200 }),
  pinata: () => { noiseBurst({ dur: 0.3, gain: 0.4, lp: 1800 });
    [659, 880].forEach((f, i) => setTimeout(() => tone({ freq: f, dur: 0.12, gain: 0.16 }), i * 80)); },
};

export function playEvent(type) {
  if (!ctx) return;
  resumeContext();
  if (buffers[type]) { playBuffer(buffers[type]); return; }
  const fn = PROCEDURAL[type];
  if (fn) try { fn(); } catch (e) {/* ignore */}
}
