import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc16, addDelimiters, removeDelimiters, toHex, fromHex } from '../src/protocol.js';
import { encryptPacket, decryptPacket, keyFromQR, parseKeyInput } from '../src/crypto.js';
import { PacketBuilder } from '../src/packets.js';

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url)));
const key = fromHex(V.key);

test('crc16 vectors', () => { for (const c of V.crc) assert.equal(crc16(fromHex(c.data)), c.crc); });
test('stuffing vectors', () => {
  for (const s of V.stuffing) {
    assert.equal(toHex(addDelimiters(fromHex(s.raw))), s.stuffed);
    assert.equal(toHex(removeDelimiters(fromHex(s.stuffed))), s.raw);
  }
});
test('encryption byte-for-byte', () => {
  for (const e of V.encryption) assert.equal(toHex(encryptPacket(fromHex(e.spp), key, fromHex(e.iv))), e.packet);
});
test('decrypt vectors', () => {
  for (const e of V.encryption) assert.equal(toHex(decryptPacket(fromHex(e.packet), key)), e.spp);
});
test('wrong key / corruption / partial -> null', () => {
  const bad = fromHex('ffeeddccbbaa99887766554433221100');
  assert.equal(decryptPacket(fromHex(V.wrongKeyPacket), bad), null);
  const p = fromHex(V.encryption[0].packet); p[10] ^= 1;
  assert.equal(decryptPacket(p, key), null);
  assert.equal(decryptPacket(fromHex(V.encryption[0].packet).slice(0, 20), key), null);
});
test('roundtrip random iv', () => {
  const spp = Uint8Array.from({ length: 40 }, (_, i) => (i * 7) & 0xff);
  assert.deepEqual(decryptPacket(encryptPacket(spp, key), key), spp);
});
test('QR -> key', () => {
  for (const q of V.qr) { assert.equal(toHex(keyFromQR(q.qr)), q.key); assert.equal(toHex(parseKeyInput(q.qr)), q.key); }
  assert.equal(toHex(parseKeyInput(V.key)), V.key);
  assert.throws(() => keyFromQR('short'));
});
test('packet builders match upstream', () => {
  const b = (f) => toHex(f(new PacketBuilder()));
  assert.equal(b((p) => p.writeSystemMode(1)), V.packets.systemModeConnect);
  assert.equal(b((p) => p.readSOC()), V.packets.readSOC);
  assert.equal(b((p) => p.readAssistLevel()), V.packets.readAssistLevel);
  assert.equal(b((p) => p.readDriveMode()), V.packets.readDriveMode);
  assert.equal(b((p) => p.readDriveProfile()), V.packets.readDriveProfile);
  assert.equal(b((p) => p.readProfileParams(1)), V.packets.readDriveProfileParams1);
  assert.equal(b((p) => p.readCruiseValues()), V.packets.readCruiseValues);
  assert.equal(b((p) => p.readDuoDriveParams()), V.packets.readDuoDriveParams);
});
