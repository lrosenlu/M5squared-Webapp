// M5Squared web app: UI wiring. All protocol/safety logic lives in the other modules.
import { parseKeyInput } from './crypto.js';
import { bluetoothSupported, bluetoothHelp, pickWheel, BLEWheelTransport } from './ble.js';
import { WheelSession, MockWheel } from './session.js';
import { WheelPair, CoreLink, DriveSupervisor, State, DriveMode, defaultMapperConfig, Mapper } from './drive.js';
import { ASSIST_NAMES, PROFILES, SELECTABLE_PROFILES, selectableKmh, rawToKmh, MAX_SPEED_MMPS, SPEED_RAW, STANDARD_TIER_MAX_RAW, validateProfileParams } from './packets.js';
import { PRESETS, SLOPE_VALUES, SPEED_BIAS_VALUES } from './presets.js';
import { processAnalyze, parseHex } from './analyzer.js';
import { processDecrypt, processEncrypt } from './packettool.js';
import { toUpstreamStatus, formatWheelStatus } from './report.js';

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
function blank() { return { transport: null, session: null, status: null, tele: null, busy: '', error: '', demo: false }; }

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
  useGamepad: false,
  engine: store.get('engine', 'classic'),       // 'classic' = proven on real wheels; 'firmware' = m25-remote port (experimental)
  liveSpeedWhileDriving: false,
  pad: { vx: 0, vy: 0, held: false },
  keyDraft: { left: '', right: '' },
  sync: true,                             // settings that must match are ALWAYS sent to both wheels when both are connected
  wheelMode: 'dual',                      // 'dual' | 'left' | 'right'
  hillHold: false,
  probe: { side: 'left', text: '01 21', out: '' },
  editor: { level: 0, draft: null, preset: 'Standard', target: 'both', msg: '', busy: false },
};
const BATT_WARN = 30, BATT_CRITICAL = 15, BATT_LOW_CAP = 20;
const reconnecting = { left: false, right: false };

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
  const other = SIDES.find((sd) => sd !== side && wheels[sd].transport?.device?.id && wheels[sd].transport.device.id === device.id);
  if (other) { w.busy = ''; w.error = `That is the same wheel (${device.name || 'unnamed'}) already connected as ${other}. Pick the OTHER wheel in the list.`; return render(); }
  w.busy = 'Connecting...'; render();
  const transport = new BLEWheelTransport(device, key, { trace });
  transport.onDisconnect = () => { w.error = 'Disconnected.'; render(); autoReconnect(side, transport); };
  try {
    await transport.connect();
    w.transport = transport;
    w.session = new WheelSession(side, transport, { engine: app.engine });
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

/** Reconnect to the same device without the picker (only while remote drive is off). Up to 5 tries, 2 s apart. */
async function autoReconnect(side, transport) {
  if (reconnecting[side] || wheels[side].demo || wheels[side].transport !== transport) return;
  if (app.sup && app.sup.state !== State.DISCONNECTED) return; // never reconnect under a live drive session
  reconnecting[side] = true;
  for (let i = 1; i <= 5 && wheels[side].transport === transport; i++) {
    wheels[side].error = `Disconnected. Reconnecting (${i}/5)...`; render();
    await new Promise((r) => setTimeout(r, 2000));
    if (wheels[side].transport !== transport) break;
    try {
      await transport.connect();
      wheels[side].error = '';
      wheels[side].status = await wheels[side].session.readStatus();
      break;
    } catch { /* try again */ }
  }
  reconnecting[side] = false;
  if (wheels[side].transport === transport && !transport.isConnected) wheels[side].error = 'Disconnected. Reconnect failed; use Disconnect, then Connect.';
  render();
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
    w.session = new WheelSession(side, m, { commandDelayMs: 0, engine: app.engine });
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

async function applyOne(side, label, fn) {
  const w = wheels[side]; if (!w.session) return;
  w.busy = label; w.error = ''; render();
  let ok = false;
  try { ok = await fn(w.session); } catch (e) { w.error = e.message || String(e); }
  if (!ok && !w.error) w.error = 'The wheel did not accept that change.';
  w.status = await w.session.readStatus();
  w.busy = ''; render();
  return ok;
}

/** Change a setting on this wheel, or on both at once when "Keep both wheels in sync" is on. */
async function apply(side, label, fn) {
  const w = wheels[side]; if (!w.session) return;
  if (app.sup && app.sup.state !== State.DISCONNECTED) { w.error = 'Turn off remote drive before changing settings.'; return render(); }
  const targets = app.sync ? SIDES.filter((sd) => wheels[sd].session && connected(sd)) : [side];
  await Promise.all(targets.map((sd) => applyOne(sd, label, fn)));
  if (targets.length > 1) {
    const [a, b] = targets.map((sd) => wheels[sd].status);
    if (a && b && (a.assistLevel !== b.assistLevel || a.profile !== b.profile || !!a.driveMode?.autoHold !== !!b.driveMode?.autoHold
      || a.params?.maxSpeedRaw !== b.params?.maxSpeedRaw)) for (const sd of targets) wheels[sd].error = 'The two wheels ended up with different settings. Check both cards.';
    render();
  }
}

// ------------------------------------------------------------------ telemetry
const polling = { left: false, right: false };
const driving = () => !!app.sup && app.sup.state !== State.DISCONNECTED;
async function pollTelemetry() {
  for (const side of SIDES) {
    const w = wheels[side];
    if (!connected(side) || !w.session || polling[side] || w.busy || reconnecting[side]) continue;
    // Like the firmware, leave the link alone while armed/driving unless live speed was asked for.
    if (driving() && !app.liveSpeedWhileDriving) continue;
    polling[side] = true;
    w.session.readTelemetry({ bms: !driving() }).then((t) => {
      w.tele = { ...(w.tele || {}), ...t, bms: t.bms ?? w.tele?.bms };
      if (t.battery != null && w.status) w.status.battery = t.battery;
    }).catch(() => {}).finally(() => { polling[side] = false; onTelemetry(); });
  }
}
function minBattery() {
  const v = SIDES.filter(connected).map((sd) => wheels[sd].tele?.battery ?? wheels[sd].status?.battery).filter((x) => x != null);
  return v.length ? Math.min(...v) : null;
}
function onTelemetry() {
  const b = minBattery();
  app.sup?.setLowBattery(b != null && b < BATT_LOW_CAP);
  if (b != null && b < 10 && app.sup && (app.sup.state === State.ARMED || app.sup.state === State.DRIVING)) app.sup.emergencyStop('Battery critically low');
  const ae = document.activeElement;
  const editing = ae && view.contains(ae) && ['INPUT', 'SELECT'].includes(ae.tagName);
  if (app.tab === 'status' && !editing && !app.editor.busy && !SIDES.some((sd) => wheels[sd].busy)) render();
  updateSpeedo();
}
setInterval(pollTelemetry, 1000);

// The wheel reports signed speed; the left wheel is mirrored, so negate it to make forward positive on both.
function speedOf(side) { const c = wheels[side].tele?.cruise; return connected(side) && c ? (side === 'left' ? -c.speedKmh : c.speedKmh) : null; }
function updateSpeedo() {
  const el = $('#speedo'); if (!el) return;
  const v = SIDES.map(speedOf).filter((x) => x != null);
  const avg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  const mag = Math.abs(avg);
  const max = MAX_SPEED_MMPS * 0.0036;
  $('#speedoNum').textContent = avg.toFixed(1);
  $('#speedoArc').setAttribute('stroke-dasharray', `${Math.min(1, mag / max) * 157} 157`);
  $('#speedoLR').textContent = SIDES.map((sd) => (sd === 'left' ? 'L ' : 'R ') + (speedOf(sd)?.toFixed(1) ?? '-')).join('   ');
}
function speedometer() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 120 70'); svg.setAttribute('class', 'speedo-svg');
  const mk = (d, id, cls) => { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); p.setAttribute('fill', 'none'); p.setAttribute('stroke-width', '8'); p.setAttribute('stroke-linecap', 'round'); if (id) p.id = id; p.setAttribute('class', cls); return p; };
  const arc = 'M 10 60 A 50 50 0 0 1 110 60';
  svg.append(mk(arc, '', 'speedo-bg'), mk(arc, 'speedoArc', 'speedo-fg'));
  svg.lastChild.setAttribute('stroke-dasharray', '0 157'); svg.lastChild.setAttribute('pathLength', '157');
  svg.firstChild.setAttribute('pathLength', '157');
  return h('div', { id: 'speedo', class: 'card speedo' }, svg, h('div', { class: 'speedo-num' }, h('span', { id: 'speedoNum' }, '0.0'), ' km/h'),
    h('div', { id: 'speedoLR', class: 'mut' }, ''));
}

