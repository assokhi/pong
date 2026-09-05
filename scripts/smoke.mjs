// End-to-end smoke test. Usage: node scripts/smoke.mjs [baseUrl]
// Exits 0 on success, 1 on the first failed assertion (CI reads the exit code).
import assert from 'node:assert';
import WS from 'ws';

const base = process.argv[2] ?? 'http://127.0.0.1:8080';
const ws = base.replace(/^http/, 'ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const fail = e => { console.error('SMOKE FAILED: ' + ((e && e.message) || e)); process.exit(1); };
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);

const post = async body => {
  const res = await fetch(base + '/room', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert(res.status === 200, 'POST /room returned ' + res.status);
  return res.json();
};

async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(50); }
  assert.fail('timed out waiting for ' + what);
}

function open(id, role, token) {
  return new Promise((res, rej) => {
    const s = new WS(`${ws}/ws?room=${id}&role=${role}${token ? '&token=' + token : ''}`);
    s.last = null; s.welcome = null; s.roleMsg = null; s.closed = null;
    s.on('message', d => {
      const m = JSON.parse(d);
      if (m.type === 'state') s.last = m;
      else if (m.type === 'welcome') { s.welcome = m; res(s); }
      else if (m.type === 'role') s.roleMsg = m;
    });
    s.on('close', (code, reason) => { s.closed = { code, reason: String(reason) }; res(s); });
    s.on('error', rej);
  });
}

async function swept(id, what) {
  let gone = false;
  try { gone = !!(await open(id, 'watch')).closed; } catch { gone = true; } // upgrade refused
  assert(gone, what + ' still resolves; it should have been swept');
}

const health = await (await fetch(base + '/health')).json();
assert(health.ok === true && typeof health.version === 'string', 'bad /health: ' + JSON.stringify(health));

// A short per-room reservation lets the claim-after-lapse path run against any server,
// including production, without a 30 s wait or an env var on the host.
const room = await post({ reserveMs: 800 });
const id = room.id;
assert(/^[\w-]{8}$/.test(id), 'room id shape: ' + id);
assert(room.reserveMs === 800, 'reserveMs not honoured: ' + JSON.stringify(room));
const clamped = await post({ reserveMs: 1, emptyMs: -5 });
assert(clamped.reserveMs === 500 && clamped.emptyMs === 1000, 'out-of-range timings not clamped: ' + JSON.stringify(clamped));

const page = await fetch(base + '/r/' + id);
assert(page.status === 200 && (await page.text()).includes('<canvas'), 'client html not served');

const a = await open(id, 'play'), b = await open(id, 'play');
assert(a.welcome.role === 'a' && b.welcome.role === 'b', 'slot assignment: ' + a.welcome.role + '/' + b.welcome.role);

const third = await open(id, 'play');
assert(third.closed && third.closed.code === 4001, 'third player not rejected: ' + JSON.stringify(third.closed));

const spec = await open(id, 'watch');
assert(spec.welcome.role === null, 'spectator was given a slot');
await until(() => spec.last && spec.last.spectators === 1, 'spectator count');
await until(() => ['count', 'play'].includes(a.last.status), 'game to start');

// a spectator has no input path; a player's input moves only their own paddle
spec.send(JSON.stringify({ type: 'input', y: 60 }));
a.send(JSON.stringify({ type: 'input', y: 400 }));
await until(() => a.last.paddles.a > 240, 'player input to move paddle A');
assert(Math.abs(a.last.paddles.b - 225) < 1, 'spectator moved a paddle: ' + a.last.paddles.b);

// garbage and out-of-range input must not corrupt state
a.send('not json');
a.send(JSON.stringify({ type: 'input', y: 1e9 }));
a.send(JSON.stringify({ type: 'input', y: 'up' }));
await sleep(300);
assert(a.last.paddles.a <= 410.01, 'paddle escaped the play area: ' + a.last.paddles.a);
assert(a.last.status !== undefined, 'server state corrupted by bad input');

// ball stays in the box across a rally (no tunneling, no sticking inside a wall)
let inPlay = 0;
for (let i = 0; i < 30; i++) {
  await sleep(50);
  assert(a.last.ball.y >= 0 && a.last.ball.y <= 450, 'ball left the box vertically: ' + a.last.ball.y);
  if (a.last.ball.x > 0 && a.last.ball.x < 800) inPlay++;
}
assert(inPlay > 20, 'ball was barely in play: ' + inPlay);

// a player dropping pauses the game and reserves the slot
b.close();
await until(() => a.last.status === 'paused', 'pause after a player disconnects');
assert(a.last.open === false, 'slot opened before the reservation lapsed');
spec.send(JSON.stringify({ type: 'claim' }));
await sleep(300);
assert(!spec.roleMsg, 'a spectator claimed a reserved slot');

// reconnect inside the reservation window with the token
const b2 = await open(id, 'play', b.welcome.token);
assert(b2.welcome.role === 'b', 'token reconnect failed: ' + JSON.stringify(b2.welcome));
await until(() => ['count', 'play'].includes(a.last.status), 'play to resume after reconnect');

// once the reservation lapses, a spectator takes the empty paddle
b2.close();
await until(() => a.last.open === true, 'slot to open after the reservation lapsed', 6000);
spec.send(JSON.stringify({ type: 'claim' }));
await until(() => spec.roleMsg && spec.roleMsg.role === 'b', 'spectator claim to succeed');
await until(() => a.last.spectators === 0, 'claimer to stop counting as a spectator');
await until(() => ['count', 'play'].includes(a.last.status), 'play to resume on claim');
a.close(); spec.close();

// room lifecycle sweep. Runs last and in parallel: it costs one 5 s sweep interval.
const empty = await post({});                       // nobody ever connects -> swept as unused
const expired = await post({ emptyMs: 1000 });      // spectators, no player, short no-player TTL
const expiredSpec = await open(expired.id, 'watch');
const kept = await post({});                        // spectators, no player, default 10 min TTL
const keptSpec = await open(kept.id, 'watch');
assert(expiredSpec.welcome && keptSpec.welcome, 'spectators failed to join the sweep-test rooms');
await sleep(6500);                                  // one full sweep cycle plus slack
await swept(empty.id, 'a room nobody joined');
await swept(expired.id, 'a room past its no-player TTL');
assert(expiredSpec.closed && expiredSpec.closed.code === 4003,
  'spectator not closed with 4003 when its room expired: ' + JSON.stringify(expiredSpec.closed));
const rejoin = await open(kept.id, 'watch');
assert(rejoin.welcome, 'a spectator-only room was swept before its no-player TTL');
rejoin.close(); keptSpec.close();

console.log('smoke ok against ' + base);
process.exit(0);
