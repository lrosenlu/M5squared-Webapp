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
    this.notifyChar.addEventListener('characteristicvaluechanged', this._onValue);
    await this.notifyChar.startNotifications();
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
    this._failWaiters();
    try { this.notifyChar?.removeEventListener('characteristicvaluechanged', this._onValue); } catch { /* ignore */ }
    try { this.device.removeEventListener('gattserverdisconnected', this._onGatt); } catch { /* ignore */ }
    try { this.device.gatt?.disconnect(); } catch { /* ignore */ }
  }

  _failWaiters() { for (const w of this.waiters) w.resolve(null); this.waiters.clear(); }

  // ---- receive: reassemble, try to decrypt, discard junk
  _receive(chunk) {
    this.rxBuf = concat(this.rxBuf, chunk);
    if (this.rxBuf.length > MAX_FRAME_LENGTH * 2) this.rxBuf = this.rxBuf.slice(-MAX_FRAME_LENGTH);
    const spp = decryptPacket(this.rxBuf, this.key);
    if (!spp) return; // incomplete or corrupt; keep buffering (bounded above)
    this.rxBuf = new Uint8Array(0);
    this.trace?.(`[RX ${this.name}] ${toHexSpaced(spp)}`);
    for (const w of [...this.waiters]) {
      if (w.tid === spp[POS.TELEGRAM]) { this.waiters.delete(w); w.resolve(spp); }
    }
  }

  // ---- send: serialize GATT operations, chunk to 20 bytes
  _enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async send(spp) {
    if (!this.isConnected) throw new Error('Not connected');
    this.trace?.(`[TX ${this.name}] ${toHexSpaced(spp)}`);
    const packet = encryptPacket(spp, this.key);
    return this._enqueue(async () => {
      for (let i = 0; i < packet.length; i += CHUNK) {
        const part = packet.slice(i, i + CHUNK);
        if (this.writeChar.writeValueWithoutResponse) await this.writeChar.writeValueWithoutResponse(part);
        else await this.writeChar.writeValue(part);
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
