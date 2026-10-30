"""Run upstream m25_parking.py --dry-run (main) with deterministic IVs and record stdout -> test/parking_vectors.json.
IV n for side: bytes(16) filled by the shared formula in test/parking.test.mjs. Usage: python tools/gen_parking_vectors.py /path/to/m5squared"""
import sys, os, io, json, contextlib, random
up = sys.argv[1]; sys.path.insert(0, up)
import m25_crypto, m25_parking
ivs = []
def iv_of(n): return bytes((n * 37 + i * 11 + 5) & 255 for i in range(16))
state = {'n': 0}
def fake(_n):
    # builders interleave left then right per send_to_both; the JS port draws iv index by call order too
    b = iv_of(state['n']); state['n'] += 1; return b
m25_crypto.get_random_bytes = fake
rnd = random.Random(7); cases = []
for k in range(40):
    lk, rk = rnd.randbytes(16).hex(), rnd.randbytes(16).hex()
    speed = rnd.choice([0, 80, 150, 250, 350, 400, -5, 1, 32767])
    ls = rnd.choice([None, None, 60, 100, 0]); rs = rnd.choice([None, None, 70, 120, 0])
    dur = rnd.choice([500, 100, 1000, 0, 250, 1500, 99])
    argv = ['m25_parking.py', '--left-key', lk, '--right-key', rk, '--speed', str(speed), '--duration', str(dur), '--dry-run']
    if ls is not None: argv += ['--left-speed', str(ls)]
    if rs is not None: argv += ['--right-speed', str(rs)]
    state['n'] = 0
    buf = io.StringIO(); sys.argv = argv
    with contextlib.redirect_stdout(buf): m25_parking.main()
    cases.append({'lk': lk, 'rk': rk, 'speed': speed, 'ls': ls, 'rs': rs, 'dur': dur, 'out': buf.getvalue()})
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
json.dump(cases, open(os.path.join(root, 'test/parking_vectors.json'), 'w'))
print(len(cases), 'cases')
