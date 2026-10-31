// About tab: project info, wheel-behaviour switches, packet tools, read probe and the protocol log.
import { parseKeyInput } from '../crypto.js';
import { processAnalyze } from '../analyzer.js';
import { processDecrypt, processEncrypt } from '../packettool.js';
import { app, wheels, SIDES, connected, driving, render } from '../state.js';
import { store } from './store.js';
import { $, h, section } from './dom.js';

export function viewAbout() {
  return [
    h('div', { class: 'card' }, h('h2', {}, 'M5Squared (web)'),
      h('p', {}, 'Unofficial companion for Alber e-motion M25 power-assist wheels, ported from the AGPL-3.0 Python toolkit 6static/m5squared. Not affiliated with or endorsed by Alber or Rheinland Zeitlos.'),
      h('p', { class: 'mut' }, 'Provided without warranty. Use only with wheels you own. Changing drive settings or driving remotely can affect safety, warranty and legality. This web port has not been verified on real hardware.'),
      h('p', { class: 'mut' }, 'AGPL-3.0: if you host a modified copy, you must offer its source to users. See LICENSE and NOTICE.md in the project.')),
    section('about-behaviour', 'Wheel behaviour', [
      h('label', {}, 'Release method (Turn off remote and Disconnect)'),
      h('div', { class: 'seg' }, [['standard', 'Standard'], ['firmware', 'Firmware exact']].map(([m, t]) =>
        h('button', { class: app.releaseMode === m ? 'on' : '', onclick: () => { app.releaseMode = m; store.set('releaseMode', m); render(); } }, t))),
      h('p', { class: 'mut' }, 'Standard: connect, then drive mode 0. Firmware exact: stop, wait 50 ms, drive mode 0 (what m25-remote does). If the DuoDrive dial stays dead until a power cycle, try the other one (wheels lifted). Never use system mode 0x02 (standby): on real wheels it left the dial unusable until a power cycle and a 30 s dial hold.'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: app.bmsCheck, onchange: (e) => { app.bmsCheck = e.target.checked; store.set('bmsCheck', app.bmsCheck); } }),
        h('span', {}, 'Charging check (experimental battery-management read, once a second). Turn off if the DuoDrive dial misbehaves after remote use.')),
    ]),
    section('about-tools', 'Packet tools', packetTools()),
    section('about-probe', 'Read probe', readProbe()),
    section('log', 'Protocol log', [
      h('p', { class: 'mut' }, 'Decrypted packets and app events (contains no keys).'),
      h('pre', { id: 'log' }, app.log.join('\n')),
    ]),
  ];
}

// ---- read probe
function readProbe() {
  return [
    h('p', { class: 'mut' }, 'Send one READ request to a connected wheel to explore what it reports. Format: service param [payload], hex. Only read parameters (ending in 1) are allowed.'),
    h('div', { class: 'seg' }, SIDES.map((sd) => h('button', { class: app.probe.side === sd ? 'on' : '', onclick: () => { app.probe.side = sd; render(); } }, sd))),
    h('input', { id: 'probeIn', type: 'text', value: app.probe.text, autocapitalize: 'off', spellcheck: 'false', oninput: (e) => { app.probe.text = e.target.value; } }),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', disabled: driving(), onclick: runProbe }, 'Send read')),
    h('pre', { id: 'probeOut' }, app.probe.out),
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
    const pkt = w.session.builder.packet(bytes[0], bytes[1], bytes.slice(2));
    const reply = await w.transport.transact(pkt, 1500);
    out(reply ? 'Reply: ' + Array.from(reply).map((x) => x.toString(16).padStart(2, '0')).join(' ') : 'No reply (timeout).');
  } catch (e) { out('Error: ' + (e.message || e)); }
}

// ---- packet tools (m25_analyzer / m25_decrypt / m25_encrypt)
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

function packetTools() {
  const seg = (key, opts) => h('div', { class: 'seg' }, opts.map(([v, t]) => h('button', { class: tool[key] === v ? 'on' : '', onclick: () => { tool[key] = v; render(); } }, t)));
  return [
    h('p', { class: 'mut' }, 'The same analyzer, decrypt and encrypt tools as the upstream scripts, with identical output. Keys of connected wheels are used without being shown.'),
    seg('mode', [['analyze', 'Analyze'], ['decrypt', 'Decrypt'], ['encrypt', 'Encrypt']]),
    tool.mode === 'analyze' && seg('fmt', [['text', 'Text'], ['json', 'JSON'], ['oneline', 'One line']]),
    tool.mode !== 'analyze' && [seg('keySrc', [['left', 'Left key'], ['right', 'Right key'], ['paste', 'Paste key']]),
      tool.keySrc === 'paste' && h('input', { type: 'password', autocomplete: 'off', placeholder: '32 hex digits or 22-character QR text', value: tool.keyText, oninput: (e) => { tool.keyText = e.target.value; } })],
    h('textarea', { rows: 4, spellcheck: 'false', autocapitalize: 'off', placeholder: tool.mode === 'analyze' ? 'Decrypted SPP hex, e.g. 01 80 05 01 08 11' : tool.mode === 'decrypt' ? 'Encrypted packet hex' : 'SPP hex to encrypt',
      oninput: (e) => { tool.input = e.target.value; } }, tool.input),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: runTool }, 'Run')),
    h('pre', { id: 'toolOut' }, tool.out),
  ];
}
