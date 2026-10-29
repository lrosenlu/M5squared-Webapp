"""Generate src/names.js and test/tools_vectors.json from the upstream toolkit
(m25_analyzer, m25_decrypt/m25_encrypt helpers, m25_utils, m25_crypto).
Usage: python tools/gen_tools_vectors.py /path/to/m5squared
"""
import sys, os, json, io, random, contextlib
up = sys.argv[1]; sys.path.insert(0, up)
import m25_protocol_data as D
import m25_analyzer as A
import m25_decrypt as DEC
import m25_encrypt as ENC
from m25_crypto import M25Encryptor, M25Decryptor, MultiKeyDecryptor
from m25_utils import parse_hex, parse_key
import m25_crypto

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
open(os.path.join(root, 'src/names.js'), 'w').write(
    "// GENERATED from upstream m25_protocol_data.py by tools/gen_tools_vectors.py. Do not edit.\n"
    "export const SOURCE_NAMES = %s;\nexport const DEST_NAMES = %s;\nexport const SERVICE_NAMES = %s;\n"
    "export const PARAM_NAMES_BY_SERVICE = %s;\nexport const PARAM_ID_ACK = %d;\nexport const MIN_SPP_PACKET_SIZE = %d;\n"
    "export const VALID_PROTOCOL_IDS = [%d, %d];\n" % (
        json.dumps(D.SOURCE_NAMES), json.dumps(D.DEST_NAMES), json.dumps(D.SERVICE_NAMES),
        json.dumps(D.PARAM_NAMES_BY_SERVICE), D.PARAM_ID_ACK, D.MIN_SPP_PACKET_SIZE, D.PROTOCOL_ID_NOT_USED, D.PROTOCOL_ID_STANDARD))

rnd = random.Random(2026)
def cap(fn, *a):
    if fn is DEC.process_packet:  # output_file arg is a placeholder: give it a real buffer so we can record it
        buf = io.StringIO(); a = list(a); a[2] = buf
        r, o, e = cap2(fn, *a); return r, buf.getvalue() + o, e
    return cap2(fn, *a)

def cap2(fn, *a):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try: r = fn(*a)
        except SystemExit as e: r = 'EXIT%s' % e.code
    return r, out.getvalue(), err.getvalue()

# ---- analyzer cases
svcs = list(D.SERVICE_NAMES) + [40, 99]
cases = []
for i in range(1000):
    n = rnd.choice([0, 3, 5, 6, 6, 7, 8, 12, 20])
    if i % 3 == 0 and D.PARAM_NAMES_BY_SERVICE:
        svc = rnd.choice(list(D.PARAM_NAMES_BY_SERVICE)); prm = rnd.choice(list(D.PARAM_NAMES_BY_SERVICE[svc]) + [0xff, 0x77])
        pkt = bytes([rnd.choice([0, 1, 1, 2]), rnd.randrange(256), rnd.choice([1, 2, 3, 5, 9]), rnd.choice([1, 2, 5, 15, 8]), svc, prm]) + bytes(rnd.randrange(256) for _ in range(rnd.choice([0, 1, 3, 11])))
    else:
        pkt = bytes(rnd.randrange(256) for _ in range(n))
    p = A.M25PacketParser(); f = A.PacketFormatter
    r, o, e = cap(p.parse, pkt)
    c = {'hex': pkt.hex(), 'parse_err': e}
    if r is not None:
        w = p.validate(r)
        c.update({'warnings': w, 'text': f.format_text(r), 'text_verbose': f.format_text(r, True), 'json': f.format_json(r), 'oneline': f.format_oneline(r),
                  'param_name': r['param_name'], 'packet_length': r['packet_length']})
        # full process_packet output for each format
        for fmt in ('text', 'json', 'oneline'):
            ok, o2, e2 = cap(A.process_packet, p, f, pkt.hex(), fmt, True, True)
            c['proc_' + fmt] = {'ok': ok, 'out': o2, 'err': e2}
    cases.append(c)

# ---- parse_hex
hexcases = []
for s in ['', '00', 'ab cd', 'AB:cd:EF', 'abc', 'zz', 'a', '0g', '0x12', '12 3', '1\t2', 'ef ef:01', ' ', '::', 'ab\ncd', '12345', 'é1']:
    try: hexcases.append({'in': s, 'out': parse_hex(s).hex()})
    except ValueError as e: hexcases.append({'in': s, 'err': str(e)})

# ---- crypto tool cases (fixed IV by patching get_random_bytes)
keys = [bytes(rnd.randrange(256) for _ in range(16)) for _ in range(3)]
cr = []
for i in range(150):
    key = rnd.choice(keys)
    spp = bytes(rnd.randrange(256) for _ in range(rnd.choice([0, 1, 5, 6, 15, 16, 17, 40, 100, 400])))
    iv = bytes(rnd.randrange(256) for _ in range(16))
    if i % 4 == 0: iv = bytes([0xEF]) + iv[1:]  # force stuffing paths
    m25_crypto.get_random_bytes = lambda n, iv=iv: iv
    try:
        r = M25Encryptor(key).encrypt_verbose(spp)
    except ValueError as e:
        cr.append({'key': key.hex(), 'spp': spp.hex(), 'iv': iv.hex(), 'enc_err': str(e)}); continue
    ent = {'key': key.hex(), 'spp': spp.hex(), 'iv': iv.hex(), 'packet': r['encrypted_packet'].hex(), 'raw': r['encrypted_packet_raw'].hex(),
           'iv_encrypted': r['iv_encrypted'].hex(), 'encrypted_data': r['encrypted_data'].hex(), 'frame_length': r['frame_length'], 'crc': r['crc']}
    # encrypt tool output
    ok, o, e = cap(ENC.process_packet, M25Encryptor(key), spp.hex(), False, True)
    ent['enc_tool'] = {'ok': ok, 'out': o, 'err': e}
    # decrypt tool in both scopes with corrupted variants
    variants = {'good': r['encrypted_packet']}
    b = bytearray(r['encrypted_packet']); 
    if len(b) > 30: b[len(b) // 2] ^= 0x40
    variants['flip'] = bytes(b)
    variants['trunc'] = r['encrypted_packet'][:-3]
    variants['wrongkey'] = r['encrypted_packet']
    ent['dec'] = {}
    for name, pk in variants.items():
        k2 = keys[(keys.index(key) + 1) % 3] if name == 'wrongkey' else key
        d = {}
        for scope in ('complete', 'data'):
            for sv in (False, True):
                ok, o, e = cap(DEC.process_packet, M25Decryptor(k2), pk.hex(), sys.stdout, False, scope, sv)
                d['%s_%s' % (scope, 'nv' if sv else 'v')] = {'ok': ok, 'out': o, 'err': e}
        d['key'] = k2.hex()
        mk = MultiKeyDecryptor(keys)
        ok, o, e = cap(DEC.process_packet, mk, pk.hex(), sys.stdout, True, 'data', False, True)
        d['multi'] = {'ok': ok, 'out': o, 'err': e}
        ent['dec'][name] = {'packet': pk.hex(), **d}
    cr.append(ent)

json.dump({'analyzer': cases, 'hex': hexcases, 'keys': [k.hex() for k in keys], 'crypto': cr}, open(os.path.join(root, 'test/tools_vectors.json'), 'w'))
print(len(cases), 'analyzer cases;', len(cr), 'crypto cases')
