// Unit test for the client's net math — the interpolation, clock tracking and ball extrapolation
// that a degraded network actually exercises. Exits 0 on success, 1 on the first failed assertion.
//
// The code under test lives inside the one inline <script> in client.html, fenced by /*<net>*/.
// Lifting it out with a regex and running it under node:vm keeps the page at two files with no
// build step and no second request, which is the whole premise of this repo.
// ponytail: if the fence ever gets awkward, make it a served module and import it properly.
import assert from 'node:assert';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const fail = e => { console.error('PREDICT FAILED: ' + ((e && e.message) || e)); process.exit(1); };
process.on('uncaughtException', fail);

const html = readFileSync(new URL('../client.html', import.meta.url), 'utf8');
const fence = html.match(/\/\*<net>\*\/([\s\S]*?)\/\*<\/net>\*\//);
assert(fence, 'the /*<net>*/ fence is gone from client.html — this test lifts the net math out of it');

// let/const inside a vm script do not become context properties, so the block hands back an
// accessor object as its completion value.
const api = vm.runInNewContext(fence[1] + `
;({
  trackClock, pushSnap, sample, ballAt, V,
  get sA() { return sA }, get sB() { return sB }, get su() { return su },
  get off() { return off }, get ballX() { return ballX }, get ballY() { return ballY },
  set rttMs(v) { rttMs = v }, set BUFFER(v) { BUFFER = v },
  reset(b) { buf = []; off = null; rttMs = 0; BUFFER = b; },
})`, vm.createContext({}));

const snap = (t, pa = 225, pb = 225, ball = { x: 400, y: 225, vx: 0, vy: 0 }) =>
  ({ type: 'state', t, ball, paddles: { a: pa, b: pb }, score: { a: 0, b: 0 }, status: 'play' });

// The rendered instant, in server time: what moment of the game the player is being shown.
const shown = () => api.sA.t + api.su * (api.sB.t - api.sA.t);

// The pre-fix algorithm, kept as a control. If the scenario below ever stops breaking THIS, the
// scenario has drifted and the assertion on the real sample() has quietly stopped proving anything.
function legacyShown(lbuf, now, BUF) {
  const rt = now - BUF;
  let i = lbuf.length - 1;
  while (i > 0 && lbuf[i].t > rt) i--;
  const a = lbuf[i].s, b = lbuf[i + 1] ? lbuf[i + 1].s : lbuf[i].s;
  const u = lbuf[i + 1] ? Math.max(0, Math.min(1, (rt - lbuf[i].t) / (lbuf[i + 1].t - lbuf[i].t || 1))) : 0;
  return a.t + u * (b.t - a.t);
}

const maxStep = xs => xs.slice(1).reduce((m, v, i) => Math.max(m, v - xs[i]), 0);
const minStep = xs => xs.slice(1).reduce((m, v, i) => Math.min(m, v - xs[i]), Infinity);

/* ---------- 1. a TCP stall-then-burst must not lurch the opponent's paddle ---------- */
// Seven snapshots arrive normally, then a lost segment stalls the next five — TCP delivers nothing
// until it is retransmitted — and all five land in the same millisecond.
const T0 = 1e6, A0 = 5000, STALL = 60, BUF = 200;
const legacy = [];
api.reset(BUF);
for (let k = 0; k < 7; k++) {
  const m = snap(T0 + 40 * k, 100 + 10 * k);
  api.pushSnap(m, A0 + 40 * k);
  legacy.push({ t: A0 + 40 * k, s: m });
}
const burstAt = A0 + 240 + 40 + STALL;
for (let j = 0; j < 5; j++) {
  const m = snap(T0 + 280 + 40 * j, 170 + 10 * j);
  api.pushSnap(m, burstAt);                      // every one of them, at the same instant
  legacy.push({ t: burstAt, s: m });
}

const real = [], ctl = [];
for (let now = burstAt; now <= burstAt + 220; now += 10) {
  api.sample(now);
  real.push(shown());
  ctl.push(legacyShown(legacy, now, BUF));
}

assert(minStep(real) >= 0, 'playback ran backwards through a burst: ' + JSON.stringify(real.slice(0, 6)));
assert(maxStep(real) <= 15,
  'playback lurched ' + maxStep(real).toFixed(0) + 'ms of game time in one 10ms frame; ' +
  'snapshots are being played on arrival time, not on m.t');
assert(real[real.length - 1] - real[0] > 100,
  'playback barely advanced across the burst: ' + (real[real.length - 1] - real[0]).toFixed(0) + 'ms');
assert(maxStep(ctl) > 100,
  'the control (pre-fix, arrival-time) algorithm no longer lurches on this scenario, so the ' +
  'assertions above prove nothing — the fixture needs rebuilding, not the code');

/* ---------- 2. the clock offset takes the fastest sample and ignores the slow ones ---------- */
api.reset(100);
api.trackClock(1000, 1100);                      // 100ms apparent offset
api.trackClock(1040, 1200);                      // a delayed sample at 160ms must not drag it up
assert(api.off < 101, 'a delayed sample moved the clock estimate: ' + api.off);
api.trackClock(1080, 1160);                      // a faster sample at 80ms is the better estimate
assert(Math.abs(api.off - 80) < 1e-9, 'a faster sample was not adopted: ' + api.off);
for (let k = 0; k < 100; k++) api.trackClock(1120 + 40 * k, 1200 + 40 * k + 500); // a long slow spell
assert(api.off > 80 && api.off < 90, 'clock drift tolerance is not tracking: ' + api.off);

/* ---------- 3. the ball is extrapolated, but never past the server's verdict ---------- */
api.reset(100);
const far = snap(2000, 225, 225, { x: 700, y: 225, vx: 1000, vy: 0 });
api.pushSnap(far, 2000);                         // off = 0
api.ballAt(far, 2200);                           // 200ms on: x would reach 900, well past B's face
assert(api.ballX === api.V.BX - api.V.R,
  'the ball ran past the paddle face ahead of the server verdict: ' + api.ballX);

api.reset(100);
const up = snap(3000, 225, 225, { x: 400, y: 20, vx: 0, vy: -200 });
api.pushSnap(up, 3000);
api.ballAt(up, 3200);                            // y would reach -20; the wall is at R = 7
assert(Math.abs(api.ballY - 34) < 1e-9, 'the ball did not bounce off the top wall: ' + api.ballY);

api.reset(100);
const still = snap(4000, 225, 225, { x: 400, y: 225, vx: 900, vy: 0 });
still.status = 'count';
api.pushSnap(still, 4000);
api.ballAt(still, 4500);
assert(api.ballX === 400, 'the ball was extrapolated while not in play: ' + api.ballX);

/* ---------- 4. extrapolation is bounded, so a dead connection freezes rather than flies ---------- */
api.reset(100);
const lost = snap(5000, 225, 225, { x: 100, y: 225, vx: 600, vy: 0 });
api.pushSnap(lost, 5000);
api.ballAt(lost, 5000 + 30e3);                   // 30 seconds with no snapshot at all
assert(api.ballX <= 100 + 600 * 0.25 + 1e-9,
  'extrapolation is unbounded; a stalled connection sends the ball off the field: ' + api.ballX);

console.log('predict ok — burst lurch: ' + maxStep(real).toFixed(1) + 'ms on the server timeline vs ' +
  maxStep(ctl).toFixed(1) + 'ms on arrival time');
process.exit(0);