// ------------------------------------------------------------------ views
function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === app.tab));
  renderChips(); renderBanner();
  const padHeld = app.tab === 'drive' && $('#pad') && app.pad.held;
  if (padHeld) return; // never rebuild the DOM under a finger
  view.replaceChildren(...({ wheels: viewWheels, status: viewStatus, drive: viewDrive, about: viewAbout }[app.tab])());
  if ($('#pad')) attachPad(); // listeners need the element to be in the DOM
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
             h('button', { class: 'btn ghost', disabled: !!w.busy || !bluetoothSupported(), onclick: () => connectReal(side, true) }, 'Show all devices'),
             h('button', { class: 'btn ghost', onclick: () => scanKey(side) }, 'Scan QR')),
           h('p', { class: 'mut' }, 'Wheel not listed? Switch it on, close the official app, and unpair it from the phone\'s Bluetooth settings, then try "Show all devices".')],
      w.busy && h('p', { class: 'mut' }, w.busy),
      w.error && h('p', { class: 'bad' }, w.error));
  });
  return [
    ...cards,
    SIDES.some(connected) && h('div', { class: 'card' },
      h('p', { class: 'mut' }, 'Each wheel reports which side it is (its own id, not the unreliable mounting setting). If the Status tab says a wheel is on the opposite side, swap the assignment here (nothing is reconnected or changed on the wheels).'),
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
    syncNotice(),
    ...SIDES.filter(connected).map(statusCard),
    SIDES.some(connected) && paramsCard(),
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
  const c = w.tele?.cruise ?? s?.cruise ?? null;
  const cur = s?.params ? Math.round(s.params.maxSpeedKmh * 2) / 2 : null;
  const speeds = selectableKmh(app.allowHigh);
  return h('div', { class: 'card' },
    h('h2', {}, (side === 'left' ? 'Left' : 'Right') + ' wheel', w.demo && ' (demo)'),
    w.transport?.name && h('p', { class: 'mut' }, 'Bluetooth device: ' + w.transport.name),
    s && !s.hasData && h('p', { class: 'bad' }, 'No reply from this wheel. Either the key is not this wheel\'s key, or this slot is connected to the same wheel as the other slot. Disconnect it on the Wheels tab, then reconnect and choose the other device name.'),
    s && h('div', { class: 'kv' },
      ...kv('Battery', (w.tele?.battery ?? s.battery) != null ? (w.tele?.battery ?? s.battery) + ' %' + (w.tele?.bms?.charging ? ' (charging)' : '') : null), ...kv('Firmware', s.firmware?.text),
      ...kv('Assist level', ASSIST_NAMES[s.assistLevel]), ...kv('Profile', PROFILES[s.profile]),
      ...kv('Max speed', s.params ? s.params.maxSpeedKmh.toFixed(1) + ' km/h' : null),
      ...kv('Charging', w.tele?.bms ? (w.tele.bms.charging ? 'yes' : 'no') : (w.session?.bmsSupported === false ? 'not reported' : null)),
      ...kv('Voltage', 'not reported by wheel'),
      ...kv('Speed', speedOf(side) != null ? speedOf(side).toFixed(2) + ' km/h (+ forward)' : null),
      ...kv('Push rim sensor', c ? String(c.pushRim) : null),
      ...kv('Push count', c ? String(c.pushCount) : null),
      ...kv('Wheel error', c ? (c.wheelError ? 'code ' + c.wheelError : 'none') : null),
      ...kv('Distance', c ? c.distanceKm.toFixed(2) + ' km' : null),
      ...kv('DuoDrive dial side', s.duo?.mounting), ...kv('Auto-hold', s.driveMode ? (s.driveMode.autoHold ? 'on' : 'off') : null)),
    s && srcSide(s) && srcSide(s) !== side && h('p', { class: 'warn' }, `This wheel identifies itself as the ${srcSide(s)} wheel, but you connected it as ${side}. Swap sides before driving.`),
    h('label', {}, 'Assist level'),
    h('div', { class: 'seg' }, [[0, 'Indoor'], [1, 'Outdoor'], [2, 'Learning']].map(([v, t]) => h('button', { class: level === v ? 'on' : '', disabled: locked, onclick: () => apply(side, 'Writing...', (x) => x.writeAssistLevel(v)) }, t))),
    app.sync && bothConnected() && h('p', { class: 'mut' }, 'Changes here apply to both wheels.'),
    h('label', {}, `Max speed (${ASSIST_NAMES[level] ?? ''} level)`),
    h('select', { disabled: locked || level > 1, onchange: (e) => apply(side, 'Writing...', (x) => x.writeMaxSpeed(level, parseFloat(e.target.value), app.allowHigh)) },
      speeds.map((k) => h('option', { value: k, selected: cur === k }, k.toFixed(1) + ' km/h'))),
    h('label', {}, 'Drive profile'),
    h('select', { disabled: locked, onchange: (e) => apply(side, 'Writing...', (x) => x.writeDriveProfile(parseInt(e.target.value, 10))) },
      SELECTABLE_PROFILES.map((p) => h('option', { value: p, selected: s?.profile === p }, PROFILES[p]))),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', disabled: locked, checked: !!s?.driveMode?.autoHold, onchange: (e) => apply(side, 'Writing...', (x) => x.writeAutoHold(e.target.checked)) }), h('span', {}, 'Auto-hold (brake on slopes)')),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', disabled: locked, onclick: () => refresh(side) }, 'Refresh'),
      s && h('button', { class: 'btn ghost', onclick: () => copyReport(side) }, 'Copy report')),
    w.busy && h('p', { class: 'mut' }, w.busy), w.error && h('p', { class: 'bad' }, w.error));
}

