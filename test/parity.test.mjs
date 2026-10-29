// Differential tests: every expectation comes from running the UPSTREAM Python (tools/gen_parity.py).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../src/packets.js';
import { fromHex, toHex } from '../src/protocol.js';

const V = JSON.parse(readFileSync(new URL('./parity.json', import.meta.url)));
const C = V.constants;

test('protocol constants equal upstream', () => {
  const eq = (js, py, name) => assert.equal(js, C[py], `${name} (${py})`);
  eq(P.PARAM.READ_SOC, 'PARAM_ID_READ_SOC', 'READ_SOC'); eq(P.PARAM.STATUS_SOC, 'PARAM_ID_STATUS_SOC', 'STATUS_SOC');
  eq(P.PARAM.READ_ASSIST_LEVEL, 'PARAM_ID_READ_ASSIST_LEVEL'); eq(P.PARAM.STATUS_ASSIST_LEVEL, 'PARAM_ID_STATUS_ASSIST_LEVEL');
  eq(P.PARAM.READ_DRIVE_MODE, 'PARAM_ID_READ_DRIVE_MODE'); eq(P.PARAM.STATUS_DRIVE_MODE, 'PARAM_ID_STATUS_DRIVE_MODE');
  eq(P.PARAM.READ_PROFILE, 'PARAM_ID_READ_DRIVE_PROFILE'); eq(P.PARAM.STATUS_PROFILE, 'PARAM_ID_STATUS_DRIVE_PROFILE');
  eq(P.PARAM.READ_PROFILE_PARAMS, 'PARAM_ID_READ_DRIVE_PROFILE_PARAMS'); eq(P.PARAM.STATUS_PROFILE_PARAMS, 'PARAM_ID_STATUS_DRIVE_PROFILE_PARAMS');
  eq(P.PARAM.READ_CRUISE, 'PARAM_ID_READ_CRUISE_VALUES'); eq(P.PARAM.CRUISE_VALUES, 'PARAM_ID_CRUISE_VALUES');
  eq(P.PARAM.READ_DUO, 'PARAM_ID_READ_DUO_DRIVE_PARAMS'); eq(P.PARAM.STATUS_DUO, 'PARAM_ID_STATUS_DUO_DRIVE_PARAMS');
  eq(P.PARAM.READ_SW_VERSION, 'PARAM_ID_READ_SW_VERSION'); eq(P.PARAM.STATUS_SW_VERSION, 'PARAM_ID_STATUS_SW_VERSION');
  eq(P.PARAM.WRITE_ASSIST_LEVEL, 'PARAM_ID_WRITE_ASSIST_LEVEL'); eq(P.PARAM.WRITE_DRIVE_MODE, 'PARAM_ID_WRITE_DRIVE_MODE');
  eq(P.PARAM.WRITE_PROFILE, 'PARAM_ID_WRITE_DRIVE_PROFILE'); eq(P.PARAM.WRITE_PROFILE_PARAMS, 'PARAM_ID_WRITE_DRIVE_PROFILE_PARAMS');
  eq(P.PARAM.WRITE_REMOTE_SPEED, 'PARAM_ID_WRITE_REMOTE_SPEED'); eq(P.PARAM.ACK, 'PARAM_ID_ACK');
  eq(P.PARAM.WRITE_SYSTEM_MODE, 'PARAM_ID_WRITE_SYSTEM_MODE'); eq(P.SYSTEM_MODE_CONNECT, 'SYSTEM_MODE_CONNECT');
  eq(P.SVC.APP, 'SERVICE_ID_APP_MGMT'); eq(P.SVC.BATT, 'SERVICE_ID_BATT_MGMT'); eq(P.SVC.VERSION, 'SERVICE_ID_VERSION_MGMT');
  eq(P.DRIVE_BIT.AUTO_HOLD, 'DRIVE_MODE_BIT_AUTO_HOLD'); eq(P.DRIVE_BIT.CRUISE, 'DRIVE_MODE_BIT_CRUISE'); eq(P.DRIVE_BIT.REMOTE, 'DRIVE_MODE_BIT_REMOTE');
  eq(P.DEV.SMARTPHONE, 'SRC_ID_SMARTPHONE'); eq(P.DEV.WHEEL_COMMON, 'DEST_ID_M25_WHEEL_COMMON'); eq(P.PROTOCOL_ID, 'PROTOCOL_ID_STANDARD');
  eq(P.POS.PROTOCOL, 'POS_PROTOCOL_ID'); eq(P.POS.TELEGRAM, 'POS_TELEGRAM_ID'); eq(P.POS.SOURCE, 'POS_SOURCE_ID');
  eq(P.POS.DEST, 'POS_DEST_ID'); eq(P.POS.SERVICE, 'POS_SERVICE_ID'); eq(P.POS.PARAM, 'POS_PARAM_ID'); eq(P.POS.PAYLOAD, 'POS_PAYLOAD');
  eq(P.POS.MIN, 'MIN_SPP_PACKET_SIZE'); eq(P.STANDARD_TIER_MAX_RAW, 'LO_SUPPORT_SPEED');
  assert.deepEqual(P.SPEED_RAW, C.MAX_SPEED_VALUES);
  assert.deepEqual(P.SPEED_RAW.filter((v) => v <= P.STANDARD_TIER_MAX_RAW), C.MAX_SPEED_VALUES_NO_MPP);
  assert.equal(P.SPEED_RAW.at(-1), C.MAX_SUPPORT_SPEED);
  assert.equal(P.KMH_PER_RAW, 0.0036);
  for (const [k, v] of Object.entries(C.ASSIST_LEVEL_NAMES)) assert.equal(P.ASSIST_NAMES[k], v);
  for (const [k, v] of Object.entries(C.PROFILE_NAMES)) assert.equal(P.PROFILES[k].replace('+', 'Plus'), v);
});

