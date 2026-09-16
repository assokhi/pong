// Degraded-network system test. Boots the real server, puts scripts/netshape.mjs in front of it,
// and plays a real game through a link with latency, jitter and loss. Exits 0 / 1 for CI.
//
// What this asserts, and why it is not "the same game twice":
//
// The plan for this test was to run one seeded game clean and one impaired and assert an identical
// final score. That does not work, and the reason is worth writing down. The sim steps at 60 Hz off
// an accumulator while broadcast() samples it at 25 Hz off a separate timer, and the phase between
// those two timers is set by process start. Two runs therefore sample the same deterministic world
// at different tick offsets, so their snapshot streams differ even with an identical seed and no
// input at all. Exact determinism is real, but it is a property of the sim, so it is asserted where
// it can be observed exactly: in-process, in `node server.js --selftest`.
//
// What IS observable here is better, anyway. Every snapshot carries `t`, stamped server-side at
// broadcast. So this test can watch the same stream on two clocks at once: `t` says when the server
// produced a frame, arrival says when this client got it. Under impairment those two diverge
// sharply — arrival goes bursty while `t` stays a metronome — and that divergence is exactly the
// claim the whole architecture rests on: the authoritative timeline is not perturbed by how bad
// one client's network is.
import assert from 'node:assert';
import net from 'node:net';
import { spawn } from 'node:child_process';
import WS from 'ws';
import { replay, quant } from './netmath.mjs';

const SRV = 8090, PROXY = 9090;
const DELAY = 150, JITTER = 50, LOSS = 0.03;
const TOKEN = 'impaired-test-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kids = [];

const stop = () => { for (const k of kids) { try { k.kill(); } catch {} } };
const fail = e => {
  console.error('IMPAIRED FAILED: ' + ((e && e.message) || e));
  stop(); process.exit(1);
};
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);
process.on('exit', stop);

function boot(args, env, name) {
  const k = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  k.stderr.on('data', d => console.error(`[${name}] ${d}`));
  k.on('error', fail);
  kids.push(k);
  return k;
}

const portUp = (port, ms = 15000) => new Promise((res, rej) => {
  const end = Date.now() + ms;
  (function tick() {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); res(); });
    s.on('error', () => {
      s.destroy();
      if (Date.now() > end) return rej(new Error(`nothing listening on :${port} after ${ms}ms`));
      setTimeout(tick, 100);
    });
  })();
});

// Collects a client's view of a game: when each snapshot arrived, and when the server says it was
// made. Validates the world on every frame rather than only at the end.
function watch(port, id, role, token) {
  return new Promise((res, rej) => {
    const s = new WS(`ws://127.0.0.1:${port}/ws?room=${id}&role=${role}${token ? '&token=' + token : ''}`);
    s.arrivals = []; s.stamps = []; s.events = []; s.lag = null; s.last = null;
    s.welcome = null; s.bad = null;
    let score = -1;
    s.on('message', d => {
      const m = JSON.parse(d);
      if (m.type === 'welcome') { s.welcome = m; return res(s); }
      if (m.type === 'lag') { s.lag = m.ms; s.events.push({ at: Date.now(), m }); return; }
      if (m.type !== 'state') return;
      const at = Date.now();
      s.arrivals.push(at); s.stamps.push(m.t); s.events.push({ at, m }); s.last = m;
      if (!(m.ball.y >= 0 && m.ball.y <= 450)) s.bad = 'ball left the box vertically: ' + m.ball.y;
      if (!(m.ball.x >= -50 && m.ball.x <= 850)) s.bad = 'ball left the box horizontally: ' + m.ball.x;
      const tot = m.score.a * 100 + m.score.b;
      if (tot < score) s.bad = 'the score went backwards: ' + JSON.stringify(m.score);
      score = tot;
    });
    s.on('error', e => rej(new Error(`connect to :${port} failed: ${e.message}`)));
  });
}

const gaps = xs => xs.slice(1).map((v, i) => v - xs[i]);
const pick = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))];
// Absolute cadence numbers are a property of the host, not of this code: Node's timers quantise to
// the platform clock (~15.6ms on Windows), so a 40ms interval really lands near 47ms there. Every
// assertion below therefore compares the impaired run against the clean run on the same machine.
const r1 = v => Math.round(v * 10) / 10;   // simT gaps are exact DT multiples, so they print long
const stats = xs => ({ med: r1(pick(xs, 0.5)), p95: r1(pick(xs, 0.95)), max: r1(Math.max(...xs)), n: xs.length });
const show = s => `med ${s.med} p95 ${s.p95} max ${s.max} (n=${s.n})`;

