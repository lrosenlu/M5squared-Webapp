// Live gauges: 1 Hz telemetry poll, battery limits and the speedometer.
import { MAX_SPEED_MMPS } from '../packets.js';
import { State } from '../drive.js';
import { app, wheels, SIDES, BATT_LOW_CAP, polling, reconnecting, connected, driving, minBattery } from '../state.js';
import { render } from '../state.js';
import { $, h, view } from './dom.js';

async function pollTelemetry() {
  for (const side of SIDES) {
    const w = wheels[side];
    if (!connected(side) || !w.session || polling[side] || w.busy || w.closing || reconnecting[side]) continue;
    // Like the firmware, leave the link alone while armed/driving unless live speed was asked for.
    if (driving() && !app.liveSpeedWhileDriving) continue;
    polling[side] = true;
    w.session.readTelemetry({ bms: !driving() && app.bmsCheck }).then((t) => {
      w.tele = { ...(w.tele || {}), ...t, bms: t.bms ?? w.tele?.bms };
      if (t.battery != null && w.status) w.status.battery = t.battery;
    }).catch(() => {}).finally(() => { polling[side] = false; onTelemetry(); });
  }
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

export const startTelemetry = () => setInterval(pollTelemetry, 1000);

// The wheel reports signed speed; the left wheel is mirrored, so negate it to make forward positive on both.
export function speedOf(side) { const c = wheels[side].tele?.cruise; return connected(side) && c ? (side === 'left' ? -c.speedKmh : c.speedKmh) : null; }

export function updateSpeedo() {
  const el = $('#speedo');
  if (!app.sup) app.tripBase = null;
  if (!el) return;
  const v = SIDES.map(speedOf).filter((x) => x != null);
  const avg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  const max = MAX_SPEED_MMPS * 0.0036;
  const d = SIDES.map((sd) => (connected(sd) ? wheels[sd].tele?.cruise?.distanceKm : null)).filter((x) => x != null);
  const odo = d.length ? d.reduce((a, b) => a + b, 0) / d.length : null;
  if (odo != null && app.tripBase == null) app.tripBase = odo;
  $('#speedoNum').textContent = Math.abs(avg).toFixed(1);
  $('#speedoArc').style.width = Math.min(1, Math.abs(avg) / max) * 100 + '%';
  $('#odoNum').textContent = odo != null ? odo.toFixed(2) : '--';
  $('#tripNum').textContent = odo != null ? Math.max(0, odo - app.tripBase).toFixed(2) : '--';
  $('#speedoLR').textContent = SIDES.map((sd) => (sd === 'left' ? 'L ' : 'R ') + (speedOf(sd)?.toFixed(1) ?? '-')).join('   ');
  const live = $('#liveBtn'); if (live) live.textContent = app.liveSpeedWhileDriving ? 'Live speed: on' : 'Live speed: off (tap)';
}

/** Large drive dashboard: speed, odometer (wheel total) and trip distance (since remote drive was enabled). */
export function dashboard() {
  const tile = (label, id, unit) => h('div', { class: 'tile' }, h('div', { class: 'mut' }, label), h('div', { class: 'tnum' }, h('span', { id }, '--'), ' ' + unit));
  return h('div', { id: 'speedo', class: 'card dash' },
    h('div', { class: 'dash-speed' }, h('div', { class: 'speedo-num' }, h('span', { id: 'speedoNum' }, '0.0'), h('small', {}, ' km/h')), h('div', { class: 'sbar' }, h('i', { id: 'speedoArc' }))),
    h('div', { class: 'dash-side' }, tile('Odometer', 'odoNum', 'km'), tile('Trip', 'tripNum', 'km')),
    h('div', { class: 'dash-foot' }, h('span', { id: 'speedoLR', class: 'mut' }, ''),
      h('button', { id: 'liveBtn', class: 'ghost mini', onclick: () => { app.liveSpeedWhileDriving = !app.liveSpeedWhileDriving; updateSpeedo(); } }, '')));
}
