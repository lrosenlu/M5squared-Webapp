// Port of m25_crypto.py (verbose paths) and the process_packet helpers of m25_decrypt.py / m25_encrypt.py.
import { ecb, cbc } from './aes.js';
import { HEADER_MARKER, HEADER_SIZE, IV_SIZE, MAX_FRAME_LENGTH, MIN_PACKET_LENGTH, crc16, addDelimiters, removeDelimiters, concat } from './protocol.js';
import { parseHex, bytesToHex } from './analyzer.js';

const h4 = (n) => n.toString(16).padStart(4, '0');
const H4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

/** pycryptodome Padding.unpad(pkcs7) with its exact error messages. Throws Error on failure. */
export function unpadStrict(data) {
  if (data.length % 16 !== 0) throw new Error('Input data is not padded');
  if (data.length === 0) throw new Error('Padding is incorrect.');
  const n = data[data.length - 1];
  if (n < 1 || n > Math.min(16, data.length)) throw new Error('Padding is incorrect.');
  for (let i = data.length - n; i < data.length; i++) if (data[i] !== n) throw new Error('PKCS#7 padding is incorrect.');
  return data.slice(0, data.length - n);
}
const pad = (d) => { const n = 16 - (d.length % 16); return concat(d, new Uint8Array(n).fill(n)); };

/** M25Decryptor.decrypt_verbose. Returns null on failure. */
export function decryptVerbose(packet, key) {
  const d = removeDelimiters(packet);
  if (!d || d.length < MIN_PACKET_LENGTH || d[0] !== HEADER_MARKER) return null;
  const frameLength = (d[1] << 8) | d[2];
  if (frameLength > MAX_FRAME_LENGTH || d.length <= frameLength) return null;
  const crcReceived = (d[frameLength - 1] << 8) | d[frameLength];
  const crcCalculated = crc16(d, frameLength - 1);
  if (crcCalculated !== crcReceived) return null;
  const ivEnc = d.slice(HEADER_SIZE, HEADER_SIZE + IV_SIZE);
  const iv = ecb(ivEnc, key, false);
  const start = HEADER_SIZE + IV_SIZE;
  const encLen = frameLength - start - 2 + 1;
  const enc = d.slice(start, start + encLen);
  if (enc.length % 16 !== 0) return null;
  return { decrypted: cbc(enc, key, iv, false), packet_bytes: d, frame_length: frameLength, iv_encrypted: ivEnc, iv, encrypted_data: enc, crc_received: crcReceived, crc_calculated: crcCalculated };
}

/** MultiKeyDecryptor.decrypt_verbose: first key whose result unpads cleanly. */
export function decryptVerboseMulti(packet, keys) {
  for (let i = 0; i < keys.length; i++) {
    const r = decryptVerbose(packet, keys[i]);
    if (!r) continue;
    try { unpadStrict(r.decrypted); } catch { continue; }
    return { ...r, successful_key: keys[i], successful_key_index: i, key_attempts: i + 1 };
  }
  return null;
}

/** M25Encryptor.encrypt_verbose; `iv` is injectable for tests. */
export function encryptVerbose(spp, key, iv) {
  const ivBytes = iv ?? globalThis.crypto.getRandomValues(new Uint8Array(IV_SIZE));
  const padded = pad(spp);
  const ivEnc = ecb(ivBytes, key, true);
  const data = cbc(padded, key, ivBytes, true);
  const payload = concat(ivEnc, data);
  const frameLength = HEADER_SIZE + payload.length + 2 - 1;
  if (frameLength > MAX_FRAME_LENGTH) throw new Error(`Packet too large (${frameLength} bytes, max ${MAX_FRAME_LENGTH})`);
  const frame = concat(Uint8Array.of(HEADER_MARKER, (frameLength >> 8) & 255, frameLength & 255), payload);
  const crc = crc16(frame, frame.length);
  const raw = concat(frame, Uint8Array.of((crc >> 8) & 255, crc & 255));
  return { encrypted_packet: addDelimiters(raw), encrypted_packet_raw: raw, iv: ivBytes, iv_encrypted: ivEnc, encrypted_data: data, frame_length: frameLength, crc };
}

/** m25_decrypt.process_packet. `decryptor` is {key} or {keys}. Returns {ok, out, err} exactly as upstream prints them. */
export function processDecrypt(decryptor, packetHex, { minimal = false, scope = 'data', skipValidation = false, showKey = false } = {}) {
  let bytes;
  try { bytes = parseHex(packetHex); } catch (e) { return { ok: false, out: '', err: `ERROR: Invalid hex string: ${e.message}\n` }; }
  const result = decryptor.keys ? decryptVerboseMulti(bytes, decryptor.keys) : decryptVerbose(bytes, decryptor.key);
  if (!result) return { ok: false, out: '', err: 'ERROR: Decryption failed (invalid packet or wrong key)\n' };
  let err = '';
  if (!minimal) {
    err += `  CRC: 0x${h4(result.crc_received)} OK, ${result.frame_length + 1}B\n`;
    err += `  IV:  ${bytesToHex(result.iv_encrypted)} -> ${bytesToHex(result.iv)}\n`;
  }
  const fail = (e) => ({ ok: false, out: '', err: err + `ERROR: PKCS7 padding validation failed: ${e.message}\nUse --no-validation to skip validation\n`.replace(/^/, '') });
  let data;
  try {
    if (scope === 'complete') {
      if (!skipValidation) unpadStrict(result.decrypted);
      data = result.packet_bytes.slice(0, result.frame_length + 1);
    } else if (!skipValidation) data = unpadStrict(result.decrypted);
    else data = result.decrypted;
  } catch (e) { return fail(e); }
  let outHex = bytesToHex(data);
  if (showKey && 'successful_key_index' in result) outHex += ` [key:${result.successful_key_index}]`;
  let out = outHex + '\n';
  if (!minimal) err += `  (${data.length}B${'successful_key_index' in result ? `, key ${result.successful_key_index}` : ''})\n`;
  return { ok: true, out, err };
}

/** m25_encrypt.process_packet. */
export function processEncrypt(key, hexData, { minimal = false, verbose = false, iv } = {}) {
  let spp;
  try { spp = parseHex(hexData); } catch (e) { return { ok: false, out: '', err: `ERROR: Invalid hex string: ${e.message}\n` }; }
  let r;
  try { r = encryptVerbose(spp, key, iv); } catch (e) { return { ok: false, out: '', err: `ERROR: ${e.message}\n` }; }
  let err = '';
  if (verbose) {
    err += `  SPP:  ${bytesToHex(spp)} (${spp.length}B)\n`;
    err += `  IV:   ${bytesToHex(r.iv)} -> ${bytesToHex(r.iv_encrypted)}\n`;
    err += `  Data: ${bytesToHex(r.encrypted_data)} (${r.encrypted_data.length}B)\n`;
    err += `  CRC:  0x${H4(r.crc)}, frame=${r.frame_length}B\n`;
  }
  const out = bytesToHex(r.encrypted_packet) + '\n';
  if (!minimal) err += `  (${r.encrypted_packet.length} bytes)\n`;
  return { ok: true, out, err };
}
