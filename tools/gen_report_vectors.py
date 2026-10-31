"""Generate test/report_vectors.json: upstream ECSRemote.format_wheel_status over fuzzed payloads.
Usage: python tools/gen_report_vectors.py /path/to/m5squared
"""
import sys, os, json, random
up = sys.argv[1]; sys.path.insert(0, up)
from m25_ecs import ResponseParser as R, ECSRemote
rnd = random.Random(7)
def rb(n): return bytes(rnd.randrange(256) for _ in range(n))
def maybe(lengths, p_none=0.1):
    if rnd.random() < p_none: return None
    return rb(rnd.choice(lengths))
out = []
for i in range(1500):
    pl = {
        'soc': maybe([0, 1, 1, 2]), 'assist': maybe([0, 1, 1, 3]), 'drive': maybe([0, 1, 1, 2]), 'profile': maybe([0, 1, 1, 2]),
        'params': maybe([0, 9, 10, 10, 11]), 'cruise': maybe([0, 11, 12, 13, 14]),
        'duo': maybe([0, 2, 3, 3, 4]), 'ver': maybe([0, 2, 3, 4, 4, 5]),
    }
    if pl['ver'] and len(pl['ver']) == 4 and rnd.random() < 0.7: pl['ver'] = bytes([rnd.choice([0x56, 0x41, 0x7e, 0x20])]) + pl['ver'][1:]
    if pl['assist'] and rnd.random() < 0.6: pl['assist'] = bytes([rnd.choice([0, 1, 2])])
    if pl['drive'] and rnd.random() < 0.6: pl['drive'] = bytes([rnd.randrange(8)])
    if pl['profile'] and rnd.random() < 0.6: pl['profile'] = bytes([rnd.randrange(7)])
    st = {
        'battery': R.parse_soc(pl['soc']) if pl['soc'] is not None else None,
        'assist_level': R.parse_assist_level(pl['assist']) if pl['assist'] is not None else None,
        'drive_mode': R.parse_drive_mode(pl['drive']) if pl['drive'] is not None else None,
        'profile': R.parse_drive_profile(pl['profile']) if pl['profile'] is not None else None,
        'profile_params': R.parse_drive_profile_params(pl['params']) if pl['params'] is not None else None,
        'cruise_values': R.parse_cruise_values(pl['cruise']) if pl['cruise'] is not None else None,
        'duo_drive': R.parse_duo_drive_params(pl['duo']) if pl['duo'] is not None else None,
        'sw_version': R.parse_sw_version(pl['ver']) if pl['ver'] is not None else None,
    }
    name = rnd.choice(['Left', 'Right']); addr = rnd.choice(['AA:BB:CC:DD:EE:FF', 'M25V2_00A0000000FF'])
    out.append({'payloads': {k: (v.hex() if v is not None else None) for k, v in pl.items()}, 'name': name, 'addr': addr,
                'text': ECSRemote.format_wheel_status(st, name, addr)})
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
json.dump(out, open(os.path.join(root, 'test/report_vectors.json'), 'w'))
print(len(out))
