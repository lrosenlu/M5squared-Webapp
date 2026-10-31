// Drive tab: enabling remote drive, the joystick, safety hooks and diagnostics. The control logic lives in ../drive.js.
import { WheelPair, CoreLink, DriveSupervisor, State, defaultMapperConfig, Mapper } from '../drive.js';
import { app, wheels, SIDES, BATT_WARN, BATT_CRITICAL, BATT_LOW_CAP, render, trace, driving, driveSides, driveReady, minBattery, batteryLocked, sideMismatch } from '../state.js';
import { store } from './store.js';
import { $, h, confirmDialog, section } from './dom.js';
import { speedometer, updateSpeedo } from './telemetry.js';

const isLive = () => app.sup?.state === State.ARMED || app.sup?.state === State.DRIVING;

export function viewDrive() {
  if (!driveReady()) return [h('div', { class: 'card mut' }, app.wheelMode === 'dual' ? 'Remote drive needs BOTH wheels connected (Wheels tab), or choose single-wheel mode.' : `Connect the ${app.wheelMode} wheel first.`),
    h('div', { class: 'seg' }, wheelModeButtons())];
  const sup = app.sup, st = sup?.state ?? State.DISCONNECTED;
  const out = [];
  if (st === State.DISCONNECTED || st === State.CONNECTING) {
    out.push(h('div', { class: 'card' },
      h('h2', {}, 'Remote drive'),
      h('p', { class: 'warn' }, 'Experimental: this moves a real wheelchair. Test with the wheels lifted and a helper present. Never use near traffic, stairs, ramps or crowds.'),
      batteryNotice(),
      sideMismatch() && h('p', { class: 'bad' }, 'A wheel identifies itself as the opposite side. Fix the Left/Right assignment before driving.'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.driveAck, onchange: (e) => { app.driveAck = e.target.checked; render(); } }), h('span', {}, 'The wheels are lifted or the area is clear, and I accept responsibility for using this.')),
      h('button', { class: 'btn', disabled: !app.driveAck || sideMismatch() || batteryLocked() || st === State.CONNECTING, onclick: enableDrive }, st === State.CONNECTING ? 'Enabling...' : 'Enable remote drive')));
    out.push(section('drive-options', 'Drive options', [
      h('label', {}, 'Wheels to drive'), h('div', { class: 'seg' }, wheelModeButtons()),
      h('label', {}, 'Drive engine'),
      h('div', { class: 'seg' }, [['classic', 'Classic'], ['core', 'Upstream core'], ['firmware', 'Firmware']].map(([v, t]) => h('button', { class: app.engine === v ? 'on' : '', onclick: () => setEngine(v) }, t))),
      h('p', { class: 'mut' }, ENGINE_HELP[app.engine]),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.useGamepad, onchange: (e) => { app.useGamepad = e.target.checked; } }), h('span', {}, 'Game controller: left stick steers, hold any bumper or trigger to move (release = stop). Press a button once so the browser sees it.')),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.invertSteering, onchange: (e) => { app.invertSteering = e.target.checked; store.set('invertSteering', app.invertSteering); } }), h('span', {}, 'Invert steering (if testing on blocks shows left/right reversed)')),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.liveSpeedWhileDriving, onchange: (e) => { app.liveSpeedWhileDriving = e.target.checked; } }), h('span', {}, 'Poll live speed while driving (the firmware avoids this)')),
    ]));
  } else {
    const live = isLive();
    out.push(h('div', { class: 'card' },
      h('div', { class: st === State.FAILSAFE ? 'bad' : live ? 'ok' : 'warn' }, 'State: ', st, sup.failsafeReason ? ` (${sup.failsafeReason})` : ''),
      st === State.PAIRED && h('p', { class: 'mut' }, 'Remote mode is on. Arm to enable the joystick, then hold your finger on the pad to move; release to stop.'),
      h('div', { class: 'seg' }, [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']].map(([m, t]) => h('button', { class: app.driveMode === m ? 'on' : '', onclick: () => { app.driveMode = m; render(); } }, t))),
      h('label', { for: 'spd' }, speedLabel()),
      h('input', { id: 'spd', type: 'range', min: 10, max: 100, step: 5, value: app.speedPct, oninput: (e) => { app.speedPct = +e.target.value; store.set('speedPct', app.speedPct); sup.mapper.config.speedScale = app.speedPct / 100; e.target.previousSibling.textContent = speedLabel(); } }),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.hillHold, onchange: toggleHillHold }), h('span', {}, 'Hill hold (brake on slopes)')),
      batteryNotice(),
      h('div', { class: 'row' },
        st === State.PAIRED && h('button', { class: 'btn', onclick: () => { sup.arm(); acquireWakeLock(); render(); } }, 'Arm'),
        live && h('button', { class: 'btn ghost', onclick: async () => { await sup.disarm(); render(); } }, 'Disarm'),
        h('button', { class: 'btn ghost', onclick: disableDrive }, 'Turn off remote'))));
    out.push(h('div', { id: 'pad', class: live ? 'armed' : 'off' }, h('div', { id: 'knob' })));
    out.push(h('p', { id: 'padHint', class: 'warn' }, ''));
  }
  out.push(h('button', { id: 'estop', onclick: () => app.sup?.emergencyStop('Emergency stop pressed') }, 'EMERGENCY STOP'));
  if (st === State.FAILSAFE) out.push(h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { await sup.reset(); render(); } }, 'Reset')));
  if (sup && st !== State.DISCONNECTED && st !== State.CONNECTING) {
    out.push(h('div', { class: 'bars' }, h('div', {}, h('div', { class: 'mut' }, 'Left ', h('span', { id: 'lv' }, '0')), h('div', { class: 'bar' }, h('i', { id: 'lb' }))),
      h('div', {}, h('div', { class: 'mut' }, 'Right ', h('span', { id: 'rv' }, '0')), h('div', { class: 'bar' }, h('i', { id: 'rb' })))));
    out.push(speedometer());
    out.push(section('drive-diag', 'Diagnostics', h('p', { id: 'diag', class: 'mut' }, '')));
  }
  setTimeout(() => { updateSpeedo(); updateDiag(); }, 0);
  return out;
}

