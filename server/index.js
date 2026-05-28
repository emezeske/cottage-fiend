// WebSocket server. Wraps the authoritative Game with networking + a tick loop.
// Railway sets PORT; we also serve the static client so one service does it all.

import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from './game/game.js';
import { TICK_MS, MSG, PHASE, ROUND } from './game/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const PORT = process.env.PORT || 8080;

// --- static file server for the client ------------------------------------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(CLIENT_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(CLIENT_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- game + websockets ------------------------------------------------------
const game = new Game();
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

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const now = game._clock || 0;

    switch (m.type) {
      case MSG.JOIN: {
        const name = (m.name || 'delivery').toString().slice(0, 16);
        playerId = game.addPlayer(name);
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
      case MSG.RELEASE:
        if (playerId) game.release(playerId, now);
        break;
      case MSG.READY:
        if (playerId) game.setReady(playerId);
        break;
    }
  });

  ws.on('close', () => {
    if (playerId) { game.removePlayer(playerId); sockets.delete(playerId); }
  });
});

// --- tick loop --------------------------------------------------------------
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = now - last;
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
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`🧀 Cottage Fiend server listening on :${PORT}`);
});
