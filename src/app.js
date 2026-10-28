// M5Squared web app: UI wiring. All protocol/safety logic lives in the other modules.
import { parseKeyInput } from './crypto.js';
import { bluetoothSupported, bluetoothHelp, pickWheel, BLEWheelTransport } from './ble.js';
import { WheelSession, MockWheel } from './session.js';
import { WheelPair, DriveSupervisor, State, DriveMode, defaultMapperConfig, Mapper } from './drive.js';
import { ASSIST_NAMES, PROFILES, SELECTABLE_PROFILES, selectableKmh, rawToKmh } from './packets.js';

const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

// ------------------------------------------------------------------ storage (best effort)
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('m5sq.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('m5sq.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem('m5sq.' + k); } catch { /* ignore */ } },
};

// ------------------------------------------------------------------ app state
const SIDES = ['left', 'right'];
const wheels = { left: blank(), right: blank() };
function blank() { return { transport: null, session: null, status: null, busy: '', error: '', demo: false }; }

const app = {
  tab: 'wheels',
  remember: store.get('remember', false),
  allowHigh: store.get('allowHigh', false),
  showLog: false,
  log: [],
  sup: null,
  driveAck: false,
  driveMode: DriveMode.SLOW,
  invertSteering: store.get('invertSteering', false),
  pad: { vx: 0, vy: 0, held: false },
  keyDraft: { left: '', right: '' },
};

const trace = (line) => { app.log.push(line); if (app.log.length > 150) app.log.shift(); if (app.showLog && app.tab === 'about') renderLogOnly(); };

const connected = (s) => !!wheels[s].transport?.isConnected;
const bothConnected = () => SIDES.every(connected);

// ------------------------------------------------------------------ dialogs
function confirmDialog(title, body, okLabel = 'Continue') {
  const dlg = $('#dlg');
  $('#dlgTitle').textContent = title;
  $('#dlgBody').textContent = body;
  $('#dlgOk').textContent = okLabel;
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = 'cancel';
    dlg.showModal();
  });
}

// ------------------------------------------------------------------ connection
async function connectReal(side, showAll = false) {
  const w = wheels[side];
  const raw = app.keyDraft[side].trim() || store.get('key.' + side, '');
  let key;
  try { key = parseKeyInput(raw); } catch (e) { w.error = e.message; return render(); }
  w.error = ''; w.busy = 'Choose the wheel in the Bluetooth picker...'; render();
  let device;
  try { device = await pickWheel(showAll); } catch (e) { w.busy = ''; w.error = e.name === 'NotFoundError' ? 'No wheel selected.' : e.message; return render(); }
  w.busy = 'Connecting...'; render();
  const transport = new BLEWheelTransport(device, key, { trace });
  transport.onDisconnect = () => { w.error = 'Disconnected.'; render(); };
  try {
    await transport.connect();
    w.transport = transport;
    w.session = new WheelSession(side, transport);
    if (app.remember) store.set('key.' + side, raw);
    w.busy = 'Reading status...'; render();
    w.status = await w.session.readStatus();
    if (!w.status.hasData) w.error = transport.rawBytes > 0
      ? 'The wheel is sending data but it cannot be decrypted: this is the wrong key. Each wheel has its own key (left and right differ), and it is the 22-character code from that wheel\'s QR label.'
      : 'Connected, but the wheel sent nothing back. Check About \u2192 log for details, then disconnect, wait 10 s and try again.';
  } catch (e) {
    w.error = 'Connection failed: ' + (e.message || e);
    try { await transport.disconnect(); } catch { /* ignore */ }
    w.transport = null; w.session = null;
  }
  app.keyDraft[side] = '';
  w.busy = ''; render();
}

/** Exchange the Left and Right assignments (wheels, sessions and saved keys). Never while driving. */
function swapSides() {
  if (app.sup && app.sup.state !== State.DISCONNECTED) return;
  [wheels.left, wheels.right] = [wheels.right, wheels.left];
  for (const sd of SIDES) if (wheels[sd].session) wheels[sd].session.side = sd;
  const [kl, kr] = [store.get('key.left'), store.get('key.right')];
  for (const [sd, k] of [['left', kr], ['right', kl]]) { if (k) store.set('key.' + sd, k); else store.del('key.' + sd); }
  [app.keyDraft.left, app.keyDraft.right] = [app.keyDraft.right, app.keyDraft.left];
  render();
}

