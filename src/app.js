// M5Squared web app entry: tabs, header chips and boot. Protocol/safety logic lives in ble/session/drive; screens in ui/.
import { bluetoothSupported, bluetoothHelp } from './ble.js';
import { State } from './drive.js';
import { app, wheels, SIDES, hooks, connected } from './state.js';
import { $, h, view } from './ui/dom.js';
import { viewWheels } from './ui/wheelsview.js';
import { viewStatus } from './ui/status.js';
import { viewDrive, attachPad, startDriveLoops } from './ui/drivepanel.js';
import { viewAbout } from './ui/about.js';
import { startTelemetry } from './ui/telemetry.js';

const VIEWS = { wheels: viewWheels, status: viewStatus, drive: viewDrive, about: viewAbout };

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === app.tab));
  renderChips(); renderBanner();
  if (app.tab === 'drive' && $('#pad') && app.pad.held) return; // never rebuild the DOM under a finger
  view.replaceChildren(...VIEWS[app.tab]());
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

hooks.render = render;
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { app.tab = b.dataset.tab; render(); }));
startTelemetry();
startDriveLoops();
render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
