// Parity with upstream's real mock wheel emulator: the same scenarios run through upstream's Python ECSRemote and through
// this app's WheelSession ('classic' engine); every encrypted request/response and the emulator's final state must match bit for bit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WheelSession } from '../src/session.js';
import { CoreLink } from '../src/drive.js';
import { LiveBridge, ReplayBridge, EmuTransport, unhex } from './helpers/emu.mjs';

const REF = JSON.parse(readFileSync(new URL('./emulator_ref.json', import.meta.url)));
const keys = REF.keys.map(unhex);
const live = LiveBridge.available();

async function runOp(s, op) {
  switch (op.op) {
    case 'status': return s.readStatus();
    case 'assist': return s.writeAssistLevel(op.level);
    case 'autohold': return s.writeAutoHold(op.on);
    case 'remote_on': return s.enterRemoteMode();
    case 'remote_off': return s.exitRemoteMode();
    case 'speed': return s.sendRemoteSpeed(op.v);
    case 'max_speed': return s.writeMaxSpeed(op.level, op.kmh, false);
    case 'params': return s.readProfileParams(op.level);
  }
}

for (const name of Object.keys(REF).filter((k) => REF[k]?.log && k !== 'core_remote')) {
  for (const mode of live ? ['live', 'replay'] : ['replay']) {
    test(`emulator parity (${mode}): ${name}`, async () => {
      const sc = REF[name];
      const bridge = mode === 'live' ? new LiveBridge() : new ReplayBridge(sc.log);
      const record = [];
      try {
        const sessions = [0, 1].map((w) => new WheelSession(['left', 'right'][w], new EmuTransport(bridge, w, keys[w], record), { commandDelayMs: 0, replyTimeoutMs: 100, retries: 2 }));
        for (const [w, op] of sc.ops) await runOp(sessions[w], op);
        assert.equal(record.length, sc.log.length, 'number of exchanges');
        sc.log.forEach((e, i) => {
          assert.equal(record[i].w, e.w, `exchange ${i} wheel`);
          assert.equal(record[i].tx_spp, e.tx_spp, `exchange ${i} request SPP`);
          assert.equal(record[i].tx, e.tx, `exchange ${i} encrypted request`);
          assert.equal(record[i].rx, e.rx, `exchange ${i} encrypted response`);
        });
        if (mode === 'live') assert.deepEqual(await bridge.state(), sc.states.at(-1), 'final emulator state');
      } finally { bridge.close(); }
    });
  }
}

for (const mode of live ? ['live', 'replay'] : ['replay']) {
  test(`emulator parity (${mode}): upstream core BluetoothTransport path (connect, frames, disconnect)`, async () => {
    const sc = REF.core_remote;
    const bridge = mode === 'live' ? new LiveBridge() : new ReplayBridge(sc.log);
    const record = [];
    try {
      const sessions = [0, 1].map((w) => new WheelSession(['left', 'right'][w], new EmuTransport(bridge, w, keys[w], record), { commandDelayMs: 0 }));
      const link = new CoreLink(sessions[0], sessions[1]);
      assert.equal(await link.enterRemoteMode(), sc.ok);
      for (const [l, r] of sc.frames) assert.equal(await link.send({ left: l, right: r }), true);
      await link.exitRemoteMode();
      assert.equal(record.length, sc.log.length);
      sc.log.forEach((e, i) => { for (const k of ['w', 'tx_spp', 'tx', 'rx']) assert.equal(record[i][k], e[k], `exchange ${i} ${k}`); });
      if (mode === 'live') assert.deepEqual(await bridge.state(), sc.states.at(-1));
    } finally { bridge.close(); }
  });
}
