// Wheels tab: connect each wheel with its key.
import { bluetoothSupported } from '../ble.js';
import { app, wheels, SIDES, connected, render } from '../state.js';
import { store } from './store.js';
import { h, section } from './dom.js';
import { connectReal, disconnect, swapSides, startDemo } from './connection.js';
import { scanKey } from './qrscan.js';

function wheelCard(side) {
  const w = wheels[side];
  return h('div', { class: 'card' },
    h('h2', {}, side === 'left' ? 'Left wheel' : 'Right wheel'),
    connected(side)
      ? [h('div', { class: 'ok' }, 'Connected: ', w.transport.name, w.transport.profile ? ` (${w.transport.profile.name})` : ''),
         h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => disconnect(side) }, 'Disconnect'))]
      : [h('label', { for: 'key-' + side }, 'Key: 22-character QR text, or 32 hex digits'),
         h('input', { id: 'key-' + side, type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
           placeholder: store.get('key.' + side) ? 'Saved key will be used' : 'Paste or type the key',
           value: app.keyDraft[side], oninput: (e) => { app.keyDraft[side] = e.target.value; } }),
         h('div', { class: 'row' }, h('button', { class: 'btn', disabled: !!w.busy || !bluetoothSupported(), onclick: () => connectReal(side) }, 'Connect'),
           h('button', { class: 'btn ghost', disabled: !!w.busy || !bluetoothSupported(), onclick: () => connectReal(side, true) }, 'Show all devices'),
           h('button', { class: 'btn ghost', onclick: () => scanKey(side) }, 'Scan QR')),
         h('p', { class: 'mut' }, store.get('pickAll') ? 'Connect lists every nearby Bluetooth device (this phone needs that to see the wheels).' : 'Wheel not listed? Switch it on, close the official app, unpair it in the phone\'s Bluetooth settings, then try "Show all devices".')],
    w.busy && h('p', { class: 'mut' }, w.busy),
    w.error && h('p', { class: 'bad' }, w.error));
}

export function viewWheels() {
  const anyConnected = SIDES.some(connected);
  return [
    ...SIDES.map(wheelCard),
    section('wheels-options', 'Options', [
      anyConnected && [
        h('p', { class: 'mut' }, 'Each wheel reports which side it is. If the Status tab says a wheel is on the opposite side, swap the assignment here (nothing is reconnected or changed on the wheels).'),
        h('button', { class: 'btn ghost', onclick: swapSides }, 'Swap left / right')],
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.remember, onchange: (e) => {
        app.remember = e.target.checked; store.set('remember', app.remember);
        if (!app.remember) SIDES.forEach((s) => store.del('key.' + s));
      } }), h('span', {}, 'Remember keys on this device. They are stored unencrypted in this browser; leave off on shared devices.')),
      SIDES.some((s) => store.get('key.' + s)) && h('button', { class: 'btn ghost', onclick: () => { SIDES.forEach((s) => store.del('key.' + s)); render(); } }, 'Forget saved keys'),
      h('p', { class: 'mut' }, 'No wheels handy? Demo mode simulates two wheels so you can try every screen. Nothing is sent over Bluetooth.'),
      h('button', { class: 'btn ghost', onclick: startDemo }, 'Start demo mode'),
    ]),
  ];
}
