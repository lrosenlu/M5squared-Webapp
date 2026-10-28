// Minimal AES-128 (block encrypt/decrypt) with ECB and CBC helpers, no padding.
//
// Why not WebCrypto: it has no ECB mode and insists on PKCS#7 handling in CBC, but the
// M25 protocol encrypts the IV with raw ECB. Verified against the upstream Python
// (pycryptodome) vectors in test/.

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);

(function initTables() {
  const rotl = (x, s) => ((x << s) | (x >> (8 - s))) & 0xff;
  let p = 1;
  let q = 1;
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff; // p *= 3
    q ^= q << 1; q &= 0xff;
    q ^= q << 2; q &= 0xff;
    q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;                           // q /= 3
    const x = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4);
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
})();

const xtime = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;

function mul(a, b) {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return r;
}

function expandKey(key) {
  if (key.length !== 16) throw new Error('AES key must be 16 bytes');
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t = [w[i - 4], w[i - 3], w[i - 2], w[i - 1]];
    if (i % 16 === 0) {
      t = [SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
      rcon = xtime(rcon);
    }
    for (let j = 0; j < 4; j++) w[i + j] = w[i - 16 + j] ^ t[j];
  }
  return w;
}

function addRoundKey(s, w, round) {
  for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
}

// State layout: s[col * 4 + row].
function shiftRows(s) {
  const t = s.slice();
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) s[c * 4 + r] = t[((c + r) % 4) * 4 + r];
}

function invShiftRows(s) {
  const t = s.slice();
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) s[((c + r) % 4) * 4 + r] = t[c * 4 + r];
}

function mixColumns(s, inverse) {
  const m = inverse ? [14, 11, 13, 9] : [2, 3, 1, 1];
  for (let c = 0; c < 4; c++) {
    const a = [s[c * 4], s[c * 4 + 1], s[c * 4 + 2], s[c * 4 + 3]];
    for (let r = 0; r < 4; r++) {
      s[c * 4 + r] =
        mul(a[0], m[(4 - r) % 4]) ^ mul(a[1], m[(5 - r) % 4]) ^
        mul(a[2], m[(6 - r) % 4]) ^ mul(a[3], m[(7 - r) % 4]);
    }
  }
}

export function encryptBlock(block, w) {
  const s = Uint8Array.from(block);
  addRoundKey(s, w, 0);
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    shiftRows(s);
    if (round < 10) mixColumns(s, false);
    addRoundKey(s, w, round);
  }
  return s;
}

export function decryptBlock(block, w) {
  const s = Uint8Array.from(block);
  addRoundKey(s, w, 10);
  for (let round = 9; round >= 0; round--) {
    invShiftRows(s);
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    addRoundKey(s, w, round);
    if (round > 0) mixColumns(s, true);
  }
  return s;
}

function assertBlocks(data) {
  if (data.length === 0 || data.length % 16 !== 0) throw new Error('data must be whole 16-byte blocks');
}

export function ecb(data, key, encrypt) {
  assertBlocks(data);
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) {
    out.set((encrypt ? encryptBlock : decryptBlock)(data.subarray(i, i + 16), w), i);
  }
  return out;
}

export function cbc(data, key, iv, encrypt) {
  assertBlocks(data);
  if (iv.length !== 16) throw new Error('IV must be 16 bytes');
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev = Uint8Array.from(iv);
  for (let i = 0; i < data.length; i += 16) {
    const block = data.subarray(i, i + 16);
    if (encrypt) {
      const x = new Uint8Array(16);
      for (let j = 0; j < 16; j++) x[j] = block[j] ^ prev[j];
      prev = encryptBlock(x, w);
      out.set(prev, i);
    } else {
      const d = decryptBlock(block, w);
      for (let j = 0; j < 16; j++) out[i + j] = d[j] ^ prev[j];
      prev = Uint8Array.from(block);
    }
  }
  return out;
}
