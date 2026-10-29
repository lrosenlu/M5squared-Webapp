// Differential test of the whole Mapper pipeline against the UPSTREAM Python mapper, using a fake clock.
// The ONLY intentional difference is steering sign (upstream: left = vx - vy; here: positive vy = right turn),
// so the test feeds the JS mapper -vy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Mapper, defaultMapperConfig } from '../src/drive.js';

const S = JSON.parse(readFileSync(new URL('./mapper_fuzz.json', import.meta.url)));

test('mapper: deadzone, curve, caps, normalisation and ramp match upstream (steering sign aside)', () => {
  let steps = 0, ties = 0, diffs = [];
  for (const seq of S) {
    let t = seq[0].t;
    const m = new Mapper(defaultMapperConfig(), () => t);
    for (const s of seq) {
      t = s.t; // identical absolute timestamps => identical float arithmetic
      const f = m.map({ vx: s.vx, vy: -s.vy, deadman: s.deadman, mode: s.mode });
      steps++;
      // Python rounds half-to-even and uses sub-ms time steps; the JS mapper follows the firmware (half-away rounding,
      // whole-ms ramp steps). That gives small +-1 (rarely +-2, compounded through the ramp) differences on a few steps.
      if (Math.abs(f.left - s.left) > 2 || Math.abs(f.right - s.right) > 2) diffs.push({ s, got: f });
      else if (f.left !== s.left || f.right !== s.right) ties++;
    }
  }
  // Python rounds half-to-even, JS half-up; with random dt an exact .5 is essentially impossible.
  assert.equal(diffs.length, 0, `${diffs.length}/${steps} differ, first: ${JSON.stringify(diffs[0])}`);
  assert.ok(ties / steps < 0.05, `${ties} rounding-tie steps`);
  assert.ok(steps > 8000);
});