async function disconnect(side) {
  if (app.sup && app.sup.state !== State.DISCONNECTED) { await app.sup.shutdown(); app.sup = null; }
  const w = wheels[side];
  try { await w.transport?.disconnect(); } catch { /* ignore */ }
  wheels[side] = blank();
  render();
}

async function startDemo() {
  for (const side of SIDES) {
    const m = new MockWheel(side === 'left' ? 'Left (demo)' : 'Right (demo)', side === 'left' ? 82 : 76);
    m.trace = trace;
    await m.connect();
    const w = wheels[side] = blank();
    w.demo = true; w.transport = m;
    w.session = new WheelSession(side, m, { commandDelayMs: 0 });
    w.status = await w.session.readStatus();
  }
  render();
}

async function refresh(side) {
  const w = wheels[side]; if (!w.session) return;
  w.busy = 'Reading...'; render();
  w.status = await w.session.readStatus();
  w.busy = ''; render();
}

async function apply(side, label, fn) {
  const w = wheels[side]; if (!w.session) return;
  if (app.sup && app.sup.state !== State.DISCONNECTED) { w.error = 'Turn off remote drive before changing settings.'; return render(); }
  w.busy = label; w.error = ''; render();
  const ok = await fn(w.session);
  if (!ok) w.error = 'The wheel did not accept that change.';
  w.status = await w.session.readStatus();
  w.busy = ''; render();
}

// ------------------------------------------------------------------ views
function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === app.tab));
  renderChips(); renderBanner();
  const padHeld = app.tab === 'drive' && $('#pad') && app.pad.held;
  if (padHeld) return; // never rebuild the DOM under a finger
  view.replaceChildren(...({ wheels: viewWheels, status: viewStatus, drive: viewDrive, about: viewAbout }[app.tab])());
}

function renderChips() {
  const chips = $('#chips'); chips.replaceChildren();
  for (const s of SIDES) chips.append(h('span', { class: 'chip ' + (connected(s) ? 'ok' : '') }, s === 'left' ? 'L' : 'R', connected(s) ? ' ●' : ' ○'));
  if (app.sup && app.sup.state !== State.DISCONNECTED) chips.append(h('span', { class: 'chip ' + (app.sup.state === State.FAILSAFE ? 'bad' : 'warn') }, app.sup.state));
}

function renderBanner() {
  const b = $('#banner');
  if (!bluetoothSupported() && !SIDES.some((s) => wheels[s].demo)) { b.hidden = false; b.textContent = bluetoothHelp() + ' Demo mode still works.'; }
  else b.hidden = true;
}

function viewWheels() {
  const cards = SIDES.map((side) => {
    const w = wheels[side];
    const isOn = connected(side);
    return h('div', { class: 'card' },
      h('h2', {}, side === 'left' ? 'Left wheel' : 'Right wheel'),
      isOn
        ? [h('div', { class: 'ok' }, 'Connected: ', w.transport.name, w.transport.profile ? ` (${w.transport.profile.name})` : ''),
           h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => disconnect(side) }, 'Disconnect'))]
        : [h('label', { for: 'key-' + side }, 'Key: 22-character QR text, or 32 hex digits'),
           h('input', { id: 'key-' + side, type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
             placeholder: store.get('key.' + side) ? 'Saved key will be used' : 'Paste or type the key',
             value: app.keyDraft[side], oninput: (e) => { app.keyDraft[side] = e.target.value; } }),
           h('div', { class: 'row' }, h('button', { class: 'btn', disabled: !!w.busy || !bluetoothSupported(), onclick: () => connectReal(side) }, 'Connect'),
             h('button', { class: 'btn ghost', disabled: !!w.busy || !bluetoothSupported(), onclick: () => connectReal(side, true) }, 'Show all devices')),
           h('p', { class: 'mut' }, 'Wheel not listed? Switch it on, close the official app, and unpair it from the phone\'s Bluetooth settings, then try "Show all devices".')],
      w.busy && h('p', { class: 'mut' }, w.busy),
      w.error && h('p', { class: 'bad' }, w.error));
  });
  return [
    ...cards,
    SIDES.some(connected) && h('div', { class: 'card' },
      h('p', { class: 'mut' }, 'Each wheel reports which side it is mounted on. If the Status tab says a wheel is on the opposite side, swap the assignment here (nothing is reconnected or changed on the wheels).'),
      h('button', { class: 'btn ghost', onclick: swapSides }, 'Swap left / right')),
    h('div', { class: 'card' },
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.remember, onchange: (e) => {
        app.remember = e.target.checked; store.set('remember', app.remember);
        if (!app.remember) SIDES.forEach((s) => store.del('key.' + s));
      } }), h('span', {}, 'Remember keys on this device. They are stored unencrypted in this browser; leave off on shared devices.')),
      SIDES.some((s) => store.get('key.' + s)) && h('button', { class: 'btn ghost', onclick: () => { SIDES.forEach((s) => store.del('key.' + s)); render(); } }, 'Forget saved keys')),
    h('div', { class: 'card' }, h('h2', {}, 'No wheels handy?'),
      h('p', { class: 'mut' }, 'Demo mode simulates two wheels so you can try every screen. Nothing is sent over Bluetooth.'),
      h('button', { class: 'btn ghost', onclick: startDemo }, 'Start demo mode')),
  ];
}