const build = {
  sysmode1: (b) => b.writeSystemMode(1),
  read_soc: (b) => b.readSOC(), read_assist_level: (b) => b.readAssistLevel(), read_drive_mode: (b) => b.readDriveMode(),
  read_drive_profile: (b) => b.readDriveProfile(), read_cruise_values: (b) => b.readCruiseValues(),
  read_duo_drive_params: (b) => b.readDuoDriveParams(), read_sw_version: (b) => b.readSWVersion(),
};
test('every builder output is byte-identical to upstream', () => {
  for (const { name, hex } of V.builders) {
    let fn = build[name], m;
    if ((m = name.match(/^read_params_(\d)$/))) fn = (b) => b.readProfileParams(+m[1]);
    else if ((m = name.match(/^write_assist_(\d)$/))) fn = (b) => b.writeAssistLevel(+m[1]);
    else if ((m = name.match(/^write_drive_mode_(\d)$/))) fn = (b) => b.writeDriveMode(+m[1]);
    else if (name === 'write_drive_mode_true') fn = (b) => b.writeDriveMode(1);
    else if (name === 'write_drive_mode_false') fn = (b) => b.writeDriveMode(0);
    else if ((m = name.match(/^write_profile_(\d)$/))) fn = (b) => b.writeDriveProfile(+m[1]);
    else if ((m = name.match(/^remote_speed_(-?\d+)$/))) fn = (b) => b.writeRemoteSpeed(+m[1]);
    else if (name === 'write_params_0') fn = (b) => b.writeProfileParams(0, { maxTorque: 100, maxSpeedRaw: 1667, pFactor: 999, speedBias: 10, speedFactor: 100, rotationThreshold: 150, slopeInc: 70, slopeDec: 20 });
    else if ((m = name.match(/^write_params_(\d+)$/))) fn = (b) => b.writeProfileParams(1, { maxTorque: 80, maxSpeedRaw: +m[1], pFactor: 300, speedBias: 30, speedFactor: 50, rotationThreshold: 20, slopeInc: 42, slopeDec: 28 });
    assert.ok(fn, `no JS mapping for ${name}`);
    assert.equal(toHex(fn(new P.PacketBuilder())), hex, name);
  }
});

test('telegram id counter matches upstream, including wrap-around', () => {
  const b = new P.PacketBuilder();
  assert.deepEqual(V.tidSequence, V.tidSequence.map(() => b.readSOC()[1]));
});

test('header parsing, ACK and NACK detection match upstream', () => {
  for (const c of V.headers) {
    const h = P.parseHeader(fromHex(c.data) ?? new Uint8Array());
    if (c.header === null) { assert.equal(h, null, c.data); continue; }
    assert.equal(h.protocolId, c.header.protocol_id); assert.equal(h.telegramId, c.header.telegram_id);
    assert.equal(h.source, c.header.source_id); assert.equal(h.dest, c.header.dest_id);
    assert.equal(h.service, c.header.service_id); assert.equal(h.param, c.header.param_id);
    assert.equal(toHex(h.payload), c.header.payload);
    assert.equal(P.isNack(h), c.nack); assert.equal(P.isAck(h), c.ack);
  }
});