// ------------------------------------------------------------------ profile parameter editor
const F = (a) => ({ maxTorque: a.max_torque, maxSpeedRaw: a.max_speed, pFactor: a.p_factor, speedBias: a.speed_bias,
  speedFactor: a.speed_factor, rotationThreshold: a.rotation_threshold, slopeInc: a.slope_inc, slopeDec: a.slope_dec });
const firstSide = () => SIDES.find(connected);

async function editorRead() {
  const sd = firstSide(); const e = app.editor; if (!sd) return;
  e.busy = true; e.msg = 'Reading from the ' + sd + ' wheel...'; render();
  const p = await wheels[sd].session.readProfileParams(e.level);
  e.busy = false;
  if (p) { e.draft = { maxTorque: p.maxTorque, maxSpeedRaw: p.maxSpeedRaw, pFactor: p.pFactor, speedBias: p.speedBias, speedFactor: p.speedFactor,
    rotationThreshold: p.rotationThreshold, slopeInc: p.slopeInc, slopeDec: p.slopeDec }; e.msg = 'Loaded current values from the ' + sd + ' wheel.'; }
  else e.msg = 'The wheel did not answer.';
  render();
}
function editorPreset() {
  const e = app.editor, pr = PRESETS[e.preset]; if (!pr) return;
  e.draft = F(pr[e.level === 0 ? 'level_1' : 'level_2']);
  e.msg = `Loaded ${e.preset}, ${ASSIST_NAMES[e.level]} level into the editor. Nothing is written until you press Write.`; render();
}
async function editorWrite() {
  const e = app.editor; if (!e.draft) return;
  if (driving()) { e.msg = 'Turn off remote drive first.'; return render(); }
  const err = validateProfileParams(e.draft);
  if (err) { e.msg = err; return render(); }
  const targets = SIDES.filter(connected);
  if (!targets.length) { e.msg = 'No connected wheel for that target.'; return render(); }
  const clamped = !app.allowHigh && e.draft.maxSpeedRaw > STANDARD_TIER_MAX_RAW;
  const d = e.draft;
  if (!(await confirmDialog('Write drive parameters?',
    `${targets.join(' and ')} wheel(s), ${ASSIST_NAMES[e.level]} level: torque ${d.maxTorque} %, max ${rawToKmh(d.maxSpeedRaw).toFixed(1)} km/h${clamped ? ' (will be limited to 6.0 unless you allow higher speeds)' : ''}, ` +
    `P ${d.pFactor}, bias ${d.speedBias}, speed factor ${d.speedFactor}, rotation ${d.rotationThreshold}, slopes ${d.slopeInc}/${d.slopeDec}. These change how the wheelchair accelerates and brakes. The old values are logged in About.`, 'Write'))) return;
  e.busy = true; e.msg = 'Writing...'; render();
  const results = [];
  for (const sd of targets) {
    const r = await wheels[sd].session.writeProfileParamsVerified(e.level, d, { allowAboveStandardTier: app.allowHigh });
    trace(`[PROFILE ${sd} level ${e.level}] before=${JSON.stringify(r.before)} after=${JSON.stringify(r.after)} ok=${r.ok} ${r.error || ''}`);
    results.push(`${sd}: ${r.ok ? 'written and verified' : 'FAILED: ' + r.error}`);
    wheels[sd].status = await wheels[sd].session.readStatus();
  }
  e.busy = false; e.msg = results.join('; '); render();
}

