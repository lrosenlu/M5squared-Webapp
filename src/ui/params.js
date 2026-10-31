// Drive-parameter editor (the motor-response values behind a drive profile) with factory presets.
import { ASSIST_NAMES, SPEED_RAW, STANDARD_TIER_MAX_RAW, rawToKmh, validateProfileParams } from '../packets.js';
import { PRESETS, SLOPE_VALUES, SPEED_BIAS_VALUES } from '../presets.js';
import { app, wheels, SIDES, connected, bothConnected, driving, render, trace } from '../state.js';
import { h, confirmDialog, section, isOpen } from './dom.js';

const KEYS = ['maxTorque', 'maxSpeedRaw', 'pFactor', 'speedBias', 'speedFactor', 'rotationThreshold', 'slopeInc', 'slopeDec'];
const pickKeys = (p) => Object.fromEntries(KEYS.map((k) => [k, p[k]]));
// presets.js uses upstream's snake_case names
const fromPreset = (a) => ({ maxTorque: a.max_torque, maxSpeedRaw: a.max_speed, pFactor: a.p_factor, speedBias: a.speed_bias,
  speedFactor: a.speed_factor, rotationThreshold: a.rotation_threshold, slopeInc: a.slope_inc, slopeDec: a.slope_dec });
const firstSide = () => SIDES.find(connected);

export async function editorRead() {
  const sd = firstSide(); const e = app.editor; if (!sd) return;
  e.busy = true; e.msg = 'Reading from the ' + sd + ' wheel...'; render();
  const p = await wheels[sd].session.readProfileParams(e.level);
  e.busy = false;
  if (p) { e.draft = pickKeys(p); e.msg = 'Loaded current values from the ' + sd + ' wheel.'; }
  else e.msg = 'The wheel did not answer.';
  render();
}

function editorPreset() {
  const e = app.editor, pr = PRESETS[e.preset]; if (!pr) return;
  e.draft = fromPreset(pr[e.level === 0 ? 'level_1' : 'level_2']);
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

/** Loads the wheel's current values the first time the section is opened (not on every render). */
export function paramsCard() {
  const e = app.editor;
  if (!e.draft && isOpen('params') && !e.busy) setTimeout(editorRead, 0);
  const d = e.draft;
  const num = (key, label, lo, hi) => [h('label', {}, `${label} (${lo}-${hi})`),
    h('input', { type: 'number', inputmode: 'numeric', min: lo, max: hi, value: d?.[key] ?? '', disabled: !d || e.busy,
      onchange: (ev) => { d[key] = parseInt(ev.target.value, 10); } })];
  const pick = (key, label, opts, fmt = String) => [h('label', {}, label),
    h('select', { disabled: !d || e.busy, onchange: (ev) => { d[key] = parseInt(ev.target.value, 10); } },
      opts.map((o) => h('option', { value: o, selected: d?.[key] === o }, fmt(o))))];
  return section('params', 'Drive parameters', [
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
    e.msg && h('p', { class: e.msg.includes('FAILED') ? 'bad' : 'mut' }, e.msg),
  ], { card: false, onOpen: () => { if (!app.editor.draft && !app.editor.busy) editorRead(); } });
}
