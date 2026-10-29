// Port of PacketBuilder/ECSPacketBuilder (m25_spp.py, m25_ecs.py), ResponseParser, and the
// subset of m25_protocol_data.py this app uses.
//
// Deliberately NOT ported: factory reset, software reset, pairing, memory/firmware blocks,
// key management and the Intellion maintenance services.

export const PROTOCOL_ID = 0x01;
export const DEV = { WHEEL_COMMON: 1, SMARTPHONE: 5 };
/** Source id a wheel puts in its replies (m25_protocol_data SRC_ID_M25_WHEEL_*). Independent of the DuoDrive mounting setting. */
export const WHEEL_SRC = { COMMON: 1, LEFT: 2, RIGHT: 3 };

// Remote speed is a signed int16 in mm/s. The firmware (6static/m25-remote) maps joystick percent to mm/s with
// 100 % = 10 km/h and never exceeds 2361 mm/s = 8.5 km/h, whatever the percent. The Python toolkit's own
// "parking" speeds (80/150/250) are in the same unit.
export const SPEED_SCALE = 27.7778;
export const MAX_SPEED_MMPS = 2361;
/** percent (-100..100) -> mm/s, truncating toward zero like the firmware's int16 cast, clamped to +-MAX_SPEED_MMPS. */
export const percentToMmps = (pct) => Math.max(-MAX_SPEED_MMPS, Math.min(MAX_SPEED_MMPS, Math.trunc(pct * SPEED_SCALE)));
export const SVC = { APP: 1, BATT: 8, VERSION: 10 };
export const POS = { PROTOCOL: 0, TELEGRAM: 1, SOURCE: 2, DEST: 3, SERVICE: 4, PARAM: 5, PAYLOAD: 6, MIN: 6 };

export const PARAM = {
  ACK: 0xff,
  WRITE_SYSTEM_MODE: 0x10, READ_SYSTEM_MODE: 0x11,
  WRITE_DRIVE_MODE: 0x20, READ_DRIVE_MODE: 0x21, STATUS_DRIVE_MODE: 0x22,
  WRITE_REMOTE_SPEED: 0x30,
  WRITE_ASSIST_LEVEL: 0x40, READ_ASSIST_LEVEL: 0x41, STATUS_ASSIST_LEVEL: 0x42,
  WRITE_PROFILE_PARAMS: 0x50, READ_PROFILE_PARAMS: 0x51, STATUS_PROFILE_PARAMS: 0x52,
  WRITE_PROFILE: 0x60, READ_PROFILE: 0x61, STATUS_PROFILE: 0x62,
  READ_CRUISE: 0xd1, CRUISE_VALUES: 0xd2,
  READ_DUO: 0xf1, STATUS_DUO: 0xf2,
  READ_SOC: 0x11, STATUS_SOC: 0x12,
  READ_SW_VERSION: 0x21, STATUS_SW_VERSION: 0x22,
};

export const SYSTEM_MODE_CONNECT = 0x01;
export const DRIVE_BIT = { AUTO_HOLD: 0x01, CRUISE: 0x02, REMOTE: 0x04 };
export const ASSIST = { NORMAL: 0, OUTDOOR: 1, LEARNING: 2 };
export const ASSIST_NAMES = { 0: 'Normal', 1: 'Outdoor', 2: 'Learning' };
export const PROFILES = { 0: 'Customized', 1: 'Standard', 2: 'Sensitive', 3: 'Soft', 4: 'Active', 5: 'Sensitive+' };
export const SELECTABLE_PROFILES = [1, 2, 3, 4, 5, 0];

/** Valid max-speed register values (mm/s): 2.0 .. 8.5 km/h in 0.5 steps. */
export const SPEED_RAW = [556, 694, 833, 972, 1111, 1250, 1389, 1528, 1667, 1806, 1944, 2083, 2222, 2361];
export const STANDARD_TIER_MAX_RAW = 1667; // 6.0 km/h, the cap without the "M++" licence
export const KMH_PER_RAW = 0.0036;

export const rawToKmh = (raw) => raw * KMH_PER_RAW;
export function nearestRaw(kmh) {
  const target = kmh / KMH_PER_RAW;
  return SPEED_RAW.reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best), SPEED_RAW[0]);
}
export function selectableKmh(allowHigh) {
  const limit = allowHigh ? SPEED_RAW[SPEED_RAW.length - 1] : STANDARD_TIER_MAX_RAW;
  return SPEED_RAW.filter((v) => v <= limit).map((v) => Math.round(rawToKmh(v) * 2) / 2);
}

export class PacketBuilder {
  constructor(destId = DEV.WHEEL_COMMON, startTelegramId = 0x80) {
    this.dest = destId;
    this.tid = startTelegramId;
  }

  packet(service, param, payload = []) {
    const tid = this.tid;
    this.tid = (this.tid + 1) & 0xff;
    return Uint8Array.from([PROTOCOL_ID, tid, DEV.SMARTPHONE, this.dest, service, param, ...payload]);
  }

