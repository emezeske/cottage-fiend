// Procedural sound effects via Web Audio. Every effect is synthesized so the
// game has sound with zero downloaded files. To use real CC0 files instead,
// drop them in client/assets/sounds/ and map them in FILE_SOUNDS below; if a
// file exists it overrides the procedural version.

const FILE_SOUNDS = {
  // event -> filename in assets/sounds/ (optional). Leave empty to stay procedural.
  // chomp: 'chomp.mp3',
  // splat: 'splat.wav',
  // throw: 'whoosh.wav',
  // score: 'ding.wav',
  // roundEnd: 'cheer.wav',
};

let ctx = null;
const buffers = {};

export function initAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  // preload any file overrides
  for (const [evt, file] of Object.entries(FILE_SOUNDS)) {
    fetch(`assets/sounds/${file}`)
      .then(r => r.arrayBuffer())
      .then(b => ctx.decodeAudioData(b))
      .then(buf => { buffers[evt] = buf; })
      .catch(() => {/* fall back to procedural */});
  }
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
  score:  () => { tone({ freq: 660, dur: 0.12, gain: 0.2 });
                  setTimeout(() => tone({ freq: 990, dur: 0.18, gain: 0.22 }), 90); },
  attack: () => tone({ type: 'square', freq: 180, dur: 0.06, gain: 0.18, slideTo: 90 }),
  drop:   () => tone({ type: 'triangle', freq: 220, dur: 0.2, gain: 0.18, slideTo: 80 }),
  chomp:  () => { // comically messy animal devour
    noiseBurst({ dur: 0.32, gain: 0.5, lp: 700 });
    tone({ type: 'sawtooth', freq: 90, dur: 0.3, gain: 0.25, slideTo: 50 });
    setTimeout(() => noiseBurst({ dur: 0.2, gain: 0.4, lp: 600 }), 120);
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
  if (ctx.state === 'suspended') ctx.resume();
  if (buffers[type]) { playBuffer(buffers[type]); return; }
  const fn = PROCEDURAL[type];
  if (fn) try { fn(); } catch (e) {/* ignore */}
}
