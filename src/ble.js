// Web Bluetooth transport for one wheel. Carries decrypted SPP packets; encryption and
// framing happen here. Requires HTTPS (or localhost) and a browser with Web Bluetooth:
// Chrome/Edge on Android and desktop, or Bluefy on iOS. iOS Safari/Chrome have none.
import { encryptPacket, decryptPacket } from './crypto.js';
import { MAX_FRAME_LENGTH, toHexSpaced, concat } from './protocol.js';
import { POS } from './packets.js';

const NORDIC = {
  name: 'Nordic UART', service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
};
export const PROFILES = [
  { name: 'M25 V2', service: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    write: '49535343-8841-43f4-a8d4-ecbe34729bb3', notify: '49535343-1e4d-4bd9-ba61-23c647249616' },
  { name: 'M25 V1', service: 'c9e61e27-93c0-45c0-b5f9-702e971daa2e',
    write: '49535343-026e-3a9b-954c-97daef17e26e', notify: '49535343-026e-3a9b-954c-97daef17e26e' },
  NORDIC,
];
// Web Bluetooth's namePrefix is case-sensitive, so list the common spellings.
export const NAME_PREFIXES = ['emotion', 'Emotion', 'EMOTION', 'M25', 'e-motion', 'E-Motion', 'Alber', 'ALBER', 'WHEEL', 'Wheel'];

const CHUNK = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const bluetoothSupported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

export function bluetoothHelp() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua)) return 'This browser has no Web Bluetooth. On iPhone/iPad open this page in the free Bluefy browser.';
  if (!window.isSecureContext) return 'Web Bluetooth needs HTTPS (or localhost).';
  return 'This browser has no Web Bluetooth. Use Chrome or Edge on Android or desktop.';
}

/** Must be called from a user gesture (tap). */
export async function pickWheel(showAll = false) {
  if (!bluetoothSupported()) throw new Error(bluetoothHelp());
  // showAll: list every nearby device, for wheels whose advertised name/services don't match the filters.
  if (showAll) return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: PROFILES.map((p) => p.service) });
  return navigator.bluetooth.requestDevice({
    filters: [...PROFILES.map((p) => ({ services: [p.service] })), ...NAME_PREFIXES.map((namePrefix) => ({ namePrefix }))],
    optionalServices: PROFILES.map((p) => p.service),
  });
}

export class BLEWheelTransport {
  constructor(device, key, { trace } = {}) {
    this.device = device;
    this.key = key;
    this.trace = trace ?? null;
    this.connected = false;
    this.profile = null;
    this.rxBuf = new Uint8Array(0);
    this.rawBytes = 0; // total notification bytes seen, for diagnosing key problems
    this.waiters = new Set();
    this.queue = Promise.resolve();
    this.onDisconnect = null;
    this._onGatt = () => { this.connected = false; this._failWaiters(); this.onDisconnect?.(); };
    this._onValue = (e) => this._receive(new Uint8Array(e.target.value.buffer.slice(e.target.value.byteOffset, e.target.value.byteOffset + e.target.value.byteLength)));
  }

  get name() { return this.device.name || 'Wheel'; }
  get isConnected() { return this.connected && !!this.device.gatt?.connected; }

  async connect() {
    this.device.addEventListener('gattserverdisconnected', this._onGatt);
    const server = await this.device.gatt.connect();
    let found = null;
    for (const p of PROFILES) {
      try {
        const svc = await server.getPrimaryService(p.service);
        found = { p, svc };
        break;
      } catch { /* try next profile */ }
    }
    if (!found) { this.device.gatt.disconnect(); throw new Error('This device does not expose a known M25 service.'); }
    this.profile = found.p;
    this.writeChar = await found.svc.getCharacteristic(found.p.write);
    this.notifyChar = found.p.notify === found.p.write ? this.writeChar : await found.svc.getCharacteristic(found.p.notify);

    // Diagnostics: log every characteristic and its properties, and also listen on any other
    // notifying characteristic, in case this wheel replies somewhere unexpected.
    this.extraNotify = [];
    if (typeof found.svc.getCharacteristics === 'function') {
      try {
        const all = await found.svc.getCharacteristics();
        for (const c of all) {
          const pr = c.properties ? Object.entries(c.properties).filter(([, v]) => v).map(([k]) => k).join(',') : '?';
          this.trace?.(`[GATT] ${c.uuid} props=${pr}`);
          const isCfg = c.uuid === this.notifyChar.uuid || c.uuid === this.writeChar.uuid;
          if (!isCfg && c.properties && (c.properties.notify || c.properties.indicate)) this.extraNotify.push(c);
        }
      } catch (e) { this.trace?.(`[GATT] could not list characteristics: ${e.message || e}`); }
    }
    const wp = this.writeChar.properties;
    this.trace?.(`[GATT] using ${this.profile.name}; write props=${wp ? Object.entries(wp).filter(([, v]) => v).map(([k]) => k).join(',') : '?'}`);

    this.notifyChar.addEventListener('characteristicvaluechanged', this._onValue);
    // Some modules reject the first subscribe right after connecting; settle, then retry once.
    await sleep(400);
    try { await this.notifyChar.startNotifications(); }
    catch (e) { this.trace?.(`[GATT] subscribe failed (${e.message || e}); retrying`); await sleep(800); await this.notifyChar.startNotifications(); }
    for (const c of this.extraNotify) {
      try { c.addEventListener('characteristicvaluechanged', this._onValue); await c.startNotifications(); this.trace?.(`[GATT] also listening on ${c.uuid}`); }
      catch (e) { this.trace?.(`[GATT] extra subscribe ${c.uuid} failed: ${e.message || e}`); }
    }
    await sleep(200);
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
    this._failWaiters();
    try { this.notifyChar?.removeEventListener('characteristicvaluechanged', this._onValue); } catch { /* ignore */ }
    for (const c of this.extraNotify ?? []) { try { c.removeEventListener('characteristicvaluechanged', this._onValue); } catch { /* ignore */ } }
    try { this.device.removeEventListener('gattserverdisconnected', this._onGatt); } catch { /* ignore */ }
    try { this.device.gatt?.disconnect(); } catch { /* ignore */ }
  }

