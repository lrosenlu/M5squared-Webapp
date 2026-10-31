// Repo-integrity checks: shell cache list, tracked junk, private identifiers, module loading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), 'utf8');
const tracked = () => { try { return execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return null; } };

test('sw.js SHELL lists only existing files and covers every src/vendor file', () => {
  const sw = read('sw.js');
  const shell = [...sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const f of shell) if (f !== './') assert.ok(existsSync(join(root, f)), `missing ${f}`);
  const need = [];
  for (const d of ['src', 'src/ui', 'vendor']) for (const f of readdirSync(join(root, d))) if (f.endsWith('.js')) need.push(`${d}/${f}`);
  for (const f of need) assert.ok(shell.includes(f), `not cached: ${f}`);
  assert.match(sw, /const VERSION = 'm5sq-v\d+'/);
});

test('deploy workflow publishes everything the app loads', () => {
  const wf = read('.github/workflows/pages.yml');
  for (const p of ['index.html', 'style.css', 'manifest.webmanifest', 'sw.js', 'icons', 'src', 'vendor', 'LICENSE']) assert.ok(wf.includes(p), p);
});

test('no junk or private identifiers are tracked', () => {
  const files = tracked();
  if (!files) return; // not a git checkout
  assert.deepEqual(files.filter((f) => /\.(zip|pyc)$|__pycache__/.test(f)), []);
  const bad = [];
  for (const f of files) {
    if (!/\.(js|mjs|json|py|md|html|yml|webmanifest)$/.test(f)) continue;
    if (/M25V2_00A0503833C6|M25V2_00A05050C94B/.test(read(f))) bad.push(f);
  }
  assert.deepEqual(bad, []);
});

test('licence files and vendored library notice are present', () => {
  for (const f of ['LICENSE', 'NOTICE.md', 'README.md']) assert.ok(existsSync(join(root, f)), f);
  assert.match(read('NOTICE.md'), /jsQR/i);
});

test('pure modules import cleanly', async () => {
  for (const m of ['aes', 'crc', 'packets', 'session', 'drive', 'ble', 'parking', 'analyzer', 'packettool']) {
    if (existsSync(join(root, `src/${m}.js`))) await import(`../src/${m}.js`);
  }
});
