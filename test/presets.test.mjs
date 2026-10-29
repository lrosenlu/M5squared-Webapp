import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS, SLOPE_VALUES, SPEED_BIAS_VALUES } from '../src/presets.js';
import { validateProfileParams, PacketBuilder, SPEED_RAW } from '../src/packets.js';
import { MockWheel, WheelSession } from '../src/session.js';

const ref = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url)));
const F = (a) => ({ maxTorque: a.max_torque, maxSpeedRaw: a.max_speed, pFactor: a.p_factor, speedBias: a.speed_bias,
  speedFactor: a.speed_factor, rotationThreshold: a.rotation_threshold, slopeInc: a.slope_inc, slopeDec: a.slope_dec });

test('presets equal upstream m25_ecs_driveprofiles.PROFILES', () => {
  assert.deepEqual(PRESETS, ref.profiles);
  assert.deepEqual(SLOPE_VALUES, ref.slope); assert.deepEqual(SPEED_BIAS_VALUES, ref.bias); assert.deepEqual(SPEED_RAW, ref.speeds);
});

test('every preset level passes validation', () => {
  for (const [n, pr] of Object.entries(PRESETS)) for (const l of ['level_1', 'level_2']) assert.equal(validateProfileParams(F(pr[l])), '', `${n} ${l}`);
});

test('validation rejects out-of-range values', () => {
  const ok = F(PRESETS.Standard.level_1);
  assert.ok(validateProfileParams({ ...ok, maxTorque: 5 }));
  assert.ok(validateProfileParams({ ...ok, maxTorque: 101 }));
  assert.ok(validateProfileParams({ ...ok, pFactor: 1000 }));
  assert.ok(validateProfileParams({ ...ok, speedBias: 25 }));
  assert.ok(validateProfileParams({ ...ok, slopeInc: 30 }));
  assert.ok(validateProfileParams({ ...ok, maxSpeedRaw: 1000 }));
  assert.ok(validateProfileParams({ ...ok, rotationThreshold: 0 }));
});

test('write packet matches upstream layout (assist level, torque, speed hi/lo, p hi/lo, bias, factor, rot, inc, dec)', () => {
  const p = F(PRESETS.Active.level_2);
  const pkt = new PacketBuilder().writeProfileParams(1, p);
  assert.deepEqual(Array.from(pkt.slice(6)), [1, 90, 2361 >> 8, 2361 & 255, 0, 5, 20, 11, 2, 70, 28]);
});

test('verified write round-trips on the mock and respects the 6 km/h tier', async () => {
  const w = new MockWheel('left'); await w.connect();
  const s = new WheelSession('left', w, { commandDelayMs: 0 });
  const p = F(PRESETS.Active.level_2);
  let r = await s.writeProfileParamsVerified(1, p, { allowAboveStandardTier: false });
  assert.equal(r.after.maxSpeedRaw, 1667);
  r = await s.writeProfileParamsVerified(1, p, { allowAboveStandardTier: true });
  assert.ok(r.ok); assert.equal(r.after.maxSpeedRaw, 2361); assert.equal(r.after.slopeInc, 70);
  const bad = await s.writeProfileParamsVerified(1, { ...p, maxTorque: 5 });
  assert.equal(bad.ok, false);
});
