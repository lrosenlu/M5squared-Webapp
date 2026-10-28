import test from 'node:test';
import assert from 'node:assert/strict';
import { BLEWheelTransport, PROFILES } from '../src/ble.js';
import { encryptPacket, decryptPacket } from '../src/crypto.js';
import { MockWheel, WheelSession } from '../src/session.js';
import { concat } from '../src/protocol.js';

const key = Uint8Array.from({ length: 16 }, (_, i) => i * 3 + 1);

// Fake GATT peripheral: reassembles 20-byte writes, decrypts, runs the MockWheel, notifies in 20-byte chunks.
function fakeDevice(profile) {
  const wheel = new MockWheel('Fake'); wheel.connected = true;
  const listeners = {}; const devL = {};
  let buf = new Uint8Array(0);
  const notify = {
    addEventListener: (t, f) => { listeners[t] = f; },
    removeEventListener() {}, startNotifications: async () => {},
  };
  const emit = (chunk) => listeners.characteristicvaluechanged?.({ target: { value: new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength) } });
  const write = {
    maxChunk: 0,
    async writeValueWithoutResponse(part) {
      write.maxChunk = Math.max(write.maxChunk, part.length);
      buf = concat(buf, part);
      const spp = decryptPacket(buf, key);
      if (!spp) return;
      buf = new Uint8Array(0);
      const res = wheel._handle(spp);
      if (res) {
        const pkt = encryptPacket(res, key);
        setTimeout(() => { for (let i = 0; i < pkt.length; i += 20) emit(pkt.slice(i, i + 20)); }, 1);
      }
    },
  };
  const chars = { [profile.write]: write, [profile.notify]: profile.notify === profile.write ? write : notify };
  if (profile.notify === profile.write) write.addEventListener = notify.addEventListener, write.startNotifications = notify.startNotifications, write.removeEventListener = notify.removeEventListener;
  const device = {
    name: 'emotion-1234',
    addEventListener: (t, f) => { devL[t] = f; }, removeEventListener() {},
    gatt: { connected: false,
      async connect() { this.connected = true; return { async getPrimaryService(uuid) {
        if (uuid !== profile.service) throw new Error('no service');
        return { getCharacteristic: async (c) => chars[c] }; } }; },
      disconnect() { this.connected = false; devL.gattserverdisconnected?.(); } },
  };
  return { device, wheel, write };
}

for (const profile of PROFILES) {
  test(`full status read over fake GATT: ${profile.name}`, async () => {
    const { device, write } = fakeDevice(profile);
    const t = new BLEWheelTransport(device, key);
    await t.connect();
    assert.equal(t.profile.name, profile.name);
    const s = new WheelSession('left', t, { retries: 1, commandDelayMs: 0, replyTimeoutMs: 500 });
    const st = await s.readStatus();
    assert.equal(st.battery, 85);
    assert.equal(st.firmware.text, 'V03.005.000');
    assert.ok(write.maxChunk <= 20);
    await t.disconnect();
    assert.equal(t.isConnected, false);
  });
}

test('disconnect fails pending transactions fast', async () => {
  const { device, wheel } = fakeDevice(PROFILES[0]);
  wheel.muted = true;
  const t = new BLEWheelTransport(device, key);
  await t.connect();
  const p = t.transact(Uint8Array.of(1, 0x80, 5, 1, 8, 0x11), 5000);
  setTimeout(() => device.gatt.disconnect(), 20);
  assert.equal(await p, null);
});

test('garbage notifications are ignored', async () => {
  const { device } = fakeDevice(PROFILES[0]);
  const t = new BLEWheelTransport(device, key);
  await t.connect();
  t._receive(Uint8Array.from({ length: 50 }, (_, i) => i));
  t._receive(Uint8Array.from({ length: 700 }, () => 0xaa));
  assert.ok(t.rxBuf.length <= 600);
});
