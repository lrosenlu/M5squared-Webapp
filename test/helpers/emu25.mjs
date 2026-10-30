// Transport that talks to the REAL 6static/m25-emulator C++ code (protocol.h/crypto.h/packet.h/command.h/state.h/safety.h),
// compiled natively by tools/emu_shim/build.sh. One harness process per emulated wheel.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { encryptPacket, decryptPacket } from '../../src/crypto.js';

export const EMU_SRC = process.env.M25_EMULATOR || '/home/claude/ref/m25-emulator';
export const HARNESS = process.env.EMU25_BIN || '/tmp/emu_harness';
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

export function emu25Available() {
  if (!existsSync(`${EMU_SRC}/packet.h`)) return false;
  if (!existsSync(HARNESS)) spawnSync('bash', ['tools/emu_shim/build.sh'], { env: { ...process.env, M25_EMULATOR: EMU_SRC, EMU25_BIN: HARNESS } });
  return existsSync(HARNESS);
}

export class Emu25Wheel {
  constructor(name, key, { echoTid = false } = {}) {
    this.echoTid = echoTid; // the emulator ACKs with a fixed telegram id 0x01; real wheels (and upstream ECSRemote's check) expect the request's id
    this.name = name; this.key = key; this.isConnected = true; this.trace = null; this.log = [];
    this.proc = spawn(HARNESS, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.q = []; createInterface({ input: this.proc.stdout }).on('line', (l) => this.q.shift()?.(l));
    this.cmd(`K ${hex(key)}`, false);
    this.t0 = 0;
  }
  cmd(line, wait = true) { return new Promise((res) => { if (wait) this.q.push(res); this.proc.stdin.write(line + '\n'); if (!wait) res(); }); }
  setClock(ms) { return this.cmd(`M ${Math.round(ms)}`, false); }
  async state() { const [speed, driveMode, hillHold, assist, battery, profile, cruise] = (await this.cmd('S')).split(' ').map(Number); return { speed, driveMode, hillHold, assist, battery, profile, cruise }; }
  async timeoutCheck() { return (await this.cmd('W')) === 'TIMEOUT'; }
  async _x(spp) {
    const enc = encryptPacket(spp, this.key);
    const [ok, kind, resp] = (await this.cmd(`F ${hex(enc)}`)).split(' ');
    const rx = resp && resp !== '-' ? decryptPacket(unhex(resp), this.key) : null;
    this.log.push({ tx: hex(spp), ok, kind, rx: rx ? hex(rx) : null });
    if (rx && this.echoTid) rx[1] = spp[1];
    if (rx) this.lastSource = rx[2];
    return { ok: ok === 'OK', rx };
  }
  async send(spp) { await this._x(spp); }
  async transact(spp) { return (await this._x(spp)).rx; }
  async disconnect() { this.isConnected = false; this.proc.stdin.end(); this.proc.kill(); }
}