function settingsOf(sd) {
  const s = wheels[sd].status; if (!s) return null;
  return { assistLevel: s.assistLevel, profile: s.profile, autoHold: !!s.driveMode?.autoHold, maxSpeedRaw: s.params?.maxSpeedRaw };
}
function mismatchedSettings() {
  if (!bothConnected()) return [];
  const a = settingsOf('left'), b = settingsOf('right'); if (!a || !b) return [];
  return [['assistLevel', 'assist level'], ['profile', 'drive profile'], ['autoHold', 'auto-hold'], ['maxSpeedRaw', 'max speed']].filter(([k]) => a[k] !== b[k]).map(([, n]) => n);
}
function syncNotice() {
  if (!bothConnected()) return null;
  const diff = mismatchedSettings();
  return h('div', { class: 'card' },
    h('p', { class: diff.length ? 'warn' : 'ok' }, diff.length ? `The wheels differ in: ${diff.join(', ')}.` : 'Both wheels have matching settings.'),
    h('p', { class: 'mut' }, 'Assist level, max speed, profile, auto-hold and drive parameters are always written to both wheels together.'),
    diff.length > 0 && h('div', { class: 'row' },
      h('button', { class: 'btn ghost', onclick: () => matchTo('left') }, 'Match right to left'),
      h('button', { class: 'btn ghost', onclick: () => matchTo('right') }, 'Match left to right')));
}
async function matchTo(src) {
  if (driving()) return;
  const dst = src === 'left' ? 'right' : 'left', a = settingsOf(src);
  if (!(await confirmDialog('Match wheels?', `Copy assist level, profile, auto-hold and max speed from the ${src} wheel to the ${dst} wheel.`, 'Copy'))) return;
  await applyOne(dst, 'Matching...', async (x) => {
    let ok = true;
    if (a.profile != null && a.profile !== settingsOf(dst).profile) ok = (await x.writeDriveProfile(a.profile)) && ok;
    if (a.assistLevel != null) ok = (await x.writeAssistLevel(a.assistLevel)) && ok;
    if (a.autoHold !== settingsOf(dst).autoHold) ok = (await x.writeAutoHold(a.autoHold)) && ok;
    const lvl = a.assistLevel ?? 0;
    if (a.maxSpeedRaw && lvl <= 1) ok = (await x.writeMaxSpeed(lvl, a.maxSpeedRaw * 0.0036, app.allowHigh)) && ok;
    return ok;
  });
}

