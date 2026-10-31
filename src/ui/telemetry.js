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
  const el = $('#speedo'); if (!el) return;
  const v = SIDES.map(speedOf).filter((x) => x != null);
  const avg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  const max = MAX_SPEED_MMPS * 0.0036;
  $('#speedoNum').textContent = avg.toFixed(1);
  $('#speedoArc').setAttribute('stroke-dasharray', `${Math.min(1, Math.abs(avg) / max) * 157} 157`);
  $('#speedoLR').textContent = SIDES.map((sd) => (sd === 'left' ? 'L ' : 'R ') + (speedOf(sd)?.toFixed(1) ?? '-')).join('   ');
}

export function speedometer() {
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
