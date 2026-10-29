#!/usr/bin/env python3
"""
Differential fuzz vectors: random inputs run through the UPSTREAM Python, results saved to
test/fuzz.json for test/fuzz.test.mjs to replay against the JS port.

  python3 tools/gen_fuzz_vectors.py /path/to/6static/m5squared
"""
import json
import random
import sys
from pathlib import Path

if len(sys.argv) != 2:
    sys.exit(__doc__)
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))

import m25_crypto  # noqa: E402
from m25_crypto import M25Encryptor, M25Decryptor  # noqa: E402
from m25_ecs import ECSPacketBuilder, ResponseParser  # noqa: E402
from m25_protocol import add_delimiters, remove_delimiters, calculate_crc  # noqa: E402
from m25_qr_to_key import M25QRConverter  # noqa: E402

rnd = random.Random(20261028)
hx = lambda b: b.hex()  # noqa: E731
rb = lambda n: bytes(rnd.choice((0xEF, rnd.randrange(256))) if rnd.random() < 0.15 else rnd.randrange(256) for _ in range(n))  # noqa: E731

out = {"crypto": [], "crc": [], "stuffing": [], "builders": [], "parsers": [], "qr": []}

# --- crypto: random key/iv/payload, plus corrupted / truncated / wrong-key variants
for i in range(400):
    key, iv, spp = rb(16), rb(16), rb(rnd.randrange(0, 200))
    m25_crypto.get_random_bytes = lambda n, iv=iv: iv
    enc, dec = M25Encryptor(key), M25Decryptor(key)
    pkt = enc.encrypt(spp)
    cases = [("ok", pkt), ("wrongkey", pkt)]
    bad = bytearray(pkt); bad[rnd.randrange(len(bad))] ^= 1 << rnd.randrange(8); cases.append(("flip", bytes(bad)))
    cases.append(("trunc", pkt[: rnd.randrange(1, len(pkt))]))
    cases.append(("junkprefix", rb(3) + pkt))
    row = {"key": hx(key), "iv": hx(iv), "spp": hx(spp), "packet": hx(pkt), "decrypt": []}
    for name, p in cases:
        d = (M25Decryptor(rb(16)) if name == "wrongkey" else dec)
        # wrong key must be regenerated deterministically: store the key used
        used = None
        if name == "wrongkey":
            wk = rb(16); d = M25Decryptor(wk); used = hx(wk)
        r = d.decrypt(p)
        row["decrypt"].append({"case": name, "packet": hx(p), "key": used, "result": None if r is None else hx(r)})
    out["crypto"].append(row)

for _ in range(300):
    d = rb(rnd.randrange(0, 120))
    out["crc"].append({"data": hx(d), "crc": calculate_crc(d, len(d))})
    out["stuffing"].append({"raw": hx(d), "stuffed": hx(add_delimiters(d)), "unstuffed": hx(remove_delimiters(add_delimiters(d)))})

# --- builders with random arguments (telegram ids continue from a random start)
B = ECSPacketBuilder
for _ in range(300):
    b = B(); b.telegram_id = rnd.randrange(256)
    start = b.telegram_id
    k = rnd.choice(["wsm", "assist", "mode", "profile", "speed", "params", "readparams"])
    if k == "wsm": a = [rnd.randrange(256)]; p = b.build_write_system_mode(*a)
    elif k == "assist": a = [rnd.randrange(3)]; p = b.build_write_assist_level(*a)
    elif k == "mode": a = [rnd.randrange(256)]; p = b.build_write_drive_mode(*a)
    elif k == "profile": a = [rnd.randrange(6)]; p = b.build_write_drive_profile(*a)
    elif k == "speed": a = [rnd.randrange(-32768, 32768)]; p = b.build_write_remote_speed(*a)
    elif k == "readparams": a = [rnd.randrange(2)]; p = b.build_read_drive_profile_params(*a)
    else:
        a = [rnd.randrange(2), rnd.randrange(10, 101), rnd.choice([556, 833, 1667, 2361]), rnd.randrange(1, 1000),
             rnd.randrange(10, 51), rnd.randrange(1, 101), rnd.randrange(1, 151), rnd.randrange(20, 71), rnd.randrange(20, 71)]
        p = b.build_write_drive_profile_params(*a)
    out["builders"].append({"kind": k, "args": a, "start": start, "packet": hx(p)})

# --- parsers: random payloads
def js(v):
    return v
P = ResponseParser
for _ in range(600):
    pl = rb(rnd.randrange(0, 16))
    for name, fn in [("soc", P.parse_soc), ("assist", P.parse_assist_level), ("driveMode", P.parse_drive_mode),
                     ("profile", P.parse_drive_profile), ("params", P.parse_drive_profile_params),
                     ("cruise", P.parse_cruise_values), ("sw", P.parse_sw_version), ("duo", P.parse_duo_drive_params)]:
        out["parsers"].append({"fn": name, "payload": hx(pl), "result": fn(pl)})
    hdr = rb(rnd.randrange(0, 12)) + pl
    h = P.parse_header(hdr)
    out["parsers"].append({"fn": "header", "payload": hx(hdr), "result": None if h is None else {**h, "payload": hx(h["payload"])}})

cs = M25QRConverter.UPK_CHARSET; conv = M25QRConverter()
for _ in range(300):
    q = "".join(rnd.choice(cs) for _ in range(22))
    out["qr"].append({"qr": q, "key": hx(conv.convert_qr_to_key(q))})

Path(__file__).resolve().parent.parent.joinpath("test", "fuzz.json").write_text(json.dumps(out))
print({k: len(v) for k, v in out.items()})