function paramsCard() {
  const e = app.editor;
  if (!e.draft) setTimeout(editorRead, 0);
  const d = e.draft;
  const num = (key, label, lo, hi) => [h('label', {}, `${label} (${lo}-${hi})`),
    h('input', { type: 'number', inputmode: 'numeric', min: lo, max: hi, value: d?.[key] ?? '', disabled: !d || e.busy,
      onchange: (ev) => { d[key] = parseInt(ev.target.value, 10); } })];
  const pick = (key, label, opts, fmt = String) => [h('label', {}, label),
    h('select', { disabled: !d || e.busy, onchange: (ev) => { d[key] = parseInt(ev.target.value, 10); } },
      opts.map((o) => h('option', { value: o, selected: d?.[key] === o }, fmt(o))))];
  return h('div', { class: 'card' }, h('h2', {}, 'Drive parameters (advanced)'),
    h('p', { class: 'mut' }, 'Edits the motor-response values behind a drive profile. Wrong values can make the chair twitchy or slow to brake. Change one thing at a time, with the wheels lifted. Values are range-checked and read back from the wheel.'),
    h('label', {}, 'Assist level to edit'),
    h('div', { class: 'seg' }, [[0, 'Indoor'], [1, 'Outdoor']].map(([v, t]) => h('button', { class: e.level === v ? 'on' : '', disabled: e.busy, onclick: () => { e.level = v; e.draft = null; render(); } }, t))),
    h('label', {}, 'Factory preset'),
    h('select', { onchange: (ev) => { e.preset = ev.target.value; } }, Object.keys(PRESETS).map((n) => h('option', { value: n, selected: e.preset === n }, n === 'SensitivePlus' ? 'Sensitive+' : n))),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', disabled: e.busy, onclick: editorPreset }, 'Load preset into editor'),
      h('button', { class: 'btn ghost', disabled: e.busy, onclick: editorRead }, 'Read from wheel')),
    ...num('maxTorque', 'Max torque %', 10, 100),
    ...pick('maxSpeedRaw', 'Max speed', SPEED_RAW.filter((r) => app.allowHigh || r <= STANDARD_TIER_MAX_RAW), (r) => rawToKmh(r).toFixed(1) + ' km/h'),
    ...num('pFactor', 'P-factor', 1, 999),
    ...pick('speedBias', 'Speed bias (sensor sensitivity)', SPEED_BIAS_VALUES),
    ...num('speedFactor', 'Speed factor', 1, 100),
    ...num('rotationThreshold', 'Rotation threshold', 1, 150),
    ...pick('slopeInc', 'Start-up slope (higher = quicker)', SLOPE_VALUES),
    ...pick('slopeDec', 'Coasting slope (higher = quicker)', SLOPE_VALUES),
    bothConnected() && h('p', { class: 'mut' }, 'Written to both wheels so they stay matched.'),
    h('div', { class: 'row' }, h('button', { class: 'btn', disabled: !d || e.busy, onclick: editorWrite }, 'Write to wheel(s)')),
    e.msg && h('p', { class: e.msg.includes('FAILED') ? 'bad' : 'mut' }, e.msg));
}

// ------------------------------------------------------------------ drive
// The wheel's own source id (2 left, 3 right) is reliable; the DuoDrive "mounting" byte is not, so it is informational only.
function srcSide(st) { return st && st.src === 2 ? 'left' : st && st.src === 3 ? 'right' : null; }
function mismatch() {
  return SIDES.some((s) => { const m = srcSide(wheels[s].status); return m && m !== s; });
}

const driveSides = () => (app.wheelMode === 'dual' ? SIDES : [app.wheelMode]);
const driveReady = () => driveSides().every(connected);

