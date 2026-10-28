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
    maxSpeed: { stop: 0, slow: 30, normal: 60, fast: 100 },
    rampRate: 50, maxRampStep: 0.25, firstStep: 0.1, invertSteering: false,
  };
}

export class Mapper {
  constructor(config = defaultMapperConfig(), now = () => Date.now() / 1000) {
    this.config = config;
    this.now = now;
    this.reset();
  }

  reset() { this.last = null; this.lastTime = 0; }

  map(state) {
    const t = this.now();
    if (!state.deadman || state.mode === DriveMode.STOP) {
      this.last = stopFrame(); this.lastTime = t;
      return stopFrame();
    }
    const vx = this.curve(this.deadzone(clamp(state.vx, -1, 1)));
    let vy = this.curve(this.deadzone(clamp(state.vy, -1, 1)));
    if (this.config.invertSteering) vy = -vy;

    let [left, right] = this.differential(vx, vy);
    const max = this.config.maxSpeed[state.mode] ?? 0;
    left = clamp(left * max, -max, max);
    right = clamp(right * max, -max, max);

    const prev = this.last ?? stopFrame();
    const raw = this.lastTime > 0 ? t - this.lastTime : this.config.firstStep;
    const dt = Math.max(0, Math.min(raw, this.config.maxRampStep));
    left = this.ramp(left, prev.left, dt);
    right = this.ramp(right, prev.right, dt);

    const frame = { left: clamp(Math.round(left), -100, 100), right: clamp(Math.round(right), -100, 100) };
    this.last = frame; this.lastTime = t;
    return frame;
  }

  deadzone(v) {
    const dz = this.config.deadzone;
    if (Math.abs(v) < dz) return 0;
    return Math.sign(v) * (Math.abs(v) - dz) / (1 - dz);
  }

  curve(v) { return v === 0 ? 0 : Math.sign(v) * Math.abs(v) ** this.config.curve; }

  differential(vx, vy) {
    let left = vx + vy, right = vx - vy;
    const m = Math.max(Math.abs(left), Math.abs(right));
    if (m > 1) { left /= m; right /= m; }
    return [left, right];
  }

  ramp(target, current, dt) {
    const maxChange = this.config.rampRate * dt;
    const delta = target - current;
    if (Math.abs(delta) <= maxChange) return target;
    return current + (delta > 0 ? maxChange : -maxChange);
  }
}

/** Two WheelSessions acting as one chair. The left wheel is mounted mirrored: its command is negated. */
export class WheelPair {
  constructor(left, right) { this.left = left; this.right = right; }

  get isConnected() { return !!(this.left.transport.isConnected && this.right.transport.isConnected); }

  async enterRemoteMode() {
    const l = await this.left.enterRemoteMode();
    const r = await this.right.enterRemoteMode();
    if (l && r) return true;
    await this.exitRemoteMode();
    return false;
  }

  async send(frame) {
    const [l, r] = await Promise.all([this.left.sendRemoteSpeed(-frame.left), this.right.sendRemoteSpeed(frame.right)]);
    return l && r;
  }

  async exitRemoteMode(pauseMs = 40) {
    for (let i = 0; i < 3; i++) {
      await Promise.all([this.left.sendRemoteSpeed(0), this.right.sendRemoteSpeed(0)]);
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    }
    await this.left.exitRemoteMode();
    await this.right.exitRemoteMode();
  }
}

export class DriveSupervisor {
  constructor(link, { mapper, loopInterval = 0.1, inputTimeout = 0.5, linkTimeout = 2.0, now = () => Date.now() / 1000 } = {}) {
    this.link = link;
    this.now = now;
    this.mapper = mapper ?? new Mapper(defaultMapperConfig(), now);
    this.loopInterval = loopInterval;
    this.inputTimeout = inputTimeout;
    this.linkTimeout = linkTimeout;
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
    if (this.input.deadman && !this._neutral()) { this.state = State.DRIVING; return; }
    await this._sendStop();
  }

  async _handleDriving() {
    const c = this.input;
    if (!c.deadman || this._neutral()) {
      await this._sendStop();
      if (this.state === State.DRIVING) this.state = State.ARMED;
      return;
    }
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