const room = async seed => {
  const r = await fetch(`http://127.0.0.1:${SRV}/room`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seed }),
  });
  assert(r.status === 200, 'POST /room returned ' + r.status);
  return r.json();
};

/* ---------- boot ---------- */
// A short keepalive beat so RTT is resampled often enough to assert on inside the test window.
boot(['server.js'], { PORT: String(SRV), PONG_BEAT_MS: '1000', PONG_METRICS_TOKEN: TOKEN }, 'server');
boot(['scripts/netshape.mjs'], {
  PORT: String(PROXY), TARGET: String(SRV),
  DELAY_MS: String(DELAY), JITTER_MS: String(JITTER), LOSS: String(LOSS),
}, 'netshape');
await portUp(SRV); await portUp(PROXY);

/* ---------- baseline: the same game on a clean link ---------- */
const clean = await room(4242);
const ca = await watch(SRV, clean.id, 'play'), cb = await watch(SRV, clean.id, 'play');
assert(clean.seed === 4242, 'seed not honoured: ' + JSON.stringify(clean));
await sleep(5000);
assert(!ca.bad, 'clean run: ' + ca.bad);
const baseArrival = stats(gaps(ca.arrivals)), baseServer = stats(gaps(ca.stamps));
ca.close(); cb.close();

/* ---------- the impaired run ---------- */
const bad = await room(4242);
const a = await watch(PROXY, bad.id, 'play'), b = await watch(PROXY, bad.id, 'play');
assert(a.welcome.role === 'a' && b.welcome.role === 'b', 'slots through the proxy: ' + a.welcome.role);

// Play it: track the ball, the way a player would, so the input path is under load throughout.
const drive = setInterval(() => {
  if (!a.last) return;
  a.send(JSON.stringify({ type: 'input', y: a.last.ball.y }));
  b.send(JSON.stringify({ type: 'input', y: a.last.ball.y }));
}, 50);
await sleep(8000);
clearInterval(drive);

// Then a deterministic probe: park the paddle somewhere specific and see if it gets there. Whether
// a rally is won depends on how well a 150ms-stale ball position plays, which is a strategy
// question; whether a command arrives and is obeyed is the thing actually under test.
const TARGET_Y = 380;
const probe = setInterval(() => a.send(JSON.stringify({ type: 'input', y: TARGET_Y })), 50);
await sleep(2500);
clearInterval(probe);

assert(!a.bad, 'impaired run: ' + a.bad);
assert(!b.bad, 'impaired run (b): ' + b.bad);
assert(a.arrivals.length > 100, 'too few snapshots got through: ' + a.arrivals.length);

const arrival = stats(gaps(a.arrivals)), server = stats(gaps(a.stamps));

// The payoff question: would this stream have *looked* smooth? Replaying it through the real
// client math answers that without a browser — how far the drawn ball departed from
// velocity x frame time, in free flight, in virtual px. This is what a player means by "jittery".
const smooth = replay(a.events);
const jp95 = quant(smooth.jit, 0.95), jmax = quant(smooth.jit, 1);
const baseSmooth = replay(ca.events);

console.log(`  arrival  clean: ${show(baseArrival)}\n           bad:   ${show(arrival)}`);
console.log(`  server t clean: ${show(baseServer)}\n           bad:   ${show(server)}`);
console.log(`  ball jitter px  clean p95 ${quant(baseSmooth.jit, 0.95).toFixed(3)} ` +
  `max ${quant(baseSmooth.jit, 1).toFixed(3)} | bad p95 ${jp95.toFixed(3)} max ${jmax.toFixed(3)} ` +
  `(${smooth.jit.length} frames measured, ${smooth.clamped} excluded)`);
console.log(`  rtt ${a.lag}ms  score ${JSON.stringify(a.last.score)}  paddle ${a.last.paddles.a.toFixed(1)}`);

// 1. The harness genuinely impairs. Without this, a green run could mean the proxy did nothing.
assert(arrival.max > 200,
  'no burst ever appeared, so the proxy is not impairing anything: max arrival gap ' + arrival.max + 'ms');
assert(arrival.max > baseArrival.max * 2.5,
  `the impaired link is no burstier than the clean one: ${arrival.max}ms vs ${baseArrival.max}ms`);

// 2. The authority claim: arrivals went bursty, the server's own cadence did not move. What the
//    network did to this client never reached the simulation.
assert(Math.abs(server.med - baseServer.med) <= 10,
  `snapshot cadence shifted under a bad client link: ${server.med}ms vs ${baseServer.med}ms clean`);
assert(server.p95 <= baseServer.p95 * 1.5 + 20,
  `the server's broadcast timeline went bursty too: p95 ${server.p95}ms vs ${baseServer.p95}ms clean`);
