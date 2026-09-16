// Parse-check client.html, and read the shader as pedantically as a compiler would if one were
// available. The page is one inline <script>, so nothing else in the pipeline ever looks at it:
// `node --check` covers server.js, and the smoke test only asserts the served page contains
// "<canvas" — which stays true when the script underneath it is broken.
//
// That gap shipped. A `git stash pop` left conflict markers in the file, they were committed, CI
// went green, and main auto-deployed a client.html whose first statement was a SyntaxError. The
// whole game was a blank page and every test still passed.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../client.html', import.meta.url), 'utf8');
const die = m => { console.error('CLIENT CHECK FAILED: ' + m); process.exit(1); };

// Cheap and specific, because this is the failure that actually happened and its real error
// message ("Unexpected token '<<'") points nowhere useful.
const lines = html.split('\n');
const marker = lines.findIndex(l => /^(<{7}|={7}|>{7})( |$)/.test(l));
if (marker >= 0) die(`unresolved merge conflict marker at line ${marker + 1}: ${lines[marker]}`);

const block = html.match(/<script>([\s\S]*?)<\/script>/);
if (!block) die('no inline <script> block — the whole client lives in one');
const js = block[1];

try {
  new vm.Script(js, { filename: 'client.html' });   // parse only, never run: there is no DOM here
} catch (e) {
  die(`client.html does not parse: ${e.message}`);
}

if (!/\/\*<net>\*\/[\s\S]*\/\*<\/net>\*\//.test(html)) die('the /*<net>*/ fence is gone; the net-math tests lift it from there');
if (!html.includes('<canvas')) die('no <canvas> in the page');

// Every id the script reaches for has to exist in the markup, or the page dies on first paint
// with a null dereference that no parser would catch.
for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) {
  if (!new RegExp(`id=["']?${m[1]}["']?[\\s>]`).test(html)) die(`script wants #${m[1]}, which the markup does not define`);
}

// The shader cannot be compiled without a GPU, and CI has none, so what a compiler would have
// caught gets checked structurally instead. This is the only code here that ships unexecuted by
// any test, which is exactly why it earns the most pedantic reading.
const shaderSrc = name => {
  const m = js.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`'));
  if (!m) die(`shader ${name} not found`);
  return m[1];
};
const vs = shaderSrc('VS'), fs = shaderSrc('FS');

for (const [name, src] of [['VS', vs], ['FS', fs]]) {
  // #version must be the first token of a GLSL ES 3.00 unit; even a leading newline is fatal.
  if (!src.startsWith('#version 300 es')) die(`${name} does not open with "#version 300 es"`);
  for (const [open, close] of [['{', '}'], ['(', ')']]) {
    const a = src.split(open).length - 1, b = src.split(close).length - 1;
    if (a !== b) die(`${name} has ${a} of "${open}" against ${b} of "${close}"`);
  }
  // GLSL ES has no implicit int->float conversion, and this is the easiest way to get it wrong.
  const bad = src.match(/\bfloat\s+\w+\s*=\s*-?\d+\s*[;,]/);
  if (bad) die(`${name}: "${bad[0].trim()}" assigns an int to a float — GLSL ES will not convert it`);
}
if (!/precision\s+\w+\s+float;/.test(fs)) die('FS declares no float precision');
if (!/\bout\s+vec4\s+\w+\s*;/.test(fs)) die('FS declares no "out vec4"');

// A uniform the JS reaches for but no shader declares resolves to null, and every write to it is
// then a silent no-op — the shape it controls renders with whatever the driver left behind.
const listed = js.match(/for \(const n of \[([^\]]+)\]\) glU\[n\]/);
if (!listed) die('could not find the uniform lookup list');
const names = listed[1].match(/'([^']+)'/g).map(x => x.slice(1, -1));
for (const n of names) {
  if (!new RegExp(`uniform\\s+\\w+\\s+${n}\\s*;`).test(vs + fs)) die(`JS looks up uniform ${n}, which no shader declares`);
}
for (const m of js.matchAll(/glU\.(\w+)/g)) {
  if (!names.includes(m[1])) die(`glU.${m[1]} is written but never looked up`);
}
// And the reverse: a declared uniform nobody sets is dead weight the linker may strip, which then
// makes the lookup above return null.
for (const m of (vs + fs).matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)) {
  if (!names.includes(m[1])) die(`shader declares uniform ${m[1]}, which the JS never sets`);
}

console.log(`client ok — ${js.split('\n').length} lines of script, ${names.length} uniforms matched across VS/FS`);
