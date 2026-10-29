// Scripted reply scenarios (NACKs, echoed params, ACK-with-payload, wrong telegram id, retries...)
// produced by the UPSTREAM ECSRemote.read_value/write_value; the JS WheelSession must give the same
// result AND make the same number of attempts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WheelSession } from '../src/session.js';
import { parseSOC } from '../src/packets.js';

const S = JSON.parse(readFileSync(new URL('./session_fuzz.json', import.meta.url)));
const hex = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

function reply(req, spec) {
  if (spec.none) return null;
  if (spec.raw) return hex(spec.raw);
  const tid = (req[1] + (spec.tidAdd ?? 0)) & 0xff;
  const svc = (spec.service ?? 'req') === 'req' ? req[4] : spec.service;
  const prm = (spec.param ?? 'req') === 'req' ? req[5] : spec.param;
  return Uint8Array.from([1, tid, 3, 5, svc, prm, ...hex(spec.payload ?? '')]);
}

for (const sc of S) {
  test(`session scenario: ${sc.name} (${sc.kind})`, async () => {
    let calls = 0;
    const transport = { transact: async (p) => { const s = sc.specs[Math.min(calls, sc.specs.length - 1)]; calls++; return reply(p, s); } };
    const w = new WheelSession('left', transport, { retries: 2 });
    const res = sc.kind === 'read'
      ? await w._read(() => w.builder.readSOC(), 0x12, parseSOC)
      : await w._write(w.builder.writeDriveMode(1));
    assert.equal(res, sc.result);
    assert.equal(calls, sc.calls, 'number of attempts');
  });
}
