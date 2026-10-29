// Differential test against the REAL firmware mapper (6static/m25-remote mapper.cpp, compiled natively).
// Covers deadzone, curve, mode caps, low-battery cap, reverse cap, turn softening, ramp and rounding.
// The one intentional difference is steering sign: the firmware feeds vy = -joystick.x, so the JS mapper
// (positive vy = right turn) is given -vy. The firmware computes in float32, so a rare +-1 is tolerated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Mapper, defaultMapperConfig } from '../src/drive.js';

const S = JSON.parse(readFileSync(new URL('./fw_mapper_fuzz.json', import.meta.url)));
const MODES = ['stop', 'slow', 'normal', 'fast'];

test('mapper matches the firmware mapper (steering sign aside)', () => {
  let steps = 0, exact = 0, off1 = 0; const bad = [];
  for (const seq of S) {
    const [deadzone, curve, slow, normal, fast, lowbat, rampRate, reverseRatio, turnReduction] = seq.cfg;
    let t = seq.steps[0].t / 1000;
    const m = new Mapper({ ...defaultMapperConfig(), deadzone, curve, maxSpeed: { stop: 0, slow, normal, fast },
      maxSpeedLowBattery: lowbat, rampRate, reverseRatio, turnReduction }, () => t);
    for (const s of seq.steps) {
      t = s.t / 1000;
      m.setLowBatteryLimit(!!s.low);
      const f = m.map({ vx: s.vx, vy: -s.vy, deadman: !!s.deadman, mode: MODES[s.mode] });
      steps++;
      const dl = Math.abs(f.left - s.left), dr = Math.abs(f.right - s.right);
      if (dl === 0 && dr === 0) exact++;
      else if (dl <= 1 && dr <= 1) off1++;
      else bad.push({ cfg: seq.cfg, s, got: f });
    }
  }
  assert.equal(bad.length, 0, `${bad.length} steps differ by >1: ${JSON.stringify(bad[0])}`);
  assert.ok(off1 / steps < 0.01, `${off1} of ${steps} steps differ by 1 (float32 vs double)`);
  assert.ok(steps > 10000);
  console.log(`# ${steps} steps: ${exact} exact, ${off1} off by one`);
});
