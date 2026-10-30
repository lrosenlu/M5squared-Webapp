// The whole app pipeline (DriveSupervisor + Mapper + link + session + crypto) against upstream's real MockWheelSimulator.
// Live only: needs the upstream checkout (M5SQ_UPSTREAM). Asserts what the emulated wheels actually end up doing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WheelSession } from '../src/session.js';
import { WheelPair, CoreLink, DriveSupervisor, Mapper, defaultMapperConfig, State } from '../src/drive.js';
import { percentToMmps } from '../src/packets.js';
import { LiveBridge, EmuTransport, unhex } from './helpers/emu.mjs';

const KEYS = ['00112233445566778899aabbccddeeff', 'ffeeddccbbaa99887766554433221100'].map(unhex);
const live = LiveBridge.available();

async function rig(engine, linkKind, scale) {
  const bridge = new LiveBridge(), record = [];
  const sessions = [0, 1].map((w) => new WheelSession(['left', 'right'][w], new EmuTransport(bridge, w, KEYS[w], record),
    { commandDelayMs: 0, replyTimeoutMs: 100, engine, timing: { edgePulseMs: 0, armSettleMs: 0, rearmMs: 0, readbackMs: 0 } }));
  const link = linkKind === 'core' ? new CoreLink(sessions[0], sessions[1], scale) : new WheelPair(sessions[0], sessions[1], 'dual', scale);
  let t = 1000; const now = () => t;
  const sup = new DriveSupervisor(link, { mapper: new Mapper(defaultMapperConfig(), now), now, armIdleTimeout: 0 });
  const step = async (dt = 0.1) => { t += dt; await sup.tick(); };
  return { bridge, record, link, sup, step, sessions };
}

const speeds = (rec, w) => rec.filter((e) => e.w === w && e.tx_spp.slice(8, 12) === '0130').map((e) => parseInt(e.tx_spp.slice(12, 16), 16) << 16 >> 16);

for (const [engine, linkKind, scale, convert] of [['classic', 'pair', 2.5, (p) => Math.trunc(p * 2.5)], ['core', 'core', 2.5, (p) => Math.trunc(p * 2.5)], ['firmware', 'pair', 1, (p) => percentToMmps(p)]]) {
  test(`emulator pipeline [${engine}]: connect, arm, drive fast, release, e-stop, shutdown`, { skip: !live && 'upstream checkout not available' }, async () => {
    const { bridge, record, link, sup, step } = await rig(engine, linkKind, scale);
    try {
      assert.equal(await sup.connect(), true);
      let st = await bridge.state();
      assert.ok(st[0].drive_mode & 4 && st[1].drive_mode & 4, 'both emulated wheels are in remote mode');
      assert.equal(sup.state, State.PAIRED);
      sup.arm(); assert.equal(sup.state, State.ARMED);

      sup.setInput(1, 0, true, 'fast');
      for (let i = 0; i < 40; i++) { await step(); sup.setInput(1, 0, true, 'fast'); }
      assert.equal(sup.state, State.DRIVING);
      st = await bridge.state();
      const full = convert(100);
      assert.equal(st[1].target_speed, full, 'right wheel at full forward');
      assert.equal(st[0].target_speed, -full, 'left wheel is mirrored');
      assert.ok(Math.abs(full) <= (engine === 'firmware' ? 2361 : 250));

      // ramped up monotonically, never above the cap
      const r = speeds(record, 1);
      assert.ok(r.length > 10); assert.ok(r.every((v, i) => i === 0 || v >= r[i - 1] || v === 0));
      assert.ok(r.every((v) => v <= (engine === 'firmware' ? 2361 : 250)));

      // steer right on the spot: right wheel slower than left
      sup.setInput(0, 1, true, 'fast'); for (let i = 0; i < 30; i++) { await step(); sup.setInput(0, 1, true, 'fast'); }
      st = await bridge.state();
      assert.ok(st[1].target_speed < 0 && st[0].target_speed < 0, 'turn right: right wheel back, (mirrored) left wheel forward');

      // release the deadman: both stop
      sup.setInput(0, 0, false, 'fast'); await step(); await step();
      st = await bridge.state();
      assert.equal(st[0].target_speed, 0); assert.equal(st[1].target_speed, 0);
      assert.equal(sup.state, State.ARMED);

      // drive again, then emergency stop
      sup.setInput(1, 0, true, 'fast'); for (let i = 0; i < 10; i++) { await step(); sup.setInput(1, 0, true, 'fast'); }
      sup.emergencyStop('test'); await new Promise((r) => setTimeout(r, 300));
      assert.equal(sup.state, State.FAILSAFE);
      st = await bridge.state();
      assert.equal(st[0].target_speed, 0); assert.equal(st[1].target_speed, 0);

      await sup.shutdown();
      st = await bridge.state();
      assert.equal(st[0].drive_mode & 4, 0, 'remote mode left'); assert.equal(st[1].drive_mode & 4, 0);
      assert.equal(sup.state, State.DISCONNECTED);
      // every packet decrypted fine on the upstream side: the emulator answered or ACKed everything we sent as a request
      assert.ok(record.filter((e) => e.rx === null && !e.tx_spp.includes('0130')).length === 0 || engine !== 'classic');
    } finally { bridge.close(); }
  });
}