const ENGINE_HELP = {
  classic: 'Classic: the arming and speed commands that worked on real wheels. Gentle speeds.',
  core: 'Upstream core: exactly what the m5squared remote sends (no replies awaited, remote-only mode). Gentle speeds.',
  firmware: 'Firmware (experimental): port of the m25-remote firmware, real mm/s speeds, stricter arming. Test lifted.',
};
const speedLabel = () => `Speed limit: ${Math.round(app.speedPct)} % of the ${app.driveMode} ceiling`;

function setEngine(v) {
  app.engine = v; store.set('engine', v);
  for (const sd of SIDES) if (wheels[sd].session) wheels[sd].session.engine = v;
  render();
}

export function wheelModeButtons() {
  return [['dual', 'Both'], ['left', 'Left only'], ['right', 'Right only']].map(([m, t]) =>
    h('button', { class: app.wheelMode === m ? 'on' : '', disabled: driving(), onclick: () => { app.wheelMode = m; render(); } }, t));
}

function batteryNotice() {
  const b = minBattery();
  if (b == null) return null;
  if (b < BATT_CRITICAL) return h('p', { class: 'bad' }, `Battery ${b} %: too low to enable remote drive (minimum ${BATT_CRITICAL} %). Charge the wheels.`);
  if (b < BATT_LOW_CAP) return h('p', { class: 'warn' }, `Battery ${b} %: remote speed is capped to a lower limit.`);
  if (b < BATT_WARN) return h('p', { class: 'warn' }, `Battery ${b} %: getting low.`);
  return null;
}

async function toggleHillHold(e) {
  app.hillHold = e.target.checked;
  const res = await Promise.all(driveSides().map((sd) => wheels[sd].session.setHillHold(app.hillHold).catch(() => false)));
  trace(`[HILL-HOLD] ${driveSides().map((sd, i) => `${sd}:${res[i] ? 'sent' : 'FAILED'}`).join(' ')}`);
}

async function enableDrive() {
  if (batteryLocked()) return;
  if (!(await confirmDialog('Enable remote drive?', 'Both wheels will switch into remote-control mode and respond to the on-screen joystick. Release the pad or press EMERGENCY STOP to stop.', 'Enable'))) return;
  const mapper = new Mapper({ ...defaultMapperConfig(), invertSteering: app.invertSteering, speedScale: app.speedPct / 100 });
  // Classic/core send percent as the raw speed value, which is far below what moves a chair (upstream's own demo speeds are 80/150/250).
  // Scale 2.5 maps the Slow/Normal/Fast presets (30/60/100 %) to 75/150/250, matching those.
  const scale = 2.5;
  const link = app.engine === 'core' && app.wheelMode === 'dual' ? new CoreLink(wheels.left.session, wheels.right.session, scale) : new WheelPair(wheels.left.session, wheels.right.session, app.wheelMode, scale);
  app.link = link;
  const sup = app.sup = new DriveSupervisor(link, { mapper, loopInterval: app.engine === 'firmware' ? 0.05 : 0.1 });
  sup.onStateChange = () => { render(); if (sup.state === State.DISCONNECTED || sup.state === State.FAILSAFE) releaseWakeLock(); };
  sup.onCommand = updateBars;
  sup.onFailsafe = (why) => trace(`[FAILSAFE] ${why}`);
  sup.setLowBattery((minBattery() ?? 100) < BATT_LOW_CAP);
  render();
  const ok = await sup.connect();
  if (!ok) { app.sup = null; wheels.left.error = wheels.right.error = ''; alert('Could not switch both wheels into remote mode. Nothing is moving.'); }
  else { await reportArm(); sup.startLoop(); if (app.hillHold) await Promise.all(driveSides().map((sd) => wheels[sd].session.setHillHold(true))); }
  render();
}

