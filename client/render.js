// Canvas renderer. Pure drawing from a snapshot — no game logic here.
// World is drawn under a (devicePixelRatio * following-camera) transform; HUD and
// overlays are drawn in CSS-pixel screen space on top.

import { images } from './assets.js';
import { computeCamera, getCamera } from './camera.js';

const PHASE = { LOBBY: 'lobby', COUNTDOWN: 'countdown', PLAYING: 'playing', LEADERBOARD: 'leaderboard' };

export const AD_H = 70; // height of the top ad banner (CSS px); HUD sits below it
// Bottom edge of the score HUD (updated each frame by drawHUD). Edge arrows clamp
// below this so they never hide under the HUD. Defaults to the ad banner.
let hudBottomY = AD_H;

const EFFECT_LABELS = {
  double_speed: '⚡2X SPEED', two_x_points: '2X PTS', invincible: '🛡INVINCIBLE',
  magnet: '🧲MAGNET', curd_cannon: '🚀CURD CANNON: MEGA THROW',
  half_speed: '🐌HALF SPEED', backwards: '🔄BACKWARDS', greased: '🧈GREASED',
  tiny: '🔬TINY', blindness: '🫥CURD BLIND', banana: '🍌SLIDEY',
};
const BUFF_SET = new Set(['double_speed', 'two_x_points', 'invincible', 'magnet', 'curd_cannon']);

// transient splatters spawned from events, faded over time
const splats = [];
export function addSplat(x, y) {
  splats.push({ x, y, t: 0, delay: 0, life: 700, size: 48, frame: (Math.random() * 3) | 0 });
}

