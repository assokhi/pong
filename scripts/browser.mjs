// The only gate that runs the client the way a player does: a real browser, a real GPU driver
// (SwiftShader in CI), real WebGL.
//
// Everything else here talks to the server over a socket and never loads the page, which is how a
// client.html that did not parse once sailed through a green pipeline and deployed. scripts/
// checkclient.mjs closed the parse hole, but a shader is not a parse problem: GLSL that is
// perfectly well-formed can still fail to compile on a driver, and nothing short of a driver can
// say so. This is also the only place the two halves are exercised together end to end.
import assert from 'node:assert';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const SRV = 8093;
const base = 'http://127.0.0.1:' + SRV;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kids = [];
let browser = null;
const stop = () => { for (const k of kids) { try { k.kill(); } catch {} } };
const fail = async e => {
  console.error('BROWSER FAILED: ' + ((e && e.message) || e));
  if (browser) await browser.close().catch(() => {});
  stop(); process.exit(1);
};
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

// SwiftShader is how a CI box without a GPU still compiles real GLSL; recent Chrome wants it
// asked for by name.
browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 } });

const problems = [];
function watch(page, who) {
  page.on('pageerror', e => problems.push(`${who}: uncaught ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') problems.push(`${who}: console.error ${m.text()}`);
    // the client console.warns exactly once, and only when a shader refuses to build
    if (m.type() === 'warning' && m.text().includes('pong:')) problems.push(`${who}: ${m.text()}`);
  });
}

/* ---------- 1. the landing page makes a room ---------- */
const a = await ctx.newPage();
watch(a, 'A');
await a.goto(base, { waitUntil: 'load' });
await a.click('#mk');
await a.waitForURL(/\/r\/[\w-]{8}$/, { timeout: 15000 });
const url = a.url();

/* ---------- 2. the renderer came up on a real driver ---------- */
// This is the assertion the whole file exists for. glProg is non-null only if both shaders
// compiled and the program linked.
await a.waitForFunction(() => typeof glProg !== 'undefined' && glProg !== null, null, { timeout: 15000 })
  .catch(async () => {
    const why = await a.evaluate(() => ({ gl: typeof gl === 'undefined' ? 'undefined' : String(gl), ctx2d: String(ctx) }));
    throw new Error(`WebGL2 never initialised: gl=${why.gl} ctx=${why.ctx2d} — the 2D fallback took over`);
  });
const renderer = await a.evaluate(() => {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});

/* ---------- 3. two players, one game ---------- */
const b = await ctx.newPage();
watch(b, 'B');
await b.goto(url, { waitUntil: 'load' });
for (const p of [a, b]) {
  await p.waitForSelector('#bp', { timeout: 15000 });
  await p.click('#bp');
}
for (const p of [a, b]) {
  await p.waitForFunction(() => typeof role !== 'undefined' && role !== null, null, { timeout: 15000 });
}
assert(await a.evaluate(() => role) !== await b.evaluate(() => role), 'both browsers were given the same paddle');
await a.waitForFunction(() => buf.length && ['count', 'play'].includes(buf[buf.length - 1].status),
  null, { timeout: 15000 });
await a.waitForFunction(() => buf[buf.length - 1].status === 'play', null, { timeout: 15000 });

/* ---------- 4. the field is lit, and it is moving ---------- */
// The centre line and its halo are drawn every frame whatever the ball is doing, so a column
// through the middle is the one place guaranteed to be non-black if the shader ran at all.
const lit = await a.evaluate(async () => {
  let best = 0;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const px = new Uint8Array(4 * 64);
    gl.readPixels(Math.floor(cv.width / 2) - 1, Math.floor(cv.height / 2) - 32, 2, 32,
                  gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let j = 0; j < px.length; j += 4) best = Math.max(best, px[j] + px[j + 1] + px[j + 2]);
  }
  return best;
});
assert(lit > 12, `the canvas is black down the centre line (brightest sample ${lit}/765) — the shader linked but drew nothing`);

// Frames are actually landing, and the paddle answers the mouse. Doing both at once is not just
// economy: with nothing driving a paddle, the only thing moving in the clipped band is the ball,
// and two frames taken while it is elsewhere are identical through no fault of the renderer.
const clip = { x: 0, y: 200, width: 1000, height: 240 };
const startY = await a.evaluate(() => myY);
const shots = [];
for (let i = 0; i < 6; i++) {
  await a.mouse.move(500, 180 + (i % 2) * 260);   // drag the paddle across its range
  shots.push(await a.screenshot({ clip }));
  await sleep(220);
}
const distinct = new Set(shots.map(s => s.toString('base64'))).size;
assert(distinct >= 4, `the playfield only produced ${distinct} distinct frames in 1.3s — rendering is stalled`);

// The input path, end to end through a real browser: mousemove -> predicted paddle -> socket ->
// the server's own record of where that paddle is.
const movedTo = await a.evaluate(() => myY);
assert(Math.abs(movedTo - startY) > 20, `the paddle ignored the mouse: ${startY} -> ${movedTo}`);
const mine = await a.evaluate(() => role);
await a.waitForFunction(m => Math.abs(buf[buf.length - 1].paddles[m] - myY) < 25, mine, { timeout: 6000 })
  .catch(async () => {
    const [srv, local] = await a.evaluate(m => [buf[buf.length - 1].paddles[m], myY], mine);
    throw new Error(`the server never caught up to the browser's paddle: server ${srv}, browser ${local}`);
  });

/* ---------- 5. the HUD is wired to the game ---------- */
const score = await a.textContent('#score');
assert(/\d/.test(score), 'the score element never rendered a number: ' + JSON.stringify(score));
await a.waitForFunction(() => {
  const st = getComputedStyle(document.getElementById('stage'));
  return parseFloat(st.width) > 100 && parseFloat(st.fontSize) > 8;
}, null, { timeout: 5000 }).catch(() => { throw new Error('#stage was never laid over the field'); });
// textContent is the source text; the uppercasing is CSS and never reaches it.
const label = await a.textContent('#frole');
assert(/player [ab]/i.test(label), 'the role label never updated: ' + JSON.stringify(label));

/* ---------- 6. it survives a resize ---------- */
await a.setViewportSize({ width: 520, height: 900 });   // portrait phone: the letterbox flips
await sleep(400);
assert(await a.evaluate(() => cv.width > 0 && cv.height > 0), 'the canvas collapsed on resize');
assert(await a.evaluate(() => parseFloat(getComputedStyle(document.getElementById('stage')).width) > 50),
  'the HUD did not follow the field through a resize');

if (problems.length) throw new Error('the page reported problems:\n  ' + problems.join('\n  '));

console.log(`browser ok — WebGL2 on "${renderer}", shader linked, ${distinct}/6 distinct frames, ` +
  `centre line at ${lit}/765, HUD wired, survived a resize`);
await browser.close();
stop();
process.exit(0);
