// Port of m25_protocol.py: frame constants, CRC-16, byte stuffing. Plus hex helpers.
import { CRC_TABLE } from './generated.js';

export const HEADER_MARKER = 0xef;
export const HEADER_SIZE = 3;
export const MAX_FRAME_LENGTH = 293;
export const MIN_PACKET_LENGTH = 37;
export const IV_SIZE = 16;

export function crc16(data, length = data.length) {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) crc = (crc >> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  return crc & 0xffff;
}

/** Double every 0xEF except the first byte. */
export function addDelimiters(buf) {
  if (buf.length === 0) return Uint8Array.from(buf);
  const out = [buf[0]];
  for (let i = 1; i < buf.length; i++) {
    out.push(buf[i]);
    if (buf[i] === HEADER_MARKER) out.push(HEADER_MARKER);
  }
  return Uint8Array.from(out);
}

/** Inverse of addDelimiters; null if implausibly long. */
export function removeDelimiters(buf) {
  if (buf.length > MAX_FRAME_LENGTH * 2) return null;
  const out = [];
  let flag = true;
  for (const b of buf) {
    if (b === HEADER_MARKER) {
      if (flag) { out.push(b); flag = false; } else { flag = true; }
    } else {
      out.push(b);
      flag = false;
    }
  }
  return Uint8Array.from(out);
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function toHexSpaced(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** Tolerates spaces and colons. Returns null on bad input. */
export function fromHex(str) {
  const clean = str.replace(/[\s:]/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}
