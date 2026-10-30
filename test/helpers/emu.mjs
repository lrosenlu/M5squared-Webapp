// Test transports that behave like a wheel link but run against upstream's MockWheelSimulator (live, via a Python bridge)
// or against a recorded transcript of it (replay, used when the upstream checkout is not available).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { encryptPacket, decryptPacket } from '../../src/crypto.js';

export const UPSTREAM = process.env.M5SQ_UPSTREAM || '/home/claude/6static/m5squared';
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
export const iv = (kind, wheel, n) => Uint8Array.from({ length: 16 }, (_, j) => ((({ req: 1, resp: 2 })[kind] * 53 + wheel * 29 + n * 7 + j * 13 + 1) & 0xff));

export class LiveBridge {
  static available() { return existsSync(`${UPSTREAM}/mock_wheel/mock_wheel_simulator.py`); }
  constructor() {
    this.proc = spawn('python3', ['tools/emulator_bridge.py'], { env: { ...process.env, M5SQ_UPSTREAM: UPSTREAM, PYTHONPATH: 'tools' }, stdio: ['pipe', 'pipe', 'ignore'] });
    this.queue = []; const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (l) => this.queue.shift()?.(JSON.parse(l)));
  }
  ask(obj) { return new Promise((res) => { this.queue.push(res); this.proc.stdin.write(JSON.stringify(obj) + '\n'); }); }
  async exchange(wheel, enc) { return (await this.ask({ op: 'packet', wheel, hex: hex(enc) })).resp; }
  async state() { return (await this.ask({ op: 'state' })).state; }
  close() { this.proc.stdin.end(); this.proc.kill(); }
}

/** Replays recorded exchanges in order; a request that differs from the record is returned as an error. */
export class ReplayBridge {
  constructor(log) { this.log = log; this.i = 0; }
  async exchange(wheel, enc) {
    const e = this.log[this.i++];
    if (!e || e.w !== wheel || e.tx !== hex(enc)) throw new Error(`replay mismatch at exchange ${this.i - 1}`);
    return e.rx;
  }
  async state() { return null; }
  close() {}
}

export class EmuTransport {
  constructor(bridge, wheel, key, record) { this.bridge = bridge; this.wheel = wheel; this.key = key; this.record = record; this.n = 0; this.isConnected = true; this.name = ['left', 'right'][wheel]; }
  async _x(spp) {
    const enc = encryptPacket(spp, this.key, iv('req', this.wheel, this.n++));
    const rx = await this.bridge.exchange(this.wheel, enc);
    this.record.push({ w: this.wheel, tx_spp: hex(spp), tx: hex(enc), rx });
    if (rx) { const d = decryptPacket(unhex(rx), this.key); this.lastSource = d?.[2]; return d; }
    return null;
  }
  async send(spp) { await this._x(spp); }
  async transact(spp) { return this._x(spp); }
}
