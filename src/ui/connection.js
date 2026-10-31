// Connecting, disconnecting, reconnecting and writing settings to the wheels.
import { parseKeyInput } from '../crypto.js';
import { pickWheel, BLEWheelTransport } from '../ble.js';
import { WheelSession, MockWheel } from '../session.js';
import { State } from '../drive.js';
import { app, wheels, SIDES, blank, render, trace, connected, polling, reconnecting } from '../state.js';
import { store } from './store.js';
import { withTimeout, sleep } from './dom.js';

export async function connectReal(side, showAll = false) {
  const w = wheels[side];
  // Some phones/browsers (Bluefy here) never list the wheels with the name/service filter. Once "Show all devices" has
  // worked, Connect uses the unfiltered list too, so the extra tap is not needed again.
  const usedAll = showAll;
  showAll = showAll || !!store.get('pickAll', false);
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
    if (usedAll) store.set('pickAll', true);
    if (app.remember) store.set('key.' + side, raw);
    w.busy = 'Reading status...'; render();
    w.status = await w.session.readStatus();
    if (!w.status.hasData) w.error = transport.rawBytes > 0
      ? 'The wheel is sending data but it cannot be decrypted: this is the wrong key. Each wheel has its own key (left and right differ), and it is the 22-character code from that wheel\'s QR label.'
      : 'Connected, but the wheel sent nothing back. Check About → Protocol log for details, then disconnect, wait 10 s and try again.';
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
    await sleep(2000);
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
export function swapSides() {
  if (app.sup && app.sup.state !== State.DISCONNECTED) return;
  [wheels.left, wheels.right] = [wheels.right, wheels.left];
  for (const sd of SIDES) if (wheels[sd].session) wheels[sd].session.side = sd;
  const [kl, kr] = [store.get('key.left'), store.get('key.right')];
  for (const [sd, k] of [['left', kr], ['right', kl]]) { if (k) store.set('key.' + sd, k); else store.del('key.' + sd); }
  [app.keyDraft.left, app.keyDraft.right] = [app.keyDraft.right, app.keyDraft.left];
  render();
}

export async function disconnect(side) {
  // Release remote mode (and verify it) BEFORE closing the link, or the wheel can stay locked out of the DuoDrive dial.
  if (app.sup && app.sup.state !== State.DISCONNECTED) { await app.sup.releaseControl({ variant: app.releaseMode }); app.sup = null; }
  const w = wheels[side];
  // Upstream disconnects between exchanges. Stop polling this wheel, let the request in flight finish, then close.
  w.closing = true;
  const t0 = Date.now();
  while ((polling[side] || w.busy) && Date.now() - t0 < 2500) await sleep(25);
  try { await withTimeout(w.session?.idle() ?? Promise.resolve(), 1500, null); } catch { /* ignore */ }
  await sleep(100);
  try { await w.transport?.disconnect(); } catch { /* ignore */ }
  wheels[side] = blank();
  render();
}

export async function startDemo() {
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

export async function refresh(side) {
  const w = wheels[side]; if (!w.session) return;
  w.busy = 'Reading...'; render();
  w.status = await w.session.readStatus();
  w.busy = ''; render();
}

/** One write on one wheel. Never leaves the card on "Writing..." forever: gives up after 15 s and says so. */
export async function applyOne(side, label, fn) {
  const w = wheels[side]; if (!w.session) return;
  w.busy = label; w.error = ''; render();
  let ok = false;
  try { ok = await withTimeout(fn(w.session), 15000, () => new Error('The wheel stopped responding while writing. Disconnect, wait 10 s, reconnect.')); }
  catch (e) { w.error = e.message || String(e); }
  if (!ok && !w.error) w.error = 'The wheel did not accept that change.';
  w.busy = ''; render();   // the write is done; the full status re-read can be slow and must not keep the card "busy"
  return ok;
}

/** Re-read a wheel's full status in the background, bounded to 12 s, and show it when it arrives. */
async function refreshStatus(side) {
  const w = wheels[side]; if (!w.session) return;
  try {
    const st = await withTimeout(w.session.readStatus(), 12000, null);
    if (st) w.status = st; else trace(`[STATUS ${side}] re-read after write timed out (the wheel is slow to answer); showing the previous values`);
  } catch (e) { trace(`[STATUS ${side}] re-read failed: ${e.message || e}`); }
  render();
}

/** Change a setting on this wheel, or on both at once when "Keep both wheels in sync" is on. */
export async function apply(side, label, fn) {
  const w = wheels[side]; if (!w.session) return;
  if (app.sup && app.sup.state !== State.DISCONNECTED) { w.error = 'Turn off remote drive before changing settings.'; return render(); }
  const targets = app.sync ? SIDES.filter((sd) => wheels[sd].session && connected(sd)) : [side];
  await Promise.all(targets.map((sd) => applyOne(sd, label, fn)));
  await Promise.all(targets.map(refreshStatus));
  if (targets.length > 1) {
    const [a, b] = targets.map((sd) => wheels[sd].status);
    if (a && b && (a.assistLevel !== b.assistLevel || a.profile !== b.profile || !!a.driveMode?.autoHold !== !!b.driveMode?.autoHold
      || a.params?.maxSpeedRaw !== b.params?.maxSpeedRaw)) for (const sd of targets) wheels[sd].error = 'The two wheels ended up with different settings. Check both cards.';
    render();
  }
}
