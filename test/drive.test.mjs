import test from 'node:test';
import assert from 'node:assert/strict';
import { Mapper, defaultMapperConfig, DriveSupervisor, WheelPair, State, DriveMode } from '../src/drive.js';
import { WheelSession } from '../src/session.js';
import { MockWheel } from '../src/mockwheel.js';
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
  const s = new WheelSession('left', L, { commandDelayMs: 0, engine: 'core' });
  await s.sendRemoteSpeed(9999); await s.sendRemoteSpeed(-9999);
  assert.deepEqual(L.speeds, [100, -100]); // core engine: upstream percent units
  const L2 = new MockWheel('L2'); await L2.connect();
  const s2 = new WheelSession('left', L2, { commandDelayMs: 0, engine: 'firmware' });
  await s2.sendRemoteSpeed(9999); await s2.sendRemoteSpeed(-9999);
  assert.deepEqual(L2.speeds, [2361, -2361]);
});

test('percentToMmps follows firmware scale and clamps', async () => {
  const { percentToMmps } = await import('../src/packets.js');
  assert.equal(percentToMmps(100), 2361);
  assert.equal(percentToMmps(10), 277);
  assert.equal(percentToMmps(-10), -277);
  assert.equal(percentToMmps(0), 0);
});

test('arming sets REMOTE and drive() refreshes mode, stop drops cruise', async () => {
  const L = new MockWheel('L'); await L.connect();
  let t = 0;
  const s = new WheelSession('left', L, { commandDelayMs: 0, engine: 'firmware', timing: { edgePulseMs: 0, armSettleMs: 0, rearmMs: 0, readbackMs: 0 }, now: () => t });
  assert.equal(await s.enterRemoteMode(), true);
  assert.ok(L.driveMode & 4);
  t += 100;
  assert.ok(await s.drive(500));
  assert.equal(L.speeds.at(-1), 500);
  assert.ok(await s.drive(0, true));
  assert.equal(L.speeds.at(-1), 0);
  assert.ok(L.driveMode & 4); assert.equal(L.driveMode & 2, 0);
});

test('telemetry reads speed, push rim, charging from mock', async () => {
  const L = new MockWheel('L'); await L.connect();
  L.charging = true; L.speedMmps = 1000; L.pushRim = -5; L.battery = 61;
  const s = new WheelSession('left', L, { commandDelayMs: 0 });
  const t = await s.readTelemetry();
  assert.equal(Math.round(t.cruise.speedKmh * 1000), 3600);
  assert.equal(t.cruise.pushRim, -5);
  assert.equal(t.bms.charging, true);
  assert.equal(t.battery, 61);
});

test('cruise speed is signed (reverse reads negative, not 65 km/h)', async () => {
  const { parseCruiseValues } = await import('../src/packets.js');
  const p = [0, 0, 0xff, 0x46, 80, 0, 0, 0, 0, 0, 1, 0];
  assert.equal(parseCruiseValues(p).speedRaw, -186);
  assert.ok(Math.abs(parseCruiseValues(p).speedKmh - (-0.6696)) < 1e-9);
});

test('drive() coalesces to the newest command while a write is slow', async () => {
  const L = new MockWheel('L'); await L.connect();
  const s = new WheelSession('left', L, { commandDelayMs: 0, engine: 'firmware', timing: { edgePulseMs: 0, armSettleMs: 0, rearmMs: 0, readbackMs: 0 } });
  await s.enterRemoteMode();
  const origSend = L.send.bind(L);
  L.send = async (x) => { await new Promise((r) => setTimeout(r, 30)); return origSend(x); };
  const a = s.drive(100), b = s.drive(200), c = s.drive(300);
  await Promise.all([a, b, c]);
  assert.equal(L.speeds.at(-1), 300);
  assert.ok(!L.speeds.includes(200));
});

test('speedScale (UI slider) scales the throttle linearly: magnitude x mode ceiling x slider', () => {
  for (const [scale, mode, cap] of [[1, 'fast', 100], [0.5, 'fast', 50], [0.25, 'normal', 15], [0.1, 'slow', 3]]) {
    const cfg = { ...defaultMapperConfig(), rampRate: 0, speedScale: scale };
    assert.equal(new Mapper(cfg, clock().now).map(ctl(1, 0, mode)).right, cap, `${scale} ${mode}`);
    assert.equal(new Mapper(cfg, clock().now).map(ctl(0.5, 0, mode)).right, Math.round(cap * ((0.5 - 0.1) / 0.9) ** 2), `half stick ${scale} ${mode}`);
  }
});

