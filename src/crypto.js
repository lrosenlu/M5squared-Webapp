// Port of m25_crypto.py and m25_qr_to_key.py.
//
// Packet (before byte stuffing):
//   [0xEF][frameLength:2 BE][ECB(IV):16][CBC ciphertext][CRC16:2 BE]
// with frameLength = 3 + 16 + n + 2 - 1. The AES key is per wheel.
import { ecb, cbc } from './aes.js';
import {
  HEADER_MARKER, HEADER_SIZE, IV_SIZE, MAX_FRAME_LENGTH, MIN_PACKET_LENGTH,
  crc16, addDelimiters, removeDelimiters, concat, fromHex,
} from './protocol.js';
import { QR_CHARSET } from './generated.js';

function pad(data) {
  const n = 16 - (data.length % 16);
  return concat(data, new Uint8Array(n).fill(n));
}

function unpad(data) {
  if (data.length === 0 || data.length % 16 !== 0) return null;
  const n = data[data.length - 1];
  if (n < 1 || n > 16 || n > data.length) return null;
  for (let i = data.length - n; i < data.length; i++) if (data[i] !== n) return null;
  return data.slice(0, data.length - n);
}

function checkKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== 16) throw new Error('AES key must be 16 bytes');
}

/** Encrypt decrypted SPP bytes into a byte-stuffed packet. `iv` is for tests only. */
export function encryptPacket(spp, key, iv) {
  checkKey(key);
  const ivBytes = iv ?? globalThis.crypto.getRandomValues(new Uint8Array(IV_SIZE));
  const payload = concat(ecb(ivBytes, key, true), cbc(pad(spp), key, ivBytes, true));
  const frameLength = HEADER_SIZE + payload.length + 2 - 1;
  if (frameLength > MAX_FRAME_LENGTH) throw new Error('Packet too large');
  const frame = concat(Uint8Array.of(HEADER_MARKER, (frameLength >> 8) & 0xff, frameLength & 0xff), payload);
  const crc = crc16(frame);
  return addDelimiters(concat(frame, Uint8Array.of((crc >> 8) & 0xff, crc & 0xff)));
}

/** Returns SPP bytes, or null on any framing/CRC/crypto/padding failure (also "incomplete"). */
export function decryptPacket(packet, key) {
  checkKey(key);
  const d = removeDelimiters(packet);
  if (!d || d.length < MIN_PACKET_LENGTH || d[0] !== HEADER_MARKER) return null;
  const frameLength = (d[1] << 8) | d[2];
  if (frameLength < MIN_PACKET_LENGTH - 1 || frameLength > MAX_FRAME_LENGTH || d.length <= frameLength) return null;

  const received = (d[frameLength - 1] << 8) | d[frameLength];
  if (crc16(d, frameLength - 1) !== received) return null;

  const iv = ecb(d.slice(HEADER_SIZE, HEADER_SIZE + IV_SIZE), key, false);
  const dataStart = HEADER_SIZE + IV_SIZE;
  const encLen = frameLength - dataStart - 2 + 1;
  if (encLen <= 0 || encLen % 16 !== 0 || dataStart + encLen > d.length) return null;
  return unpad(cbc(d.slice(dataStart, dataStart + encLen), key, iv, false));
}

/** 22-character QR text -> 16-byte key (bits 4..132 of the 6-bit stream). */
export function keyFromQR(qr) {
  const text = qr.trim();
  if (text.length !== 22) throw new Error(`QR code must be 22 characters (got ${text.length}).`);
  let bits = '';
  for (const ch of text) {
    const idx = QR_CHARSET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid character '${ch}' in QR code.`);
    bits += idx.toString(2).padStart(6, '0');
  }
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) key[i] = parseInt(bits.slice(4 + i * 8, 12 + i * 8), 2);
  return key;
}

/** Accepts a 22-char QR string or a 32-digit hex key. */
export function parseKeyInput(input) {
  const hex = fromHex(input);
  if (hex && hex.length === 16) return hex;
  return keyFromQR(input);
}
