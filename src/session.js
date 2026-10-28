// Port of ECSRemote (m25_ecs.py) for ONE wheel, plus an in-memory MockWheel.
//
// A transport carries *decrypted* SPP packets and exposes:
//   name, isConnected, send(spp), transact(spp, timeoutMs) -> Uint8Array|null, disconnect()
import {
  PacketBuilder, POS, PARAM, SVC, DEV, SYSTEM_MODE_CONNECT, DRIVE_BIT, ASSIST, SELECTABLE_PROFILES,
  parseHeader, isAck, isNack, parseSOC, parseAssistLevel, parseDriveMode, parseDriveProfile,
  parseProfileParams, parseCruiseValues, parseDuoDriveParams, parseSWVersion,
  nearestRaw, STANDARD_TIER_MAX_RAW,
} from './packets.js';
import { toHexSpaced } from './protocol.js';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Defence in depth: whatever the caller asks, remote speed is clamped here. */
export const REMOTE_SPEED_HARD_LIMIT = 250;

export class WheelSession {
  constructor(side, transport, { retries = 2, commandDelayMs = 150, replyTimeoutMs = 1000 } = {}) {
    this.side = side;
    this.transport = transport;
    this.builder = new PacketBuilder();
    this.retries = retries;
    this.commandDelayMs = commandDelayMs;
    this.replyTimeoutMs = replyTimeoutMs;
  }

  async initConnection() {
    const h = parseHeader(await this._transact(this.builder.writeSystemMode(SYSTEM_MODE_CONNECT)));
    return !!h && isAck(h);
  }

  async _transact(packet) {
    try {
      return await this.transport.transact(packet, this.replyTimeoutMs);
    } catch {
      return null;
    }
  }

