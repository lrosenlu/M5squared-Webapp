"""JSON-lines bridge to upstream's MockWheelSimulator. stdin: {"op":"packet","wheel":0,"hex":"..."} | {"op":"state"}; stdout: one JSON per line."""
import sys, json
from emu_common import Emu, state_dict
emu = Emu()
for line in sys.stdin:
    req = json.loads(line)
    if req['op'] == 'packet':
        out = emu.process(req['wheel'], bytes.fromhex(req['hex']))
        print(json.dumps({'resp': out.hex() if out is not None else None}), flush=True)
    elif req['op'] == 'state':
        print(json.dumps({'state': [state_dict(s) for s in emu.sims]}), flush=True)