// The Mallen devouring curds: a staggered burst of splats around him, popping in
// over ~0.7s so it reads as him ravaging the cottage cheese.
export function addChomp(x, y) {
  for (let i = 0; i < 12; i++) {
    const ang = Math.random() * Math.PI * 2;
    const rad = 16 + Math.random() * 72;
    splats.push({
      x: x + Math.cos(ang) * rad,
      y: y + Math.sin(ang) * rad,
      t: 0,
      delay: Math.random() * 420,           // staggered = animated
      life: 380 + Math.random() * 300,
      size: 30 + Math.random() * 42,
      frame: (Math.random() * 3) | 0,
    });
  }
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

// white "poof" puffs on a punch swing (so a whiff still reads as a punch)
const poofs = [];
export function addPoof(x, y) {
  for (let i = 0; i < 5; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * 14;
    poofs.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, t: 0, life: 340, r: 8 + Math.random() * 8 });
  }
}
function drawPoofs(ctx) {
  for (let i = poofs.length - 1; i >= 0; i--) {
    const p = poofs[i];
    p.t += 16;
    const k = p.t / p.life;
    if (k >= 1) { poofs.splice(i, 1); continue; }
    ctx.save();
    ctx.globalAlpha = (1 - k) * 0.7;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * (0.6 + k * 1.1), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// rapid rainbow after-trail dropped while the Mallen dashes
const dashTrail = [];
export function addDashTrail(x, y, r) {
  dashTrail.push({ x, y, r, t: 0, life: 340, hue: (performance.now() * 0.9) % 360 });
}

function drawDashTrail(ctx) {
  for (let i = dashTrail.length - 1; i >= 0; i--) {
    const d = dashTrail[i];
    d.t += 16;
    const a = Math.max(0, 1 - d.t / d.life);
    if (a <= 0) { dashTrail.splice(i, 1); continue; }
    ctx.save();
    ctx.globalAlpha = a * 0.6;
    ctx.fillStyle = `hsl(${d.hue},100%,60%)`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r * (0.45 + a * 0.55), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// Golden-curd buff celebration: a big golden-curd image zooms up above the
// claimer's head with a ring of smaller copies spinning around it, then a "+1
// POINT" rises and fades. Driven by the presentClaim event, visible to everyone.
const GOLDEN_MS = 3000;          // mirrors EFFECT.goldenCurdMs (the server freeze length)
const goldenCurds = [];          // { id, t0 } active celebrations, keyed by player id
export function addGoldenCurd(id) {
  goldenCurds.push({ id, t0: performance.now() });
}
function isGolden(id) {
  const now = performance.now();
  return goldenCurds.some(g => g.id === id && now - g.t0 < GOLDEN_MS);
}
function drawGoldenCurds(ctx, state) {
  const img = images.golden_curd;
  const now = performance.now();
  const players = (state && state.players) || [];
  for (let i = goldenCurds.length - 1; i >= 0; i--) {
    const g = goldenCurds[i];
    const elapsed = now - g.t0;
    if (elapsed >= GOLDEN_MS) { goldenCurds.splice(i, 1); continue; }
    const p = players.find(pp => pp.id === g.id);
    if (!p) continue;                                   // claimer left — skip (pruned on expiry)
    const t = elapsed / GOLDEN_MS;                      // 0..1
    const aspect = (img && img.width) ? img.height / img.width : 0.667;
    const cx = p.x;
    const cy = p.y - p.radius * 1.5 - 95;               // float well above the head
    // big image: ease-out zoom from tiny to full over the first 70%
    const grow = Math.min(1, t / 0.7);
    const ease = 1 - Math.pow(1 - grow, 3);
    const w = 120 * (0.12 + 0.88 * ease);               // ~20% of the screen at full size
    const h = w * aspect;
    if (img) {
      // kaleidoscope: smaller copies orbiting + self-rotating around the big one
      const N = 6, orbitR = w * 0.92, sw = w * 0.42, sh = sw * aspect;
      ctx.save();
      ctx.globalAlpha = 0.9;
      for (let k = 0; k < N; k++) {
        const a = elapsed * 0.004 + (k / N) * Math.PI * 2;
        ctx.save();
        ctx.translate(cx + Math.cos(a) * orbitR, cy + Math.sin(a) * orbitR);
        ctx.rotate(a + elapsed * 0.006);
        ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);
        ctx.restore();
      }
      ctx.restore();
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);  // big center image
    }
    // "+1 POINT" rises and fades over the last segment
    if (t > 0.6) {
      const tt = (t - 0.6) / 0.4;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - tt);
      ctx.font = '900 38px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 6; ctx.strokeStyle = '#1e1814';
      ctx.fillStyle = '#ffe14d';
      const ty = cy - h / 2 - 14 - tt * 70;
      ctx.strokeText('+1 POINT', cx, ty);
      ctx.fillText('+1 POINT', cx, ty);
      ctx.restore();
    }
  }
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

  // floor rotates per round: street -> grass -> desert -> repeat
  const floors = [images.bg, images.bg2, images.bg3];
  const floorImg = floors[(Math.max(1, state.round || 1) - 1) % 3] || images.bg;
  drawFloor(ctx, arena || { width: 1600, height: 1600 }, floorImg);
  if (state.safeZone) drawSafeZone(ctx, state.safeZone);

  if (loci) {
    drawSprite(ctx, images.truck, loci.truck.x, loci.truck.y, 160, 120);
    drawSprite(ctx, images.fridge, loci.fridge.x, loci.fridge.y, 110, 130);
    if (!images.truck) fallbackCircle(ctx, loci.truck.x, loci.truck.y, 60, '#ccd');
    if (!images.fridge) fallbackCircle(ctx, loci.fridge.x, loci.fridge.y, 54, '#dde');
    if (state.phase === PHASE.PLAYING || state.phase === PHASE.COUNTDOWN) {
      drawBounceMarker(ctx, loci.truck.x, loci.truck.y - 60, 'GRAB CURDS HERE', '#ffe14d');
      drawBounceMarker(ctx, loci.fridge.x, loci.fridge.y - 65, 'DELIVER CURDS HERE', '#9ad7ff');
    }
  }

  // tubs (ready/loose/flying — carried are drawn with their player)
  for (const t of tubs) {
    if (t.state === 'carried') continue;
    if (t.state === 'flying' && Math.random() < 0.35) addSplat(t.x, t.y); // splat trail in flight
    drawSprite(ctx, images.tub, t.x, t.y, 36, 36);
    if (!images.tub) fallbackCircle(ctx, t.x, t.y, 15, '#f2f0e0');
  }

  // splatters (under players)
  for (let i = splats.length - 1; i >= 0; i--) {
    const s = splats[i];
    s.t += 16;
    const age = s.t - s.delay;
    if (age < 0) continue;                                  // staggered: not yet
    const a = Math.max(0, 1 - age / s.life);
    const grow = age < 90 ? 0.55 + 0.45 * (age / 90) : 1;   // quick pop-in
    const sz = s.size * grow;
    ctx.globalAlpha = a;
    drawSprite(ctx, images[`splat_${s.frame}`], s.x, s.y, sz, sz);
    ctx.globalAlpha = 1;
    if (age >= s.life) splats.splice(i, 1);
  }

  // walk frame: time-based (framerate-independent) and slower than before
  const animFrame = ((performance.now() / 230) | 0) & 1;
  drawDashTrail(ctx);   // rainbow trail (behind players)
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
  drawPoofs(ctx);
  drawGoldenCurds(ctx, state);   // golden-curd celebration, on top of the world

  if (charge && charge.active) drawChargeArc(ctx, charge);

  ctx.restore();

  // ---- screen space ---------------------------------------------------------
  const self = players.find((p) => p.id === selfId);

  // off-screen edge arrows
  if (state.phase === PHASE.PLAYING) {
    // where everyone is: a small color-coded arrow per off-screen player, Mallen in red
    for (const p of players) {
      if (p.id === selfId) continue;
      if (p.isMallen) edgeArrow(ctx, cssW, cssH, p, '#ff4d6a', '👹', 16);
      else edgeArrow(ctx, cssW, cssH, p, PLAYER_COLORS[p.spriteIndex % PLAYER_COLORS.length], null, 11);
    }
    // bigger nav arrow to your current objective (truck or fridge), so it stands out
    if (loci && self) {
      if (self.carrying) edgeArrow(ctx, cssW, cssH, loci.fridge, '#9ad7ff', '🧊 FRIDGE', 24);
      else edgeArrow(ctx, cssW, cssH, loci.truck, '#ffe14d', '🚚 TUBS', 24);
    }
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

// a bouncing label + down-arrow hovering above a prop (truck/fridge)
function drawBounceMarker(ctx, x, propTopY, text, color) {
  const bob = Math.sin(walkClock * 0.12) * 8;
  const baseY = propTopY - 28 + bob;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.lineWidth = 4; ctx.strokeStyle = '#1e1814';
  ctx.strokeText(text, x, baseY);
  ctx.fillStyle = color;
  ctx.fillText(text, x, baseY);
  // downward arrow pointing at the prop
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x - 16, baseY + 10);
  ctx.lineTo(x + 16, baseY + 10);
  ctx.lineTo(x, baseY + 34);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();
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
  ctx.fillText('NO MALLEN ZONE', z.x + z.w / 2, z.y + z.h + 22); // below the zone, clear of the truck marker
  ctx.restore();
}

function drawFloor(ctx, arena, bgImg) {
  if (bgImg) {
    const T = arena.width / 4;   // tile ~4x smaller than the arena (tweak the divisor)
    for (let x = 0; x < arena.width; x += T)
      for (let y = 0; y < arena.height; y += T)
        ctx.drawImage(bgImg, x, y, T, T);
  } else {
    ctx.fillStyle = '#27331f';
    ctx.fillRect(0, 0, arena.width, arena.height);
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let gx = 0; gx < arena.width; gx += 64)
      for (let gy = 0; gy < arena.height; gy += 64)
        if ((gx / 64 + gy / 64) % 2 === 0) ctx.fillRect(gx, gy, 64, 64);
  }
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
  const tnow = performance.now();
  // golden-curd celebration freezes the player too, but it's a buff — show the
  // golden animation (drawGoldenCurds) instead of the debuff stun visuals.
  const golden = isGolden(p.id);
  // stunned = rapid frame flicker; otherwise walk only while moving
  const f = (p.stunned && !golden) ? ((tnow / 55) | 0) & 1 : (p.moving ? frame : 0);
  let img;
  if (p.isMallen) img = images[`mallen${p.frenzy ? '_frenzy' : ''}_${dir}_${f}`];
  else img = images[`delivery_${p.spriteIndex}_${dir}_${f}`];
  // full-body sprites are drawn a bit taller than the collision circle and nudged
  // up so the feet sit near the player position
  const size = p.radius * 3.0;
  let px = p.x;
  const cy = p.y - size * 0.12;
  if (p.stunned && !golden) px += (Math.random() - 0.5) * 4; // jitter/shake
  if (p.dashing) addDashTrail(p.x, cy, size * 0.42);

  if (p.stunned && !golden) {
    // A Mallen chomp can stun ~everyone at once, so avoid shadowBlur here (it's a
    // brutal per-sprite mobile GPU cost when many are stunned) — use a cheap
    // hue-cycling ring + the existing flicker/jitter instead.
    drawSprite(ctx, img, px, cy + (Math.random() - 0.5) * 4, size, size);
    ctx.save();
    ctx.strokeStyle = `hsl(${(tnow * 0.8) % 360},100%,62%)`; // rapid color flash
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(px, p.y, p.radius + 6, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  } else if (p.isMallen && p.frenzy) {
    ctx.save();
    ctx.shadowColor = `hsl(${(walkClock * 20) % 360},90%,60%)`;
    ctx.shadowBlur = 25;
    drawSprite(ctx, img, p.x, cy, size, size);
    ctx.restore();
  } else {
    drawSprite(ctx, img, p.x, cy, size, size);
  }
  if (!img) fallbackCircle(ctx, p.x, p.y, p.radius, p.isMallen ? '#a4c' : '#d96');

  // facing arrow at the feet (color-coded) — shows your current punch/throw direction
  {
    const col = p.isMallen ? '#ff4d6a' : PLAYER_COLORS[p.spriteIndex % PLAYER_COLORS.length];
    ctx.save();
    ctx.translate(p.x, p.y + p.radius);
    ctx.rotate(Math.atan2(p.dir.y, p.dir.x));
    ctx.fillStyle = col; ctx.strokeStyle = '#1e1814'; ctx.lineWidth = 2;
    ctx.beginPath();
    // a dart with a notched (concave) back so only the long tip reads as "forward"
    ctx.moveTo(19, 0); ctx.lineTo(-8, -9); ctx.lineTo(1, 0); ctx.lineTo(-8, 9); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // The Mallen's real face, bobblehead-style over the demon's head — fiend face
  // during frenzy, mirrored by facing, with a little bob while walking.
  if (p.isMallen) {
    const face = p.frenzy ? images.mallen_face_fiend : images.mallen_face;
    if (face) {
      const faceH = size * 0.62;
      const faceW = faceH * (face.width / face.height);
      const bob = p.moving ? Math.sin(tnow / 110) * size * 0.05 : 0;
      const faceDx = size * 0.12;  // face sits left of center; nudge it right
      ctx.save();
      ctx.translate(p.x + faceDx, cy - size * 0.32 + bob);
      if (p.dir.x < 0) ctx.scale(-1, 1);   // mirror when facing left
      ctx.drawImage(face, -faceW / 2, -faceH / 2, faceW, faceH);
      ctx.restore();
    }
  }

  // invincible: three tiny tubs spinning in a halo around the head
  if (p.effect === 'invincible' && images.tub) {
    const headY = cy - size * 0.32;
    const orbitR = size * 0.38;
    const spin = performance.now() * 0.005;
    const ts = size * 0.2;
    for (let i = 0; i < 3; i++) {
      const a = spin + (i / 3) * Math.PI * 2;
      const tx = p.x + Math.cos(a) * orbitR;
      const ty = headY + Math.sin(a) * orbitR * 0.45; // tilted ring
      ctx.drawImage(images.tub, tx - ts / 2, ty - ts / 2, ts, ts);
    }
  }

  const topY = cy - size / 2 - 4;   // just above the sprite, so it never overlaps
  const tag = `${p.name} (${p.isMallen ? p.eaten : p.score})`;
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.strokeStyle = '#1e1814';
  ctx.strokeText(tag, p.x, topY);
  ctx.fillStyle = isSelf ? '#ffe14d' : '#fff';
  ctx.fillText(tag, p.x, topY);

  if (p.adStunned && images.interstitial_ad) {
    // a tiny "forced to watch an ad" screen above the head, so others can see why
    // this player is frozen
    const img = images.interstitial_ad;
    const aw = size * 0.5;
    const ah = aw * (img.width && img.height ? img.height / img.width : 1.25);
    const ax = p.x - aw / 2, ay = topY - 16 - ah;
    ctx.fillStyle = '#1e1814';
    ctx.fillRect(ax - 3, ay - 3, aw + 6, ah + 6);   // bezel
    ctx.drawImage(img, ax, ay, aw, ah);
    ctx.fillStyle = '#ffe14d';                       // little "AD" tab
    ctx.fillRect(ax - 3, ay - 3, 18, 12);
    ctx.fillStyle = '#1e1814';
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('AD', ax, ay + 6);
    ctx.textAlign = 'center';
  } else if (p.stunned && !golden) {
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillStyle = '#9fefff';
    ctx.strokeText('💫 STUNNED 💫', p.x, topY - 16);
    ctx.fillText('💫 STUNNED 💫', p.x, topY - 16);
  } else if (p.effect) {
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

// player-variant colors (match the 12 recolored delivery sprites)
const PLAYER_COLORS = [
  '#cd3c34', '#3a6ecd', '#46af5c', '#d7a834', '#9650c3', '#3ab6b2',
  '#eb7d23', '#ee5faa', '#46cde1', '#a0cd37', '#8c5f37', '#cdcdd7',
];

// An edge arrow pointing toward an off-screen world target (player/mallen/locus).
function edgeArrow(ctx, cssW, cssH, target, color, label, size) {
  const cam = getCamera();
  const sx = target.x * cam.scale + cam.offX;
  const sy = target.y * cam.scale + cam.offY;
  const m = 30;
  const left = m, right = cssW - m, top = hudBottomY + m, bottom = cssH - m;
  if (sx >= left && sx <= right && sy >= top && sy <= bottom) return; // on-screen

  const cx = cssW / 2, cy = (hudBottomY + cssH) / 2;
  const ang = Math.atan2(sy - cy, sx - cx);
  const px = Math.max(left, Math.min(right, sx));
  let py = Math.max(top, Math.min(bottom, sy));
  // never let the arrow (or its label above it) ride up under the HUD
  py = Math.max(py, hudBottomY + size + (label ? 24 : 4));

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.strokeStyle = '#1e1814';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.55, -size * 0.7);
  ctx.lineTo(-size * 0.55, size * 0.7);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();

  if (label) {
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = '#1e1814';
    ctx.strokeText(label, px, py - size - 3);
    ctx.fillStyle = color;
    ctx.fillText(label, px, py - size - 3);
  }
}

// ---- the single fake mobile-game ad banner --------------------------------
// [title, subtitle, rating (0.5–1.5 stars — terrible), installs (absurdly high)]
const AD_SLOGANS = [
  ['CURD CLASH', 'Build your DAIRY EMPIRE!', 0.5, '500M+'],
  ['MERGE CHEESE TYCOON', '100,000,000 curds served', 1.5, '1.2B+'],
  ['LUCERNE LEGENDS', 'Collect & BATTLE tubs!', 1.0, '900M+'],
  ['IDLE COTTAGE EMPIRE', 'Tap to get RICH in curds 💰', 0.5, '2B+'],
  ['COTTAGE CRUSH SAGA', 'Match-3 the curds, WIN BIG', 1.5, '750M+'],
  ['FIEND FIGHTERS 3D', 'Can YOU defeat The Mallen?', 1.0, '3B+'],
];

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

// a 5-point star path centered at (cx,cy)
function star5(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + i * Math.PI / 5;
    const rad = i % 2 === 0 ? r : r * 0.45;
    const x = cx + Math.cos(ang) * rad, y = cy + Math.sin(ang) * rad;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
}

// draw a 5-star rating filled left-to-right to `rating` (supports halves);
// returns the x of the right edge so following text can be placed after it
function drawStars(ctx, x, cy, rating, r) {
  const gap = r * 2.3;
  for (let i = 0; i < 5; i++) {
    const cx = x + r + i * gap;
    star5(ctx, cx, cy, r); ctx.fillStyle = '#d8d2c2'; ctx.fill();
    const frac = Math.max(0, Math.min(1, rating - i));
    if (frac > 0) {
      ctx.save();
      ctx.beginPath(); ctx.rect(cx - r, cy - r, 2 * r * frac, 2 * r); ctx.clip();
      star5(ctx, cx, cy, r); ctx.fillStyle = '#f5a623'; ctx.fill();
      ctx.restore();
    }
  }
  return x + 5 * gap;
}

function drawTopAd(ctx, cssW) {
  const h = AD_H;
  const [title, sub, rating, installs] = AD_SLOGANS[((walkClock / 300) | 0) % AD_SLOGANS.length];

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
  const bw = 92, bh = 32, bx = cssW - bw - 12, by = (h - bh) / 2;

  // app icon (the Lucerne tub) in a rounded square
  const ix = 40, iy = 9, isz = h - 18;
  ctx.fillStyle = '#ffffff'; roundRect(ctx, ix, iy, isz, isz, 9); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.save(); roundRect(ctx, ix, iy, isz, isz, 9); ctx.clip();
  const icon = images.ad_app_icon || images.tub;
  if (icon) ctx.drawImage(icon, ix + 3, iy + 3, isz - 6, isz - 6);
  else { ctx.fillStyle = '#e8e6d8'; ctx.fillRect(ix, iy, isz, isz); }
  ctx.restore();

  // title + subtitle, constrained to the space before the button
  const tx = ix + isz + 12;
  const maxW = Math.max(40, bx - tx - 10); // condense text instead of clipping it
  ctx.textAlign = 'left';
  ctx.fillStyle = '#1e1814'; ctx.font = 'bold 17px system-ui, sans-serif';
  ctx.fillText(title, tx, 25, maxW);
  ctx.fillStyle = '#5a564a'; ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(sub, tx, 42, maxW);

  // rating stars (terrible) + absurd install count
  const starsY = 56;
  const afterStars = drawStars(ctx, tx, starsY, rating, 5.5);
  ctx.fillStyle = '#5a564a'; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left';
  const ratingTx = afterStars + 7;
  ctx.fillText(`(${rating.toFixed(1)}) · ${installs}`, ratingTx, starsY + 4, Math.max(20, bx - ratingTx - 8));

  // INSTALL button (fake)
  ctx.fillStyle = '#34c759'; roundRect(ctx, bx, by, bw, bh, 16); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.fillText('INSTALL', bx + bw / 2, by + 21);
}

function drawHUD(ctx, cssW, cssH, state, selfId) {
  ctx.textAlign = 'left';
  const deliveries = state.players.filter((p) => !p.isMallen)
    .sort((a, b) => b.score - a.score).slice(0, 2);
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
  const bx = 8, by = AD_H + 8;
  const bw = maxW + padX * 2 + 8;
  const bh = 16 + lineH * lines.length;
  hudBottomY = by + bh; // edge arrows clamp below this
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(bx, by, bw, bh);

  let y = AD_H + 28;
  for (const ln of lines) {
    ctx.font = ln.font; ctx.fillStyle = ln.color;
    let tx = 16;
    if (ln.icon && images.tub) { ctx.drawImage(images.tub, 16, y - iconSz + 2, iconSz, iconSz); tx = 16 + iconSz + 6; }
    ctx.fillText(ln.text, tx, y);
    y += lineH;
  }

  // mini-map to the right of the score box (square — the arena is square — and
  // the same height), showing live positions; clamped so it stays on-screen
  if (state.phase === PHASE.PLAYING || state.phase === PHASE.COUNTDOWN) {
    const mmX = Math.min(bx + bw + 8, cssW - bh - 8);
    drawMinimap(ctx, mmX, by, bh, state);
  }
}

// A tiny live map: translucent panel with dots for the truck, fridge, players,
// and the Mallen. World coords are scaled down to the panel.
function drawMinimap(ctx, x, y, size, state) {
  const arena = state.arena || { width: 1600, height: 1600 };
  const sx = size / arena.width, sy = size / arena.height;
  const mx = (wx) => x + wx * sx;
  const my = (wy) => y + wy * sy;
  const dot = (wx, wy, r, color) => {
    ctx.beginPath();
    ctx.arc(mx(wx), my(wy), r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };

  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = 'rgba(255,225,77,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);

  if (state.loci) {
    dot(state.loci.truck.x, state.loci.truck.y, 2.8, '#ffe14d');   // truck (yellow)
    dot(state.loci.fridge.x, state.loci.fridge.y, 2.8, '#9ad7ff'); // fridge (blue)
  }
  for (const p of state.players || []) {
    if (p.isMallen) dot(p.x, p.y, 3.6, '#ff4d6a');                 // Mallen (red, medium)
    else dot(p.x, p.y, 2, PLAYER_COLORS[p.spriteIndex % PLAYER_COLORS.length]); // players (small)
  }
}

// a swirling "hurricane" of cottage cheese tubs — concentric rings spinning at
// different speeds/directions, radii pulsing in and out
function drawTubHurricane(ctx, W, H) {
  const t = performance.now();
  const cx = W / 2, cy = H / 2;
  const maxR = Math.max(W, H) * 0.62;
  const rings = 7;
  ctx.save();
  ctx.globalAlpha = 0.5;
  for (let r = 0; r < rings; r++) {
    const frac = r / (rings - 1);
    const radius = 50 + frac * maxR + Math.sin(t * 0.002 + r * 0.9) * 38;
    const dir = r % 2 === 0 ? 1 : -1;
    const spin = t * 0.0016 * dir * (1.3 - frac * 0.7); // inner rings whirl faster
    const count = 6 + r * 3;
    const sz = 40 - frac * 14;
    for (let i = 0; i < count; i++) {
      const a = spin + (i / count) * Math.PI * 2;
      ctx.save();
      ctx.translate(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
      ctx.rotate(a + t * 0.004);
      if (images.tub) ctx.drawImage(images.tub, -sz / 2, -sz / 2, sz, sz);
      else { ctx.fillStyle = '#f2f0e0'; ctx.beginPath(); ctx.arc(0, 0, sz / 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawCountdown(ctx, W, H, state) {
  const n = Math.ceil(state.countdownMs / 1000);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, W, H);
  drawTubHurricane(ctx, W, H);
  ctx.textAlign = 'center';
  // ROUND N: CURD intro banner
  const title = `ROUND ${state.round || 1}: CURD`;
  ctx.font = 'bold 64px system-ui, sans-serif';
  ctx.lineWidth = 6; ctx.strokeStyle = '#1e1814';
  ctx.strokeText(title, W / 2, H / 2 - 90, W - 24);
  ctx.fillStyle = '#ff8ad4';
  ctx.fillText(title, W / 2, H / 2 - 90, W - 24);
  // countdown number
  ctx.fillStyle = '#ffe14d';
  ctx.font = 'bold 120px system-ui, sans-serif';
  ctx.fillText(n > 0 ? n : 'GO!', W / 2, H / 2 + 40);
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.fillStyle = '#fff';
  ctx.fillText('GET YOUR CURDS READY', W / 2, H / 2 + 110, W - 24);
}

// a grid of tubs rocking in place, adjacent rows tilting in opposite directions
// (hamster-dance style). Drawn under the dark overlay so it's subtle.
function drawTubHamsterDance(ctx, W, H) {
  const t = performance.now();
  const step = 88, sz = 58;
  let row = 0;
  for (let y = step / 2; y < H + sz; y += step, row++) {
    const dir = row % 2 === 0 ? 1 : -1;
    const ang = Math.sin(t * 0.005) * 0.4 * dir;
    const bob = Math.cos(t * 0.005) * 5 * dir;
    for (let x = step / 2; x < W + sz; x += step) {
      ctx.save();
      ctx.translate(x, y + bob);
      ctx.rotate(ang);
      if (images.tub) ctx.drawImage(images.tub, -sz / 2, -sz / 2, sz, sz);
      else { ctx.fillStyle = '#f2f0e0'; ctx.beginPath(); ctx.arc(0, 0, sz / 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
  }
}

function drawLeaderboard(ctx, W, H, state, selfId) {
  drawTubHamsterDance(ctx, W, H);
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
  ctx.fillText('🏆 ' + title, W / 2, AD_H + 256, W - 24);

  // ready count up top (near the winner) so it's nowhere near the bottom LET'S GO button
  const ready = state.players.filter((p) => p.ready).length;
  ctx.fillStyle = '#9f9';
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.fillText(`${ready}/${state.players.length} ready — press LET'S GO below (need 50%)`, W / 2, AD_H + 292, W - 24);

  const sorted = [...state.players].sort((a, b) =>
    (b.isMallen ? b.eaten : b.score) - (a.isMallen ? a.eaten : a.score));
  ctx.font = 'bold 22px system-ui, sans-serif';
  let y = AD_H + 332;
  for (const p of sorted) {
    ctx.fillStyle = p.id === selfId ? '#ffe14d' : '#fff';
    const sc = p.isMallen ? `${p.eaten} tubs devoured` : `${p.score} delivered`;
    const rd = p.ready ? '  ✅' : '';
    const crown = p.isMallen ? '👑 ' : '';
    ctx.fillText(`${crown}${p.name} — ${sc}${rd}`, W / 2, y, W - 24);
    y += 32;
    if (y > H - 110) break;
  }
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