  readSystemMode() { return this.packet(SVC.APP, PARAM.READ_SYSTEM_MODE); }
  readSOC() { return this.packet(SVC.BATT, PARAM.READ_SOC); }
  readAssistLevel() { return this.packet(SVC.APP, PARAM.READ_ASSIST_LEVEL); }
  readDriveMode() { return this.packet(SVC.APP, PARAM.READ_DRIVE_MODE); }
  readDriveProfile() { return this.packet(SVC.APP, PARAM.READ_PROFILE); }
  readProfileParams(level) { return this.packet(SVC.APP, PARAM.READ_PROFILE_PARAMS, [level]); }
  readCruiseValues() { return this.packet(SVC.APP, PARAM.READ_CRUISE); }
  readDuoDriveParams() { return this.packet(SVC.APP, PARAM.READ_DUO); }
  readSWVersion() { return this.packet(SVC.VERSION, PARAM.READ_SW_VERSION); }

  writeSystemMode(mode) { return this.packet(SVC.APP, PARAM.WRITE_SYSTEM_MODE, [mode]); }
  writeAssistLevel(level) { return this.packet(SVC.APP, PARAM.WRITE_ASSIST_LEVEL, [level]); }
  writeDriveMode(mask) { return this.packet(SVC.APP, PARAM.WRITE_DRIVE_MODE, [mask & 0xff]); }
  writeDriveProfile(profile) { return this.packet(SVC.APP, PARAM.WRITE_PROFILE, [profile]); }

  /** Signed 16-bit big-endian. */
  writeRemoteSpeed(speed) {
    const v = Math.max(-32768, Math.min(32767, Math.trunc(speed))) & 0xffff;
    return this.packet(SVC.APP, PARAM.WRITE_REMOTE_SPEED, [v >> 8, v & 0xff]);
  }

  /** 11-byte payload exactly as upstream builds it (assist level first). */
  writeProfileParams(level, p) {
    const b = (n) => Math.max(0, Math.min(255, n));
    return this.packet(SVC.APP, PARAM.WRITE_PROFILE_PARAMS, [
      level, b(p.maxTorque), (p.maxSpeedRaw >> 8) & 0xff, p.maxSpeedRaw & 0xff,
      (p.pFactor >> 8) & 0xff, p.pFactor & 0xff,
      b(p.speedBias), b(p.speedFactor), b(p.rotationThreshold), b(p.slopeInc), b(p.slopeDec),
    ]);
  }
}

// ---------------------------------------------------------------- parsing

export function parseHeader(d) {
  if (!d || d.length < POS.MIN) return null;
  return {
    protocolId: d[0], telegramId: d[1], source: d[2], dest: d[3], service: d[4], param: d[5],
    payload: d.slice(POS.PAYLOAD),
  };
}

export const isNack = (h) => h.param >= 0x80 && h.param <= 0x88;
export const isAck = (h) => h.param === PARAM.ACK;

export const parseSOC = (p) => (p.length >= 1 ? p[0] : null);
export const parseAssistLevel = (p) => (p.length >= 1 ? p[0] : null);
export const parseDriveProfile = (p) => (p.length >= 1 ? p[0] : null);

export function parseDriveMode(p) {
  if (p.length < 1) return null;
  return { raw: p[0], autoHold: !!(p[0] & DRIVE_BIT.AUTO_HOLD), cruise: !!(p[0] & DRIVE_BIT.CRUISE), remote: !!(p[0] & DRIVE_BIT.REMOTE) };
}

export function parseProfileParams(p) {
  if (p.length < 10) return null;
  const maxSpeedRaw = (p[1] << 8) | p[2];
  return {
    maxTorque: p[0], maxSpeedRaw, maxSpeedKmh: rawToKmh(maxSpeedRaw), pFactor: (p[3] << 8) | p[4],
    speedBias: p[5], speedFactor: p[6], rotationThreshold: p[7], slopeInc: p[8], slopeDec: p[9],
  };
}

export function parseCruiseValues(p) {
  if (p.length < 12) return null;
  const distanceRaw = ((p[5] << 24) | (p[6] << 16) | (p[7] << 8) | p[8]) >>> 0;
  return {
    driveMode: parseDriveMode([p[0]]),
    pushRim: (p[1] << 24) >> 24,
    speedKmh: ((p[2] << 8) | p[3]) * 0.001,
    batteryPercent: p[4],
    distanceKm: (distanceRaw * 0.01) / 1000,
    pushCount: (p[9] << 8) | p[10],
    wheelError: p[11],
  };
}

export function parseDuoDriveParams(p) {
  if (p.length < 3) return null;
  return { mountingSide: p[0], mounting: { 1: 'Right', 2: 'Left' }[p[0]] ?? 'Unknown', speedSensibility: p[1], steeringDynamic: p[2] };
}

export function parseSWVersion(p) {
  let prefix, major, minor, patch;
  if (p.length === 4) {
    if (p[0] < 0x20 || p[0] > 0x7e) return null;
    [prefix, major, minor, patch] = [String.fromCharCode(p[0]), p[1], p[2], p[3]];
  } else if (p.length === 3) {
    [prefix, major, minor, patch] = ['V', p[0], p[1], p[2]];
  } else {
    return null;
  }
  const z = (n, w) => String(n).padStart(w, '0');
  return { text: `${prefix}${z(major, 2)}.${z(minor, 3)}.${z(patch, 3)}`, major, minor, patch };
}
