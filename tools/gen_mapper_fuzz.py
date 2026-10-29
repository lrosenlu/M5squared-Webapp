#!/usr/bin/env python3
"""
Runs random control sequences through the UPSTREAM core/mapper.py (with a fake clock) and writes
test/mapper_fuzz.json for test/mapper_fuzz.test.mjs.   python3 tools/gen_mapper_fuzz.py /path/to/m5squared
"""
import json, random, sys, time
from pathlib import Path
if len(sys.argv) != 2:
    sys.exit(__doc__)
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
import core.mapper as cm
from core.mapper import Mapper
from core.types import ControlState, DriveMode, MapperConfig

rnd = random.Random(424242)
clock = [1000.0]
cm.time = type("T", (), {"time": staticmethod(lambda: clock[0])})  # fake clock inside mapper module
modes = {"slow": DriveMode.SLOW, "normal": DriveMode.NORMAL, "fast": DriveMode.FAST, "stop": DriveMode.STOP}

def val():
    r = rnd.random()
    if r < 0.15: return 0.0
    if r < 0.30: return rnd.choice([-1.0, 1.0, 0.1, -0.1, 0.099, 0.5, -0.5])
    return round(rnd.uniform(-1, 1), 4)

seqs = []
for _ in range(400):
    m = Mapper(MapperConfig())
    clock[0] += 100
    steps = []
    # start from an explicit stop so upstream's no-history jump does not apply
    s0 = ControlState(vx=0.0, vy=0.0, deadman=False, mode=DriveMode.NORMAL, timestamp=clock[0])
    m.map(s0); steps.append({"t": clock[0], "dt": 0, "vx": 0.0, "vy": 0.0, "deadman": False, "mode": "normal", "left": 0, "right": 0})
    for _ in range(rnd.randrange(5, 40)):
        dt = round(rnd.uniform(0.02, 0.2), 5)
        clock[0] += dt
        mode = rnd.choice(["slow", "normal", "fast", "fast", "normal", "stop"])
        dm = rnd.random() > 0.1
        vx, vy = val(), val()
        f = m.map(ControlState(vx=vx, vy=vy, deadman=dm, mode=modes[mode], timestamp=clock[0]))
        steps.append({"t": clock[0], "dt": dt, "vx": vx, "vy": vy, "deadman": dm, "mode": mode, "left": f.left_speed, "right": f.right_speed})
    seqs.append(steps)
Path(__file__).resolve().parent.parent.joinpath("test", "mapper_fuzz.json").write_text(json.dumps(seqs))
print(len(seqs), "sequences,", sum(len(s) for s in seqs), "steps")
