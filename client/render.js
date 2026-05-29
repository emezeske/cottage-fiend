// Canvas renderer. Pure drawing from a snapshot — no game logic here.
// World is drawn under a (devicePixelRatio * following-camera) transform; HUD and
// overlays are drawn in CSS-pixel screen space on top.

import { images } from './assets.js';
import { computeCamera, getCamera } from './camera.js';

const PHASE = { LOBBY: 'lobby', COUNTDOWN: 'countdown', PLAYING: 'playing', LEADERBOARD: 'leaderboard' };

const AD_H = 58; // height of the top ad banner (CSS px); HUD sits below it

const EFFECT_LABELS = {
  double_speed: '⚡2X SPEED', two_x_points: '2X PTS', invincible: '🛡INVINCIBLE',
  magnet: '🧲MAGNET', curd_cannon: '💥CURD CANNON',
  half_speed: '🐌HALF SPEED', backwards: '🔄BACKWARDS', greased: '🧈GREASED',
  tiny: '🔬TINY', blindness: '🫥CURD BLIND', banana: '🍌SLIDEY',
};
const BUFF_SET = new Set(['double_speed', 'two_x_points', 'invincible', 'magnet', 'curd_cannon']);

// transient splatters spawned from events, faded over time
const splats = [];
export function addSplat(x, y) {
  splats.push({ x, y, t: 0, life: 700, frame: (Math.random() * 3) | 0 });
}

// colorful confetti burst on a successful delivery (world-space, at the fridge)
const confetti = [];
const CONFETTI_COLORS = ['#ff5d5d', '#ffd23f', '#3fd0ff', '#6dff8f', '#c98bff', '#ff8ad4', '#ffffff'];
export function addConfetti(x, y) {
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 90 + Math.random() * 320;
    confetti.push({
      x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 180,
      t: 0, life: 1200 + Math.random() * 700,
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
      w: 5 + Math.random() * 7, h: 8 + Math.random() * 9,
      rot: Math.random() * Math.PI, vrot: (Math.random() - 0.5) * 0.5,
    });
  }
}

// comic "BAM!" starburst on a connecting punch (world-space, at the impact)
const bams = [];
const BAM_WORDS = ['BAM!', 'POW!', 'WHAM!', 'BONK!', 'SMACK!', 'KAPOW!'];
export function addBam(x, y) {
  bams.push({
    x, y, t: 0, life: 520,
    word: BAM_WORDS[(Math.random() * BAM_WORDS.length) | 0],
    rot: (Math.random() - 0.5) * 0.5,
  });
}