test('releaseControl: stops, leaves remote mode on both wheels, verifies by readback', async () => {
  const { L, R, sup } = await rig();
  await sup.connect(); sup.arm(); sup.setInput(1, 0, true, 'normal'); await sup.tick();
  assert.ok(await sup.releaseControl());
  assert.equal(L.driveMode & 4, 0); assert.equal(R.driveMode & 4, 0);
  assert.equal(sup.state, State.DISCONNECTED);
  assert.equal(L.speeds.at(-1), 0); assert.equal(R.speeds.at(-1), 0);
});

test('releaseNow (tab close) issues stop + drive-mode-0 writes synchronously', async () => {
  const { L, R, sup } = await rig();
  await sup.connect();
  sup.releaseNow();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(L.driveMode & 4, 0); assert.equal(R.driveMode & 4, 0);
});

test('releaseControl: a late/queued drive write cannot re-assert REMOTE after the exit (firmware engine)', async () => {
  const c = clock(); const L = new MockWheel('L'), R = new MockWheel('R'); await L.connect(); await R.connect();
  const o = { retries: 0, commandDelayMs: 0, replyTimeoutMs: 100, engine: 'firmware' };
  const sl = new WheelSession('left', L, o), sr = new WheelSession('right', R, o);
  const sup = new DriveSupervisor(new WheelPair(sl, sr, 'dual', 1), { now: c.now });
  await sup.connect(); sup.arm();
  sl._driveBusy = true; sl._pendingDrive = [800, false]; // simulate a write in flight with a newer one queued
  setTimeout(() => { sl._driveBusy = false; }, 30);
  assert.ok(await sup.releaseControl());
  await sl.drive(800); await sr.drive(800);              // anything arriving afterwards is ignored
  assert.equal(L.driveMode & 4, 0); assert.equal(R.driveMode & 4, 0);
  assert.equal(L.speeds.at(-1), 0);
});

test('release variants all clear REMOTE; standby also writes system mode 2', async () => {
  for (const variant of ['standard', 'firmware', 'standby']) {
    const { L, R, sup } = await rig();
    await sup.connect(); sup.arm();
    assert.ok(await sup.releaseControl({ variant }), variant);
    assert.equal(L.driveMode & 4, 0); assert.equal(R.driveMode & 4, 0);
  }
});

test('Upstream-core link honours the standby variant (was ignored: park did nothing on core)', async () => {
  const { CoreLink } = await import('../src/drive.js');
  const L = new MockWheel('L'), R = new MockWheel('R'); await L.connect(); await R.connect();
  const sent = [];
  for (const w of [L, R]) { const o = w.send.bind(w); w.send = async (p) => { sent.push(Buffer.from(p).toString('hex')); return o(p); }; }
  const opts = { retries: 0, commandDelayMs: 0, replyTimeoutMs: 100 };
  const sup = new DriveSupervisor(new CoreLink(new WheelSession('left', L, opts), new WheelSession('right', R, opts)), {});
  await sup.connect(); sent.length = 0;
  assert.ok(await sup.releaseControl({ variant: 'standby' }));
  assert.equal(sent.filter((x) => x.endsWith('1002')).length, 2, 'both wheels get SYSTEM_MODE standby');
  sent.length = 0; await sup.connect();  sent.length = 0;
  assert.ok(await sup.releaseControl());
  assert.equal(sent.filter((x) => x.endsWith('1002')).length, 0, 'normal release never sends standby');
});

