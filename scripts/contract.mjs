// Protocol contract gate. The client and the server are edited independently and share nothing but
// JSON, so the failure mode is silent: a field gets renamed on one side, every existing test still
// passes because they all talk to the server directly, and the only symptom is a browser rendering
// `undefined`. Nothing else here would notice.
//
// Two halves. Statically: every message type one side sends, the other must handle. At runtime:
// the real frames off a real socket are checked against what client.html actually reads, so the
// contract is taken from the wire rather than from a list someone kept up to date by hand.
import assert from 'node:assert';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import WS from 'ws';

const SRV = 8091;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kids = [];
const stop = () => { for (const k of kids) { try { k.kill(); } catch {} } };
const fail = e => { console.error('CONTRACT FAILED: ' + ((e && e.message) || e)); stop(); process.exit(1); };
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);
process.on('exit', stop);

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const client = readFileSync(new URL('../client.html', import.meta.url), 'utf8');
const all = (src, re) => new Set([...src.matchAll(re)].map(m => m[1]));
const list = s => [...s].sort().join(', ');

/* ---------- 1. the two sides agree on which messages exist ---------- */
const serverHandles = all(server, /m\.type === '(\w+)'/g);
const serverSends = all(server, /type: '(\w+)'/g);
const clientHandles = all(client, /m\.type === '(\w+)'/g);
// The client builds its hot-path input frame as a string by hand, so both spellings count.
const clientSends = new Set([...all(client, /"type":"(\w+)"/g), ...all(client, /type: '(\w+)'/g)]);

for (const t of clientSends) {
  assert(serverHandles.has(t), `the client sends "${t}", which the server does not handle (it handles: ${list(serverHandles)})`);
}
for (const t of serverSends) {
  assert(clientHandles.has(t), `the server sends "${t}", which the client does not handle (it handles: ${list(clientHandles)})`);
}
// Dead branches on either side are drift too, and they are how a rename hides.
for (const t of serverHandles) {
  assert(clientSends.has(t), `the server handles "${t}", which no client ever sends`);
}
for (const t of clientHandles) {
  assert(serverSends.has(t), `the client handles "${t}", which the server never sends`);
}

/* ---------- 2. the real frames carry what the client actually reads ---------- */
const k = spawn(process.execPath, ['server.js'],
  { env: { ...process.env, PORT: String(SRV), PONG_BEAT_MS: '600' }, stdio: ['ignore', 'ignore', 'pipe'] });
k.stderr.on('data', d => console.error('[server] ' + d));
kids.push(k);

await new Promise((res, rej) => {
  const end = Date.now() + 15000;
  (function tick() {
    const s = net.connect(SRV, '127.0.0.1');
    s.on('connect', () => { s.destroy(); res(); });
    s.on('error', () => { s.destroy(); Date.now() > end ? rej(new Error('server never listened')) : setTimeout(tick, 100); });
  })();
});

const seen = new Map();                    // type -> the key set actually observed on the wire
function open(id, role, token) {
  return new Promise(res => {
    const s = new WS(`ws://127.0.0.1:${SRV}/ws?room=${id}&role=${role}${token ? '&token=' + token : ''}`);
    s.on('message', d => {
      const m = JSON.parse(d);
      if (!seen.has(m.type)) seen.set(m.type, Object.keys(m).filter(x => x !== 'type').sort());
      if (m.type === 'welcome' || m.type === 'bye') res(s);
    });
    s.on('error', () => {});
    s.on('close', () => res(s));
  });
}

const room = await (await fetch(`http://127.0.0.1:${SRV}/room`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reserveMs: 500 }),
})).json();

const a = await open(room.id, 'play'), b = await open(room.id, 'play');
await open(room.id, 'play');               // third player: provokes a bye
const spec = await open(room.id, 'watch');
await sleep(1400);                         // two keepalive beats: provokes a lag
b.close();
await sleep(900);                          // the reservation lapses
spec.send(JSON.stringify({ type: 'claim' }));   // provokes a role
await sleep(600);
a.close(); spec.close();

for (const t of serverSends) {
  assert(seen.has(t), `the server declares it sends "${t}", but no live session produced one`);
}

// Every field on the wire must be one the client reads. A field nobody reads is either dead
// bandwidth or, far more likely, a rename that only landed on one side.
const UNREAD = { welcome: ['room'] };      // room is echoed for humans reading the frame, not used
for (const [type, keys] of seen) {
  for (const key of keys) {
    if ((UNREAD[type] || []).includes(key)) continue;
    assert(new RegExp(`\\.${key}\\b`).test(client),
      `the server's "${type}" frame carries "${key}", which client.html never reads`);
  }
}

const stateKeys = seen.get('state');
assert(stateKeys.includes('t'), 'a state frame with no t: clients extrapolate from it');
assert(stateKeys.includes('ball') && stateKeys.includes('paddles') && stateKeys.includes('score'),
  'state frame is missing core fields: ' + stateKeys.join(', '));

console.log(`contract ok — ${clientSends.size} client message types, ${serverSends.size} server types, ` +
  `state carries [${stateKeys.join(' ')}]`);
stop();
process.exit(0);