function drawStarburst(ctx, r) {
  const spikes = 12;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const ang = (i / (spikes * 2)) * Math.PI * 2;
    const rad = i % 2 === 0 ? r : r * 0.58;
    const x = Math.cos(ang) * rad, y = Math.sin(ang) * rad;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawBams(ctx) {
  for (let i = bams.length - 1; i >= 0; i--) {
    const b = bams[i];
    b.t += 16;
    const k = b.t / b.life;
    if (k >= 1) { bams.splice(i, 1); continue; }
    const scale = k < 0.28 ? k / 0.28 : 1;          // pop in
    const alpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3; // fade out
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    ctx.scale(scale, scale);
    drawStarburst(ctx, 48);
    ctx.fillStyle = '#ffe14d'; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = '#ff5d3a'; ctx.stroke();
    ctx.fillStyle = '#3a1010';
    ctx.font = '900 28px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 5; ctx.strokeStyle = '#fff';
    ctx.strokeText(b.word, 0, 1);
    ctx.fillText(b.word, 0, 1);
    ctx.restore();
  }
  ctx.textBaseline = 'alphabetic';
}

function drawConfetti(ctx) {
  for (let i = confetti.length - 1; i >= 0; i--) {
    const c = confetti[i];
    c.t += 16;
    const a = Math.max(0, 1 - c.t / c.life);
    if (a <= 0) { confetti.splice(i, 1); continue; }
    c.x += c.vx * 0.016; c.y += c.vy * 0.016;
    c.vy += 900 * 0.016; c.vx *= 0.99; c.rot += c.vrot;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(c.x, c.y); ctx.rotate(c.rot);
    ctx.fillStyle = c.color;
    ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    ctx.restore();
  }
}

let walkClock = 0;

function drawSprite(ctx, img, x, y, w, h) {
  if (img) ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
}

function fallbackCircle(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#1e1814'; ctx.lineWidth = 3; ctx.stroke();
}

export function render(ctx, canvas, state, selfId, charge) {
  walkClock += 1;
  const cam = computeCamera(canvas, state, selfId);
  const { cssW, cssH } = cam;

  // base transform: CSS pixels (crisp on hi-dpi)
  ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);

  // void outside the arena
  ctx.fillStyle = '#10160f';
  ctx.fillRect(0, 0, cssW, cssH);

  if (!state) { drawTopAd(ctx, cssW); return; }

  const { loci, players = [], tubs = [], presents = [], arena } = state;

  // ---- world space ----------------------------------------------------------
  ctx.save();
  ctx.translate(cam.offX, cam.offY);
  ctx.scale(cam.scale, cam.scale);

  drawFloor(ctx, arena || { width: 1600, height: 1600 });
  if (state.safeZone) drawSafeZone(ctx, state.safeZone);

  if (loci) {
    drawSprite(ctx, images.truck, loci.truck.x, loci.truck.y, 160, 120);
    drawSprite(ctx, images.fridge, loci.fridge.x, loci.fridge.y, 110, 130);
    if (!images.truck) fallbackCircle(ctx, loci.truck.x, loci.truck.y, 60, '#ccd');
    if (!images.fridge) fallbackCircle(ctx, loci.fridge.x, loci.fridge.y, 54, '#dde');
  }

  // tubs (ready/loose/flying — carried are drawn with their player)
  for (const t of tubs) {
    if (t.state === 'carried') continue;
    drawSprite(ctx, images.tub, t.x, t.y, 36, 36);
    if (!images.tub) fallbackCircle(ctx, t.x, t.y, 15, '#f2f0e0');
  }

  // splatters (under players)
  for (let i = splats.length - 1; i >= 0; i--) {
    const s = splats[i];
    s.t += 16;
    const a = Math.max(0, 1 - s.t / s.life);
    ctx.globalAlpha = a;
    drawSprite(ctx, images[`splat_${s.frame}`], s.x, s.y, 48, 48);
    ctx.globalAlpha = 1;
    if (s.t >= s.life) splats.splice(i, 1);
  }

  // walk frame: time-based (framerate-independent) and slower than before
  const animFrame = ((performance.now() / 230) | 0) & 1;
  for (const p of players) drawPlayer(ctx, p, animFrame, p.id === selfId);

  // carried tubs on top of their carriers
  for (const t of tubs) {
    if (t.state !== 'carried') continue;
    drawSprite(ctx, images.tub, t.x, t.y, 32, 32);
    if (!images.tub) fallbackCircle(ctx, t.x, t.y, 13, '#f2f0e0');
  }

  for (const g of presents) {
    drawSprite(ctx, images.present, g.x, g.y, 52, 52);
    if (!images.present) fallbackCircle(ctx, g.x, g.y, 26, '#e57');
    if (!g.landed) drawSprite(ctx, images.parachute, g.x, g.y - 46, 96, 96);
    else {
      const r = 30 + Math.sin(walkClock * 0.15) * 4;
      ctx.strokeStyle = 'rgba(255,225,77,0.7)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(g.x, g.y, r, 0, Math.PI * 2); ctx.stroke();
    }
  }

  drawConfetti(ctx);
  drawBams(ctx);

  if (charge && charge.active) drawChargeArc(ctx, charge);

  ctx.restore();

  // ---- screen space ---------------------------------------------------------
  const self = players.find((p) => p.id === selfId);

  // off-screen guidance arrows so you can navigate the panned arena
  if (loci && self && state.phase === PHASE.PLAYING) {
    if (self.carrying) locusArrow(ctx, cssW, cssH, loci.fridge, '🧊 FRIDGE', '#9ad7ff');
    else locusArrow(ctx, cssW, cssH, loci.truck, '🚚 TUBS', '#ffe14d');
  }

  if (self && self.effect === 'blindness') drawBlindness(ctx, cssW, cssH);
  else _blindBlobs = null;

  drawHUD(ctx, cssW, cssH, state, selfId);
  if (state.phase === PHASE.COUNTDOWN) drawCountdown(ctx, cssW, cssH, state);
  if (state.phase === PHASE.LEADERBOARD) drawLeaderboard(ctx, cssW, cssH, state, selfId);
  if (state.phase === PHASE.LOBBY) drawLobby(ctx, cssW, cssH, state);

  // the single, always-on, deeply annoying top ad — drawn last so it's on top
  drawTopAd(ctx, cssW);
}

