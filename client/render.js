// Canvas renderer. Pure drawing from a snapshot — no game logic here.

import { images, AD_KEYS } from './assets.js';

const PHASE = { LOBBY: 'lobby', COUNTDOWN: 'countdown', PLAYING: 'playing', LEADERBOARD: 'leaderboard' };

const EFFECT_LABELS = {
  double_speed: '⚡2X SPEED', two_x_points: '🧀2X PTS', invincible: '🛡INVINCIBLE',
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
  const { width, height } = canvas;
  walkClock += 1;

  // background: cottage-cheese tile vibe
  ctx.fillStyle = '#3a5a3a';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  for (let gx = 0; gx < width; gx += 48)
    for (let gy = 0; gy < height; gy += 48)
      if ((gx / 48 + gy / 48) % 2 === 0) ctx.fillRect(gx, gy, 48, 48);

  if (!state) return;
  const sx = width / 1280, sy = height / 720;
  ctx.save();
  ctx.scale(sx, sy);

  // ad banners around the arena edges (over the top)
  drawAds(ctx);

  const { loci, players = [], tubs = [], presents = [] } = state;

  // loci
  if (loci) {
    drawSprite(ctx, images.truck, loci.truck.x, loci.truck.y, 160, 120);
    drawSprite(ctx, images.fridge, loci.fridge.x, loci.fridge.y, 110, 130);
    if (!images.truck) fallbackCircle(ctx, loci.truck.x, loci.truck.y, 60, '#ccd');
    if (!images.fridge) fallbackCircle(ctx, loci.fridge.x, loci.fridge.y, 54, '#dde');
  }

  // tubs (ready/loose/flying — carried are drawn with their player)
  for (const t of tubs) {
    if (t.state === 'carried') continue;
    drawSprite(ctx, images.tub, t.x, t.y, 34, 34);
    if (!images.tub) fallbackCircle(ctx, t.x, t.y, 14, '#5af');
  }

  // splatters (drawn under players)
  for (let i = splats.length - 1; i >= 0; i--) {
    const s = splats[i];
    s.t += 16;
    const a = Math.max(0, 1 - s.t / s.life);
    ctx.globalAlpha = a;
    drawSprite(ctx, images[`splat_${s.frame}`], s.x, s.y, 48, 48);
    ctx.globalAlpha = 1;
    if (s.t >= s.life) splats.splice(i, 1);
  }

  // players
  const frame = (walkClock >> 3) & 1;
  for (const p of players) {
    drawPlayer(ctx, p, frame, p.id === selfId);
  }

  // carried tubs on top of their carriers
  for (const t of tubs) {
    if (t.state !== 'carried') continue;
    drawSprite(ctx, images.tub, t.x, t.y, 30, 30);
    if (!images.tub) fallbackCircle(ctx, t.x, t.y, 13, '#5af');
  }

  // parachuting / landed presents
  for (const g of presents) {
    drawSprite(ctx, images.present, g.x, g.y, 52, 52);
    if (!images.present) fallbackCircle(ctx, g.x, g.y, 26, '#e57');
    if (!g.landed) drawSprite(ctx, images.parachute, g.x, g.y - 46, 96, 96);
    else {
      // gentle pulse ring to signal it's claimable
      const r = 30 + Math.sin(walkClock * 0.15) * 4;
      ctx.strokeStyle = 'rgba(255,225,77,0.7)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(g.x, g.y, r, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // charge arc for self
  if (charge && charge.active) drawChargeArc(ctx, charge);

  ctx.restore();

  // CLIENT-ONLY: curd-blindness screen splatter for the self player
  const self = players.find(p => p.id === selfId);
  if (self && self.effect === 'blindness') drawBlindness(ctx, canvas);
  else _blindBlobs = null; // reset so the next onset gets a fresh splatter

  // HUD overlays (unscaled)
  drawHUD(ctx, canvas, state, selfId);
  if (state.phase === PHASE.COUNTDOWN) drawCountdown(ctx, canvas, state);
  if (state.phase === PHASE.LEADERBOARD) drawLeaderboard(ctx, canvas, state, selfId);
  if (state.phase === PHASE.LOBBY) drawLobby(ctx, canvas, state);
}

function drawPlayer(ctx, p, frame, isSelf) {
  let img;
  if (p.isMallen) {
    img = images[`mallen${p.frenzy ? '_frenzy' : ''}_${frame}`];
  } else {
    img = images[`delivery_${p.spriteIndex}_${frame}`];
  }
  const size = p.radius * 2.4;

  // frenzy flash tint
  if (p.isMallen && p.frenzy) {
    ctx.save();
    ctx.shadowColor = `hsl(${(walkClock * 20) % 360},90%,60%)`;
    ctx.shadowBlur = 25;
    drawSprite(ctx, img, p.x, p.y, size, size);
    // composite the user's face onto the mallen head
    drawSprite(ctx, images.mallenFace, p.x, p.y - size * 0.28, size * 0.5, size * 0.5);
    ctx.restore();
  } else {
    drawSprite(ctx, img, p.x, p.y, size, size);
    if (p.isMallen)
      drawSprite(ctx, images.mallenFace, p.x, p.y - size * 0.28, size * 0.5, size * 0.5);
  }
  if (!img) fallbackCircle(ctx, p.x, p.y, p.radius, p.isMallen ? '#a4c' : '#d96');

  // name tag
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.strokeStyle = '#1e1814';
  ctx.strokeText(p.name, p.x, p.y - p.radius - 8);
  ctx.fillStyle = isSelf ? '#ffe14d' : '#fff';
  ctx.fillText(p.name, p.x, p.y - p.radius - 8);

  // active effect indicator
  if (p.effect) {
    const label = EFFECT_LABELS[p.effect] || p.effect;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = BUFF_SET.has(p.effect) ? '#8f8' : '#f88';
    ctx.strokeText(label, p.x, p.y - p.radius - 24);
    ctx.fillText(label, p.x, p.y - p.radius - 24);
    // aura ring
    ctx.strokeStyle = BUFF_SET.has(p.effect) ? 'rgba(120,255,120,0.5)' : 'rgba(255,120,120,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.radius + 9, 0, Math.PI * 2); ctx.stroke();
  }

  // carry/charge indicator ring for self
  if (isSelf) {
    ctx.strokeStyle = 'rgba(255,225,77,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.radius + 5, 0, Math.PI * 2); ctx.stroke();
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
  // power bar extending in facing direction, color shifts with power
  const hue = 60 - frac * 60; // yellow -> red
  ctx.fillStyle = `hsl(${hue},90%,55%)`;
  ctx.globalAlpha = 0.8;
  ctx.fillRect(20, -7, len, 14);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.fillRect(20 + len - 4, -10, 4, 20); // moving tip
  ctx.restore();
}

function drawAds(ctx) {
  const positions = [
    [10, 8], [950, 8], [10, 622], [950, 622],
  ];
  positions.forEach((pos, i) => {
    const img = images[AD_KEYS[i % AD_KEYS.length]];
    if (img) ctx.drawImage(img, pos[0], pos[1], 320, 90);
  });
  // rotating center-top ad
  const idx = ((walkClock / 120) | 0) % AD_KEYS.length;
  const adImg = images[AD_KEYS[idx]];
  if (adImg) {
    ctx.globalAlpha = 0.92;
    ctx.drawImage(adImg, 480, 4, 320, 90);
    ctx.globalAlpha = 1;
  }
}

function drawHUD(ctx, canvas, state, selfId) {
  const me = state.players.find(p => p.id === selfId);
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  // top scoreboard strip
  const deliveries = state.players.filter(p => !p.isMallen)
    .sort((a, b) => b.score - a.score).slice(0, 3);
  const mallen = state.players.find(p => p.isMallen);
  let y = 28;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(8, 8, 230, 16 + 26 * (deliveries.length + (mallen ? 1 : 0)));
  ctx.fillStyle = '#ffe14d';
  ctx.fillText('🧀 COTTAGE FIEND', 16, y); y += 28;
  ctx.font = 'bold 16px system-ui, sans-serif';
  if (mallen) {
    ctx.fillStyle = '#f6a';
    ctx.fillText(`THE MALLEN: ${mallen.eaten}/10 eaten`, 16, y); y += 26;
  }
  ctx.fillStyle = '#fff';
  for (const p of deliveries) {
    ctx.fillText(`${p.name}: ${p.score}/10`, 16, y); y += 26;
  }
}

function drawCountdown(ctx, canvas, state) {
  const n = Math.ceil(state.countdownMs / 1000);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffe14d';
  ctx.font = 'bold 120px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(n > 0 ? n : 'GO!', canvas.width / 2, canvas.height / 2);
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.fillText('GET YOUR CURDS READY', canvas.width / 2, canvas.height / 2 + 80);
}

function drawLeaderboard(ctx, canvas, state, selfId) {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';

  // birthday banner
  ctx.fillStyle = '#ff8ad4';
  ctx.font = 'bold 52px system-ui, sans-serif';
  ctx.fillText('🎂 HAPPY BIRTHDAY MALLEN! 🎂', W / 2, 70);

  // birthday cottage cheese tub with candles, centered
  const cake = images.birthday_tub;
  if (cake) {
    const cw = 200, ch = 182;
    ctx.drawImage(cake, W / 2 - cw / 2, 88, cw, ch);
  }

  // winner line under the cake
  const w = state.roundWinner;
  const title = w ? (w.type === 'mallen'
    ? `THE MALLEN (${w.name}) DEVOURED ALL THE CURDS!`
    : `${w.name} STOCKED THE FRIDGE!`) : 'ROUND OVER';
  ctx.fillStyle = '#ffe14d';
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.fillText('🏆 ' + title, W / 2, 300);

  // standings: Mallen by tubs eaten, deliveries by score
  const sorted = [...state.players].sort((a, b) =>
    (b.isMallen ? b.eaten : b.score) - (a.isMallen ? a.eaten : a.score));
  ctx.font = 'bold 24px system-ui, sans-serif';
  let y = 350;
  for (const p of sorted) {
    ctx.fillStyle = p.id === selfId ? '#ffe14d' : '#fff';
    const sc = p.isMallen ? `${p.eaten} tubs devoured 🧀` : `${p.score} delivered`;
    const rd = p.ready ? '  ✅' : '';
    const crown = p.isMallen ? '👑 ' : '';
    ctx.fillText(`${crown}${p.name} — ${sc}${rd}`, W / 2, y);
    y += 34;
    if (y > H - 80) break;
  }

  const ready = state.players.filter(p => p.ready).length;
  ctx.fillStyle = '#9f9';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.fillText(`${ready}/${state.players.length} ready — press LET'S GO (need 50%)`,
    W / 2, H - 40);
}

// CLIENT-ONLY: curd-blindness overlay — splatters cottage cheese across the screen.
let _blindBlobs = null;
function drawBlindness(ctx, canvas) {
  const W = canvas.width, H = canvas.height;
  if (!_blindBlobs) {
    _blindBlobs = [];
    for (let i = 0; i < 40; i++) {
      _blindBlobs.push({
        x: Math.random() * W, y: Math.random() * H,
        r: 30 + Math.random() * 70,
      });
    }
  }
  ctx.save();
  ctx.fillStyle = 'rgba(245,244,230,0.82)';
  for (const b of _blindBlobs) {
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#b4b096';
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('🧀 CURD BLINDNESS! 🧀', W / 2, H / 2);
  ctx.restore();
}

function drawLobby(ctx, canvas, state) {
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, canvas.height / 2 - 70, canvas.width, 140);
  ctx.fillStyle = '#ffe14d';
  ctx.font = 'bold 40px system-ui, sans-serif';
  ctx.fillText('WAITING IN THE CURD LOBBY', canvas.width / 2, canvas.height / 2 - 10);
  ctx.font = 'bold 24px system-ui, sans-serif';
  ctx.fillStyle = '#fff';
  const ready = state.players.filter(p => p.ready).length;
  ctx.fillText(`Press LET'S GO — ${ready}/${state.players.length} ready (need 50%)`,
    canvas.width / 2, canvas.height / 2 + 40);
}