// The sharp one: on the same stream, arrivals are many times burstier than the timeline they
// carry. Measured separation is roughly 8x against 1.4x.
assert(arrival.max / arrival.med > 4,
  `arrivals never went bursty: max ${arrival.max}ms on a ${arrival.med}ms median`);
assert(server.max / server.med < arrival.max / arrival.med / 2,
  `the server timeline is as bursty as its delivery (${(server.max / server.med).toFixed(1)}x vs ` +
  `${(arrival.max / arrival.med).toFixed(1)}x), so the client's link is reaching the simulation`);

// 2b. And it would have looked smooth. A bad link changes when frames arrive, never where the ball
//     is at a given instant, so extrapolation off an honestly-stamped snapshot stays continuous
//     through a burst. Sub-pixel here; ~5px if snapshots are stamped at broadcast instead of at the
//     simulation instant, which is the defect this number was added to catch.
assert(smooth.jit.length > 200, 'too few measurable frames to judge smoothness: ' + smooth.jit.length);
assert(jp95 < 1, `the ball would not have looked smooth: p95 ${jp95.toFixed(2)}px per frame`);
assert(jmax < 4, `worst drawn frame was ${jmax.toFixed(2)}px off a straight line`);

// 3. RTT is measured here, from a ping we stamped, so it reports the link and not a client's claim.
assert(a.lag > DELAY, 'RTT never measured the impairment: ' + a.lag + 'ms');
assert(a.lag < 4 * (DELAY + JITTER) + 400, 'RTT is implausible: ' + a.lag + 'ms');

// 4. The game ran and input survived the link.
assert(['count', 'play', 'over'].includes(a.last.status), 'the game never got going: ' + a.last.status);
assert(a.last.score.a + a.last.score.b > 0, 'nobody scored in 8s of impaired play');
assert(Math.abs(a.last.paddles.a - TARGET_Y) < 5,
  `input did not survive the link: paddle sat at ${a.last.paddles.a.toFixed(1)}, asked for ${TARGET_Y}`);

/* ---------- 5. the beta telemetry path, end to end and hostile ---------- */
// Everything here crosses a trust boundary on its way into an operator's log, so the test sends
// the shapes an attacker would and checks what came out the other side, not just that it was taken.
a.send(JSON.stringify({
  type: 'telemetry', ms: 15000,
  net: { rtt: 350, snaps: 200, gapMax: 'not a number', stalls: -3, gapMed: NaN },
  render: { fps: 60, jitP95: 0.1, jitMax: 1e12 },
  view: { w: 1920, h: 1080, dpr: 2 },
  note: 'x'.repeat(900),
  evil: { nested: 'must not survive' }, at: 'forged', room: 'forged', role: 'forged',
}));
await sleep(500);

assert((await fetch(`http://127.0.0.1:${SRV}/metrics`)).status === 404, '/metrics served without a token');
assert((await fetch(`http://127.0.0.1:${SRV}/metrics?token=nope`)).status === 404, '/metrics took a bad token');
const mres = await fetch(`http://127.0.0.1:${SRV}/metrics?token=${TOKEN}`);
assert(mres.status === 200, '/metrics refused the right token: ' + mres.status);
const { reports } = await mres.json();
const rec = reports[reports.length - 1];
assert(rec, 'the telemetry frame never reached /metrics');
assert(rec.net.rtt === 350 && rec.render.fps === 60, 'good values did not survive: ' + JSON.stringify(rec.net));
assert(rec.net.gapMax === 0 && rec.net.gapMed === 0, 'a non-number reached the log: ' + JSON.stringify(rec.net));
assert(rec.net.stalls === 0, 'a negative count was not clamped: ' + rec.net.stalls);
assert(rec.render.jitMax === 1e7, 'an absurd value was not clamped: ' + rec.render.jitMax);
assert(rec.note.length === 500, 'the note was not truncated: ' + rec.note.length);
assert(rec.evil === undefined, 'an unknown key was copied into the log');
assert(rec.room === bad.id && rec.role === 'a', 'a client forged its own identity: ' + rec.room + '/' + rec.role);
assert(rec.at !== 'forged' && !isNaN(Date.parse(rec.at)), 'a client forged the timestamp: ' + rec.at);
assert(typeof rec.ua === 'string', 'the user agent was not attached from the request headers');

console.log(`  telemetry ok — ${reports.length} report(s) via /metrics, unknown keys dropped, ` +
  `note truncated to ${rec.note.length}`);
console.log(`impaired ok — ${DELAY}+/-${JITTER}ms, ${LOSS * 100}% loss: arrivals burst to ` +
  `${arrival.max}ms, ball jitter p95 ${jp95.toFixed(2)}px, server cadence ${server.med}ms`);
stop();
process.exit(0);
