// Server-authoritative Pong. Node + ws. Rooms in memory, no persistence.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const W = 800, H = 450, R = 7, PW = 12, PH = 80, AX = 24, BX = W - 24 - PW, PSPEED = 700;
const DT = 1 / 60, V0 = 380, VMAX = 900, MAXA = Math.PI / 3, WIN = 11;
const SPEC_CAP = 20, PORT = process.env.PORT || 8080;
const NEW_ROOM_GRACE = 60e3; // a just-created room has not been reached by its creator yet
// Defaults for rooms that do not ask for their own; POST /room may override per room.
const RESERVE = +process.env.PONG_RESERVE_MS || 30e3;
const EMPTY_TTL = +process.env.PONG_EMPTY_TTL_MS || 600e3;
const SNAP_MS = +process.env.PONG_SNAP_MS || 40;   // snapshot period; lower it to trade bandwidth for smoothness
const BEAT_MS = +process.env.PONG_BEAT_MS || 5000; // keepalive period, and how often RTT is resampled

const rooms = new Map();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const raw = (ws, s) => { if (ws && ws.readyState === 1) ws.send(s); };
const send = (ws, o) => raw(ws, JSON.stringify(o));

// mulberry32. Seeded per room so a game is a pure function of (seed, inputs): without that, a run
// cannot be replayed and a test can only assert vague properties of it.
const rng = a => () => {
  a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

function makeRoom(reserve = RESERVE, empty = EMPTY_TTL, seed = crypto.randomBytes(4).readUInt32LE(0)) {
  const r = {
    id: crypto.randomBytes(6).toString('base64url'), // 8 url-safe chars
    reserve, empty, seed, rand: rng(seed), createdAt: Date.now(), everJoined: false, lag: { a: 0, b: 0 },
    sock: { a: null, b: null }, tok: { a: null, b: null }, res: { a: 0, b: 0 }, specs: new Set(),
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0 }, pad: { a: H / 2, b: H / 2 }, tgt: { a: H / 2, b: H / 2 },
    score: { a: 0, b: 0 }, status: 'wait', cd: 0, winner: null, started: false, emptySince: Date.now(),
  };
  rooms.set(r.id, r);
  return r;
}

// dir: +1 serves toward B (right), -1 toward A (left)
function launch(r, dir) {
  const th = r.rand() * 0.8 - 0.4;
  r.ball = { x: W / 2, y: H / 2, vx: dir * V0 * Math.cos(th), vy: V0 * Math.sin(th) };
  r.status = 'count'; r.cd = 1.5; r.started = true;
}

// Swept test: leading edge of the ball crossing the paddle plane inside this step.
// A per-frame AABB check tunnels as soon as |vx|*dt > PW.
function paddleHit(r, s, px, py) {
  const b = r.ball, left = s === 'a', face = left ? AX + PW : BX, lead = left ? -R : R;
  const p0 = px + lead, p1 = b.x + lead;
  if (left ? !(p0 > face && p1 <= face) : !(p0 < face && p1 >= face)) return false;
  const u = (p0 - face) / (p0 - p1);
  const yc = py + (b.y - py) * u;
  const off = (yc - r.pad[s]) / (PH / 2);
  if (Math.abs(off) > 1 + R / (PH / 2)) return false;
  const th = clamp(off, -1, 1) * MAXA;
  const sp = Math.min(Math.hypot(b.vx, b.vy) * 1.05, VMAX);
  b.vx = (left ? 1 : -1) * sp * Math.cos(th);
  b.vy = sp * Math.sin(th);
  b.y = yc;
  b.x = face + (left ? R : -R) * 1.01; // push clear so it cannot double-collide next tick
  return true;
}

function sim(r, dt) {
  const b = r.ball, px = b.x, py = b.y;
  b.x += b.vx * dt; b.y += b.vy * dt;
  if (!paddleHit(r, 'a', px, py)) paddleHit(r, 'b', px, py);
  if (b.y < R) { b.y = R + (R - b.y); b.vy = -b.vy; }
  else if (b.y > H - R) { b.y = (H - R) - (b.y - (H - R)); b.vy = -b.vy; }
  if (b.x < 0 || b.x > W) {
    const aScored = b.x > W;
    r.score[aScored ? 'a' : 'b']++;
    if (r.score.a >= WIN || r.score.b >= WIN) {
      r.winner = r.score.a >= WIN ? 'a' : 'b'; r.status = 'over';
      r.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
    } else launch(r, aScored ? -1 : 1); // serve away from whoever conceded
  }
}