function viewDrive() {
  if (!driveReady()) return [h('div', { class: 'card mut' }, app.wheelMode === 'dual' ? 'Remote drive needs BOTH wheels connected (Wheels tab), or choose single-wheel mode.' : `Connect the ${app.wheelMode} wheel first.`),
    h('div', { class: 'seg' }, wheelModeButtons())];
  const sup = app.sup, st = sup?.state ?? State.DISCONNECTED;
  const live = st === State.ARMED || st === State.DRIVING;
  const out = [];
  if (st === State.DISCONNECTED || st === State.CONNECTING) {
    out.push(h('div', { class: 'card' },
      h('h2', {}, 'Remote drive'),
      h('p', { class: 'warn' }, 'Experimental. This moves a real wheelchair. Test with the wheels lifted off the ground first, with a helper present. Never use while seated in or near traffic, stairs, ramps or crowds.'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.useGamepad, onchange: (e) => { app.useGamepad = e.target.checked; } }), h('span', {}, 'Use a game controller: left stick steers, hold any bumper or trigger to move (release = stop). Press a button once so the browser sees it.')),
      h('label', {}, 'Drive engine'),
      h('div', { class: 'seg' }, [['classic', 'Classic'], ['core', 'Upstream core'], ['firmware', 'Firmware (experimental)']].map(([v, t]) => h('button', { class: app.engine === v ? 'on' : '', onclick: () => setEngine(v) }, t))),
      h('p', { class: 'mut' }, app.engine === 'classic' ? 'Classic: the arming and speed commands that worked on your wheels. Speeds are very gentle.' : app.engine === 'core' ? 'Upstream core: exactly what the m5squared remote sends (no replies awaited, remote-only mode). Same gentle speeds.' : 'Firmware: port of the m25-remote firmware (real mm/s speeds, stricter arming). Not yet confirmed on your wheels; test lifted.'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.liveSpeedWhileDriving, onchange: (e) => { app.liveSpeedWhileDriving = e.target.checked; } }), h('span', {}, 'Poll live speed while driving (the firmware avoids this)')),
      h('label', {}, 'Wheels to drive'), h('div', { class: 'seg' }, wheelModeButtons()),
      batteryNotice(),
      mismatch() && h('p', { class: 'bad' }, 'A wheel identifies itself as the opposite side. Fix the Left/Right assignment before driving.'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.driveAck, onchange: (e) => { app.driveAck = e.target.checked; render(); } }), h('span', {}, 'The wheels are lifted or the area is clear, and I accept responsibility for using this.')),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.invertSteering, onchange: (e) => { app.invertSteering = e.target.checked; store.set('invertSteering', app.invertSteering); } }), h('span', {}, 'Invert steering (use if testing on blocks shows left/right reversed)')),
      h('button', { class: 'btn', disabled: !app.driveAck || mismatch() || batteryLocked() || st === State.CONNECTING, onclick: enableDrive }, st === State.CONNECTING ? 'Enabling...' : 'Enable remote drive')));
  } else {
    out.push(h('div', { class: 'card' },
      h('div', { class: st === State.FAILSAFE ? 'bad' : live ? 'ok' : 'warn' }, 'State: ', st, sup.failsafeReason ? ` (${sup.failsafeReason})` : ''),
      st === State.PAIRED && h('p', { class: 'mut' }, 'Remote mode is on. Arm to enable the joystick. Hold your finger on the pad to move; release to stop.'),
      h('div', { class: 'seg' }, [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']].map(([m, t]) => h('button', { class: app.driveMode === m ? 'on' : '', onclick: () => { app.driveMode = m; render(); } }, t))),
      h('div', { class: 'row' },
        st === State.PAIRED && h('button', { class: 'btn', onclick: () => { sup.arm(); acquireWakeLock(); render(); } }, 'Arm'),
        live && h('button', { class: 'btn ghost', onclick: async () => { await sup.disarm(); render(); } }, 'Disarm'),
        h('button', { class: 'btn ghost', onclick: disableDrive }, 'Turn off remote'))));
    out.push(speedometer());
    out.push(h('div', { class: 'card' }, batteryNotice(),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.hillHold, onchange: async (e) => {
        app.hillHold = e.target.checked;
        await Promise.all(driveSides().map((sd) => wheels[sd].session.setHillHold(app.hillHold)));
      } }), h('span', {}, 'Hill hold (brake on slopes while driving remotely)'))));
    out.push(h('p', { id: 'diag', class: 'mut' }, ''));
    out.push(h('div', { id: 'pad', class: live ? 'armed' : 'off' }, h('div', { id: 'knob' })));
    out.push(h('div', { class: 'bars' }, h('div', {}, h('div', { class: 'mut' }, 'Left ', h('span', { id: 'lv' }, '0')), h('div', { class: 'bar' }, h('i', { id: 'lb' }))),
      h('div', {}, h('div', { class: 'mut' }, 'Right ', h('span', { id: 'rv' }, '0')), h('div', { class: 'bar' }, h('i', { id: 'rb' })))));
  }
  setTimeout(updateSpeedo, 0);
  out.push(h('button', { id: 'estop', onclick: () => app.sup?.emergencyStop('Emergency stop pressed') }, 'EMERGENCY STOP'));
  if (st === State.FAILSAFE) out.push(h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { await sup.reset(); render(); } }, 'Reset')));
  return out;
}

function setEngine(v) {
  app.engine = v; store.set('engine', v);
  for (const sd of SIDES) if (wheels[sd].session) wheels[sd].session.engine = v;
  render();
}
function wheelModeButtons() {
  return [['dual', 'Both'], ['left', 'Left only'], ['right', 'Right only']].map(([m, t]) =>
    h('button', { class: app.wheelMode === m ? 'on' : '', disabled: driving(), onclick: () => { app.wheelMode = m; render(); } }, t));
}
function batteryLocked() { const b = minBattery(); return b != null && b < BATT_CRITICAL; }
function batteryNotice() {
  const b = minBattery();
  if (b == null) return null;
  if (b < BATT_CRITICAL) return h('p', { class: 'bad' }, `Battery ${b} %: too low to enable remote drive (minimum ${BATT_CRITICAL} %). Charge the wheels.`);
  if (b < BATT_LOW_CAP) return h('p', { class: 'warn' }, `Battery ${b} %: remote speed is capped to a lower limit.`);
  if (b < BATT_WARN) return h('p', { class: 'warn' }, `Battery ${b} %: getting low.`);
  return null;
}

