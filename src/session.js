// Port of ECSRemote (m25_ecs.py) for ONE wheel, plus an in-memory MockWheel.
//
// A transport carries *decrypted* SPP packets and exposes:
//   name, isConnected, send(spp), transact(spp, timeoutMs) -> Uint8Array|null, disconnect()
import {
  PacketBuilder, POS, PARAM, SVC, DEV, SYSTEM_MODE_CONNECT, DRIVE_BIT, ASSIST, SELECTABLE_PROFILES,
  parseHeader, isAck, isNack, parseSOC, parseAssistLevel, parseDriveMode, parseDriveProfile,
  parseProfileParams, parseCruiseValues, parseDuoDriveParams, parseSWVersion,
  nearestRaw, STANDARD_TIER_MAX_RAW, MAX_SPEED_MMPS, parseBmsState, validateProfileParams,
} from './packets.js';
import { toHexSpaced } from './protocol.js';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Defence in depth: whatever the caller asks, remote speed (mm/s) is clamped here. 2361 mm/s = 8.5 km/h. */
export const REMOTE_SPEED_HARD_LIMIT = MAX_SPEED_MMPS;
export const CLASSIC_SPEED_LIMIT = 250;

// Remote-mode handshake timing, from the firmware that drives real wheels (m25_ble.cpp _connectWheel).
export const ARM_TIMING = { edgePulseMs: 45, armSettleMs: 80, rearmMs: 90, readbackMs: 180, attempts: 4, keepAliveMs: 80 };

