// Concurrency gate for a design that is deliberately one process on one instance.
//
// render.yaml pins numInstances: 1 because rooms live in a Map, so there is no horizontal escape
// hatch — the only question that matters is what this single loop does as rooms multiply. Two
// things are asserted: that the simulation's own cadence does not stretch under load (broadcast is
// O(clients), and if it ever starts costing more than a frame, every client's extrapolation is
// working from stale snapshots), and that rooms and sockets are actually reclaimed afterwards.
//
// The second is the real leak test. The first is the ceiling this design is allowed to have.
import assert from 'node:assert';
import net from 'node:net';
import { spawn } from 'node:child_process';
import WS from 'ws';

const SRV = 8092;
const ROOMS = +process.env.LOAD_ROOMS || 16;
const SPECS = +process.env.LOAD_SPECS || 8;      // per room, on top of the two players
const SECONDS = +process.env.LOAD_SECONDS || 6;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const kids = [];
const stop = () => { for (const k of kids) { try { k.kill(); } catch {} } };
const fail = e => { console.error('LOAD FAILED: ' + ((e && e.message) || e)); stop(); process.exit(1); };
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);
process.on('exit', stop);

const k = spawn(process.execPath, ['server.js'],
  { env: { ...process.env, PORT: String(SRV) }, stdio: ['ignore', 'ignore', 'pipe'] });
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

const base = 'http://127.0.0.1:' + SRV;
const health = async () => (await fetch(base + '/health')).json();
const room = async () => (await (await fetch(base + '/room', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ emptyMs: 1000, reserveMs: 500 }),
})).json()).id;

function open(id, role, record) {
  return new Promise((res, rej) => {
    const s = new WS(`ws://127.0.0.1:${SRV}/ws?room=${id}&role=${role}`);
    s.stamps = []; s.arrivals = []; s.dead = null;
    s.on('message', d => {
      const m = JSON.parse(d);
      if (m.type === 'welcome') return res(s);
      if (m.type === 'state' && record) { s.stamps.push(m.t); s.arrivals.push(Date.now()); }
    });
    s.on('close', () => { s.dead = true; res(s); });
    s.on('error', e => rej(new Error('connect failed: ' + e.message)));
  });
}

const gaps = xs => xs.slice(1).map((v, i) => v - xs[i]);
const med = xs => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : 0);
const r1 = v => Math.round(v * 10) / 10;

/* ---------- baseline: one room, nothing else happening ---------- */
const idle = await health();
const solo = await room();
const s1 = await open(solo, 'play', true), s2 = await open(solo, 'play', false);
await sleep(3000);
const baseCadence = med(gaps(s1.stamps));
s1.close(); s2.close();

/* ---------- load ---------- */
const sockets = [], sampled = [];
const t0 = Date.now();
for (let i = 0; i < ROOMS; i++) {
  const id = await room();
  const a = await open(id, 'play', true);          // one sampled client per room
  sockets.push(a, await open(id, 'play', false));
  sampled.push(a);
  for (let j = 0; j < SPECS; j++) sockets.push(await open(id, 'watch', false));
}
const connectMs = Date.now() - t0;
const peak = await health();
await sleep(SECONDS * 1000);
const under = await health();

const cadences = sampled.map(s => med(gaps(s.stamps)));
const loadCadence = med(cadences);
const counts = sampled.map(s => s.stamps.length);
const arrivalP95 = (() => {
  const g = sampled.flatMap(s => gaps(s.arrivals)).sort((a, b) => a - b);
  return g[Math.floor(g.length * 0.95)] ?? 0;
})();

console.log(`  ${ROOMS} rooms x ${SPECS + 2} sockets = ${sockets.length} connections in ${connectMs}ms`);
console.log(`  server cadence  idle ${r1(baseCadence)}ms -> loaded ${r1(loadCadence)}ms`);
console.log(`  snapshots per sampled client in ${SECONDS}s: min ${Math.min(...counts)} max ${Math.max(...counts)}`);
console.log(`  arrival p95 ${arrivalP95}ms   rss ${idle.rssMb} -> ${under.rssMb}MB   sockets ${under.sockets}`);

assert(!sockets.some(s => s.dead), 'the server dropped a connection under load');
assert(under.sockets === sockets.length,
  `server counts ${under.sockets} sockets, the test opened ${sockets.length}`);
assert(under.rooms === ROOMS, `server holds ${under.rooms} rooms, the test made ${ROOMS}`);

// The claim: the simulation loop does not stretch as rooms multiply. Compared against this same
// machine's idle cadence, never an absolute, because Node timers quantise to the platform clock.
assert(loadCadence <= baseCadence * 1.5 + 5,
  `snapshot cadence stretched under load: ${r1(loadCadence)}ms against ${r1(baseCadence)}ms idle`);
assert(Math.min(...counts) > SECONDS * 1000 / 40 * 0.55,
  `a client got only ${Math.min(...counts)} snapshots in ${SECONDS}s; the broadcast is falling behind`);
assert(arrivalP95 < 250, `snapshots arrived in bursts under load: p95 gap ${arrivalP95}ms`);

/* ---------- reclamation: the leak test ---------- */
for (const s of sockets) s.close();
await sleep(9000);                                  // a 1s no-player TTL plus a whole 5s sweep
const after = await health();
console.log(`  after disconnect + sweep: ${after.rooms} rooms, ${after.sockets} sockets, rss ${after.rssMb}MB`);
assert(after.sockets === 0, `${after.sockets} sockets still registered after everyone left`);
assert(after.rooms === 0, `${after.rooms} rooms survived the sweep; they are never coming back`);

console.log(`load ok — ${sockets.length} sockets, cadence ${r1(baseCadence)} -> ${r1(loadCadence)}ms, ` +
  `all rooms and sockets reclaimed`);
stop();
process.exit(0);
