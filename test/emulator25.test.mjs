// Runs the web app against the REAL 6static/m25-emulator firmware code (C++ headers compiled natively; see tools/emu_shim).
// Skipped when the emulator checkout (M25_EMULATOR, default /home/claude/ref/m25-emulator) or g++/libssl are not available.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Emu25Wheel, emu25Available } from './helpers/emu25.mjs';
import { WheelSession } from '../src/session.js';
import { WheelPair, CoreLink, DriveSupervisor, Mapper, defaultMapperConfig, State } from '../src/drive.js';
import { PacketBuilder } from '../src/packets.js';

const skip = !emu25Available() && 'm25-emulator checkout or g++/libssl not available';
const KL = Uint8Array.from({ length: 16 }, (_, i) => i * 7 + 1), KR = Uint8Array.from({ length: 16 }, (_, i) => 255 - i * 5);
const OPTS = { retries: 0, commandDelayMs: 0, replyTimeoutMs: 100 };
async function rig(engine, { echoTid = true } = {}) {
  const L = new Emu25Wheel('left', KL, { echoTid }), R = new Emu25Wheel('right', KR, { echoTid });
  const sl = new WheelSession('left', L, { ...OPTS, engine }), sr = new WheelSession('right', R, { ...OPTS, engine });
  const clock = { t: 100 }; const now = () => clock.t;
  return { L, R, sl, sr, clock, now, done: () => { L.disconnect(); R.disconnect(); } };
}

test('emulator accepts every frame the app builds and mirrors the written state (200 random frames)', { skip }, async () => {
  const w = new Emu25Wheel('x', KL, { echoTid: true }); const b = new PacketBuilder();
  let seed = 7; const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let i = 0; i < 200; i++) {
    const kind = rnd(3);
    if (kind === 0) { const m = rnd(8); await w.transact(b.writeDriveMode(m)); assert.equal((await w.state()).driveMode, m); }
    else if (kind === 1) { const v = rnd(65536) - 32768; await w.send(b.writeRemoteSpeed(v)); assert.equal((await w.state()).speed, v); }
    else { const l = rnd(3); await w.transact(b.writeAssistLevel?.(l) ?? b.writeSystemMode(1)); }
  }
  assert.ok(w.log.every((e) => e.ok === 'OK'), 'emulator failed to decode a frame');
  w.disconnect();
});

for (const engine of ['classic', 'firmware']) {
  test(`${engine}: arming puts the emulator in REMOTE, drive writes signed speed, exit restores normal`, { skip }, async () => {
    const r = await rig(engine);
    assert.ok(await r.sl.enterRemoteMode()); assert.equal((await r.L.state()).driveMode & 4, 4);
    await (engine === 'firmware' ? r.sl.drive(-500) : r.sl.sendRemoteSpeed(-120));
    assert.equal((await r.L.state()).speed, engine === 'firmware' ? -500 : -120);
    assert.ok(await r.sl.exitRemoteMode()); assert.equal((await r.L.state()).driveMode & 4, 0);
    r.done();
  });
}

for (const [name, mk, scale] of [['classic', (l, rr) => new WheelPair(l, rr, 'dual', 2.5), 2.5], ['core', (l, rr) => new CoreLink(l, rr, 2.5), 2.5], ['firmware', (l, rr) => new WheelPair(l, rr, 'dual', 1), 1]]) {
  test(`${name} engine: supervisor drives both emulated wheels, left mirrored, stops, and releaseControl frees the bus`, { skip }, async () => {
    const r = await rig(name === 'core' ? 'classic' : name);
    const cfg = { ...defaultMapperConfig(), rampRate: 0 };
    const sup = new DriveSupervisor(mk(r.sl, r.sr), { mapper: new Mapper(cfg, r.now), now: r.now });
    assert.ok(await sup.connect());
    assert.equal((await r.L.state()).driveMode & 4, 4); assert.equal((await r.R.state()).driveMode & 4, 4);
    sup.arm(); sup.setInput(1, 0, true, 'normal'); await sup.tick(); r.clock.t += 0.1; sup.setInput(1, 0, true, 'normal'); await sup.tick();
    const [ls, rs] = [(await r.L.state()).speed, (await r.R.state()).speed];
    assert.ok(rs > 0 && ls === -rs, `L ${ls} R ${rs}`);
    assert.ok(Math.abs(rs) <= 2361, 'within the firmware speed cap');
    sup.setInput(0, 0, false, 'normal'); await sup.tick();
    assert.equal((await r.L.state()).speed, 0); assert.equal((await r.R.state()).speed, 0);
    sup.setInput(1, 0, true, 'normal'); await sup.tick();
    assert.ok(await sup.releaseControl(), 'wheels must report remote mode cleared');
    for (const w of [r.L, r.R]) { const s = await w.state(); assert.equal(s.driveMode & 4, 0); assert.equal(s.speed, 0); }
    for (const w of [r.L, r.R]) assert.ok(w.log.every((e) => e.ok === 'OK'));
    r.done();
  });
}

test('command watchdog: emulator zeroes speed after 1200 ms without a speed frame; the app refreshes faster than that', { skip }, async () => {
  const r = await rig('classic');
  const cfg = { ...defaultMapperConfig(), rampRate: 0 };
  const sup = new DriveSupervisor(new WheelPair(r.sl, r.sr, 'dual', 2.5), { mapper: new Mapper(cfg, r.now), now: r.now });
  await sup.connect(); sup.arm();
  for (let i = 0; i < 20; i++) { // 2 s of 100 ms ticks
    r.clock.t += 0.1; await r.L.setClock(r.clock.t * 1000); await r.R.setClock(r.clock.t * 1000);
    sup.setInput(1, 0, true, 'normal'); await sup.tick();
    assert.equal(await r.L.timeoutCheck(), false, `watchdog fired at tick ${i}`);
  }
  assert.notEqual((await r.R.state()).speed, 0);
  r.clock.t += 1.3; await r.R.setClock(r.clock.t * 1000);
  assert.equal(await r.R.timeoutCheck(), true); assert.equal((await r.R.state()).speed, 0);
  r.done();
});

test('as shipped the emulator ACKs with a fixed telegram id, which a strict client (the app, upstream ECSRemote) rejects', { skip }, async () => {
  const r = await rig('classic', { echoTid: false });
  assert.equal(await r.sl._write(r.sl.builder.writeDriveMode(4)), false, 'ACK carries telegram id 0x01, not the request id');
  assert.equal((await r.L.state()).driveMode, 4, '...although the emulator did apply the command');
  r.done();
});
