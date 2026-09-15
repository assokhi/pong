// A TCP impairment proxy. Sits between a client and the game server and makes the link bad on
// purpose. Usage:
//
//   node server.js &
//   DELAY_MS=150 JITTER_MS=50 LOSS=0.03 node scripts/netshape.mjs
//   # then play on http://127.0.0.1:9080 instead of :8080
//
// Why a userspace proxy rather than `tc netem`: netem is Linux-only and needs root, so a CI
// failure could never be reproduced on the machine this game is developed on. What it buys in
// fidelity is small here, because of the one thing this file is really about:
//
//   THE TRANSPORT IS TCP, SO NOTHING IS EVER LOST ABOVE IT.
//
// A dropped segment is retransmitted. What the application sees is not a gap but a stall: the lost
// segment blocks every byte queued behind it for a retransmit timeout, and then the whole backlog
// arrives at once. That is head-of-line blocking, and it is the only thing "3% packet loss" means
// to a WebSocket. Modelling it is one line — the monotonic release clock in shape() — and once you
// have that, impairing bytes in userspace and impairing packets in the kernel look the same from
// inside the browser.
//
// ponytail: byte-level, so it cannot model congestion-window collapse or reordering (TCP would
// hide reordering anyway). Upgrade path if that fidelity is ever wanted: `tc qdisc add dev lo root
// netem delay 150ms 50ms loss 3%` in a Linux-only CI job.
import net from 'node:net';

const DELAY = +process.env.DELAY_MS || 0;    // one-way base latency
const JITTER = +process.env.JITTER_MS || 0;  // +/- variation on top of it
const LOSS = +process.env.LOSS || 0;         // 0..1, chance a chunk is "lost" and waits for an RTO
const RTO = +process.env.RTO_MS || 200;      // retransmit timeout a lost chunk costs
const PORT = +process.env.PORT || 9080;
const TARGET = +process.env.TARGET || 8080;
const HOST = process.env.TARGET_HOST || '127.0.0.1';

// One FIFO queue per direction, drained by a single timer. The queue is what guarantees order, and
// order is the whole point: a proxy that can reorder bytes is not modelling TCP, it is corrupting
// the stream. Handing each chunk its own setTimeout is not good enough — two chunks clamped to the
// same release instant get different *delay* values, land in different timer buckets, and can fire
// out of insertion order. That shows up as a torn HTTP handshake, not as a slow one.
function shape(from, to) {
  const q = [];
  let releaseAt = 0, timer = null;
  const drain = () => {
    timer = null;
    const now = Date.now();
    while (q.length && q[0].at <= now) to.write(q.shift().chunk);
    if (q.length) timer = setTimeout(drain, Math.max(1, q[0].at - Date.now()));
  };
  from.on('data', chunk => {
    let at = Date.now() + DELAY + (Math.random() * 2 - 1) * JITTER;
    if (Math.random() < LOSS) at += RTO;
    // The line that makes this TCP and not UDP: a delayed chunk can never be overtaken, so one
    // stalled chunk holds back everything behind it until the backlog drains in a burst. It also
    // keeps q sorted by `at`, which is what lets a single head-of-queue timer be correct.
    releaseAt = at = Math.max(releaseAt, at);
    q.push({ chunk, at });
    if (!timer) timer = setTimeout(drain, Math.max(1, at - Date.now()));
  });
  // Let the queue drain before passing the close on, or the tail of the stream is lost for real.
  from.on('close', () => setTimeout(() => to.end(), Math.max(0, releaseAt - Date.now()) + 20));
  from.on('error', () => {});
}

const server = net.createServer(down => {
  const up = net.connect(TARGET, HOST);
  down.on('error', () => {}); up.on('error', () => {});
  shape(down, up); shape(up, down);
});

server.listen(PORT, () => console.log(
  `netshape :${PORT} -> ${HOST}:${TARGET}  delay=${DELAY}+/-${JITTER}ms loss=${LOSS} rto=${RTO}ms`));

process.on('SIGTERM', () => server.close(() => process.exit(0)));
