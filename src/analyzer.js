// Port of m25_analyzer.py (M25PacketParser, PacketFormatter, process_packet) and the hex helper from m25_utils.py.
// Output strings are byte-identical to upstream (verified by test/tools.test.mjs against generated vectors).
import { SOURCE_NAMES, DEST_NAMES, SERVICE_NAMES, PARAM_NAMES_BY_SERVICE, PARAM_ID_ACK, MIN_SPP_PACKET_SIZE, VALID_PROTOCOL_IDS } from './names.js';

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
export const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** m25_utils.parse_hex: tolerate spaces and colons, otherwise bytes.fromhex semantics incl. its error text. */
export function parseHex(str) {
  const s = str.replace(/ /g, '').replace(/:/g, '');
  const out = [];
  let i = 0;
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
  const val = (c) => { const n = parseInt(c, 16); return /^[0-9a-fA-F]$/.test(c) ? n : -1; };
  while (i < s.length) {
    if (isWs(s[i])) { i++; continue; }
    const hi = val(s[i]);
    if (hi < 0) throw new Error(`non-hexadecimal number found in fromhex() arg at position ${i}`);
    i++;
    if (i >= s.length) throw new Error(`non-hexadecimal number found in fromhex() arg at position ${i}`);
    const lo = val(s[i]);
    if (lo < 0) throw new Error(`non-hexadecimal number found in fromhex() arg at position ${i}`);
    i++;
    out.push((hi << 4) | lo);
  }
  return Uint8Array.from(out);
}

export const getSourceName = (id) => SOURCE_NAMES[id] ?? `UNKNOWN_SRC_0x${hex2(id)}`;
export const getDestName = (id) => DEST_NAMES[id] ?? `UNKNOWN_DEST_0x${hex2(id)}`;
export const getServiceName = (id) => SERVICE_NAMES[id] ?? `UNKNOWN_SRV_0x${hex2(id)}`;
export function getParamName(service, param) {
  if (param === PARAM_ID_ACK) return 'ACK';
  const t = PARAM_NAMES_BY_SERVICE[service];
  if (t) return t[param] ?? `PARAM_0x${hex2(param)}`;
  return `PARAM_0x${hex2(param)}`;
}

/** Returns {packet} or {error} (upstream prints the error to stderr and returns None). */
export function parsePacket(spp) {
  if (spp.length < MIN_SPP_PACKET_SIZE) return { error: `ERROR: Packet too short (${spp.length} bytes, minimum ${MIN_SPP_PACKET_SIZE})` };
  const payload = spp.length > 6 ? spp.slice(6) : new Uint8Array(0);
  return { packet: {
    protocol_id: spp[0], telegram_id: spp[1], source_id: spp[2], dest_id: spp[3], service_id: spp[4], param_id: spp[5], payload,
    packet_length: spp.length, payload_length: payload.length, has_payload: payload.length > 0,
    source_name: getSourceName(spp[2]), dest_name: getDestName(spp[3]), service_name: getServiceName(spp[4]),
    param_name: getParamName(spp[4], spp[5]), raw_hex: bytesToHex(spp),
  } };
}

export function validatePacket(p) {
  const w = [];
  if (!VALID_PROTOCOL_IDS.includes(p.protocol_id)) w.push(`Invalid protocol ID: 0x${hex2(p.protocol_id)} (expected 0x00 or 0x01)`);
  if (p.source_name.startsWith('UNKNOWN_SRC')) w.push(`Unknown source ID: 0x${hex2(p.source_id)}`);
  if (p.dest_name.startsWith('UNKNOWN_DEST')) w.push(`Unknown destination ID: 0x${hex2(p.dest_id)}`);
  if (p.service_name.startsWith('UNKNOWN_SRV')) w.push(`Unknown service ID: 0x${hex2(p.service_id)}`);
  return w;
}

export function formatText(p, verbose = false) {
  const l = [];
  l.push(`Protocol ID:  0x${hex2(p.protocol_id)}`);
  l.push(`Telegram ID:  ${p.telegram_id} (0x${hex2(p.telegram_id)})`);
  l.push(`Source:       ${p.source_name} (0x${hex2(p.source_id)})`);
  l.push(`Destination:  ${p.dest_name} (0x${hex2(p.dest_id)})`);
  l.push(`Service:      ${p.service_name} (0x${hex2(p.service_id)})`);
  l.push(`Parameter:    ${p.param_name} (0x${hex2(p.param_id)})`);
  l.push(p.has_payload ? `Payload:      ${bytesToHex(p.payload)} (${p.payload_length} bytes)` : 'Payload:      (none)');
  if (verbose) l.push(`Raw SPP:      ${p.raw_hex}`);
  return l.join('\n');
}

export function formatJson(p) {
  return JSON.stringify({
    protocol: { id: `0x${hex2(p.protocol_id)}`, telegram_id: p.telegram_id },
    communication: { source: { id: p.source_id, name: p.source_name }, destination: { id: p.dest_id, name: p.dest_name } },
    service: { id: p.service_id, name: p.service_name },
    parameter: { id: p.param_id, name: p.param_name },
    payload: { hex: bytesToHex(p.payload), length: p.payload_length },
  }, null, 2);
}

export function formatOneline(p) {
  const payload = p.has_payload ? bytesToHex(p.payload) : '(none)';
  return `PID=0x${hex2(p.protocol_id)} TID=${hex2(p.telegram_id)} ${p.source_name}->${p.dest_name} SRV=${p.service_name} PARAM=${p.param_name} PAYLOAD=${payload}`;
}

/** m25_analyzer.process_packet: returns {ok, out, err} with exactly the text upstream would print. */
export function processAnalyze(hexData, format = 'text', verbose = false, showWarnings = true) {
  let spp;
  try { spp = parseHex(hexData); } catch (e) { return { ok: false, out: '', err: `ERROR: Invalid hex string: ${e.message}\n` }; }
  const r = parsePacket(spp);
  if (r.error) return { ok: false, out: '', err: r.error + '\n' };
  let err = '';
  if (showWarnings) for (const w of validatePacket(r.packet)) err += `WARNING: ${w}\n`;
  let out;
  if (format === 'json') out = formatJson(r.packet) + '\n';
  else if (format === 'oneline') out = formatOneline(r.packet) + '\n';
  else out = formatText(r.packet, verbose) + '\n' + '############\n\n';
  return { ok: true, out, err };
}