  async _read(build, expected, parse) {
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const packet = build();
      const [tid, service, param] = [packet[POS.TELEGRAM], packet[POS.SERVICE], packet[POS.PARAM]];
      const h = parseHeader(await this._transact(packet));
      if (!h) { if (attempt < this.retries) await sleep(100); continue; }
      if (h.telegramId !== tid) { if (attempt < this.retries) await sleep(50); continue; }
      if (isNack(h)) break; // never retry a NACK
      // Variants differ: STATUS_* id, echoed READ_* id, ACK carrying the value, or same service.
      if (h.param === expected || h.param === param || (isAck(h) && h.payload.length) || (h.service === service && h.payload.length)) {
        const parsed = parse(h.payload);
        if (parsed !== null) return parsed;
      }
    }
    return null;
  }

  async _write(packet) {
    const tid = packet[POS.TELEGRAM];
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const h = parseHeader(await this._transact(packet));
      if (!h) { if (attempt < this.retries) await sleep(100); continue; }
      if (h.telegramId !== tid) { if (attempt < this.retries) await sleep(50); continue; }
      if (isNack(h)) return false;
      if (isAck(h)) return true;
    }
    return false;
  }

  async readStatus() {
    const b = this.builder;
    const s = {};
    await this.initConnection(); await sleep(this.commandDelayMs);
    s.battery = await this._read(() => b.readSOC(), PARAM.STATUS_SOC, parseSOC); await sleep(this.commandDelayMs);
    s.assistLevel = await this._read(() => b.readAssistLevel(), PARAM.STATUS_ASSIST_LEVEL, parseAssistLevel); await sleep(this.commandDelayMs);
    s.driveMode = await this._read(() => b.readDriveMode(), PARAM.STATUS_DRIVE_MODE, parseDriveMode); await sleep(this.commandDelayMs);
    s.profile = await this._read(() => b.readDriveProfile(), PARAM.STATUS_PROFILE, parseDriveProfile); await sleep(this.commandDelayMs);
    const level = s.assistLevel ?? ASSIST.NORMAL;
    s.params = await this._read(() => b.readProfileParams(level), PARAM.STATUS_PROFILE_PARAMS, parseProfileParams); await sleep(this.commandDelayMs);
    s.cruise = await this._read(() => b.readCruiseValues(), PARAM.CRUISE_VALUES, parseCruiseValues); await sleep(this.commandDelayMs);
    s.duo = await this._read(() => b.readDuoDriveParams(), PARAM.STATUS_DUO, parseDuoDriveParams); await sleep(this.commandDelayMs);
    s.firmware = await this._read(() => b.readSWVersion(), PARAM.STATUS_SW_VERSION, parseSWVersion);
    s.updated = Date.now();
    s.hasData = [s.battery, s.assistLevel, s.driveMode, s.firmware].some((v) => v !== null);
    return s;
  }

  async readProfileParams(level) {
    await this.initConnection(); await sleep(this.commandDelayMs);
    return this._read(() => this.builder.readProfileParams(level), PARAM.STATUS_PROFILE_PARAMS, parseProfileParams);
  }

  async writeAssistLevel(level) {
    if (level !== ASSIST.NORMAL && level !== ASSIST.OUTDOOR) return false; // Learning is not switchable here
    await this.initConnection(); await sleep(this.commandDelayMs);
    return this._write(this.builder.writeAssistLevel(level));
  }

  async writeAutoHold(enabled) {
    await this.initConnection(); await sleep(this.commandDelayMs);
    return this._write(this.builder.writeDriveMode(enabled ? DRIVE_BIT.AUTO_HOLD : 0));
  }

  async writeDriveProfile(profile) {
    if (!SELECTABLE_PROFILES.includes(profile)) return false;
    await this.initConnection(); await sleep(this.commandDelayMs);
    return this._write(this.builder.writeDriveProfile(profile));
  }

  /** Read-modify-write; only max speed changes. Snaps to the wheel's valid table. */
  async writeMaxSpeed(level, kmh, allowAboveStandardTier = false) {
    if (level !== ASSIST.NORMAL && level !== ASSIST.OUTDOOR) return false;
    let raw = nearestRaw(kmh);
    if (!allowAboveStandardTier) raw = Math.min(raw, STANDARD_TIER_MAX_RAW);
    const params = await this.readProfileParams(level);
    if (!params) return false;
    await sleep(this.commandDelayMs);
    return this._write(this.builder.writeProfileParams(level, { ...params, maxSpeedRaw: raw }));
  }

  /** Try cruise+remote first (many variants need it), then remote only, like upstream. */
  async enterRemoteMode() {
    await this.initConnection(); await sleep(this.commandDelayMs);
    for (const mask of [DRIVE_BIT.REMOTE | DRIVE_BIT.CRUISE, DRIVE_BIT.REMOTE]) {
      if (await this._write(this.builder.writeDriveMode(mask))) return true;
    }
    return false;
  }

  async exitRemoteMode() {
    await this.initConnection(); await sleep(this.commandDelayMs);
    return this._write(this.builder.writeDriveMode(0));
  }

  async sendRemoteSpeed(speed) {
    const s = Math.max(-REMOTE_SPEED_HARD_LIMIT, Math.min(REMOTE_SPEED_HARD_LIMIT, Math.trunc(speed)));
    try {
      await this.transport.send(this.builder.writeRemoteSpeed(s));
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------- Mock wheel

/** In-memory fake wheel speaking the same decrypted SPP protocol (demo mode and tests). */
export class MockWheel {
  constructor(name, battery = 85) {
    this.name = name;
    this.battery = battery;
    this.assistLevel = 0;
    this.driveMode = 0;
    this.profile = 1;
    this.params = {
      0: [80, 0x06, 0x83, 0x01, 0x2c, 30, 50, 20, 42, 28], // 6.0 km/h
      1: [100, 0x08, 0x1b, 0x01, 0x2c, 30, 50, 20, 42, 28], // 7.5 km/h
    };
    this.distanceCm = 123456;
    this.firmware = [0x56, 3, 5, 0];
    this.muted = false;
    this.connected = false;
    this.speeds = [];
    this.trace = null;
  }

  get isConnected() { return this.connected; }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }

  async send(spp) {
    if (!this.connected) throw new Error('Not connected');
    this._handle(spp);
  }

  async transact(spp) {
    if (!this.connected) throw new Error('Not connected');
    await sleep(15);
    return this._handle(spp);
  }

  _reply(req, param, payload) {
    return Uint8Array.from([1, req[POS.TELEGRAM], DEV.WHEEL_COMMON, DEV.SMARTPHONE, req[POS.SERVICE], param, ...payload]);
  }

  _handle(req) {
    this.trace?.(`[TX ${this.name[0]}] ${toHexSpaced(req)}`);
    if (this.muted || req.length < POS.MIN) return null;
    const svc = req[POS.SERVICE], param = req[POS.PARAM], payload = Array.from(req.slice(POS.PAYLOAD));
    const ack = () => this._reply(req, PARAM.ACK, [0]);
    const d = this.distanceCm >>> 0;
    let res = null;
    const key = `${svc}:${param}`;
    switch (key) {
      case `${SVC.APP}:${PARAM.WRITE_SYSTEM_MODE}`: res = ack(); break;
      case `${SVC.BATT}:${PARAM.READ_SOC}`: res = this._reply(req, PARAM.STATUS_SOC, [this.battery]); break;
      case `${SVC.APP}:${PARAM.READ_ASSIST_LEVEL}`: res = this._reply(req, PARAM.STATUS_ASSIST_LEVEL, [this.assistLevel]); break;
      case `${SVC.APP}:${PARAM.READ_DRIVE_MODE}`: res = this._reply(req, PARAM.STATUS_DRIVE_MODE, [this.driveMode]); break;
      case `${SVC.APP}:${PARAM.READ_PROFILE}`: res = this._reply(req, PARAM.STATUS_PROFILE, [this.profile]); break;
      case `${SVC.APP}:${PARAM.READ_PROFILE_PARAMS}`:
        res = this._reply(req, PARAM.STATUS_PROFILE_PARAMS, this.params[payload[0] ?? 0] ?? this.params[0]); break;
      case `${SVC.APP}:${PARAM.READ_CRUISE}`:
        res = this._reply(req, PARAM.CRUISE_VALUES, [this.driveMode, 0, 0, 0, this.battery,
          (d >>> 24) & 255, (d >>> 16) & 255, (d >>> 8) & 255, d & 255, 0, 42, 0, 0]); break;
      case `${SVC.APP}:${PARAM.READ_DUO}`: res = this._reply(req, PARAM.STATUS_DUO, [/left/i.test(this.name) ? 2 : 1, 3, 2]); break;
      case `${SVC.VERSION}:${PARAM.READ_SW_VERSION}`: res = this._reply(req, PARAM.STATUS_SW_VERSION, this.firmware); break;
      case `${SVC.APP}:${PARAM.WRITE_ASSIST_LEVEL}`: this.assistLevel = payload[0]; res = ack(); break;
      case `${SVC.APP}:${PARAM.WRITE_DRIVE_MODE}`: this.driveMode = payload[0]; res = ack(); break;
      case `${SVC.APP}:${PARAM.WRITE_PROFILE}`: this.profile = payload[0]; res = ack(); break;
      case `${SVC.APP}:${PARAM.WRITE_PROFILE_PARAMS}`:
        if (payload.length >= 11) this.params[payload[0]] = payload.slice(1, 11);
        res = ack(); break;
      case `${SVC.APP}:${PARAM.WRITE_REMOTE_SPEED}`:
        this.speeds.push(((payload[0] << 8) | payload[1]) << 16 >> 16);
        res = null; break; // the real wheel does not ack the speed stream
      default: res = this._reply(req, 0x82, []); // NACK_PID
    }
    if (res) this.trace?.(`[RX ${this.name[0]}] ${toHexSpaced(res)}`);
    return res;
  }
}
