// Lifts the /*<net>*/ block out of client.html and runs it under node:vm, so tests exercise the
// code the browser actually ships rather than a second copy of it that can drift.
//
// The page stays two files with no build step, which is the premise of this repo. let/const inside
// a vm script do not become context properties, so the block hands back an accessor object as its
// completion value.
// ponytail: if the fence ever gets awkward, make it a served module and import it properly.
import vm from 'node:vm';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

export function loadNetMath() {
  const html = readFileSync(new URL('../client.html', import.meta.url), 'utf8');
  const fence = html.match(/\/\*<net>\*\/([\s\S]*?)\/\*<\/net>\*\//);
  assert(fence, 'the /*<net>*/ fence is gone from client.html — the net-math tests lift it from there');
  return vm.runInNewContext(fence[1] + `
;({
  trackClock, pushSnap, sample, ballAt, slew, setRtt, V,
  get sA() { return sA }, get sB() { return sB }, get su() { return su },
  get off() { return off }, get offTarget() { return offTarget },
  get rttMs() { return rttMs }, set rttMs(v) { rttMs = v },
  get ballX() { return ballX }, get ballY() { return ballY },
  get ballAge() { return ballAge }, get jitterPx() { return jitterPx },
  get newest() { return buf[buf.length - 1] }, get bufLen() { return buf.length },
  set BUFFER(v) { BUFFER = v },
  reset(b) {
    buf = []; offs = []; off = null; offTarget = null;
    rttMs = 0; rttTarget = 0; rttSeen = false;
    pClean = false; jitterPx = -1; ballAge = 0;
    BUFFER = b === undefined ? 100 : b;
  },
})`, vm.createContext({}));
}

// Replays a captured session through the real client math at a fixed frame rate and reports how
// smoothly the ball would have been drawn. `events` are {at, m} in arrival order, m being a `state`
// or `lag` frame exactly as it came off the wire.
export function replay(events, fps = 60) {
  const api = loadNetMath();
  api.reset(100);
  const step = 1000 / fps;
  const first = events[0].at, last = events[events.length - 1].at;
  const jit = [];
  let i = 0, frames = 0, clamped = 0;

  for (let now = first; now <= last; now += step) {
    while (i < events.length && events[i].at <= now) {
      const e = events[i++];
      if (e.m.type === 'state') api.pushSnap(e.m, e.at);
      else if (e.m.type === 'lag') api.setRtt(e.m.ms);
    }
    if (!api.bufLen) continue;
    api.slew(step);
    api.sample(now);
    api.ballAt(api.newest, now);
    frames++;
    if (api.jitterPx >= 0) jit.push(api.jitterPx); else clamped++;
  }
  return { jit, frames, clamped };
}

export const quant = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
