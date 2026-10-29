import { percentToMmps } from "./packets.js";
// Port of core/types.py, core/mapper.py and core/supervisor.py. SAFETY-CRITICAL.
//
// Deliberate differences from the Python original (same as the iOS port):
//  1. Steering sign: positive vy is a RIGHT turn (left = vx + vy, right = vx - vy). Upstream
//     had it reversed. `invertSteering` flips it if testing on blocks shows otherwise.
//  2. Ramping always starts from zero after a stop, and the time step is capped.
//  3. No "heartbeat" replay of a stale command; the loop sends a fresh command every tick.
//  4. The input watchdog only applies while the deadman is held.

export const DriveMode = { STOP: 'stop', SLOW: 'slow', NORMAL: 'normal', FAST: 'fast' };
export const State = {
  DISCONNECTED: 'disconnected', CONNECTING: 'connecting', PAIRED: 'paired',
  ARMED: 'armed', DRIVING: 'driving', FAILSAFE: 'failsafe',
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const stopFrame = () => ({ left: 0, right: 0 });
export const isStop = (f) => f.left === 0 && f.right === 0;

export function defaultMapperConfig() {
  return {
    deadzone: 0.1, curve: 2.0,
    maxSpeed: { stop: 0, slow: 30, normal: 60, fast: 100 }, // percent of the 10 km/h hardware scale
    maxSpeedLowBattery: 30,   // cap applied in every mode while the low-battery limit is active
    rampRate: 50,             // percent/s; <= 0 disables ramping (as in the firmware)
    reverseRatio: 1.0,        // reverse cap as a fraction of forward max (1.0 = none)
    turnReduction: 0.0,       // inner-wheel softening (0 = none)
    maxRampStep: 0.25, firstStep: 0.1, invertSteering: false,
  };
}

/** Same rounding as C roundf(): half away from zero (Math.round rounds -2.5 to -2). */
const roundHalfAway = (v) => Math.sign(v) * Math.round(Math.abs(v));

export class Mapper {
  constructor(config = defaultMapperConfig(), now = () => Date.now() / 1000) {
    this.config = config;
    this.now = now;
    this.lowBattery = false;
    this.reset();
  }

  reset() { this.last = null; this.lastTime = 0; }
  setLowBatteryLimit(active) { this.lowBattery = !!active; }

  map(state) {
    const t = this.now();
    if (!state.deadman || state.mode === DriveMode.STOP) {
      this.last = stopFrame(); this.lastTime = t;
      return stopFrame();
    }
    const c = this.config;
    const vx = this.curve(this.deadzone(clamp(state.vx, -1, 1)));
    let vy = this.curve(this.deadzone(clamp(state.vy, -1, 1)));
    if (c.invertSteering) vy = -vy;

    let [left, right] = this.differential(vx, vy);
    let max = c.maxSpeed[state.mode] ?? 0;
    if (this.lowBattery && max > c.maxSpeedLowBattery) max = c.maxSpeedLowBattery;
    left = clamp(left * max, -max, max);
    right = clamp(right * max, -max, max);

    if (c.reverseRatio < 1) {
      const reverseMax = max * c.reverseRatio;
      if (left < -reverseMax) left = -reverseMax;
      if (right < -reverseMax) right = -reverseMax;
    }

    if (c.rampRate > 0) {
      const prev = this.last ?? stopFrame();
      // Whole milliseconds, like the firmware's millis(): no float noise on exact x.5 ramp steps.
      const rawMs = this.lastTime > 0 ? Math.round((t - this.lastTime) * 1000) : Math.round(c.firstStep * 1000);
      const dtMs = Math.max(0, Math.min(rawMs, Math.round(c.maxRampStep * 1000)));
      left = this.ramp(left, prev.left, dtMs);
      right = this.ramp(right, prev.right, dtMs);
    }

    const frame = { left: clamp(roundHalfAway(left), -100, 100), right: clamp(roundHalfAway(right), -100, 100) };
    this.last = frame; this.lastTime = t;
    return frame;
  }

  deadzone(v) {
    const dz = this.config.deadzone;
    if (Math.abs(v) < dz) return 0;
    return Math.sign(v) * (Math.abs(v) - dz) / (1 - dz);
  }

  curve(v) { return v === 0 ? 0 : Math.sign(v) * Math.abs(v) ** this.config.curve; }

  /** Positive vy = right turn: left = vx + vy, right = vx - vy. The INNER wheel's turn term is softened. */
  differential(vx, vy) {
    const soft = 1 - this.config.turnReduction;
    const leftTurn = vy < 0 ? vy * soft : vy;
    const rightTurn = vy >= 0 ? vy * soft : vy;
    let left = vx + leftTurn, right = vx - rightTurn;
    const m = Math.max(Math.abs(left), Math.abs(right));
    if (m > 1) { left /= m; right /= m; }
    return [left, right];
  }

  ramp(target, current, dtMs) {
    const maxChange = (this.config.rampRate * dtMs) / 1000;
    const delta = target - current;
    if (Math.abs(delta) <= maxChange) return target;
    return current + (delta > 0 ? maxChange : -maxChange);
  }
}

/** Two WheelSessions acting as one chair. The left wheel is mounted mirrored: its command is negated. */
export class WheelPair {
  /** `mode`: 'dual' | 'left' | 'right'. In single-wheel modes the other session may be null. */
  constructor(left, right, mode = 'dual') { this.left = left; this.right = right; this.mode = mode; }

  get active() {
    return [this.mode !== 'right' ? this.left : null, this.mode !== 'left' ? this.right : null].filter(Boolean);
  }

  get isConnected() { return this.active.length > 0 && this.active.every((w) => w.transport.isConnected); }

  async enterRemoteMode() {
    const results = [];
    for (const w of this.active) results.push(await w.enterRemoteMode());
    if (results.every(Boolean)) return true;
    await this.exitRemoteMode();
    return false;
  }

  /** frame is in percent; converted to mm/s here, left wheel mirrored. A single wheel gets its own side of the frame. */
  async send(frame) {
    const isStop = frame.left === 0 && frame.right === 0;
    const jobs = [];
    if (this.mode !== 'right' && this.left) jobs.push(this.left.drive(-percentToMmps(frame.left), isStop));
    if (this.mode !== 'left' && this.right) jobs.push(this.right.drive(percentToMmps(frame.right), isStop));
    const r = await Promise.all(jobs);
    return r.every(Boolean);
  }

  async exitRemoteMode(pauseMs = 40) {
    for (let i = 0; i < 3; i++) {
      await Promise.all(this.active.map((w) => w.sendRemoteSpeed(0)));
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    }
    for (const w of this.active) await w.exitRemoteMode();
  }
}

export class DriveSupervisor {
  constructor(link, { mapper, loopInterval = 0.05, inputTimeout = 0.5, linkTimeout = 2.0, armIdleTimeout = 60, now = () => Date.now() / 1000 } = {}) {
    this.link = link;
    this.now = now;
    this.mapper = mapper ?? new Mapper(defaultMapperConfig(), now);
    this.loopInterval = loopInterval;
    this.inputTimeout = inputTimeout;
    this.linkTimeout = linkTimeout;
    this.armIdleTimeout = armIdleTimeout; // seconds armed without movement before auto-disarm (0 = never)
    this.lastActiveTime = 0;
    this._state = State.DISCONNECTED;
    this.failsafeReason = null;
    this.lastCommand = stopFrame();
    this.onStateChange = null;
    this.onCommand = null;
    this.input = { vx: 0, vy: 0, deadman: false, mode: DriveMode.SLOW };
    this.lastInputTime = 0;
    this.lastLinkTime = 0;
    this.timer = null;
  }

  get state() { return this._state; }
  set state(s) {
    const old = this._state;
    this._state = s;
    if (old !== s) this.onStateChange?.(old, s);
  }

  /** Call on every control change AND periodically (>= 2 Hz) while the deadman is held. */
  setInput(vx, vy, deadman, mode) {
    this.input = { vx: clamp(vx, -1, 1), vy: clamp(vy, -1, 1), deadman, mode };
    this.lastInputTime = this.now();
  }

  setLowBattery(active) { this.mapper.setLowBatteryLimit(active); }

  async connect() {
    if (this.state !== State.DISCONNECTED) return this.state !== State.FAILSAFE;
    this.failsafeReason = null;
    this.state = State.CONNECTING;
    const ok = await this.link.enterRemoteMode();
    this.state = ok ? State.PAIRED : State.DISCONNECTED;
    if (ok) this.lastLinkTime = this.now();
    return ok;
  }

  arm() {
    if (this.state !== State.PAIRED) return;
    this.mapper.reset();
    this.lastLinkTime = this.now();
    this.lastInputTime = this.now();
    this.lastActiveTime = this.now();
    this.state = State.ARMED;
  }

  async disarm() {
    if (this.state !== State.ARMED && this.state !== State.DRIVING) return;
    await this._sendStop();
    this.state = State.PAIRED;
  }

  /** Synchronous state change so a button acts instantly; stop frames follow asynchronously. */
  emergencyStop(reason = 'Emergency stop') {
    if (this.state === State.DISCONNECTED || this.state === State.FAILSAFE) return;
    this.failsafeReason = reason;
    this.input = { vx: 0, vy: 0, deadman: false, mode: this.input.mode };
    this.mapper.reset();
    this.state = State.FAILSAFE;
    this._sendStop().then(() => this._sendStop());
  }

  async reset() {
    this.stopLoop();
    await this._sendStop();
    await this.link.exitRemoteMode();
    this.mapper.reset();
    this.failsafeReason = null;
    this.state = State.DISCONNECTED;
  }

  async shutdown() {
    if (this.state === State.DISCONNECTED) { this.stopLoop(); return; }
    await this.reset();
  }

  startLoop() {
    if (this.timer) return;
    const run = async () => {
      await this.tick();
      if (this.timer) this.timer = setTimeout(run, Math.max(10, this.loopInterval * 1000));
    };
    this.timer = setTimeout(run, 0);
  }

  stopLoop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  async tick() {
    switch (this.state) {
      case State.DISCONNECTED: case State.CONNECTING: case State.PAIRED: return;
      case State.ARMED: await this._handleArmed(); break;
      case State.DRIVING: await this._handleDriving(); break;
      case State.FAILSAFE:
        await this._sendStop();
        if (!this.link.isConnected) this.state = State.DISCONNECTED;
        return;
    }
    if (this.state === State.ARMED || this.state === State.DRIVING) await this._checkWatchdogs();
  }

  _neutral() { return Math.abs(this.input.vx) < 0.01 && Math.abs(this.input.vy) < 0.01; }

  async _handleArmed() {
    if (this.input.deadman && !this._neutral()) { this.lastActiveTime = this.now(); this.state = State.DRIVING; return; }
    if (this.armIdleTimeout > 0 && this.now() - this.lastActiveTime > this.armIdleTimeout) { await this._sendStop(); this.state = State.PAIRED; return; }
    await this._sendStop();
  }

  async _handleDriving() {
    const c = this.input;
    if (!c.deadman || this._neutral()) {
      await this._sendStop();
      if (this.state === State.DRIVING) this.state = State.ARMED;
      return;
    }
    this.lastActiveTime = this.now();
    const cmd = this.mapper.map(c);
    const ok = await this.link.send(cmd);
    if (ok && this.state === State.DRIVING) this.lastLinkTime = this.now();
    this.lastCommand = cmd;
    this.onCommand?.(cmd);
  }

  async _checkWatchdogs() {
    const t = this.now();
    if (!this.link.isConnected) return this._failsafe('Wheel connection lost');
    if (this.input.deadman && t - this.lastInputTime > this.inputTimeout) return this._failsafe('Input timeout');
    if (t - this.lastLinkTime > this.linkTimeout) return this._failsafe('Link timeout');
  }

  async _failsafe(reason) {
    if (this.state === State.FAILSAFE) return;
    this.failsafeReason = reason;
    this.input = { vx: 0, vy: 0, deadman: false, mode: this.input.mode };
    this.mapper.reset();
    this.state = State.FAILSAFE;
    await this._sendStop();
  }

  async _sendStop() {
    this.mapper.reset();
    this.lastCommand = stopFrame();
    const ok = await this.link.send(stopFrame());
    if (ok && this.state !== State.FAILSAFE) this.lastLinkTime = this.now();
    this.onCommand?.(stopFrame());
  }
}
