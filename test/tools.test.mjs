import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { processAnalyze, parseHex, parsePacket, validatePacket, formatText, formatJson, formatOneline, bytesToHex } from '../src/analyzer.js';
import { processDecrypt, processEncrypt, encryptVerbose } from '../src/packettool.js';

const V = JSON.parse(readFileSync(new URL('./tools_vectors.json', import.meta.url)));
const hexb = (s) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

test('parse_hex matches Python bytes.fromhex semantics and messages', () => {
  for (const c of V.hex) {
    if ('err' in c) assert.throws(() => parseHex(c.in), { message: c.err }, JSON.stringify(c.in));
    else assert.equal(bytesToHex(parseHex(c.in)), c.out, JSON.stringify(c.in));
  }
});

test('analyzer: parse/validate/format_* are byte-identical to m25_analyzer', () => {
  let n = 0;
  for (const c of V.analyzer) {
    const spp = hexb(c.hex);
    const r = parsePacket(spp);
    if (!r.packet) { assert.equal(r.error + '\n', c.parse_err, c.hex); continue; }
    const p = r.packet; n++;
    assert.deepEqual(validatePacket(p), c.warnings, c.hex);
    assert.equal(formatText(p), c.text, c.hex);
    assert.equal(formatText(p, true), c.text_verbose, c.hex);
    assert.equal(formatJson(p), c.json, c.hex);
    assert.equal(formatOneline(p), c.oneline, c.hex);
    assert.equal(p.param_name, c.param_name);
    for (const fmt of ['text', 'json', 'oneline']) {
      const o = processAnalyze(c.hex, fmt, true, true), e = c['proc_' + fmt];
      assert.deepEqual({ ok: o.ok, out: o.out, err: o.err }, e, `${fmt} ${c.hex}`);
    }
  }
  assert.ok(n > 500);
});

test('encrypt: packet, raw, iv_encrypted, crc and tool output equal upstream (fixed IV)', () => {
  for (const c of V.crypto) {
    const key = hexb(c.key), spp = hexb(c.spp), iv = hexb(c.iv);
    if (c.enc_err) { assert.throws(() => encryptVerbose(spp, key, iv), { message: c.enc_err }); continue; }
    const r = encryptVerbose(spp, key, iv);
    assert.equal(bytesToHex(r.encrypted_packet), c.packet);
    assert.equal(bytesToHex(r.encrypted_packet_raw), c.raw);
    assert.equal(bytesToHex(r.iv_encrypted), c.iv_encrypted);
    assert.equal(bytesToHex(r.encrypted_data), c.encrypted_data);
    assert.equal(r.frame_length, c.frame_length); assert.equal(r.crc, c.crc);
    const t = processEncrypt(key, c.spp, { minimal: false, verbose: true, iv });
    assert.deepEqual(t, c.enc_tool);
  }
});

test('decrypt tool: output and diagnostics equal m25_decrypt for good/corrupt/truncated/wrong-key packets, both scopes, multi-key', () => {
  let ok = 0, bad = 0;
  for (const c of V.crypto) {
    if (!c.dec) continue;
    for (const [name, d] of Object.entries(c.dec)) {
      const key = hexb(d.key);
      for (const scope of ['complete', 'data']) for (const sv of [false, true]) {
        const got = processDecrypt({ key }, d.packet, { scope, skipValidation: sv });
        const exp = d[`${scope}_${sv ? 'nv' : 'v'}`];
        assert.deepEqual(got, exp, `${name} ${scope} skip=${sv}`);
        got.ok ? ok++ : bad++;
      }
      const m = processDecrypt({ keys: V.keys.map(hexb) }, d.packet, { minimal: true, scope: 'data', showKey: true });
      assert.deepEqual(m, d.multi, `${name} multi`);
    }
  }
  assert.ok(ok > 100 && bad > 50, `${ok} ok / ${bad} failing cases exercised`);
});
