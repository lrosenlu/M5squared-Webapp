// Status tab: per-wheel readings and the settings that are always written to both wheels together.
import { ASSIST_NAMES, PROFILES, SELECTABLE_PROFILES, selectableKmh } from '../packets.js';
import { toUpstreamStatus, formatWheelStatus } from '../report.js';
import { app, wheels, SIDES, connected, bothConnected, driving, srcSide, render, trace } from '../state.js';
import { store } from './store.js';
import { h, confirmDialog, section } from './dom.js';
import { apply, applyOne, refresh } from './connection.js';
import { speedOf } from './telemetry.js';
import { paramsCard } from './params.js';

export function viewStatus() {
  if (!SIDES.some(connected)) return [h('div', { class: 'card mut' }, 'Connect a wheel first.')];
  return [
    syncNotice(),
    ...SIDES.filter(connected).map(statusCard),
    section('status-advanced', 'Advanced', [
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.allowHigh, onchange: async (e) => {
        if (e.target.checked && !(await confirmDialog('Allow speeds above 6 km/h?',
          'Wheels without the manufacturer\'s higher-speed licence are limited to 6.0 km/h. Raising it may not be allowed where you live or by your warranty and insurance. You are responsible for any use.', 'Allow'))) { e.target.checked = false; return; }
        app.allowHigh = e.target.checked; store.set('allowHigh', app.allowHigh); render();
      } }), h('span', {}, 'Allow speed choices above 6.0 km/h (up to 8.5)')),
      paramsCard(),
    ]),
  ];
}

function statusCard(side) {
  const w = wheels[side], s = w.status, locked = !!w.busy;
  const kv = (k, v) => [h('span', {}, k), h('span', {}, v ?? '-')];
  const level = s?.assistLevel ?? 0;
  const c = w.tele?.cruise ?? s?.cruise ?? null;
  const cur = s?.params ? Math.round(s.params.maxSpeedKmh * 2) / 2 : null;
  const battery = w.tele?.battery ?? s?.battery;
  const spd = speedOf(side);
  return h('div', { class: 'card' },
    h('h2', {}, (side === 'left' ? 'Left' : 'Right') + ' wheel', w.demo && ' (demo)'),
    s && !s.hasData && h('p', { class: 'bad' }, 'No reply from this wheel. Either the key is not this wheel\'s key, or this slot is connected to the same wheel as the other slot. Disconnect it on the Wheels tab, then reconnect and choose the other device name.'),
    s && srcSide(s) && srcSide(s) !== side && h('p', { class: 'warn' }, `This wheel identifies itself as the ${srcSide(s)} wheel, but you connected it as ${side}. Swap sides before driving.`),
    s && h('div', { class: 'kv' },
      ...kv('Battery', battery != null ? battery + ' %' + (w.tele?.bms?.charging ? ' (charging)' : '') : null),
      ...kv('Speed', spd != null ? spd.toFixed(2) + ' km/h' : null)),
    h('label', {}, 'Assist level'),
    h('div', { class: 'seg' }, [[0, 'Indoor'], [1, 'Outdoor'], [2, 'Learning']].map(([v, t]) => h('button', { class: level === v ? 'on' : '', disabled: locked, onclick: () => apply(side, 'Writing...', (x) => x.writeAssistLevel(v)) }, t))),
    h('label', {}, `Max speed (${ASSIST_NAMES[level] ?? ''} level)`),
    h('select', { disabled: locked || level > 1, onchange: (e) => apply(side, 'Writing...', (x) => x.writeMaxSpeed(level, parseFloat(e.target.value), app.allowHigh)) },
      selectableKmh(app.allowHigh).map((k) => h('option', { value: k, selected: cur === k }, k.toFixed(1) + ' km/h'))),
    h('label', {}, 'Drive profile'),
    h('select', { disabled: locked, onchange: (e) => apply(side, 'Writing...', (x) => x.writeDriveProfile(parseInt(e.target.value, 10))) },
      SELECTABLE_PROFILES.map((p) => h('option', { value: p, selected: s?.profile === p }, PROFILES[p]))),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', disabled: locked, checked: !!s?.driveMode?.autoHold, onchange: (e) => apply(side, 'Writing...', (x) => x.writeAutoHold(e.target.checked)) }), h('span', {}, 'Auto-hold (brake on slopes)')),
    w.busy && h('p', { class: 'mut' }, w.busy), w.error && h('p', { class: 'bad' }, w.error),
    s && section(`status-${side}-more`, 'Sensors and details', [
      h('div', { class: 'kv' },
        ...kv('Bluetooth device', w.transport?.name),
        ...kv('Firmware', s.firmware?.text),
        ...kv('Distance', c ? c.distanceKm.toFixed(2) + ' km' : null),
        ...kv('Push rim sensor', c ? String(c.pushRim) : null),
        ...kv('Push count', c ? String(c.pushCount) : null),
        ...kv('Wheel error', c ? (c.wheelError ? 'code ' + c.wheelError : 'none') : null),
        ...kv('Charging', w.tele?.bms ? (w.tele.bms.charging ? 'yes' : 'no') : (w.session?.bmsSupported === false ? 'not reported' : null)),
        ...kv('Voltage', 'not reported by wheel'),
        ...kv('DuoDrive dial side', s.duo?.mounting)),
    ], { card: false }),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', disabled: locked, onclick: () => refresh(side) }, 'Refresh'),
      s && h('button', { class: 'btn ghost', onclick: () => copyReport(side) }, 'Copy report')));
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
    h('p', { class: diff.length ? 'warn' : 'ok' }, diff.length ? `The wheels differ in: ${diff.join(', ')}.` : 'Both wheels match. Changes here are written to both.'),
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

async function copyReport(side) {
  const w = wheels[side]; if (!w.status) return;
  const text = formatWheelStatus(toUpstreamStatus(w.status), side === 'left' ? 'Left' : 'Right', w.transport?.name ?? '?');
  try { await navigator.clipboard.writeText(text); w.error = ''; trace('Status report copied'); } catch { /* fall through to the alert */ }
  alert(text);
}