function step(r) {
  const both = r.sock.a && r.sock.b;
  if (r.status !== 'over') {
    if (!both) r.status = r.started ? 'paused' : 'wait';
    else if (r.status === 'paused' || r.status === 'wait') launch(r, r.rand() < 0.5 ? 1 : -1);
  }
  for (const s of ['a', 'b']) {
    const d = clamp(r.tgt[s], PH / 2, H - PH / 2) - r.pad[s];
    r.pad[s] += clamp(d, -PSPEED * DT, PSPEED * DT);
  }
  if (r.status === 'count') { r.cd -= DT; if (r.cd <= 0) { r.cd = 0; r.status = 'play'; } return; }
  if (r.status === 'play') sim(r, DT);
}

function broadcast() {
  const now = Date.now();
  for (const r of rooms.values()) {
    const msg = JSON.stringify({ // serialized once per room per tick
      type: 'state', ball: r.ball, paddles: r.pad, score: r.score, spectators: r.specs.size,
      open: ['a', 'b'].some(k => !r.sock[k] && r.res[k] < now),
      status: r.status, cd: r.cd, winner: r.winner, t: now,
    });
    raw(r.sock.a, msg); raw(r.sock.b, msg);
    for (const ws of r.specs) raw(ws, msg);
  }
}

// A proxy may swallow a close frame and leave the peer with a bare 1006 and no reason (Render
// does). Say why in a data frame, which relays like any other traffic, then close a moment later;
// the close code stays as a secondary signal for direct connections.
function bye(ws, code, reason) {
  send(ws, { type: 'bye', code, reason });
  setTimeout(() => ws.close(code, reason), 250).unref();
}

// Round trip, timed entirely here: we stamp the ping and read the clock again on the pong, so
// nothing a client says can influence it. The client needs it to draw the ball where it is now
// rather than where it was when the packet left. Resampled once per keepalive beat, smoothed
// because a jumpy value would make the rendered ball jitter — RTT is a slow-moving quantity.
function measureLag(r, s, ws, ms) {
  if (!(ms >= 0 && ms < 30e3)) return;   // an unsolicited pong (RFC 6455 allows them) times nothing
  r.lag[s] = r.lag[s] ? r.lag[s] * 0.8 + ms * 0.2 : ms;
  send(ws, { type: 'lag', ms: Math.round(r.lag[s]) });
}

function seat(r, ws, s) {
  r.specs.delete(ws); r.sock[s] = ws; ws.slot = s; r.res[s] = 0;
  r.tok[s] = crypto.randomBytes(9).toString('base64url');
  r.tgt[s] = r.pad[s];
  return r.tok[s];
}

function join(r, ws, role, token) {
  ws.slot = null;
  ws.on('error', () => {});
  // Keepalive. Without it a client that vanishes without a FIN (lid closed, tunnel dropped, carrier
  // handover) holds its paddle until the OS TCP timeout — minutes during which the room never
  // pauses, the opponent farms free points, and the slot never reaches its reservation.
  ws.isAlive = true; ws.pingAt = 0;
  ws.on('pong', () => {
    ws.isAlive = true;
    if (ws.pingAt && ws.slot && r.sock[ws.slot] === ws) measureLag(r, ws.slot, ws, Date.now() - ws.pingAt);
  });
  if (role === 'play') {
    const now = Date.now();
    let s = token && ['a', 'b'].find(k => r.tok[k] === token && !r.sock[k]);
    if (!s) s = ['a', 'b'].find(k => !r.sock[k] && r.res[k] < now);
    if (!s) return bye(ws, 4001, 'both paddles are taken');
    seat(r, ws, s);
  } else {
    if (r.specs.size >= SPEC_CAP) return bye(ws, 4002, 'spectator limit reached');
    r.specs.add(ws);
  }
  r.everJoined = true;
  send(ws, {
    type: 'welcome', room: r.id, role: ws.slot, token: ws.slot ? r.tok[ws.slot] : null,
    dims: { W, H, R, PW, PH, AX, BX, SPEED: PSPEED, WIN },
  });

  ws.on('message', data => {
    let m; try { m = JSON.parse(data); } catch { return; }
    const mine = ws.slot && r.sock[ws.slot] === ws; // authority is the room's record, never the message
    if (m.type === 'input') {
      if (!mine || typeof m.y !== 'number' || !isFinite(m.y)) return;
      r.tgt[ws.slot] = clamp(m.y, PH / 2, H - PH / 2);
    } else if (m.type === 'claim') {
      if (mine) return;
      const s = ['a', 'b'].find(k => !r.sock[k] && r.res[k] < Date.now());
      if (!s) return;
      send(ws, { type: 'role', role: s, token: seat(r, ws, s) });
    } else if (m.type === 'rematch') {
      if (!mine || r.status !== 'over') return;
      r.score.a = r.score.b = 0; r.winner = null; r.started = false; r.status = 'wait';
    }
  });

  ws.on('close', () => {
    if (ws.slot && r.sock[ws.slot] === ws) { r.sock[ws.slot] = null; r.res[ws.slot] = Date.now() + r.reserve; }
    else r.specs.delete(ws);
  });
}

const CLIENT = path.join(__dirname, 'client.html');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/health') { // plain HTTP, never an upgrade: CI polls .version
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true, version: process.env.RENDER_GIT_COMMIT ?? 'dev',
      rooms: rooms.size, uptime: Math.round(process.uptime()),
    }));
  }
  if (req.method === 'POST' && u.pathname === '/room') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1000) req.destroy(); }); // unauthenticated: cap it
    req.on('end', () => {
      let o = {};
      try { o = JSON.parse(body || '{}') || {}; } catch { /* junk body -> defaults */ }
      const ms = (v, lo, hi, dflt) => (typeof v === 'number' && isFinite(v) ? clamp(v, lo, hi) : dflt);
      // Per-room timings so a test room can exercise the reconnect and sweep paths in seconds.
      // Worst case for an abuser: their own room forgets them faster.
      // A caller-chosen seed makes a room's serves reproducible; it decides nothing but which way
      // the ball is thrown, so there is nothing to gain by picking one.
      const seed = typeof o.seed === 'number' && isFinite(o.seed) ? o.seed >>> 0 : undefined;
      const r = makeRoom(ms(o.reserveMs, 500, 60e3, RESERVE), ms(o.emptyMs, 1e3, 600e3, EMPTY_TTL), seed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: r.id, reserveMs: r.reserve, emptyMs: r.empty, seed: r.seed }));
    });
    return;
  }
  if (req.method === 'GET' && (u.pathname === '/' || /^\/r\/[\w-]{1,16}$/.test(u.pathname))) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return fs.createReadStream(CLIENT).pipe(res);
  }
  res.writeHead(404).end('not found');
});

// maxPayload: the largest thing a client legitimately sends is a ~50 byte input frame. The default
// cap is 100 MiB, which is a free memory spike for anyone who asks.
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on('upgrade', (req, sock, head) => {
  const u = new URL(req.url, 'http://x');
  const r = rooms.get(u.searchParams.get('room') || '');
  if (u.pathname !== '/ws' || !r) return sock.destroy();
  const role = u.searchParams.get('role') === 'play' ? 'play' : 'watch';
  wss.handleUpgrade(req, sock, head, ws => join(r, ws, role, u.searchParams.get('token')));
});

// Fixed 60 Hz accumulator: measures real elapsed time, so it cannot drift like setInterval.
let last = Date.now(), acc = 0;
const simTimer = setInterval(() => {
  const now = Date.now();
  acc = Math.min(acc + (now - last) / 1000, 0.25); last = now;
  while (acc >= DT) { acc -= DT; for (const r of rooms.values()) step(r); }
}, 4);
const castTimer = setInterval(broadcast, SNAP_MS); // 25 Hz snapshots by default

// A socket that misses a whole beat is gone. terminate() fires 'close', so the slot release and
// reservation below need no special case. Browsers answer ping frames in the protocol layer, so
// this costs the client nothing to implement.
const beatTimer = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.pingAt = now; ws.ping();
  }
}, BEAT_MS);

const sweepTimer = setInterval(() => { // TTL sweep
  const now = Date.now();
  for (const [id, r] of rooms) {
    const players = (r.sock.a ? 1 : 0) + (r.sock.b ? 1 : 0);
    if (players) r.emptySince = 0; else if (!r.emptySince) r.emptySince = now;
    // "Idle" means everyone left. A room nobody has reached yet is not idle, it is new: the
    // creator's browser is still loading /r/<id>, which on a slow phone outlasts a sweep tick.
    // Sweeping it there hands them a dead link to the room they just made.
    const idle = !players && !r.specs.size && (r.everJoined || now - r.createdAt > NEW_ROOM_GRACE);
    if (idle || (r.emptySince && now - r.emptySince > r.empty)) {
      for (const ws of r.specs) bye(ws, 4003, 'room closed');
      rooms.delete(id);
    }
  }
}, 5000);

// Render sends SIGTERM before replacing the instance. Rooms are in memory, so every game in
// progress is lost either way — 4004 just makes that legible instead of a generic disconnect.
process.on('SIGTERM', () => {
  clearInterval(simTimer); clearInterval(castTimer); clearInterval(sweepTimer); clearInterval(beatTimer);
  for (const ws of wss.clients) bye(ws, 4004, 'server restarting');
  rooms.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref(); // force-exit if a socket will not close
});

if (process.argv[2] === '--selftest') {
  const assert = require('assert');
  const r = makeRoom(); r.status = 'play';
  // tunneling: one step moves the ball far past the paddle, the swept test must still catch it
  r.ball = { x: 200, y: 225, vx: -12000, vy: 0 }; r.pad.a = 225;
  sim(r, DT);
  assert(r.ball.vx > 0 && r.ball.x > AX, 'tunneled through paddle A: ' + JSON.stringify(r.ball));
  // offset reflection: an edge hit must bend the ball and speed it up
  r.ball = { x: BX - R - 2, y: 225 + PH / 2, vx: 500, vy: 0 }; r.pad.b = 225;
  sim(r, DT);
  assert(r.ball.vx < 0 && r.ball.vy > 100, 'no angle off paddle edge: ' + JSON.stringify(r.ball));
  assert(Math.hypot(r.ball.vx, r.ball.vy) > 500, 'no speed-up on bounce');
  // wall bounce ends outside the wall, moving away from it
  r.ball = { x: 400, y: R - 3, vx: 0, vy: -400 };
  sim(r, DT);
  assert(r.ball.y >= R && r.ball.vy > 0, 'stuck inside the top wall: ' + r.ball.y);
  // scoring: past the left edge is B's point, and the serve goes away from A
  r.score.a = r.score.b = 0;
  r.ball = { x: 2, y: 225, vx: -400, vy: 0 };
  sim(r, DT);
  assert(r.score.b === 1 && r.status === 'count' && r.ball.vx > 0, 'bad score/serve: ' + JSON.stringify(r.score));
  rooms.delete(r.id);

  // Fairness. A rally speeds up on every hit, and once the ball outruns the paddle the game stops
  // being a contest of skill and becomes a coin flip on which half the serve lands in. The invariant
  // is that a paddle can still cross the field in the time the fastest possible shot takes to arrive.
  const travel = PSPEED * ((BX - AX - PW) / VMAX);
  assert(travel >= H - PH,
    'top-speed shots are no longer reachable: ' + travel.toFixed(0) + 'px of paddle travel for ' +
    (H - PH) + 'px of field. Lower VMAX or raise PSPEED.');

  // Determinism. Same seed, same steps, same world. This is what lets an impaired run be compared
  // against anything at all; without it a network test can only assert vague properties.
  const d1 = makeRoom(RESERVE, EMPTY_TTL, 12345), d2 = makeRoom(RESERVE, EMPTY_TTL, 12345);
  for (const d of [d1, d2]) { launch(d, 1); d.status = 'play'; }
  const firstServe = { ...d1.ball };
  for (let i = 0; i < 900; i++) { sim(d1, DT); sim(d2, DT); }   // 15 s of play, several serves deep
  assert(d1.score.a + d1.score.b > 0, 'the determinism fixture never scored, so it never re-served');
  assert.deepStrictEqual(d1.ball, d2.ball, 'same seed diverged: ' + JSON.stringify([d1.ball, d2.ball]));
  assert.deepStrictEqual(d1.score, d2.score, 'same seed scored differently');
  const d3 = makeRoom(RESERVE, EMPTY_TTL, 999);
  launch(d3, 1);
  assert(d3.ball.vy !== firstServe.vy, 'a different seed served at an identical angle');
  rooms.delete(d1.id); rooms.delete(d2.id); rooms.delete(d3.id);

  console.log('selftest ok'); process.exit(0); // sim timers are already running, so exit explicitly
} else {
  server.listen(PORT, () => console.log('pong on http://localhost:' + PORT));
}