function drawSafeZone(ctx, z) {
  ctx.save();
  ctx.fillStyle = 'rgba(120,220,255,0.07)';
  ctx.fillRect(z.x, z.y, z.w, z.h);
  ctx.setLineDash([14, 10]);
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(120,220,255,0.75)';
  ctx.strokeRect(z.x, z.y, z.w, z.h);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(170,235,255,0.9)';
  ctx.font = 'bold 17px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('PICKUP ZONE · NO MALLEN', z.x + z.w / 2, z.y - 9);
  ctx.restore();
}

function drawFloor(ctx, arena) {
  ctx.fillStyle = '#27331f';
  ctx.fillRect(0, 0, arena.width, arena.height);
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (let gx = 0; gx < arena.width; gx += 64)
    for (let gy = 0; gy < arena.height; gy += 64)
      if ((gx / 64 + gy / 64) % 2 === 0) ctx.fillRect(gx, gy, 64, 64);
  ctx.strokeStyle = 'rgba(255,225,77,0.22)';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, arena.width - 6, arena.height - 6);
}

// movement vector -> one of 8 compass facings (screen +y is down)
function dir8(dx, dy) {
  const idx = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
  return ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'][idx];
}

function drawPlayer(ctx, p, frame, isSelf) {
  const dir = dir8(p.dir.x, p.dir.y);
  const f = p.moving ? frame : 0;   // stand on frame 0 when not moving
  let img;
  if (p.isMallen) img = images[`mallen${p.frenzy ? '_frenzy' : ''}_${dir}_${f}`];
  else img = images[`delivery_${p.spriteIndex}_${dir}_${f}`];
  // full-body sprites are drawn a bit taller than the collision circle and nudged
  // up so the feet sit near the player position
  const size = p.radius * 3.0;
  const cy = p.y - size * 0.12;

  if (p.isMallen && p.frenzy) {
    ctx.save();
    ctx.shadowColor = `hsl(${(walkClock * 20) % 360},90%,60%)`;
    ctx.shadowBlur = 25;
    drawSprite(ctx, img, p.x, cy, size, size);
    ctx.restore();
  } else {
    drawSprite(ctx, img, p.x, cy, size, size);
  }
  if (!img) fallbackCircle(ctx, p.x, p.y, p.radius, p.isMallen ? '#a4c' : '#d96');

  const topY = cy - size / 2 - 4;   // just above the sprite, so it never overlaps
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.strokeStyle = '#1e1814';
  ctx.strokeText(p.name, p.x, topY);
  ctx.fillStyle = isSelf ? '#ffe14d' : '#fff';
  ctx.fillText(p.name, p.x, topY);

  if (p.effect) {
    const label = EFFECT_LABELS[p.effect] || p.effect;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = BUFF_SET.has(p.effect) ? '#8f8' : '#f88';
    ctx.strokeText(label, p.x, topY - 16);
    ctx.fillText(label, p.x, topY - 16);
  }
}

function drawChargeArc(ctx, charge) {
  const { x, y, dir, power, minPower, maxPower } = charge;
  const frac = (power - minPower) / (maxPower - minPower);
  const len = 60 + frac * 160;
  const ang = Math.atan2(dir.y, dir.x);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  const hue = 60 - frac * 60;
  ctx.fillStyle = `hsl(${hue},90%,55%)`;
  ctx.globalAlpha = 0.8;
  ctx.fillRect(20, -7, len, 14);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.fillRect(20 + len - 4, -10, 4, 20);
  ctx.restore();
}

