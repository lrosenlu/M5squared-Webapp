import test from 'node:test';
import assert from 'node:assert/strict';
import { WheelSession, MockWheel } from '../src/session.js';
import { parseSWVersion, nearestRaw, selectableKmh } from '../src/packets.js';

const mk = async (o = {}) => {
  const w = new MockWheel('Left'); await w.connect();
  return { w, s: new WheelSession('left', w, { retries: 1, commandDelayMs: 0, replyTimeoutMs: 100, ...o }) };
};

test('readStatus reads everything', async () => {
  const { s } = await mk();
  const st = await s.readStatus();
  assert.equal(st.battery, 85); assert.equal(st.assistLevel, 0); assert.equal(st.profile, 1);
  assert.equal(st.driveMode.autoHold, false);
  assert.equal(st.params.maxSpeedRaw, 0x0683);
  assert.equal(st.firmware.text, 'V03.005.000');
  assert.equal(st.duo.mounting, 'Left');
  assert.ok(st.hasData);
});

test('writes: assist, profile, auto-hold', async () => {
  const { w, s } = await mk();
  assert.ok(await s.writeAssistLevel(1)); assert.equal(w.assistLevel, 1);
  assert.equal(await s.writeAssistLevel(2), false);
  assert.ok(await s.writeDriveProfile(3)); assert.equal(w.profile, 3);
  assert.equal(await s.writeDriveProfile(9), false);
  assert.ok(await s.writeAutoHold(true)); assert.equal(w.driveMode, 1);
});

test('max speed is capped at 6.0 km/h unless allowed, and preserves other params', async () => {
  const { w, s } = await mk();
  const before = w.params[0].slice();
  assert.ok(await s.writeMaxSpeed(0, 8.5));
  const after = w.params[0];
  assert.equal((after[1] << 8) | after[2], 1667);
  assert.deepEqual([after[0], ...after.slice(3)], [before[0], ...before.slice(3)]);
  assert.ok(await s.writeMaxSpeed(0, 8.5, true));
  assert.equal((w.params[0][1] << 8) | w.params[0][2], 2361);
});

test('silent wheel -> null/false, no throw', async () => {
  const { w, s } = await mk(); w.muted = true;
  const st = await s.readStatus();
  assert.equal(st.hasData, false);
  assert.equal(await s.writeAutoHold(true), false);
});

test('helpers', () => {
  assert.equal(nearestRaw(6.0), 1667);
  assert.deepEqual(selectableKmh(false).at(-1), 6);
  assert.deepEqual(selectableKmh(true).at(-1), 8.5);
  assert.equal(parseSWVersion(Uint8Array.of(1, 2)), null);
});
