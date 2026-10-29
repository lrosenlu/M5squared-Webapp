#!/usr/bin/env python3
"""
Differential fuzz against the REAL firmware mapper (6static/m25-remote mapper.cpp), compiled natively with a
tiny Arduino shim. Writes test/fw_mapper_fuzz.json for test/fw_mapper_fuzz.test.mjs.

  python3 tools/gen_fw_mapper_fuzz.py /path/to/m25-remote
"""
import json, random, subprocess, sys, tempfile
from pathlib import Path

if len(sys.argv) != 2:
    sys.exit(__doc__)
fw = Path(sys.argv[1]).resolve()
here = Path(__file__).resolve().parent
exe = Path(tempfile.mkdtemp()) / "fwmapper"
subprocess.run(["g++", "-std=c++17", "-O0", "-I", str(here / "fw_shim"), "-I", str(fw), "-o", str(exe),
                str(here / "fw_shim" / "harness.cpp"), str(fw / "mapper.cpp")], check=True)

rnd = random.Random(777)
f32 = lambda v: float(f"{v:.6f}")  # noqa: E731
val = lambda: rnd.choice([0.0, 1.0, -1.0, 0.1, -0.1, 0.5, -0.5]) if rnd.random() < 0.3 else round(rnd.uniform(-1, 1), 4)  # noqa: E731
presets = [  # name, deadzone, curve, slow, normal, fast, lowbat, ramp, reverse, turn
    (0.05, 1.0, 30, 60, 100, 30, 0.0, 1.0, 0.0),        # firmware defaults
    (0.05, 1.0, 30, 60, 100, 30, 0.0, 0.5, 0.5),        # "indoor" feel + reverse cap
    (0.05, 1.5, 30, 40, 100, 30, 150.0, 0.5, 0.6),      # "learning"
    (0.05, 1.0, 30, 80, 100, 30, 0.0, 0.5, 0.3),        # "outdoor"
    (0.10, 2.0, 30, 60, 100, 30, 50.0, 1.0, 0.0),       # python-style
    (0.05, 1.0, 30, 60, 100, 20, 80.0, 0.5, 0.5),
]
seqs, lines = [], []
for _ in range(500):
    c = rnd.choice(presets)
    steps, t = [], 1000
    lines += ["S", "C " + " ".join(str(x) for x in c)]
    lines.append(f"T {t} 0 0 0 2 0"); steps.append({"t": t, "vx": 0.0, "vy": 0.0, "deadman": 0, "mode": 2, "low": 0})
    for _ in range(rnd.randrange(5, 40)):
        t += rnd.randrange(10, 250)  # <= 250 ms: my mapper caps the ramp step at 0.25 s (deliberate)
        s = {"t": t, "vx": val(), "vy": val(), "deadman": int(rnd.random() > 0.1), "mode": rnd.choice([0, 1, 2, 2, 3, 3]),
             "low": int(rnd.random() < 0.2)}
        steps.append(s)
        lines.append(f"T {s['t']} {s['vx']} {s['vy']} {s['deadman']} {s['mode']} {s['low']}")
    seqs.append({"cfg": c, "steps": steps})
out = subprocess.run([str(exe)], input="\n".join(lines) + "\n", capture_output=True, text=True, check=True).stdout.split("\n")
it = iter(l for l in out if l)
for sq in seqs:
    for s in sq["steps"]:
        l, r = next(it).split(); s["left"], s["right"] = int(l), int(r)
(here.parent / "test" / "fw_mapper_fuzz.json").write_text(json.dumps(seqs))
print(len(seqs), "sequences,", sum(len(s["steps"]) for s in seqs), "steps")
