// Repo hygiene gate: no merge artifact may be committed, anywhere.
//
// This exists because one already was. A `git stash pop` conflicted, the markers were committed
// into client.html, CI went green, and main auto-deployed a page whose first statement was a
// SyntaxError. scripts/checkclient.mjs now catches that specific file; this catches the rest of
// the repo, because next time it will be a different file.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const die = m => { console.error('REPO CHECK FAILED: ' + m); process.exit(1); };

let files;
try {
  files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 32e6 })
    .split('\0').filter(Boolean);
} catch (e) {
  die('could not list tracked files: ' + e.message);
}

// Markers only count at the start of a line, which is where git writes them. Anywhere else they
// are ordinary text — this very file talks about them.
const MARKER = /^(<{7}|={7}|>{7})( |$)/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp3|wav|pdf|zip|gz)$/i;
let scanned = 0;
const bad = [];

for (const f of files) {
  if (BINARY.test(f)) continue;
  let text;
  try {
    if (statSync(f).size > 4e6) continue;          // a multi-MB text file is not hand-merged
    text = readFileSync(f, 'utf8');
  } catch { continue; }                            // deleted, or not readable as text
  if (text.includes('\0')) continue;               // binary that slipped the extension list
  scanned++;
  text.split('\n').forEach((line, i) => {
    if (MARKER.test(line)) bad.push(`${f}:${i + 1}: ${line.slice(0, 60)}`);
  });
}

// One more thing git leaves behind that parses fine and is never intended.
for (const f of files) {
  if (/\.(orig|rej|BACKUP|BASE|LOCAL|REMOTE)$/.test(f) || /\.(orig|rej)\./.test(f)) {
    bad.push(`${f}: merge leftover file is tracked`);
  }
}

if (bad.length) die(`unresolved merge artifacts:\n  ` + bad.join('\n  '));
console.log(`repo ok — ${scanned} tracked text files, no merge artifacts`);
