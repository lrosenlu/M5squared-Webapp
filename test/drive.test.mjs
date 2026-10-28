import test from 'node:test';
import assert from 'node:assert/strict';
import { Mapper, defaultMapperConfig, DriveSupervisor, WheelPair, State, DriveMode } from '../src/drive.js';
import { WheelSession, MockWheel } from '../src/session.js';
import { PacketBuilder } from '../src/packets.js';

const clock = () => { const c = { t: 100 }; c.now = () => c.t; return c; };
const ctl = (vx, vy, mode = DriveMode.NORMAL, deadman = true) => ({ vx, vy, deadman, mode });

test('deadman off or STOP mode -> stop', () => {
  const m = new Mapper(defaultMapperConfig(), clock().now);
  assert.deepEqual(m.map(ctl(1, 0, DriveMode.NORMAL, false)), { left: 0, right: 0 });
  assert.deepEqual(m.map(ctl(1, 0, DriveMode.STOP)), { left: 0, right: 0 });
});

test('deadzone and curve', () => {
  const m = new Mapper(defaultMapperConfig(), clock().now);
  assert.equal(m.deadzone(0.05), 0);
  assert.ok(Math.abs(m.deadzone(1) - 1) < 1e-9);
  assert.ok(Math.abs(m.curve(0.5) - 0.25) < 1e-9);
  assert.ok(Math.abs(m.curve(-0.5) + 0.25) < 1e-9);
});

test('right turn speeds LEFT wheel, slows right', () => {
  const c = clock(); const cfg = defaultMapperConfig(); cfg.rampRate = 1e6;
  const m = new Mapper(cfg, c.now);
  const f = m.map(ctl(0, 1));
  assert.ok(f.left > 0 && f.right < 0, JSON.stringify(f));
});

test('invertSteering flips', () => {
  const c = clock(); const cfg = defaultMapperConfig(); cfg.rampRate = 1e6; cfg.invertSteering = true;
  const f = new Mapper(cfg, c.now).map(ctl(0, 1));
  assert.ok(f.left < 0 && f.right > 0);
});

test('speed caps per mode', () => {
  const c = clock(); const cfg = defaultMapperConfig(); cfg.rampRate = 1e6;
  for (const [mode, cap] of [['slow', 30], ['normal', 60], ['fast', 100]]) {
    const f = new Mapper(cfg, c.now).map(ctl(1, 0, mode));
    assert.deepEqual(f, { left: cap, right: cap });
  }
});

test('ramp starts from zero and never jumps after a long gap', () => {
  const c = clock(); const m = new Mapper(defaultMapperConfig(), c.now);
  assert.equal(m.map(ctl(1, 0, 'fast')).left, 5); // firstStep 0.1s * 50/s
  c.t += 30; // long gap -> capped to 0.25 s -> +12.5
  assert.equal(m.map(ctl(1, 0, 'fast')).left, 18);
  m.reset();
  c.t += 1;
  assert.equal(m.map(ctl(1, 0, 'fast')).left, 5);
});

test('stop resets ramp', () => {
  const c = clock(); const m = new Mapper(defaultMapperConfig(), c.now);
  m.map(ctl(1, 0, 'fast')); c.t += 0.1; m.map(ctl(1, 0, 'fast'));
  m.map(ctl(1, 0, 'fast', false)); c.t += 0.1;
  assert.equal(m.map(ctl(1, 0, 'fast')).left, 5);
});

// ---- supervisor with mock wheels
async function rig() {
  const c = clock();
  const L = new MockWheel('Left'), R = new MockWheel('Right');
  await L.connect(); await R.connect();
  const opts = { retries: 0, commandDelayMs: 0, replyTimeoutMs: 100 };
  const pair = new WheelPair(new WheelSession('left', L, opts), new WheelSession('right', R, opts));
  const sup = new DriveSupervisor(pair, { now: c.now });
  return { c, L, R, pair, sup };
}

test('connect -> paired -> armed -> driving -> release -> armed', async () => {
  const { c, L, R, sup } = await rig();
  assert.ok(await sup.connect());
  assert.equal(sup.state, State.PAIRED);
  assert.equal(L.driveMode & 4, 4); assert.equal(R.driveMode & 4, 4);
  sup.arm(); assert.equal(sup.state, State.ARMED);
  sup.setInput(1, 0, true, 'normal'); await sup.tick();
  assert.equal(sup.state, State.DRIVING);
  c.t += 0.1; sup.setInput(1, 0, true, 'normal'); await sup.tick();
  const lastL = L.speeds.at(-1), lastR = R.speeds.at(-1);
  assert.ok(lastR > 0 && lastL === -lastR, `${lastL} ${lastR}`); // left negated
  sup.setInput(0, 0, false, 'normal'); await sup.tick();
  assert.equal(sup.state, State.ARMED);
  assert.equal(L.speeds.at(-1), 0);
});

test('input timeout while deadman held -> failsafe + zero speed', async () => {
  const { c, L, sup } = await rig();
  await sup.connect(); sup.arm();
  sup.setInput(1, 0, true, 'normal'); await sup.tick(); await sup.tick();
  c.t += 0.6; await sup.tick();
  assert.equal(sup.state, State.FAILSAFE);
  assert.equal(sup.failsafeReason, 'Input timeout');
  assert.equal(L.speeds.at(-1), 0);
});

test('no input timeout when deadman is not held', async () => {
  const { c, sup } = await rig();
  await sup.connect(); sup.arm();
  c.t += 1.0; await sup.tick();
  assert.equal(sup.state, State.ARMED);
});

test('link loss -> failsafe -> disconnected', async () => {
  const { L, sup } = await rig();
  await sup.connect(); sup.arm();
  await L.disconnect();
  await sup.tick(); assert.equal(sup.state, State.FAILSAFE);
  await sup.tick(); assert.equal(sup.state, State.DISCONNECTED);
});

test('emergency stop is synchronous and stops', async () => {
  const { L, R, sup } = await rig();
  await sup.connect(); sup.arm();
  sup.setInput(1, 0, true, 'fast'); await sup.tick();
  sup.emergencyStop('Test');
  assert.equal(sup.state, State.FAILSAFE);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(L.speeds.at(-1), 0); assert.equal(R.speeds.at(-1), 0);
});

test('enterRemoteMode failure on one wheel aborts all-or-nothing', async () => {
  const { L, R, sup } = await rig();
  R.muted = true;
  assert.equal(await sup.connect(), false);
  assert.equal(sup.state, State.DISCONNECTED);
  assert.equal(L.driveMode & 4, 0);
});

test('session clamps remote speed to hard limit', async () => {
  const L = new MockWheel('L'); await L.connect();
  const s = new WheelSession('left', L, { commandDelayMs: 0 });
  await s.sendRemoteSpeed(9999); await s.sendRemoteSpeed(-9999);
  assert.deepEqual(L.speeds, [250, -250]);
});
