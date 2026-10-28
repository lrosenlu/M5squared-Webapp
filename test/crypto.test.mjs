import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc16, addDelimiters, removeDelimiters, fromHex, toHex } from '../src/protocol.js';
import { encryptPacket, decryptPacket, keyFromQR, parseKeyInput } from '../src/crypto.js';

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url)));
const key = fromHex(V.key);

test('crc16 matches upstream', () => {
  for (const c of V.crc) assert.equal(crc16(fromHex(c.data)), c.crc);
});

test('byte stuffing matches upstream and round-trips', () => {
  for (const s of V.stuffing) {
    assert.equal(toHex(addDelimiters(fromHex(s.raw))), s.stuffed);
    assert.equal(toHex(removeDelimiters(fromHex(s.stuffed))), s.raw);
  }
});

test('encryption is byte-for-byte identical to upstream', () => {
  for (const e of V.encryption) {
    assert.equal(toHex(encryptPacket(fromHex(e.spp), key, fromHex(e.iv))), e.packet);
  }
});

test('decrypt recovers the SPP payload', () => {
  for (const e of V.encryption) assert.equal(toHex(decryptPacket(fromHex(e.packet), key)), e.spp);
});

test('random IV round-trips', () => {
  const spp = fromHex('018005010811');
  assert.equal(toHex(decryptPacket(encryptPacket(spp, key), key)), toHex(spp));
});

test('wrong key, corruption and truncation yield null', () => {
  const p = fromHex(V.wrongKeyPacket);
  const other = Uint8Array.from(key, (b) => b ^ 0xff);
  assert.equal(decryptPacket(p, other), null);
  const bad = Uint8Array.from(p); bad[10] ^= 1;
  assert.equal(decryptPacket(bad, key), null);
  assert.equal(decryptPacket(p.slice(0, 20), key), null);
});

test('QR -> key matches upstream', () => {
  for (const q of V.qr) {
    assert.equal(toHex(keyFromQR(q.qr)), q.key);
    assert.equal(toHex(parseKeyInput(q.qr)), q.key);
  }
  assert.throws(() => keyFromQR('short'));
  assert.equal(toHex(parseKeyInput(V.key)), V.key);
});
