// In-memory fake wheel for demo mode and the tests. Speaks the same decrypted SPP protocol as a real wheel (see session.js).
import { POS, PARAM, SVC, DEV } from './packets.js';
import { toHexSpaced } from './protocol.js';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

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
    this.charging = false; this.speedMmps = 0; this.pushRim = 0; this.pushCount = 42; this.error = 0;
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
        res = this._reply(req, PARAM.CRUISE_VALUES, [this.driveMode, this.pushRim & 255, (this.speedMmps >> 8) & 255, this.speedMmps & 255, this.battery,
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