// An edge arrow pointing toward an off-screen world target (truck/fridge).
function locusArrow(ctx, cssW, cssH, target, label, color) {
  const cam = getCamera();
  const sx = target.x * cam.scale + cam.offX;
  const sy = target.y * cam.scale + cam.offY;
  const m = 30;
  const left = m, right = cssW - m, top = AD_H + m, bottom = cssH - m;
  if (sx >= left && sx <= right && sy >= top && sy <= bottom) return; // on-screen

  const cx = cssW / 2, cy = (AD_H + cssH) / 2;
  const ang = Math.atan2(sy - cy, sx - cx);
  const px = Math.max(left, Math.min(right, sx));
  const py = Math.max(top, Math.min(bottom, sy));

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.strokeStyle = '#1e1814';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(16, 0); ctx.lineTo(-8, -11); ctx.lineTo(-8, 11); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();

  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.strokeStyle = '#1e1814';
  ctx.strokeText(label, px, py - 16);
  ctx.fillStyle = color;
  ctx.fillText(label, px, py - 16);
}

// ---- the single fake mobile-game ad banner --------------------------------
const AD_SLOGANS = [
  ['CURD CLASH', 'Build your DAIRY EMPIRE!'],
  ['MERGE CHEESE TYCOON', '100,000,000 curds served'],
  ['LUCERNE LEGENDS', 'Collect & BATTLE tubs!'],
  ['IDLE COTTAGE EMPIRE', 'Tap to get RICH in curds 💰'],
  ['COTTAGE CRUSH SAGA', 'Match-3 the curds, WIN BIG'],
  ['FIEND FIGHTERS 3D', 'Can YOU defeat The Mallen?'],
];

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawTopAd(ctx, cssW) {
  const h = AD_H;
  const [title, sub] = AD_SLOGANS[((walkClock / 300) | 0) % AD_SLOGANS.length];

  // banner background
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#f6f3e8'); g.addColorStop(1, '#d9d4c2');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cssW, h);
  ctx.fillStyle = '#1e1814';
  ctx.fillRect(0, h - 3, cssW, 3);

  // "Ad" tag
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  roundRect(ctx, 6, 6, 26, 14, 3); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.fillText('Ad', 11, 16);

  // INSTALL button geometry (computed first so text can avoid overlapping it)
  const bw = 88, bh = 30, bx = cssW - bw - 12, by = (h - bh) / 2;

  // app icon (the Lucerne tub) in a rounded square
  const ix = 40, iy = 8, isz = h - 16;
  ctx.fillStyle = '#ffffff'; roundRect(ctx, ix, iy, isz, isz, 9); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.save(); roundRect(ctx, ix, iy, isz, isz, 9); ctx.clip();
  const icon = images.ad_app_icon || images.tub;
  if (icon) ctx.drawImage(icon, ix + 3, iy + 3, isz - 6, isz - 6);
  else { ctx.fillStyle = '#e8e6d8'; ctx.fillRect(ix, iy, isz, isz); }
  ctx.restore();

  // title + subtitle + stars, constrained to the space before the button
  const tx = ix + isz + 12;
  const maxW = Math.max(40, bx - tx - 10); // condense text instead of clipping it
  ctx.textAlign = 'left';
  ctx.fillStyle = '#1e1814'; ctx.font = 'bold 17px system-ui, sans-serif';
  ctx.fillText(title, tx, 25, maxW);
  ctx.fillStyle = '#5a564a'; ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(sub, tx, 41, maxW);
  ctx.fillStyle = '#f5a623'; ctx.font = '12px system-ui, sans-serif';
  ctx.fillText('★★★★★ (4.7) · 9M+', tx, 54, maxW);

  // INSTALL button (fake)
  ctx.fillStyle = '#34c759'; roundRect(ctx, bx, by, bw, bh, 15); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.fillText('INSTALL', bx + bw / 2, by + 20);
}

