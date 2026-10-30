// Port of the dry-run path of m25_parking.py (main + run_remote_test): same text, byte for byte.
import { encryptVerbose } from './packettool.js';
import { toHex } from './protocol.js';

export const SPEED_SLOW = 80, SPEED_MEDIUM = 150, SPEED_FAST = 250, COMMAND_INTERVAL_MS = 100, FORWARD_DURATION_MS = 500;

class Builder {
  constructor() { this.tid = 0x80; }
  pkt(param, payload = []) { const t = this.tid; this.tid = (this.tid + 1) & 0xff; return Uint8Array.of(0x01, t, 5, 1, 1, param, ...payload); }
  systemMode(m) { return this.pkt(0x10, [m]); }
  driveMode(m) { return this.pkt(0x20, [m]); }
  remoteSpeed(s) { const v = ((s % 65536) + 65536) % 65536; return this.pkt(0x30, [v >> 8, v & 255]); }
}

/** `ivFor(side, n)` supplies the n-th IV (0-based) for 'left'/'right' so tests can be deterministic; default random. */
export function parkingDryRun({ leftKey, rightKey, speed = SPEED_SLOW, leftSpeed = null, rightSpeed = null, durationMs = FORWARD_DURATION_MS, ivFor } = {}) {
  let out = '';
  const print = (s = '', end = '\n') => { out += s + end; };
  const n = { left: 0, right: 0 };
  const enc = (side, p) => toHex(encryptVerbose(p, side === 'left' ? leftKey : rightKey, ivFor ? ivFor(side, n[side]++) : undefined).encrypted_packet);
  if (speed < 0 || speed > 350) print(`WARNING: Speed ${speed} is outside typical range (0-350)`);
  print('\n*** DRY RUN MODE ***');
  print('Showing packets that would be sent.\n');
  print(`Left wheel key:  ${toHex(leftKey)}`);
  print(`Right wheel key: ${toHex(rightKey)}`);
  const L = new Builder(), R = new Builder();
  print('\nM25 Remote Control Test [DRY RUN]');
  const both = (pl, pr, d) => {
    print(`\n>> ${d}`);
    print(`   Left SPP:  ${toHex(pl)}`);
    print(`   Right SPP: ${toHex(pr)}`);
    const el = enc('left', pl), er = enc('right', pr);
    print(`   Left would send:  ${el}`);
    print(`   Right would send: ${er}`);
  };
  print('\n[0/5] INITIALIZING CONNECTION');
  both(L.systemMode(1), R.systemMode(1), 'WRITE_SYSTEM_MODE = 0x01 (connect)');
  print('\n[1/5] ENABLING REMOTE CONTROL MODE');
  both(L.driveMode(4), R.driveMode(4), 'WRITE_DRIVE_MODE = 0x04 (remote)');
  const ls = -(leftSpeed ?? speed), rs = rightSpeed ?? speed;
  print(`\n[2/5] MOVING FORWARD (left=${ls}, right=${rs}, duration=${durationMs}ms)`);
  const num = Math.floor(durationMs / COMMAND_INTERVAL_MS);
  for (let i = 0; i < num; i++) {
    const pl = L.remoteSpeed(ls), pr = R.remoteSpeed(rs);
    if (i === 0) both(pl, pr, `WRITE_REMOTE_SPEED left=${ls}, right=${rs}`);
    else print(`   Sending speed command ${i + 1}/${num}...`, '\r');
  }
  print(`   Sent ${num} speed commands                    `);
  print('\n[3/5] STOPPING');
  both(L.remoteSpeed(0), R.remoteSpeed(0), 'WRITE_REMOTE_SPEED = 0 (stop)');
  print('\n[4/5] DISABLING REMOTE CONTROL MODE');
  both(L.driveMode(0), R.driveMode(0), 'WRITE_DRIVE_MODE = 0x00 (normal)');
  print('\n' + '='.repeat(60));
  print('TEST COMPLETE');
  print('='.repeat(60));
  return out;
}