test('core engine sends upstream raw units: the mapper percent unscaled, never above 100', async () => {
  const L = new MockWheel('L'), R = new MockWheel('R'); await L.connect(); await R.connect();
  const sent = [];
  const o = L.send.bind(L); L.send = async (p) => { sent.push(Buffer.from(p).toString('hex')); return o(p); };
  const s = new WheelSession('left', L, { retries: 0, commandDelayMs: 0, replyTimeoutMs: 100, engine: 'core' });
  await s.sendRemoteSpeed(60); assert.ok(sent.at(-1).endsWith('30' + (60).toString(16).padStart(4, '0')), '60 goes out as 60');
  await s.sendRemoteSpeed(1666); assert.ok(sent.at(-1).endsWith('30' + (100).toString(16).padStart(4, '0')), 'clamped to 100');
});

test('core link: a drive frame in flight during release is dropped, stops still go out, and re-enabling drives again', async () => {
  const { CoreLink } = await import('../src/drive.js');
  const L = new MockWheel('L'), R = new MockWheel('R'); await L.connect(); await R.connect();
  const o = { retries: 0, commandDelayMs: 0, replyTimeoutMs: 100, engine: 'core' };
  const sl = new WheelSession('left', L, o), sr = new WheelSession('right', R, o);
  const link = new CoreLink(sl, sr, 1);
  const sup = new DriveSupervisor(link, {});
  await sup.connect();
  await link.send({ left: 10, right: 10 });
  assert.deepEqual(R.speeds, [10]);
  await sup.releaseControl();
  assert.equal(await link.send({ left: 50, right: 50 }), true, 'late frame reports success but is not sent');
  assert.equal(R.speeds.includes(50), false);
  assert.equal(R.speeds.at(-1), 0, 'stop frames still went out');
  await sup.connect();
  await link.send({ left: 20, right: 20 });
  assert.equal(R.speeds.at(-1), 20, 'driving works again after re-enabling');
});

test('disarm returns ARMED/DRIVING to PAIRED and stops; setHillHold keeps REMOTE and toggles AUTO_HOLD', async () => {
  const { L, R, sup } = await rig();
  await sup.connect(); sup.arm();
  assert.equal(sup.state, State.ARMED);
  await sup.disarm();
  assert.equal(sup.state, State.PAIRED);
  assert.equal(R.speeds.at(-1), 0);
  const sl = sup.link.left;
  assert.ok(await sl.setHillHold(true)); assert.equal(L.driveMode & 5, 5, 'REMOTE|AUTO_HOLD');
  assert.ok(await sl.setHillHold(false)); assert.equal(L.driveMode & 5, 4, 'REMOTE only');
});

test('startLoop runs ticks on a real timer until stopLoop', async () => {
  const { R, sup } = await rig();
  sup.loopInterval = 0.01; sup.now = () => Date.now() / 1000; sup.mapper.now = sup.now;
  await sup.connect(); sup.arm();
  sup.startLoop();
  for (let i = 0; i < 10; i++) { sup.setInput(1, 0, true, 'fast'); await new Promise((r) => setTimeout(r, 15)); }
  sup.stopLoop();
  assert.ok(R.speeds.some((v) => v > 0), 'loop drove the wheel');
  const n = R.speeds.length; await new Promise((r) => setTimeout(r, 60));
  assert.equal(R.speeds.length, n, 'no more writes after stopLoop');
});

test('snapAxis: near an axis the off-axis part is dropped, magnitude is kept, diagonals are untouched', async () => {
  const { snapAxis } = await import('../src/drive.js');
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const mag = (v) => Math.hypot(v[0], v[1]);
  for (const [x, y] of [[1, 0.2], [-1, 0.2], [-0.8, -0.1], [0.2, 1], [0.1, -1], [-0.2, -0.9]]) {
    const r = snapAxis(x, y); assert.ok(near(mag(r), Math.hypot(x, y)), 'magnitude kept');
    assert.ok(r[0] === 0 || r[1] === 0, `snapped (${x}, ${y})`);
    assert.equal(Math.sign(r[0] + r[1]), Math.sign(Math.abs(x) > Math.abs(y) ? x : y), 'same direction');
  }
  assert.deepEqual(snapAxis(1, 1), [1, 1]);       // 45 degrees
  assert.deepEqual(snapAxis(1, 0.4), [1, 0.4]);   // ~22 degrees: outside the 15 degree window
  assert.deepEqual(snapAxis(0, 0), [0, 0]);
  assert.deepEqual(snapAxis(1, 0.2, 0), [1, 0.2]); // disabled
});
