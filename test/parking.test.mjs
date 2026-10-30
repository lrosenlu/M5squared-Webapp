import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parkingDryRun } from '../src/parking.js';

const V = JSON.parse(readFileSync(new URL('./parking_vectors.json', import.meta.url)));
const hexb = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
// Same IV formula as tools/gen_parking_vectors.py, drawn in call order (left then right for each exchange).
const ivOf = (n) => Uint8Array.from({ length: 16 }, (_, i) => (n * 37 + i * 11 + 5) & 255);

test('m25_parking.py --dry-run output is byte-identical (40 random runs)', () => {
  for (const c of V) {
    let n = 0;
    const out = parkingDryRun({ leftKey: hexb(c.lk), rightKey: hexb(c.rk), speed: c.speed, leftSpeed: c.ls, rightSpeed: c.rs, durationMs: c.dur, ivFor: () => ivOf(n++) });
    assert.equal(out, c.out, JSON.stringify({ ...c, out: undefined }));
  }
});