export class WheelSession {
  constructor(side, transport, { retries = 2, commandDelayMs = 150, replyTimeoutMs = 1000, timing = ARM_TIMING, now = () => Date.now(), engine = 'classic' } = {}) {
    // 'classic': the arming/streaming that is proven on real wheels (raw speed units, <= 250). 'firmware': port of 6static/m25-remote (mm/s), experimental.
    this.engine = engine;
    this._txChain = Promise.resolve();
    this.timing = { ...ARM_TIMING, ...timing };
    this.now = now;
    this.driveBits = 0;        // last drive-mode byte we wrote (REMOTE/CRUISE/AUTO_HOLD bits)
    this.lastModeWrite = 0;
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

  /** One request/reply at a time per wheel: interleaved exchanges (e.g. a telemetry poll during a settings write) can make a wheel drop one. */
  async _transact(packet) {
    const run = this._txChain.then(async () => {
      try { return await this.transport.transact(packet, this.replyTimeoutMs); } catch { return null; }
    });
    this._txChain = run.catch(() => {});
    return run;
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
    s.src = this.transport.lastSource ?? null; // wheel's own source id: 2 = left, 3 = right
    s.updated = Date.now();
    s.hasData = [s.battery, s.assistLevel, s.driveMode, s.firmware].some((v) => v !== null);
    return s;
  }

  /** Light poll for the live gauges: cruise values (speed, push rim, soc, distance, errors) + charging flag. */
  async readTelemetry({ bms = true } = {}) {
    const b = this.builder;
    const t = { at: Date.now() };
    t.cruise = await this._read(() => b.readCruiseValues(), PARAM.CRUISE_VALUES, parseCruiseValues);
    // Upstream's tools only ever read SOC (and the cruise-values soc byte). The BMS charging flag exists in its protocol
    // table but no script uses it, so treat it as experimental: ask once, and stop asking if the wheel does not answer.
    if (bms && this.bmsSupported !== false) {
      t.bms = await this._read(() => b.readBmsState(), PARAM.STATUS_BMS_STATE, parseBmsState);
      this.bmsSupported = t.bms ? true : false;
    }
    t.battery = t.cruise ? t.cruise.batteryPercent : null;
    return t;
  }

  /**
   * Write a full profile-parameter set for one assist level and verify it by reading it back.
   * Returns { ok, before, after, error }. Values are range-checked against upstream's documented limits first.
   */
  async writeProfileParamsVerified(level, p, { allowAboveStandardTier = false } = {}) {
    if (level !== ASSIST.NORMAL && level !== ASSIST.OUTDOOR) return { ok: false, error: 'Only levels 0 and 1 have parameters' };
    const err = validateProfileParams(p);
    if (err) return { ok: false, error: err };
    const params = { ...p };
    if (!allowAboveStandardTier) params.maxSpeedRaw = Math.min(params.maxSpeedRaw, STANDARD_TIER_MAX_RAW);
    const before = await this.readProfileParams(level);
    if (!before) return { ok: false, error: 'Could not read the current parameters' };
    await sleep(this.commandDelayMs);
    if (!(await this._write(this.builder.writeProfileParams(level, params)))) return { ok: false, before, error: 'The wheel rejected the write' };
    await sleep(this.commandDelayMs);
    const after = await this.readProfileParams(level);
    const keys = ['maxTorque', 'maxSpeedRaw', 'pFactor', 'speedBias', 'speedFactor', 'rotationThreshold', 'slopeInc', 'slopeDec'];
    const same = after && keys.every((k) => after[k] === params[k]);
    return { ok: !!same, before, after, error: same ? '' : 'The wheel did not keep the values I wrote (read-back differs)' };
  }

  async readProfileParams(level) {
    await this.initConnection(); await sleep(this.commandDelayMs);
    return this._read(() => this.builder.readProfileParams(level), PARAM.STATUS_PROFILE_PARAMS, parseProfileParams);
  }

  async writeAssistLevel(level) {
    // 0 = Normal/Indoor, 1 = Outdoor, 2 = Learning (the firmware cycles all three on real wheels).
    if (![ASSIST.NORMAL, ASSIST.OUTDOOR, ASSIST.LEARNING].includes(level)) return false;
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
    const ok = await this._write(this.builder.writeProfileParams(level, { ...params, maxSpeedRaw: raw }));
    if (!ok) return false;
    // Read back the same level. Upstream is inconsistent about whether profile levels are 0/1 or 1/2
    // (its GUI passes 1 and 2), so confirm the wheel really changed what we think we changed.
    await sleep(this.commandDelayMs);
    const after = await this._read(() => this.builder.readProfileParams(level), PARAM.STATUS_PROFILE_PARAMS, parseProfileParams);
    return after === null || after.maxSpeedRaw === raw;
  }

  /**
   * Remote-mode handshake exactly as the firmware does it on real wheels (up to 4 attempts):
   * SYSTEM_MODE=connect, edge pulse 0x00 -> 0x04, then 0x06 (remote+cruise) followed by 0x04 (remote only),
   * settle, and only count success when a READ_DRIVE_MODE shows the REMOTE bit latched.
   */
  async enterRemoteMode() {
    if (this.engine !== 'firmware') {
      await this.initConnection(); await sleep(this.commandDelayMs);
      for (const mask of [DRIVE_BIT.REMOTE | DRIVE_BIT.CRUISE, DRIVE_BIT.REMOTE]) {
        if (await this._write(this.builder.writeDriveMode(mask))) { this.driveBits = mask; return true; }
      }
      return false;
    }
    const T = this.timing;
    const bits = (m) => this.builder.writeDriveMode(m);
    for (let attempt = 1; attempt <= T.attempts; attempt++) {
      const init = this.builder.writeSystemMode(SYSTEM_MODE_CONNECT);
      if (!(await this._send(init))) { await sleep(T.rearmMs); continue; }
      // Wheels answer the init; a short wait keeps the following writes from racing it.
      await sleep(T.edgePulseMs);
      if (!(await this._send(bits(0x00)))) { await sleep(T.rearmMs); continue; }
      await sleep(T.edgePulseMs);
      if (!(await this._send(bits(DRIVE_BIT.REMOTE)))) { await sleep(T.rearmMs); continue; }
      await sleep(T.edgePulseMs);
      if (attempt > 1) await sleep(T.rearmMs);
      let armed = false;
      for (const mode of [DRIVE_BIT.REMOTE | DRIVE_BIT.CRUISE, DRIVE_BIT.REMOTE]) {
        if (await this._send(bits(mode))) { armed = true; this.driveBits = mode; this.lastModeWrite = this.now(); }
        await sleep(T.edgePulseMs);
      }
      if (!armed) { await sleep(T.rearmMs); continue; }
      await sleep(T.armSettleMs);
      if (await this._remoteLatched()) { return true; }
      // forced re-arm, then one more readback (firmware does the same)
      for (const mode of [DRIVE_BIT.REMOTE | DRIVE_BIT.CRUISE, DRIVE_BIT.REMOTE]) { if (await this._send(bits(mode))) this.driveBits = mode; }
      await sleep(T.readbackMs);
      if (await this._remoteLatched()) { return true; }
      await sleep(T.rearmMs);
    }
    this.driveBits = 0;
    return false;
  }

  async _send(packet) {
    try { await this.transport.send(packet); return true; } catch (e) { this.lastError = e?.message || String(e); this.transport.trace?.(`[TX-FAIL ${this.side}] ${this.lastError}`); return false; }
  }

  async _remoteLatched() {
    const dm = await this._read(() => this.builder.readDriveMode(), PARAM.STATUS_DRIVE_MODE, parseDriveMode);
    if (!dm) return false;
    this.driveBits = dm.raw;
    return !!(dm.raw & DRIVE_BIT.REMOTE);
  }

  async exitRemoteMode() {
    await this.initConnection(); await sleep(this.commandDelayMs);
    const ok = await this._write(this.builder.writeDriveMode(0));
    if (ok) this.driveBits = 0;
    return ok;
  }

  /** Re-write the drive-mode byte when it differs or is older than keepAliveMs: wheels drop remote mode silently. */
  async _ensureDriveMode(target) {
    const stale = this.now() - this.lastModeWrite >= this.timing.keepAliveMs;
    if (this.driveBits === target && !stale) return true;
    const ok = await this._send(this.builder.writeDriveMode(target));
    if (ok) { this.driveBits = target; this.lastModeWrite = this.now(); }
    return ok;
  }

  /**
   * One motor command in mm/s (already sign-corrected for this wheel). Like the firmware: keep REMOTE set (refreshed
   * every keepAliveMs), then write the speed. A stop writes speed 0 first, then drops CRUISE but stays in REMOTE.
   */
  async drive(mmps, isStop = false) {
    // Like the firmware's motor queue (depth 1, newest wins): never queue behind a slow write, just remember the latest.
    if (this._driveBusy) { this._pendingDrive = [mmps, isStop]; this.skippedDrives = (this.skippedDrives || 0) + 1; return this._lastDriveOk !== false; }
    this._driveBusy = true;
    try {
      let args = [mmps, isStop], ok = true;
      do { this._pendingDrive = null; ok = await this._driveNow(...args); args = this._pendingDrive; } while (args);
      this._lastDriveOk = ok; this.driveWrites = (this.driveWrites || 0) + 1;
      return ok;
    } finally { this._driveBusy = false; }
  }

  async _driveNow(mmps, isStop = false) {
    const speed = Math.max(-REMOTE_SPEED_HARD_LIMIT, Math.min(REMOTE_SPEED_HARD_LIMIT, Math.trunc(mmps)));
    if (isStop || speed === 0) {
      const sent = await this._send(this.builder.writeRemoteSpeed(0));
      if (!sent) return false;
      return this._ensureDriveMode((this.driveBits | DRIVE_BIT.REMOTE) & ~DRIVE_BIT.CRUISE & 0xff);
    }
    if (!(await this._ensureDriveMode((this.driveBits | DRIVE_BIT.REMOTE) & 0xff))) return false;
    return this._send(this.builder.writeRemoteSpeed(speed));
  }

  /** Hill hold while in remote mode keeps the REMOTE bit (the byte is written whole). */
  async setHillHold(enabled) {
    const bits = enabled ? (this.driveBits | DRIVE_BIT.AUTO_HOLD) : (this.driveBits & ~DRIVE_BIT.AUTO_HOLD);
    const ok = await this._send(this.builder.writeDriveMode(bits & 0xff));
    if (ok) { this.driveBits = bits & 0xff; this.lastModeWrite = this.now(); }
    return ok;
  }

  /** Fire-and-forget speed write, no mode handling (used for the safety stop bursts on exit). */
  async sendRemoteSpeed(speed) {
    const lim = this.engine === 'firmware' ? REMOTE_SPEED_HARD_LIMIT : CLASSIC_SPEED_LIMIT;
    const s = Math.max(-lim, Math.min(lim, Math.trunc(speed)));
    return this._send(this.builder.writeRemoteSpeed(s));
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
    this.charging = false; this.speedMmh = 0; this.pushRim = 0; this.pushCount = 42; this.error = 0;
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
        res = this._reply(req, PARAM.CRUISE_VALUES, [this.driveMode, this.pushRim & 255, (this.speedMmh >> 8) & 255, this.speedMmh & 255, this.battery,
          (d >>> 24) & 255, (d >>> 16) & 255, (d >>> 8) & 255, d & 255, (this.pushCount >> 8) & 255, this.pushCount & 255, this.error, 0]); break;
      case `${SVC.BATT}:${PARAM.READ_BMS_STATE}`: res = this._reply(req, PARAM.STATUS_BMS_STATE, [0, this.charging ? 1 : 0]); break;
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
