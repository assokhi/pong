// Unit test for the client's net math — the interpolation, clock tracking and ball extrapolation
// that a degraded network actually exercises. Exits 0 on success, 1 on the first failed assertion.
//
// The code under test lives inside the one inline <script> in client.html, fenced by /*<net>*/.
// Lifting it out with a regex and running it under node:vm keeps the page at two files with no
// build step and no second request, which is the whole premise of this repo.
// ponytail: if the fence ever gets awkward, make it a served module and import it properly.
import assert from 'node:assert';
import { loadNetMath, replay, quant } from './netmath.mjs';

const fail = e => { console.error('PREDICT FAILED: ' + ((e && e.message) || e)); process.exit(1); };
process.on('uncaughtException', fail);

const api = loadNetMath();

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

/* ---------- 2. the clock estimate takes the fastest sample, and is never applied as a jump ---- */
api.reset(100);
api.trackClock(1000, 1100);                      // cold start: adopt it, nothing to be smooth against
assert(Math.abs(api.off - 100) < 1e-9, 'cold start did not adopt the first offset: ' + api.off);
api.trackClock(1040, 1200);                      // a delayed sample at 160ms is not a better estimate
assert(Math.abs(api.offTarget - 100) < 1e-9, 'a delayed sample moved the estimate: ' + api.offTarget);
api.trackClock(1080, 1160);                      // a faster sample at 80ms is
assert(Math.abs(api.offTarget - 80) < 1e-9, 'a faster sample was not taken as the target: ' + api.offTarget);
assert(Math.abs(api.off - 100) < 1e-9, 'the offset was applied as a jump: ' + api.off);

// It has to get there, and it must never get there fast: a step in the offset moves the entire
// extrapolated world at once, which is the jitter this whole mechanism exists to avoid.
let steps = 0;
while (Math.abs(api.off - api.offTarget) > 1e-9 && steps++ < 10000) {
  const was = api.off;
  api.slew(1000 / 60);
  assert(Math.abs(api.off - was) <= 0.25 + 1e-9,
    'a clock correction moved ' + Math.abs(api.off - was).toFixed(3) + 'ms in a single frame');
}
assert(steps > 40 && steps < 120, 'a 20ms correction took ' + steps + ' frames, expected ~80');

// An old minimum must eventually fall out of the window, or one lucky early packet pins the
// estimate for the life of the session and a server clock change can never be followed.
for (let k = 0; k < 64; k++) api.trackClock(2000 + 40 * k, 2130 + 40 * k);
assert(Math.abs(api.offTarget - 130) < 1e-9, 'the window never forgot an old minimum: ' + api.offTarget);

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

/* ---------- 5. the drawn ball is smooth, and stops being smooth if snapshots lie ---------- */
// A snapshot says "the ball was here at t". If the server stamps t at broadcast rather than at the
// simulation instant, the position is from up to a step earlier — by a different amount each time,
// because the broadcast timer and the sim accumulator have no fixed phase. Clients extrapolate
// from t, so that lands on the ball directly. This is the bug players report as "it jitters".
// One rally, staying inside the field the whole way: a ball that leaves it is all bounces and
// clamps, and those frames are excluded by design, so such a fixture measures nothing.
function rally(phaseMs, vx, vy, x0, y0, secs) {
  const T0 = 1e6, ev = [];
  // The real phase error is the sim accumulator's remainder, which is independent snapshot to
  // snapshot. Seeded so the fixture is reproducible, but genuinely mixed: a sequence that merely
  // creeps would put its jumps below p95 and the test would pass while measuring nothing.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let k = 0; k < Math.floor(secs * 25); k++) {
    const t = T0 + 40 * k;
    const lag = phaseMs ? rnd() * phaseMs : 0;
    const tau = 40 * k - lag;                    // the instant this position is really from
    ev.push({ at: t, m: {
      type: 'state', status: 'play', t,
      ball: { x: x0 + vx * tau / 1000, y: y0 + vy * tau / 1000, vx, vy },
      paddles: { a: 225, b: 225 }, score: { a: 0, b: 0 },
    } });
  }
  return ev;
}

const RALLIES = [[450, 150, 60, 100, 1.5], [-450, -150, 730, 340, 1.4],
                 [380, -120, 70, 400, 1.6], [-500, 90, 740, 60, 1.3]];
const smoothness = phaseMs =>
  RALLIES.flatMap(([vx, vy, x0, y0, s]) => replay(rally(phaseMs, vx, vy, x0, y0, s)).jit);

const honest = smoothness(0);
const lying = smoothness(20);                // one sim step of wall-clock stamping error
const hp95 = quant(honest, 0.95), hmax = quant(honest, 1), lp95 = quant(lying, 0.95);
assert(honest.length > 200, 'the smoothness fixture produced almost no measurable frames: ' + honest.length);
assert(hp95 < 1, 'the drawn ball is not smooth on a truthful stream: p95 ' + hp95.toFixed(2) + 'px per frame');
assert(hmax < 3, 'worst frame on a truthful stream: ' + hmax.toFixed(2) + 'px');
assert(lp95 > 5,
  'a stream whose positions do not match their own timestamps now renders smoothly (p95 ' +
  lp95.toFixed(2) + 'px), so this fixture has stopped detecting the bug it exists for');

console.log('predict ok — burst lurch ' + maxStep(real).toFixed(1) + 'ms vs ' +
  maxStep(ctl).toFixed(1) + 'ms pre-fix; ball jitter p95 ' + hp95.toFixed(2) +
  'px vs ' + lp95.toFixed(2) + 'px if snapshots mis-stamp by a sim step');
process.exit(0);