async function enableDrive() {
  if (batteryLocked()) return;
  if (!(await confirmDialog('Enable remote drive?', 'Both wheels will switch into remote-control mode and respond to the on-screen joystick. Release the pad or press EMERGENCY STOP to stop.', 'Enable'))) return;
  const mapper = new Mapper({ ...defaultMapperConfig(), invertSteering: app.invertSteering });
  const link = app.engine === 'core' && app.wheelMode === 'dual' ? new CoreLink(wheels.left.session, wheels.right.session) : new WheelPair(wheels.left.session, wheels.right.session, app.wheelMode);
  const sup = app.sup = new DriveSupervisor(link, { mapper, loopInterval: app.engine === 'firmware' ? 0.05 : 0.1 });
  sup.onStateChange = () => { render(); if (sup.state === State.DISCONNECTED || sup.state === State.FAILSAFE) releaseWakeLock(); };
  sup.onCommand = updateBars;
  sup.onFailsafe = (why) => trace(`[FAILSAFE] ${why}`);
  sup.setLowBattery((minBattery() ?? 100) < BATT_LOW_CAP);
  render();
  const ok = await sup.connect();
  if (!ok) { app.sup = null; wheels.left.error = wheels.right.error = ''; alert('Could not switch both wheels into remote mode. Nothing is moving.'); }
  else { sup.startLoop(); if (app.hillHold) await Promise.all(driveSides().map((sd) => wheels[sd].session.setHillHold(true))); }
  render();
}

async function disableDrive() {
  if (app.sup) { await app.sup.shutdown(); app.sup = null; }
  releaseWakeLock(); render();
}

function updateDiag() {
  const el = $('#diag'); if (!el || !app.sup) return;
  const parts = driveSides().map((sd) => { const x = wheels[sd].session; return `${sd[0].toUpperCase()}: ${x.driveWrites || 0} writes, ${x.skippedDrives || 0} coalesced, last ${x._lastDriveOk === false ? 'FAILED' : 'ok'}`; });
  el.textContent = `${app.sup.state}${app.pad.held ? ' · finger down' : ''} · ${parts.join(' · ')}`;
}
setInterval(updateDiag, 500);

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
setInterval(() => {
  if (!app.sup) return;
  if (app.useGamepad) {
    // Hold a shoulder button/trigger as the deadman. Letting go (or unplugging) drops the deadman immediately.
    const gp = [...(navigator.getGamepads?.() ?? [])].find((g) => g && g.connected);
    const dead = !!gp && [4, 5, 6, 7].some((i) => gp.buttons[i]?.pressed);
    const dz = (v) => (Math.abs(v) < 0.12 ? 0 : v);
    app.sup.setInput(gp ? -dz(gp.axes[1] ?? 0) : 0, gp ? dz(gp.axes[0] ?? 0) : 0, dead, app.driveMode);
    return;
  }
  if (app.pad.held) app.sup.setInput(app.pad.vx, app.pad.vy, true, app.driveMode);
}, 50);

// Leaving the app / hiding the page must stop the chair.
const bail = (why) => { if (app.sup && (app.sup.state === State.ARMED || app.sup.state === State.DRIVING)) app.sup.emergencyStop(why); app.pad = { vx: 0, vy: 0, held: false }; };
document.addEventListener('visibilitychange', () => { if (document.hidden) bail('App went to background'); });
window.addEventListener('pagehide', () => bail('Page closed'));
window.addEventListener('blur', () => setTimeout(() => { if (document.hidden || !document.hasFocus()) bail('App lost focus'); }, 300));

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
    packetToolsCard(),
    h('div', { class: 'card' }, h('h2', {}, 'Read probe'),
      h('p', { class: 'mut' }, 'Send one READ request to a connected wheel to explore what it reports (for example battery voltage, if your firmware supports it). Format: service param [payload], hex. Only read parameters (ending in 1) are allowed. Replies appear below and in the log.'),
      h('div', { class: 'seg' }, SIDES.map((sd) => h('button', { class: app.probe.side === sd ? 'on' : '', onclick: () => { app.probe.side = sd; render(); } }, sd))),
      h('input', { id: 'probeIn', value: app.probe.text, autocapitalize: 'off', spellcheck: 'false', oninput: (e) => { app.probe.text = e.target.value; } }),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', disabled: driving(), onclick: runProbe }, 'Send read')),
      h('pre', { id: 'probeOut' }, app.probe.out)),
    h('div', { class: 'card' }, h('h2', {}, 'Protocol log'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.showLog, onchange: (e) => { app.showLog = e.target.checked; render(); } }), h('span', {}, 'Show decrypted packets (contains no keys)')),
      app.showLog && logEl),
  ];
}
async function runProbe() {
  const side = app.probe.side, w = wheels[side];
  const out = (t) => { app.probe.out = t; const el = $('#probeOut'); if (el) el.textContent = t; };
  if (!connected(side)) return out('Wheel not connected.');
  const bytes = app.probe.text.trim().split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x, 16));
  if (bytes.length < 2 || bytes.some((n) => !(n >= 0 && n <= 255))) return out('Enter at least two hex bytes: service param.');
  if ((bytes[1] & 0x0f) !== 1) return out('Blocked: only read parameters (ending in 1) may be probed.');
  try {
    const b = w.session.builder; const pkt = b.packet(bytes[0], bytes[1], bytes.slice(2));
    const reply = await w.transport.transact(pkt, 1500);
    out(reply ? 'Reply: ' + Array.from(reply).map((x) => x.toString(16).padStart(2, '0')).join(' ') : 'No reply (timeout).');
  } catch (e) { out('Error: ' + (e.message || e)); }
}
// ------------------------------------------------------------------ packet tools (m25_analyzer / m25_decrypt / m25_encrypt)
const tool = { mode: 'analyze', fmt: 'text', keySrc: 'left', keyText: '', input: '', out: '' };
function toolKey() {
  if (tool.keySrc === 'paste') return parseKeyInput(tool.keyText.trim());
  const k = wheels[tool.keySrc].transport?.key;
  if (!k) throw new Error('That wheel is not connected, so its key is unknown. Paste a key instead.');
  return k;
}
function runTool() {
  let r;
  try {
    if (tool.mode === 'analyze') r = processAnalyze(tool.input, tool.fmt, true, true);
    else if (tool.mode === 'decrypt') r = processDecrypt({ key: toolKey() }, tool.input, { scope: 'data' });
    else r = processEncrypt(toolKey(), tool.input, { verbose: true });
  } catch (e) { r = { ok: false, out: '', err: 'ERROR: ' + (e.message || e) + '\n' }; }
  tool.out = (r.out + (r.err ? '\n' + r.err : '')).trimEnd();
  const el = $('#toolOut'); if (el) el.textContent = tool.out;
}
function packetToolsCard() {
  const seg = (key, opts) => h('div', { class: 'seg' }, opts.map(([v, t]) => h('button', { class: tool[key] === v ? 'on' : '', onclick: () => { tool[key] = v; render(); } }, t)));
  return h('div', { class: 'card' }, h('h2', {}, 'Packet tools'),
    h('p', { class: 'mut' }, 'The same analyzer, decrypt and encrypt tools as the upstream scripts, with identical output. Keys of connected wheels are used without being shown.'),
    seg('mode', [['analyze', 'Analyze'], ['decrypt', 'Decrypt'], ['encrypt', 'Encrypt']]),
    tool.mode === 'analyze' && seg('fmt', [['text', 'Text'], ['json', 'JSON'], ['oneline', 'One line']]),
    tool.mode !== 'analyze' && [seg('keySrc', [['left', 'Left key'], ['right', 'Right key'], ['paste', 'Paste key']]),
      tool.keySrc === 'paste' && h('input', { type: 'password', autocomplete: 'off', placeholder: '32 hex digits or 22-character QR text', value: tool.keyText, oninput: (e) => { tool.keyText = e.target.value; } })],
    h('textarea', { rows: 4, spellcheck: 'false', autocapitalize: 'off', placeholder: tool.mode === 'analyze' ? 'Decrypted SPP hex, e.g. 01 80 05 01 08 11' : tool.mode === 'decrypt' ? 'Encrypted packet hex' : 'SPP hex to encrypt',
      oninput: (e) => { tool.input = e.target.value; } }, tool.input),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: runTool }, 'Run')),
    h('pre', { id: 'toolOut' }, tool.out));
}

