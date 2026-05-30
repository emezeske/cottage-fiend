// WebSocket server. Wraps the authoritative Game with networking + a tick loop.
// Railway sets PORT; we also serve the static client so one service does it all.

import { WebSocketServer } from 'ws';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from './game/game.js';
import { TICK_MS, MSG, PHASE, ROUND } from './game/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const PORT = process.env.PORT || 8080;

// Last-resort safety net: for a disposable party game, staying up beats crashing.
// The per-tick and per-message try/catch handle the expected paths; this catches
// anything that slips through (e.g. a socket send error) without exiting.
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

// --- static file server for the client ------------------------------------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  // --- admin (no auth — it's a joke game) ---
  if (urlPath === '/admin/reset' && req.method === 'POST') { // POST-only so a stray GET can't wipe state
    game = new Game();                       // wipe all state
    game.setForcedPresent(forcedPresent);    // keep the testing override across a reset
    game.setMallenPower(mallenPower);        // keep the difficulty setting across a reset
    game.setPresentRate(presentRate);        // keep the present-frequency setting across a reset
    for (const ws of sockets.values()) { try { ws.close(); } catch {} } // kick clients to rejoin fresh
    sockets.clear();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('server reset — players must refresh to rejoin');
    return;
  }
  // testing: force every present to a specific effect. POST ?fx=banana (or fx=random/empty
  // to clear); GET returns the current setting so the admin dropdown can sync.
  if (urlPath === '/admin/force-present') {
    if (req.method === 'POST') {
      const fx = new URL(req.url, 'http://x').searchParams.get('fx') || '';
      game.setForcedPresent(fx);
      forcedPresent = game.forcedFx || '';   // store the validated value (persists across reset)
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(forcedPresent ? `forcing every present: ${forcedPresent}` : 'presents are random again');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(forcedPresent);
    return;
  }
  // live Mallen difficulty knob. POST ?level=1..5; GET returns the current level.
  if (urlPath === '/admin/mallen-power') {
    if (req.method === 'POST') {
      const level = new URL(req.url, 'http://x').searchParams.get('level');
      game.setMallenPower(level);
      mallenPower = game.mallenPower;        // validated value, persists across reset
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`Mallen power set to ${mallenPower}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(String(mallenPower));
    return;
  }
  // live present-frequency knob. POST ?rate=2; GET returns the current multiplier.
  if (urlPath === '/admin/present-rate') {
    if (req.method === 'POST') {
      const rate = new URL(req.url, 'http://x').searchParams.get('rate');
      game.setPresentRate(rate);
      presentRate = game.presentRate;        // validated value, persists across reset
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`Presents drop at ${presentRate}x`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(String(presentRate));
    return;
  }
  if (urlPath === '/admin') urlPath = '/admin.html';
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(CLIENT_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(CLIENT_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // never cache the client during active iteration — always serve fresh files
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(data);
  });
});

// --- game + websockets ------------------------------------------------------
let game = new Game();
let forcedPresent = '';  // admin testing: effect id every present rolls ('' = random)
let mallenPower = 3;     // admin: live Mallen difficulty level (1-5), persists across reset
let presentRate = 1;     // admin: present-frequency multiplier, persists across reset
const wss = new WebSocketServer({ server: httpServer });
const sockets = new Map(); // id -> ws

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...payload }));
}
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of sockets.values()) if (ws.readyState === ws.OPEN) ws.send(msg);
}

wss.on('connection', (ws) => {
  let playerId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; }); // heartbeat: client answered our ping

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    // A bug handling one player's input must never take the whole party down.
    try {
      const now = game._clock || 0;
      switch (m.type) {
        case MSG.JOIN: {
          const name = (m.name || 'delivery').toString().slice(0, 16);
          const colors = {
            vest:   typeof m.vestColor   === 'string' ? m.vestColor   : null,
            pants:  typeof m.pantsColor  === 'string' ? m.pantsColor  : null,
            mallen: typeof m.mallenColor === 'string' ? m.mallenColor : null,
          };
          playerId = game.addPlayer(name, colors);
          sockets.set(playerId, ws);
          send(ws, MSG.WELCOME, { id: playerId });
          // if we're idling in lobby with players, kick a round when ready
          break;
        }
        case MSG.INPUT:
          if (playerId) game.setInput(playerId, m.x || 0, m.y || 0);
          break;
        case MSG.PICKUP:
          if (playerId) game.pickup(playerId, now);
          break;
        case MSG.CHARGE:
          if (playerId) game.startCharge(playerId, now);
          break;
        case MSG.AIM:
          if (playerId) game.setAim(playerId, m.x || 0, m.y || 0);
          break;
        case MSG.RELEASE:
          if (playerId) game.release(playerId, now);
          break;
        case MSG.NUKE_LAUNCH:
          if (playerId) game.launchNuke(playerId, now, m.x || 0, m.y || 0);
          break;
        case MSG.PUNCH:
          if (playerId) game.punch(playerId, now);
          break;
        case MSG.READY:
          if (playerId) game.setReady(playerId);
          break;
      }
    } catch (err) {
      console.error('message handler error:', err);
    }
  });

  ws.on('error', () => { try { ws.terminate(); } catch {} }); // don't let a socket error bubble up
  ws.on('close', () => {
    if (playerId) { game.removePlayer(playerId); sockets.delete(playerId); }
  });
});

// Heartbeat: ping every 15s; a socket that misses two cycles (dead/backgrounded
// phone that never sent a clean close) is terminated so it stops being a ghost
// player inflating the "ready" count.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 15000);
wss.on('close', () => clearInterval(heartbeat));

// --- tick loop --------------------------------------------------------------
let last = Date.now();
setInterval(() => {
  // One bad tick must not crash the server and kick all 12 players.
  try {
    const now = Date.now();
    // clamp dt: a GC pause / CPU spike shouldn't fast-forward the sim and teleport
    // everyone across the arena in a single giant step.
    const dt = Math.min(now - last, 100);
    last = now;

    game.tick(dt);

    // lobby/leaderboard -> start a round when enough players are ready
    if ((game.phase === PHASE.LOBBY || game.phase === PHASE.LEADERBOARD)) {
      if (game.players.size > 0 && game.readyFractionMet()) {
        game.startRound();
      }
    }

    // broadcast snapshot + drained events
    const events = game.drainEvents();
    broadcast({ type: MSG.STATE, snapshot: game.snapshot(), events });
  } catch (err) {
    console.error('tick error:', err);
  }
}, TICK_MS);

// Non-internal IPv4 addresses, so you can open the game from a phone on the LAN.
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

httpServer.listen(PORT, () => {
  console.log(`🧀 Cottage Fiend server listening on :${PORT}`);
  console.log(`   Local:   http://localhost:${PORT}`);
  const lan = lanAddresses();
  if (lan.length) {
    for (const ip of lan) console.log(`   Network: http://${ip}:${PORT}  (open this on your phone)`);
  } else {
    console.log('   Network: no LAN IPv4 found (are you on Wi-Fi/Ethernet?)');
  }
});
