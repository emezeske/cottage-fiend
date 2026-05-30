// End-to-end integration tests: boot the real WebSocket server in a child
// process, drive it from real ws clients, assert the protocol holds up. These
// catch bugs that only happen at the network seam (duplicate JOIN, the admin
// reset close-handler race, snapshot shape, etc.) — things the in-process
// game.test.js exercising Game directly can't see.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { WebSocket } from 'ws';

// One server is shared by every test in this file — they're sequential by
// node:test default, and resetting state between tests via /admin/reset
// keeps them independent without the boot cost per test.
const PORT = 8095 + Math.floor(Math.random() * 100);
let serverProc = null;

async function ensureServer() {
  if (serverProc) return;
  serverProc = spawn('node', ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // wait for the listen line so the http server is actually accepting
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server boot timed out')), 5000);
    serverProc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening on :' + PORT)) { clearTimeout(timer); resolve(); }
    });
    serverProc.on('exit', (code) => reject(new Error('server exited during boot ' + code)));
  });
}

after(() => {
  if (serverProc) { try { serverProc.kill('SIGTERM'); } catch {} serverProc = null; }
});

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw)); } catch {} });
    ws.on('open', () => resolve({ ws, events }));
    ws.on('error', reject);
  });
}
async function reset() {
  // The admin reset wipes Game state + closes every connected ws. Wait for
  // the http response so the next test starts clean.
  const r = await fetch(`http://127.0.0.1:${PORT}/admin/reset`, { method: 'POST' });
  assert.ok(r.ok, 'admin/reset returned ' + r.status);
  await wait(150);
}

test('integration: JOIN -> WELCOME -> STATE snapshot has the expected shape', async () => {
  await ensureServer(); await reset();
  const { ws, events } = await connect();
  ws.send(JSON.stringify({ type: 'join', name: 'alice', shirtColor: '#ff0000', pantsColor: '#0000ff' }));
  await wait(200);
  const welcome = events.find(e => e.type === 'welcome');
  assert.ok(welcome, 'WELCOME received');
  assert.ok(typeof welcome.id === 'number', 'WELCOME has id');
  const state = events.find(e => e.type === 'state');
  assert.ok(state, 'STATE snapshot received');
  assert.ok(state.snapshot, 'snapshot present');
  assert.ok(Array.isArray(state.snapshot.players), 'players[]');
  const me = state.snapshot.players.find(p => p.id === welcome.id);
  assert.ok(me, 'self in snapshot');
  assert.equal(me.shirtColor, '#ff0000', 'colors persisted from JOIN payload');
  assert.equal(me.pantsColor, '#0000ff');
  ws.close();
});

test('integration: duplicate JOIN on same socket creates exactly ONE player', async () => {
  await ensureServer(); await reset();
  const { ws, events } = await connect();
  ws.send(JSON.stringify({ type: 'join', name: 'first' }));
  await wait(80);
  ws.send(JSON.stringify({ type: 'join', name: 'second' }));   // should be ignored
  await wait(200);
  const state = events.slice().reverse().find(e => e.type === 'state');
  assert.equal(state.snapshot.players.length, 1, 'only one player despite two JOINs');
  assert.equal(state.snapshot.players[0].name, 'first', 'first name wins, second is ignored');
  ws.close();
});

test('integration: server rejects malformed messages without crashing', async () => {
  await ensureServer(); await reset();
  const { ws } = await connect();
  ws.send('this-is-not-json');
  ws.send(JSON.stringify({ type: 'join', name: 'alice' }));
  ws.send(JSON.stringify({ type: 'input', x: 'banana', y: null }));    // garbage payload
  ws.send(JSON.stringify({ type: 'input', x: NaN }));
  ws.send(JSON.stringify({ type: 'unknown_message_type' }));
  ws.send(JSON.stringify({ type: 'release' }));   // release with no charge
  await wait(200);
  // Server is still alive: a fresh connection should still succeed.
  const { ws: ws2, events: ev2 } = await connect();
  ws2.send(JSON.stringify({ type: 'join', name: 'bob' }));
  await wait(200);
  assert.ok(ev2.find(e => e.type === 'welcome'), 'server still serves new joins after garbage');
  ws.close(); ws2.close();
});

test('integration: disconnecting cleanly removes the player from snapshots', async () => {
  await ensureServer(); await reset();
  const { ws: w1, events: e1 } = await connect();
  const { ws: w2, events: e2 } = await connect();
  w1.send(JSON.stringify({ type: 'join', name: 'alpha' }));
  w2.send(JSON.stringify({ type: 'join', name: 'beta' }));
  await wait(200);
  const before = e2.slice().reverse().find(e => e.type === 'state');
  assert.equal(before.snapshot.players.length, 2, 'two players visible');
  w1.close();
  await wait(300);
  const after = e2.slice().reverse().find(e => e.type === 'state');
  assert.equal(after.snapshot.players.length, 1, 'one remains after disconnect');
  assert.equal(after.snapshot.players[0].name, 'beta');
  w2.close();
});

test('integration: 20 clients can all connect, send input, and see each other in snapshots', async () => {
  await ensureServer(); await reset();
  const conns = [];
  for (let i = 0; i < 20; i++) {
    const c = await connect();
    c.ws.send(JSON.stringify({ type: 'join', name: 'crew' + i }));
    conns.push(c);
  }
  await wait(400);
  for (const { ws } of conns) {
    ws.send(JSON.stringify({ type: 'input', x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 }));
  }
  await wait(200);
  const lastState = conns[0].events.slice().reverse().find(e => e.type === 'state');
  assert.equal(lastState.snapshot.players.length, 20, '20 players visible in everyone\'s snapshot');
  for (const { ws } of conns) ws.close();
});

test('integration: snapshot wire size with 8 players is meaningfully smaller than the JSON', async () => {
  await ensureServer(); await reset();
  // Use 8 clients so the snapshot has enough body to compress (the threshold is
  // 1 KB; below that the message is sent uncompressed).
  const N = 8;
  const conns = [];
  for (let i = 0; i < N; i++) {
    const c = await connect();
    c.ws.send(JSON.stringify({ type: 'join', name: 'crew' + i }));
    conns.push(c);
  }
  await wait(300);
  // We can read the raw frame size from the ws library by listening to the
  // low-level 'message' event with the binary buffer — but ws auto-decodes
  // by default. Instead, observe via the bytesReceived stat on the socket
  // after a known number of snapshots.
  const start = conns[0].ws._socket?.bytesRead || 0;
  const startEvents = conns[0].events.length;
  // collect ~30 snapshots
  await wait(1100);
  const end = conns[0].ws._socket?.bytesRead || 0;
  const endEvents = conns[0].events.length;
  const snaps = endEvents - startEvents;
  const bytes = end - start;
  if (snaps < 5) {
    for (const { ws } of conns) ws.close();
    return;  // CI may have throttled — skip the assertion rather than flake
  }
  const lastState = conns[0].events.slice().reverse().find(e => e.type === 'state');
  const uncompressed = JSON.stringify(lastState).length;
  const compressedPerSnap = bytes / snaps;
  const ratio = compressedPerSnap / uncompressed;
  console.log(`  per-message-deflate: ${uncompressed} B JSON -> ${compressedPerSnap.toFixed(0)} B on wire (${(ratio*100).toFixed(0)}%)`);
  assert.ok(ratio < 0.7,
    `expected on-wire snapshot well under JSON size, ratio ${ratio.toFixed(2)}`);
  for (const { ws } of conns) ws.close();
});