  _failWaiters() { for (const w of this.waiters) w.resolve(null); this.waiters.clear(); }

  // ---- receive: reassemble, try to decrypt, discard junk
  _receive(chunk) {
    this.rawBytes += chunk.length;
    this.trace?.(`[RAW ${this.name}] ${chunk.length}B ${toHexSpaced(chunk)}`);
    this.rxBuf = concat(this.rxBuf, chunk);
    if (this.rxBuf.length > MAX_FRAME_LENGTH * 2) this.rxBuf = this.rxBuf.slice(-MAX_FRAME_LENGTH);
    // Wheels sometimes emit stray notifications (e.g. "2B 00 00") that are not part of a frame.
    // A frame always starts with 0xEF, so drop anything before it, and if a complete-looking
    // buffer fails to decrypt, skip one byte and resync on the next 0xEF.
    let spp = null;
    for (;;) {
      let start = 0;
      while (start < this.rxBuf.length && this.rxBuf[start] !== 0xef) start++;
      if (start > 0) this.rxBuf = this.rxBuf.slice(start);
      if (this.rxBuf.length === 0) return;
      spp = decryptPacket(this.rxBuf, this.key);
      if (spp) break;
      const declared = this.rxBuf.length >= 3 ? ((this.rxBuf[1] << 8) | this.rxBuf[2]) + 1 : Infinity;
      if (this.rxBuf.length > declared + 24 || this.rxBuf.length > MAX_FRAME_LENGTH) { this.rxBuf = this.rxBuf.slice(1); continue; }
      return; // incomplete: wait for more bytes
    }
    this.rxBuf = new Uint8Array(0);
    this.trace?.(`[RX ${this.name}] ${toHexSpaced(spp)}`);
    this.lastSource = spp[POS.SOURCE];
    for (const w of [...this.waiters]) {
      if (w.tid === spp[POS.TELEGRAM]) { this.waiters.delete(w); w.resolve(spp); }
    }
  }

  // ---- send: serialize GATT operations, chunk to 20 bytes
  // A GATT write that never settles (stalled stack, wheel asleep) would block every later write behind it forever.
  // Bound each queued operation; the late result, if any, is ignored.
  _enqueue(fn, limitMs = 4000) {
    const bounded = () => new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.trace?.(`[GATT-TIMEOUT ${this.name}] write did not complete in ${limitMs} ms`); reject(new Error('Bluetooth write timed out')); }, limitMs);
      Promise.resolve().then(fn).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
    const run = this.queue.then(bounded, bounded);
    this.queue = run.catch(() => {});
    return run;
  }

  async send(spp) {
    if (!this.isConnected) throw new Error('Not connected');
    this.trace?.(`[TX ${this.name}] ${toHexSpaced(spp)}`);
    const packet = encryptPacket(spp, this.key);
    return this._enqueue(async () => {
      // Upstream (m25_bluetooth_ble.py) writes the whole encrypted packet in ONE GATT write, and uses
      // write-with-response only when the characteristic supports nothing else. Do the same; fall
      // back to 20-byte chunks only if the single write is rejected (e.g. value too long for the MTU).
      const wp = this.writeChar.properties;
      const needsResponse = !!(wp && wp.write && !wp.writeWithoutResponse);
      const writeOne = async (part) => {
        if (needsResponse && this.writeChar.writeValueWithResponse) await this.writeChar.writeValueWithResponse(part);
        else if (!needsResponse && this.writeChar.writeValueWithoutResponse) await this.writeChar.writeValueWithoutResponse(part);
        else await this.writeChar.writeValue(part);
      };
      try {
        await writeOne(packet);
      } catch (e) {
        if (!this.isConnected) throw e;
        this.trace?.(`[GATT] single write failed (${e.message || e}); retrying in ${CHUNK}-byte chunks`);
        for (let i = 0; i < packet.length; i += CHUNK) {
          await writeOne(packet.slice(i, i + CHUNK));
          if (i + CHUNK < packet.length) await sleep(12);
        }
      }
    });
  }

  async transact(spp, timeoutMs = 1000) {
    const waiter = { tid: spp[POS.TELEGRAM] };
    const reply = new Promise((resolve) => { waiter.resolve = resolve; this.waiters.add(waiter); });
    const timer = setTimeout(() => { this.waiters.delete(waiter); waiter.resolve(null); }, timeoutMs);
    this.rxBuf = new Uint8Array(0);
    try { await this.send(spp); } catch (e) { clearTimeout(timer); this.waiters.delete(waiter); throw e; }
    const res = await reply;
    clearTimeout(timer);
    return res;
  }
}