const PARSE = {
  soc: (p, r) => assert.equal(P.parseSOC(p), r),
  assist_level: (p, r) => { const v = P.parseAssistLevel(p); assert.equal(v, r === null ? null : r.value); },
  drive_mode: (p, r) => {
    const v = P.parseDriveMode(p);
    if (r === null) return assert.equal(v, null);
    assert.deepEqual([v.raw, v.autoHold, v.cruise, v.remote], [r.value, r.auto_hold, r.cruise, r.remote]);
  },
  drive_profile: (p, r) => assert.equal(P.parseDriveProfile(p), r === null ? null : r.value),
  drive_profile_params: (p, r) => {
    const v = P.parseProfileParams(p);
    if (r === null) return assert.equal(v, null);
    assert.deepEqual([v.maxTorque, v.maxSpeedRaw, v.pFactor, v.speedBias, v.speedFactor, v.rotationThreshold, v.slopeInc, v.slopeDec],
      [r.max_torque, r.max_speed_raw, r.p_factor, r.speed_bias, r.speed_factor, r.rotation_threshold, r.slope_inc, r.slope_dec]);
    assert.ok(Math.abs(v.maxSpeedKmh - r.max_speed) < 1e-9);
  },
  cruise_values: (p, r) => {
    const v = P.parseCruiseValues(p);
    if (r === null) return assert.equal(v, null);
    assert.equal(v.distanceKm, r.distance_km); // only the distance is used/verified; other fields are extra
  },
  sw_version: (p, r) => {
    const v = P.parseSWVersion(p);
    if (r === null) return assert.equal(v, null);
    assert.deepEqual([v.text, v.major, v.minor, v.patch], [r.version_str, r.major, r.minor, r.patch]);
  },
  duo_drive_params: (p, r) => {
    const v = P.parseDuoDriveParams(p);
    if (r === null) return assert.equal(v, null);
    assert.deepEqual([v.mountingSide, v.speedSensibility, v.steeringDynamic], [r.mounting_side, r.speed_sensibility, r.steering_dynamic]);
    if (/^Unknown\(/.test(r.mounting_name)) assert.equal(v.mounting, 'Unknown'); else assert.equal(v.mounting, r.mounting_name);
  },
};
for (const [name, cases] of Object.entries(V.parsers)) {
  test(`parser ${name} matches upstream on ${cases.length} payloads`, () => {
    for (const c of cases) PARSE[name](fromHex(c.payload) ?? new Uint8Array(), c.result);
  });
}

// ---- Mapper: deadzone, curve, speed caps vs the real upstream core/mapper.py (ramping disabled).
// Documented deviation: steering sign is mirrored (upstream: left = vx - vy; here: left = vx + vy),
// so JS (left, right) must equal upstream (right, left). Python rounds half-to-even, JS half-up: allow 1 unit.
import { Mapper, defaultMapperConfig } from '../src/drive.js';
test(`mapper matches upstream (mirrored steering) on ${V.mapper.length} inputs`, () => {
  let t = 100;
  for (const c of V.mapper) {
    const cfg = defaultMapperConfig(); cfg.rampRate = 1e9;
    const m = new Mapper(cfg, () => (t += 1));
    const f = m.map({ vx: c.vx, vy: c.vy, deadman: c.deadman !== false, mode: c.mode });
    const near = (a, b) => Math.abs(a - b) <= 1;
    assert.ok(near(f.left, c.right) && near(f.right, c.left), `${JSON.stringify(c)} -> JS ${JSON.stringify(f)}`);
  }
});

test('with invertSteering the mapper is exactly upstream orientation', () => {
  let t = 100;
  for (const c of V.mapper) {
    const cfg = defaultMapperConfig(); cfg.rampRate = 1e9; cfg.invertSteering = true;
    const m = new Mapper(cfg, () => (t += 1));
    const f = m.map({ vx: c.vx, vy: c.vy, deadman: c.deadman !== false, mode: c.mode });
    assert.ok(Math.abs(f.left - c.left) <= 1 && Math.abs(f.right - c.right) <= 1, JSON.stringify(c));
  }
});
