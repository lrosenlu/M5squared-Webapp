import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSOC, parseAssistLevel, parseDriveMode, parseDriveProfile, parseProfileParams, parseCruiseValues, parseDuoDriveParams, parseSWVersion } from '../src/packets.js';
import { toUpstreamStatus, formatWheelStatus } from '../src/report.js';

const V = JSON.parse(readFileSync(new URL('./report_vectors.json', import.meta.url)));
const hb = (s) => (s === null ? null : Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16)));

test('status report text equals upstream ECSRemote.format_wheel_status over 1500 fuzzed payload sets', () => {
  let full = 0;
  for (const c of V) {
    const p = Object.fromEntries(Object.entries(c.payloads).map(([k, v]) => [k, hb(v)]));
    const parse = (fn, b) => (b === null ? null : fn(b));
    const s = {
      battery: parse(parseSOC, p.soc), assistLevel: parse(parseAssistLevel, p.assist), driveMode: parse(parseDriveMode, p.drive),
      profile: parse(parseDriveProfile, p.profile), params: parse(parseProfileParams, p.params), cruise: parse(parseCruiseValues, p.cruise),
      duo: parse(parseDuoDriveParams, p.duo), firmware: parse(parseSWVersion, p.ver),
    };
    assert.equal(formatWheelStatus(toUpstreamStatus(s), c.name, c.addr), c.text, JSON.stringify(c.payloads));
    if (s.params && s.cruise && s.duo && s.firmware) full++;
  }
  assert.ok(full > 50, `${full} fully populated reports compared`);
});