async function copyReport(side) {
  const w = wheels[side]; if (!w.status) return;
  const text = formatWheelStatus(toUpstreamStatus(w.status), side === 'left' ? 'Left' : 'Right', w.transport?.name ?? '?');
  try { await navigator.clipboard.writeText(text); w.error = ''; trace('Status report copied'); } catch { /* fall through */ }
  const el = $('#log'); app.probe.out = text; if (el) el.textContent = text;
  alert(text);
}

// ------------------------------------------------------------------ QR scanner
let jsqrPromise = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsqrPromise ??= new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/jsQR.js'; s.onload = () => res(window.jsQR); s.onerror = () => rej(new Error('QR decoder failed to load')); document.head.append(s); });
  return jsqrPromise;
}
async function scanKey(side) {
  const dlg = $('#scanDlg'), video = $('#scanVideo'), msg = $('#scanMsg');
  if (!navigator.mediaDevices?.getUserMedia) { wheels[side].error = 'This browser cannot open the camera. Type the QR text instead.'; return render(); }
  let stream, stop = false;
  const cleanup = () => { stop = true; try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ } video.srcObject = null; };
  dlg.addEventListener('close', cleanup, { once: true });
  msg.textContent = 'Starting camera...'; dlg.showModal();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream; await video.play();
    msg.textContent = 'Point the camera at the QR code on the wheel label.';
    const detector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
    const jsQR = detector ? null : await loadJsQR();
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    while (!stop) {
      await new Promise((r) => setTimeout(r, 150));
      if (!video.videoWidth) continue;
      let text = null;
      if (detector) { const f = await detector.detect(video).catch(() => []); text = f[0]?.rawValue ?? null; }
      else { canvas.width = video.videoWidth; canvas.height = video.videoHeight; ctx.drawImage(video, 0, 0); const img = ctx.getImageData(0, 0, canvas.width, canvas.height); text = jsQR(img.data, img.width, img.height)?.data ?? null; }
      if (!text) continue;
      try { parseKeyInput(text.trim()); } catch { msg.textContent = 'That QR code is not a wheel key. Keep scanning...'; continue; }
      app.keyDraft[side] = text.trim(); dlg.close(); wheels[side].error = ''; render(); return;
    }
  } catch (e) { dlg.close(); wheels[side].error = 'Camera error: ' + (e.message || e); render(); }
}

function renderLogOnly() { const l = $('#log'); if (l) l.textContent = app.log.join('\n'); }

// ------------------------------------------------------------------ boot
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { app.tab = b.dataset.tab; render(); }));
render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