function viewStatus() {
  if (!SIDES.some(connected)) return [h('div', { class: 'card mut' }, 'Connect a wheel first.')];
  return [
    ...SIDES.filter(connected).map(statusCard),
    h('div', { class: 'card' },
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.allowHigh, onchange: async (e) => {
        if (e.target.checked && !(await confirmDialog('Allow speeds above 6 km/h?',
          'Wheels without the manufacturer\'s higher-speed licence are limited to 6.0 km/h. Raising it may not be allowed where you live or by your warranty and insurance. You are responsible for any use.', 'Allow'))) { e.target.checked = false; return; }
        app.allowHigh = e.target.checked; store.set('allowHigh', app.allowHigh); render();
      } }), h('span', {}, 'Allow speed choices above 6.0 km/h (up to 8.5)'))),
  ];
}

function statusCard(side) {
  const w = wheels[side], s = w.status, locked = !!w.busy;
  const kv = (k, v) => [h('span', {}, k), h('span', {}, v ?? '-')];
  const level = s?.assistLevel ?? 0;
  const cur = s?.params ? Math.round(s.params.maxSpeedKmh * 2) / 2 : null;
  const speeds = selectableKmh(app.allowHigh);
  return h('div', { class: 'card' },
    h('h2', {}, (side === 'left' ? 'Left' : 'Right') + ' wheel', w.demo && ' (demo)'),
    s && h('div', { class: 'kv' },
      ...kv('Battery', s.battery != null ? s.battery + ' %' : null), ...kv('Firmware', s.firmware?.text),
      ...kv('Assist level', ASSIST_NAMES[s.assistLevel]), ...kv('Profile', PROFILES[s.profile]),
      ...kv('Max speed', s.params ? s.params.maxSpeedKmh.toFixed(1) + ' km/h' : null),
      ...kv('Distance', s.cruise ? s.cruise.distanceKm.toFixed(1) + ' km' : null),
      ...kv('Mounted', s.duo?.mounting), ...kv('Auto-hold', s.driveMode ? (s.driveMode.autoHold ? 'on' : 'off') : null)),
    s && s.duo && s.duo.mounting !== 'Unknown' && s.duo.mounting.toLowerCase() !== side && h('p', { class: 'warn' }, `This wheel reports it is mounted on the ${s.duo.mounting.toLowerCase()}, but you connected it as ${side}. Swap sides before driving.`),
    h('label', {}, 'Assist level'),
    h('div', { class: 'seg' }, [[0, 'Normal'], [1, 'Outdoor']].map(([v, t]) => h('button', { class: level === v ? 'on' : '', disabled: locked, onclick: () => apply(side, 'Writing...', (x) => x.writeAssistLevel(v)) }, t))),
    h('label', {}, `Max speed (${ASSIST_NAMES[level] ?? ''} level)`),
    h('select', { disabled: locked || level > 1, onchange: (e) => apply(side, 'Writing...', (x) => x.writeMaxSpeed(level, parseFloat(e.target.value), app.allowHigh)) },
      speeds.map((k) => h('option', { value: k, selected: cur === k }, k.toFixed(1) + ' km/h'))),
    h('label', {}, 'Drive profile'),
    h('select', { disabled: locked, onchange: (e) => apply(side, 'Writing...', (x) => x.writeDriveProfile(parseInt(e.target.value, 10))) },
      SELECTABLE_PROFILES.map((p) => h('option', { value: p, selected: s?.profile === p }, PROFILES[p]))),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', disabled: locked, checked: !!s?.driveMode?.autoHold, onchange: (e) => apply(side, 'Writing...', (x) => x.writeAutoHold(e.target.checked)) }), h('span', {}, 'Auto-hold (brake on slopes)')),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', disabled: locked, onclick: () => refresh(side) }, 'Refresh')),
    w.busy && h('p', { class: 'mut' }, w.busy), w.error && h('p', { class: 'bad' }, w.error));
}

// ------------------------------------------------------------------ drive
function mismatch() {
  return SIDES.some((s) => { const m = wheels[s].status?.duo?.mounting; return m && m !== 'Unknown' && m.toLowerCase() !== s; });
}

function viewDrive() {
  if (!bothConnected()) return [h('div', { class: 'card mut' }, 'Remote drive needs BOTH wheels connected (Wheels tab).')];
  const sup = app.sup, st = sup?.state ?? State.DISCONNECTED;
  const live = st === State.ARMED || st === State.DRIVING;
  const out = [];
  if (st === State.DISCONNECTED || st === State.CONNECTING) {
    out.push(h('div', { class: 'card' },
      h('h2', {}, 'Remote drive'),
      h('p', { class: 'warn' }, 'Experimental. This moves a real wheelchair. Test with the wheels lifted off the ground first, with a helper present. Never use while seated in or near traffic, stairs, ramps or crowds.'),
      mismatch() && h('p', { class: 'bad' }, 'A wheel reports the opposite mounting side. Fix the Left/Right assignment before driving.'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.driveAck, onchange: (e) => { app.driveAck = e.target.checked; render(); } }), h('span', {}, 'The wheels are lifted or the area is clear, and I accept responsibility for using this.')),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.invertSteering, onchange: (e) => { app.invertSteering = e.target.checked; store.set('invertSteering', app.invertSteering); } }), h('span', {}, 'Invert steering (use if testing on blocks shows left/right reversed)')),
      h('button', { class: 'btn', disabled: !app.driveAck || mismatch() || st === State.CONNECTING, onclick: enableDrive }, st === State.CONNECTING ? 'Enabling...' : 'Enable remote drive')));
  } else {
    out.push(h('div', { class: 'card' },
      h('div', { class: st === State.FAILSAFE ? 'bad' : live ? 'ok' : 'warn' }, 'State: ', st, sup.failsafeReason ? ` (${sup.failsafeReason})` : ''),
      st === State.PAIRED && h('p', { class: 'mut' }, 'Remote mode is on. Arm to enable the joystick. Hold your finger on the pad to move; release to stop.'),
      h('div', { class: 'seg' }, [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']].map(([m, t]) => h('button', { class: app.driveMode === m ? 'on' : '', onclick: () => { app.driveMode = m; render(); } }, t))),
      h('div', { class: 'row' },
        st === State.PAIRED && h('button', { class: 'btn', onclick: () => { sup.arm(); acquireWakeLock(); render(); } }, 'Arm'),
        live && h('button', { class: 'btn ghost', onclick: async () => { await sup.disarm(); render(); } }, 'Disarm'),
        h('button', { class: 'btn ghost', onclick: disableDrive }, 'Turn off remote'))));
    out.push(h('div', { id: 'pad', class: live ? 'armed' : 'off' }, h('div', { id: 'knob' })));
    out.push(h('div', { class: 'bars' }, h('div', {}, h('div', { class: 'mut' }, 'Left ', h('span', { id: 'lv' }, '0')), h('div', { class: 'bar' }, h('i', { id: 'lb' }))),
      h('div', {}, h('div', { class: 'mut' }, 'Right ', h('span', { id: 'rv' }, '0')), h('div', { class: 'bar' }, h('i', { id: 'rb' })))));
    attachPad();
  }
  out.push(h('button', { id: 'estop', onclick: () => app.sup?.emergencyStop('Emergency stop pressed') }, 'EMERGENCY STOP'));
  if (st === State.FAILSAFE) out.push(h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { await sup.reset(); render(); } }, 'Reset')));
  return out;
}

async function enableDrive() {
  if (!(await confirmDialog('Enable remote drive?', 'Both wheels will switch into remote-control mode and respond to the on-screen joystick. Release the pad or press EMERGENCY STOP to stop.', 'Enable'))) return;
  const mapper = new Mapper({ ...defaultMapperConfig(), invertSteering: app.invertSteering });
  const link = new WheelPair(wheels.left.session, wheels.right.session);
  const sup = app.sup = new DriveSupervisor(link, { mapper });
  sup.onStateChange = () => { render(); if (sup.state === State.DISCONNECTED || sup.state === State.FAILSAFE) releaseWakeLock(); };
  sup.onCommand = updateBars;
  render();
  const ok = await sup.connect();
  if (!ok) { app.sup = null; wheels.left.error = wheels.right.error = ''; alert('Could not switch both wheels into remote mode. Nothing is moving.'); }
  else sup.startLoop();
  render();
}

async function disableDrive() {
  if (app.sup) { await app.sup.shutdown(); app.sup = null; }
  releaseWakeLock(); render();
}

function updateBars(f) {
  const set = (id, v) => { const b = $('#' + id + 'b'), t = $('#' + id + 'v'); if (!b) return; t.textContent = v;
    b.style.left = v >= 0 ? '50%' : (50 + v / 2) + '%'; b.style.width = Math.abs(v) / 2 + '%'; };
  set('l', f.left); set('r', f.right);
}

// joystick: pointer capture, finger-down == deadman
function attachPad() {
  const pad = $('#pad'), knob = $('#knob');
  const reset = () => { app.pad = { vx: 0, vy: 0, held: false }; knob.style.left = '33%'; knob.style.top = '33%'; push(); };
  const move = (e) => {
    const r = pad.getBoundingClientRect(), R = r.width / 2;
    let dx = (e.clientX - (r.left + R)) / R, dy = (e.clientY - (r.top + R)) / R;
    const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
    app.pad.vx = -dy; app.pad.vy = dx;
    knob.style.left = (33 + dx * 33) + '%'; knob.style.top = (33 + dy * 33) + '%';
    push();
  };
  const push = () => app.sup?.setInput(app.pad.vx, app.pad.vy, app.pad.held, app.driveMode);
  pad.addEventListener('pointerdown', (e) => {
    if (app.sup?.state !== State.ARMED && app.sup?.state !== State.DRIVING) return;
    pad.setPointerCapture(e.pointerId); app.pad.held = true; move(e); e.preventDefault();
  });
  pad.addEventListener('pointermove', (e) => { if (app.pad.held) move(e); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(ev, () => { if (app.pad.held) reset(); else push(); });
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Keep the supervisor's input watchdog fed while the finger is down (even if perfectly still).
setInterval(() => { if (app.pad.held && app.sup) app.sup.setInput(app.pad.vx, app.pad.vy, true, app.driveMode); }, 100);

// Leaving the app / hiding the page must stop the chair.
const bail = (why) => { if (app.sup && (app.sup.state === State.ARMED || app.sup.state === State.DRIVING)) app.sup.emergencyStop(why); app.pad = { vx: 0, vy: 0, held: false }; };
document.addEventListener('visibilitychange', () => { if (document.hidden) bail('App went to background'); });
window.addEventListener('pagehide', () => bail('Page closed'));
window.addEventListener('blur', () => bail('App lost focus'));

let wakeLock = null;
async function acquireWakeLock() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ } }
function releaseWakeLock() { try { wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }

// ------------------------------------------------------------------ about
function viewAbout() {
  const logEl = h('pre', { id: 'log' }, app.log.join('\n'));
  return [
    h('div', { class: 'card' }, h('h2', {}, 'M5Squared (web)'),
      h('p', {}, 'Unofficial companion for Alber e-motion M25 power-assist wheels, ported from the AGPL-3.0 Python toolkit 6static/m5squared. Not affiliated with or endorsed by Alber or Rheinland Zeitlos.'),
      h('p', { class: 'mut' }, 'Provided without warranty. Use only with wheels you own. Changing drive settings or driving remotely can affect safety, warranty and legality. This web port has not been verified on real hardware.')),
    h('div', { class: 'card' }, h('h2', {}, 'Source'),
      h('p', { class: 'mut' }, 'AGPL-3.0: if you host a modified copy, you must offer its source to users. See LICENSE and NOTICE.md in the project.')),
    h('div', { class: 'card' }, h('h2', {}, 'Protocol log'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.showLog, onchange: (e) => { app.showLog = e.target.checked; render(); } }), h('span', {}, 'Show decrypted packets (contains no keys)')),
      app.showLog && logEl),
  ];
}
function renderLogOnly() { const l = $('#log'); if (l) l.textContent = app.log.join('\n'); }

// ------------------------------------------------------------------ boot
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { app.tab = b.dataset.tab; render(); }));
render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