function drawHUD(ctx, cssW, cssH, state, selfId) {
  ctx.textAlign = 'left';
  const deliveries = state.players.filter((p) => !p.isMallen)
    .sort((a, b) => b.score - a.score).slice(0, 3);
  const mallen = state.players.find((p) => p.isMallen);
  const TITLE_FONT = 'bold 18px system-ui, sans-serif';
  const ROW_FONT = 'bold 16px system-ui, sans-serif';
  const iconSz = 18;

  // build the lines, then size the box to fit the widest one
  const lines = [{ text: 'COTTAGE FIEND', color: '#ffe14d', font: TITLE_FONT, icon: true }];
  if (mallen) lines.push({ text: `THE MALLEN: ${mallen.eaten}/10 eaten`, color: '#f6a', font: ROW_FONT });
  for (const p of deliveries) lines.push({ text: `${p.name}: ${p.score}/10`, color: '#fff', font: ROW_FONT });

  let maxW = 0;
  for (const ln of lines) {
    ctx.font = ln.font;
    const w = ctx.measureText(ln.text).width + (ln.icon ? iconSz + 6 : 0);
    if (w > maxW) maxW = w;
  }
  const lineH = 26, padX = 8;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(8, AD_H + 8, maxW + padX * 2 + 8, 16 + lineH * lines.length);

  let y = AD_H + 28;
  for (const ln of lines) {
    ctx.font = ln.font; ctx.fillStyle = ln.color;
    let tx = 16;
    if (ln.icon && images.tub) { ctx.drawImage(images.tub, 16, y - iconSz + 2, iconSz, iconSz); tx = 16 + iconSz + 6; }
    ctx.fillText(ln.text, tx, y);
    y += lineH;
  }
}

function drawCountdown(ctx, W, H, state) {
  const n = Math.ceil(state.countdownMs / 1000);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffe14d';
  ctx.font = 'bold 120px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(n > 0 ? n : 'GO!', W / 2, H / 2);
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.fillText('GET YOUR CURDS READY', W / 2, H / 2 + 80, W - 24);
}

function drawLeaderboard(ctx, W, H, state, selfId) {
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';

  ctx.fillStyle = '#ff8ad4';
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.fillText('🎂 HAPPY BIRTHDAY MALLEN! 🎂', W / 2, AD_H + 50, W - 24);

  const cake = images.birthday_tub;
  if (cake) { const cw = 180, ch = 164; ctx.drawImage(cake, W / 2 - cw / 2, AD_H + 64, cw, ch); }

  const w = state.roundWinner;
  const title = w ? (w.type === 'mallen'
    ? `THE MALLEN (${w.name}) DEVOURED ALL THE CURDS!`
    : `${w.name} STOCKED THE FRIDGE!`) : 'ROUND OVER';
  ctx.fillStyle = '#ffe14d';
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.fillText('🏆 ' + title, W / 2, AD_H + 260, W - 24);

  const sorted = [...state.players].sort((a, b) =>
    (b.isMallen ? b.eaten : b.score) - (a.isMallen ? a.eaten : a.score));
  ctx.font = 'bold 22px system-ui, sans-serif';
  let y = AD_H + 300;
  for (const p of sorted) {
    ctx.fillStyle = p.id === selfId ? '#ffe14d' : '#fff';
    const sc = p.isMallen ? `${p.eaten} tubs devoured` : `${p.score} delivered`;
    const rd = p.ready ? '  ✅' : '';
    const crown = p.isMallen ? '👑 ' : '';
    ctx.fillText(`${crown}${p.name} — ${sc}${rd}`, W / 2, y, W - 24);
    y += 32;
    if (y > H - 70) break;
  }

  const ready = state.players.filter((p) => p.ready).length;
  ctx.fillStyle = '#9f9';
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.fillText(`${ready}/${state.players.length} ready — press LET'S GO (need 50%)`, W / 2, H - 36, W - 24);
}

let _blindBlobs = null;
function drawBlindness(ctx, W, H) {
  if (!_blindBlobs) {
    _blindBlobs = [];
    for (let i = 0; i < 40; i++)
      _blindBlobs.push({ x: Math.random() * W, y: Math.random() * H, r: 30 + Math.random() * 70 });
  }
  ctx.save();
  ctx.fillStyle = 'rgba(245,244,230,0.82)';
  for (const b of _blindBlobs) { ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = '#b4b096';
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('CURD BLINDNESS!', W / 2, H / 2);
  ctx.restore();
}

function drawLobby(ctx, W, H, state) {
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, H / 2 - 70, W, 140);
  ctx.fillStyle = '#ffe14d';
  ctx.font = 'bold 36px system-ui, sans-serif';
  ctx.fillText('WAITING IN THE CURD LOBBY', W / 2, H / 2 - 10, W - 24);
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.fillStyle = '#fff';
  const ready = state.players.filter((p) => p.ready).length;
  ctx.fillText(`Press LET'S GO — ${ready}/${state.players.length} ready (need 50%)`, W / 2, H / 2 + 40, W - 24);
}