async function reportArm() {
  for (const sd of driveSides()) {
    const dm = await wheels[sd].session.readDriveModeByte();
    trace(`[ARM] ${sd} drive mode readback: ${dm == null ? 'no reply' : '0x' + dm.toString(16).padStart(2, '0') + (dm & 4 ? ' (remote on)' : ' (REMOTE NOT SET)')}`);
    if (dm != null && !(dm & 4)) wheels[sd].error = 'This wheel did not stay in remote mode after arming.';
    app.armInfo = { ...(app.armInfo || {}), [sd]: dm };
  }
}

async function disableDrive() {
  if (app.sup) { const ok = await app.sup.releaseControl({ variant: app.releaseMode }); if (!ok) trace('[RELEASE] a wheel still reported remote mode after 4 tries; power-cycle it if the dial stays dead'); app.sup = null; }
  releaseWakeLock(); render();
}

function updateDiag() {
  const el = $('#diag'); if (!el || !app.sup) return;
  const parts = driveSides().map((sd) => { const x = wheels[sd].session.driveStats(); return `${sd[0].toUpperCase()}: ${x.writes} writes, ${x.coalesced} coalesced, last ${x.lastOk ? 'ok' : 'FAILED'}`; });
  const raw = app.link?.lastRaw ? ` · last raw L ${app.link.lastRaw.left} / R ${app.link.lastRaw.right}` : '';
  const dm = app.armInfo ? ` · mode ${Object.entries(app.armInfo).map(([k, v]) => k[0].toUpperCase() + ':' + (v == null ? '?' : '0x' + v.toString(16))).join(' ')}` : '';
  el.textContent = `${app.sup.state}${app.pad.held ? ` · finger down (x ${app.pad.vy.toFixed(2)}, y ${app.pad.vx.toFixed(2)})` : ''} · ${parts.join(' · ')}${raw}${dm}`;
}

function updateBars(f) {
  const set = (id, v) => { const b = $('#' + id + 'b'), t = $('#' + id + 'v'); if (!b) return; t.textContent = v;
    b.style.left = v >= 0 ? '50%' : (50 + v / 2) + '%'; b.style.width = Math.abs(v) / 2 + '%'; };
  set('l', f.left); set('r', f.right);
}

// joystick: pointer capture, finger-down == deadman
export function attachPad() {
  const pad = $('#pad'), knob = $('#knob');
  const hint = (t) => { const el = $('#padHint'); if (el) el.textContent = t; };
  const push = () => app.sup?.setInput(isLive() ? app.pad.vx : 0, isLive() ? app.pad.vy : 0, app.pad.held && isLive(), app.driveMode);
  const reset = () => { app.pad = { vx: 0, vy: 0, held: false }; knob.style.left = '33%'; knob.style.top = '33%'; push(); hint(''); };
  const move = (e) => {
    const r = pad.getBoundingClientRect(), R = r.width / 2;
    let dx = (e.clientX - (r.left + R)) / R, dy = (e.clientY - (r.top + R)) / R;
    const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
    app.pad.vx = -dy; app.pad.vy = dx;
    knob.style.left = (33 + dx * 33) + '%'; knob.style.top = (33 + dy * 33) + '%';
    hint(isLive() ? '' : `Not armed (${app.sup?.state ?? 'off'}): the wheels will not move. Press Arm first.`);
    push();
  };
  // The knob always follows the finger so you can see the touch registered; the wheels only get input while armed.
  pad.addEventListener('pointerdown', (e) => { try { pad.setPointerCapture(e.pointerId); } catch { /* optional */ } app.pad.held = true; move(e); e.preventDefault(); });
  pad.addEventListener('pointermove', (e) => { if (app.pad.held) move(e); });
  for (const ev of ['pointerup', 'pointercancel']) pad.addEventListener(ev, () => { if (app.pad.held) reset(); });
  pad.addEventListener('lostpointercapture', () => { if (app.pad.held) reset(); });
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---- safety hooks and input loops (started once from app.js)
const bail = (why) => { if (app.sup && isLive()) app.sup.emergencyStop(why); app.pad = { vx: 0, vy: 0, held: false }; };
// Closing/reloading the tab: stop immediately, then fire the "leave remote mode" writes (cannot be awaited here).
const releaseOnExit = () => { if (app.sup && app.sup.state !== State.DISCONNECTED) { bail('Page closed'); app.sup.releaseNow(); } };

export function startDriveLoops() {
  setInterval(updateDiag, 500);
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
  document.addEventListener('visibilitychange', () => { if (document.hidden) bail('App went to background'); });
  window.addEventListener('beforeunload', releaseOnExit);
  window.addEventListener('pagehide', releaseOnExit);
  window.addEventListener('blur', () => setTimeout(() => { if (document.hidden || !document.hasFocus()) bail('App lost focus'); }, 300));
}

let wakeLock = null;
async function acquireWakeLock() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ } }
function releaseWakeLock() { try { wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }
