// Shared UI state: the two wheels, app settings, and small selectors. No rendering here; render() is registered by app.js.
import { State, DriveMode } from './drive.js';
import { store } from './ui/store.js';

export const SIDES = ['left', 'right'];
export const BATT_WARN = 30, BATT_CRITICAL = 15, BATT_LOW_CAP = 20;

export function blank() { return { transport: null, session: null, status: null, tele: null, busy: '', error: '', demo: false }; }
export const wheels = { left: blank(), right: blank() };
export const reconnecting = { left: false, right: false };
export const polling = { left: false, right: false };

export const app = {
  tab: 'wheels',
  remember: store.get('remember', false),
  allowHigh: store.get('allowHigh', false),
  log: [],
  sup: null,
  link: null,
  armInfo: null,
  driveAck: false,
  driveMode: DriveMode.SLOW,
  releaseMode: ['standard', 'firmware'].includes(store.get('releaseMode')) ? store.get('releaseMode') : 'standard',
  bmsCheck: store.get('bmsCheck', true),
  speedPct: Math.min(100, Math.max(10, Number(store.get('speedPct')) || 100)),
  invertSteering: store.get('invertSteering', false),
  useGamepad: false,
  engine: store.get('engine', 'classic'),       // 'classic' = proven on real wheels; 'core' = upstream transport; 'firmware' = m25-remote port (experimental)
  liveSpeedWhileDriving: false,
  pad: { vx: 0, vy: 0, held: false },
  keyDraft: { left: '', right: '' },
  sync: true,                             // settings that must match are ALWAYS sent to both wheels when both are connected
  wheelMode: 'dual',                      // 'dual' | 'left' | 'right'
  hillHold: false,
  probe: { side: 'left', text: '01 21', out: '' },
  editor: { level: 0, draft: null, preset: 'Standard', target: 'both', msg: '', busy: false },
};

// render() lives in app.js; screens call it through this hook so modules never import each other in a cycle.
export const hooks = { render: () => {} };
export const render = () => hooks.render();

export const trace = (line) => {
  app.log.push(line); if (app.log.length > 150) app.log.shift();
  const el = document.querySelector('#log'); if (el) el.textContent = app.log.join('\n');
};

export const connected = (s) => !!wheels[s].transport?.isConnected;
export const bothConnected = () => SIDES.every(connected);
export const driving = () => !!app.sup && app.sup.state !== State.DISCONNECTED;
export const driveSides = () => (app.wheelMode === 'dual' ? SIDES : [app.wheelMode]);
export const driveReady = () => driveSides().every(connected);

export function minBattery() {
  const v = SIDES.filter(connected).map((sd) => wheels[sd].tele?.battery ?? wheels[sd].status?.battery).filter((x) => x != null);
  return v.length ? Math.min(...v) : null;
}
export const batteryLocked = () => { const b = minBattery(); return b != null && b < BATT_CRITICAL; };

// The wheel's own source id (2 left, 3 right) is reliable; the DuoDrive "mounting" byte is not, so it is informational only.
export const srcSide = (st) => (st && st.src === 2 ? 'left' : st && st.src === 3 ? 'right' : null);
export const sideMismatch = () => SIDES.some((s) => { const m = srcSide(wheels[s].status); return m && m !== s; });
