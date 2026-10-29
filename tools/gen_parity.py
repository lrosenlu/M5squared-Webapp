#!/usr/bin/env python3
"""Differential-test data: run the UPSTREAM Python on many inputs and record the results.

Usage: python3 tools/gen_parity.py /path/to/6static/m5squared   (writes test/parity.json)
"""
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
import m25_protocol_data as D  # noqa: E402
from m25_ecs import ECSPacketBuilder, ResponseParser as RP  # noqa: E402

fresh = ECSPacketBuilder
out = {"constants": {}, "builders": [], "parsers": {}, "headers": []}

c = out["constants"]
for n in ("PARAM_ID_READ_SOC PARAM_ID_STATUS_SOC PARAM_ID_READ_ASSIST_LEVEL PARAM_ID_STATUS_ASSIST_LEVEL "
          "PARAM_ID_READ_DRIVE_MODE PARAM_ID_STATUS_DRIVE_MODE PARAM_ID_READ_DRIVE_PROFILE PARAM_ID_STATUS_DRIVE_PROFILE "
          "PARAM_ID_READ_DRIVE_PROFILE_PARAMS PARAM_ID_STATUS_DRIVE_PROFILE_PARAMS PARAM_ID_READ_CRUISE_VALUES PARAM_ID_CRUISE_VALUES "
          "PARAM_ID_READ_DUO_DRIVE_PARAMS PARAM_ID_STATUS_DUO_DRIVE_PARAMS PARAM_ID_READ_SW_VERSION PARAM_ID_STATUS_SW_VERSION "
          "PARAM_ID_WRITE_ASSIST_LEVEL PARAM_ID_WRITE_DRIVE_MODE PARAM_ID_WRITE_DRIVE_PROFILE PARAM_ID_WRITE_DRIVE_PROFILE_PARAMS "
          "PARAM_ID_WRITE_REMOTE_SPEED PARAM_ID_ACK PARAM_ID_WRITE_SYSTEM_MODE SYSTEM_MODE_CONNECT "
          "SERVICE_ID_APP_MGMT SERVICE_ID_BATT_MGMT SERVICE_ID_VERSION_MGMT "
          "DRIVE_MODE_BIT_AUTO_HOLD DRIVE_MODE_BIT_CRUISE DRIVE_MODE_BIT_REMOTE "
          "SRC_ID_SMARTPHONE DEST_ID_M25_WHEEL_COMMON PROTOCOL_ID_STANDARD "
          "POS_PROTOCOL_ID POS_TELEGRAM_ID POS_SOURCE_ID POS_DEST_ID POS_SERVICE_ID POS_PARAM_ID POS_PAYLOAD MIN_SPP_PACKET_SIZE "
          "MAX_SUPPORT_SPEED LO_SUPPORT_SPEED").split():
    c[n] = getattr(D, n)
c["MAX_SPEED_VALUES"] = D.MAX_SPEED_VALUES
c["MAX_SPEED_VALUES_NO_MPP"] = D.MAX_SPEED_VALUES_NO_MPP
c["ASSIST_LEVEL_NAMES"] = {str(k): v for k, v in D.ASSIST_LEVEL_NAMES.items()}
c["PROFILE_NAMES"] = {str(k): v for k, v in D.PROFILE_NAMES.items()}

B = []
def add(name, fn):
    B.append((name, fn))
add("sysmode1", lambda b: b.build_write_system_mode(1))
for n in ("soc", "assist_level", "drive_mode", "drive_profile", "cruise_values", "duo_drive_params", "sw_version"):
    add("read_" + n, lambda b, n=n: getattr(b, "build_read_" + n)())
for lvl in (0, 1):
    add(f"read_params_{lvl}", lambda b, lvl=lvl: b.build_read_drive_profile_params(lvl))
for lvl in (0, 1, 2):
    add(f"write_assist_{lvl}", lambda b, lvl=lvl: b.build_write_assist_level(lvl))
for m in range(0, 8):
    add(f"write_drive_mode_{m}", lambda b, m=m: b.build_write_drive_mode(m))
add("write_drive_mode_true", lambda b: b.build_write_drive_mode(True))
add("write_drive_mode_false", lambda b: b.build_write_drive_mode(False))
for p in range(0, 6):
    add(f"write_profile_{p}", lambda b, p=p: b.build_write_drive_profile(p))
for s in (-32768, -250, -100, -1, 0, 1, 30, 60, 100, 250, 32767):
    add(f"remote_speed_{s}", lambda b, s=s: b.build_write_remote_speed(s))
for raw in D.MAX_SPEED_VALUES:
    add(f"write_params_{raw}", lambda b, raw=raw: b.build_write_drive_profile_params(1, 80, raw, 300, 30, 50, 20, 42, 28))
add("write_params_0", lambda b: b.build_write_drive_profile_params(0, 100, 1667, 999, 10, 100, 150, 70, 20))
for name, fn in B:
    out["builders"].append({"name": name, "hex": fn(fresh()).hex()})
# telegram-id counter: sequence of builds on ONE builder, wrapping past 0xFF
b = fresh(); seq = []
for _ in range(300):
    seq.append(b.build_read_soc()[1])
out["tidSequence"] = seq

def norm(v):
    return json.loads(json.dumps(v, default=lambda o: o.hex() if isinstance(o, (bytes, bytearray)) else str(o)))

rng = random.Random(25)
def payloads(lens):
    ps = [b""]
    for n in lens:
        ps += [bytes([0] * n), bytes([255] * n)] + [bytes(rng.randrange(256) for _ in range(n)) for _ in range(40)]
    return ps

PARSERS = {
    "soc": (RP.parse_soc, range(0, 4)),
    "assist_level": (RP.parse_assist_level, range(0, 4)),
    "drive_mode": (RP.parse_drive_mode, range(0, 4)),
    "drive_profile": (RP.parse_drive_profile, range(0, 4)),
    "drive_profile_params": (RP.parse_drive_profile_params, (8, 9, 10, 11, 12)),
    "cruise_values": (RP.parse_cruise_values, (10, 11, 12, 13, 14)),
    "sw_version": (RP.parse_sw_version, range(0, 7)),
    "duo_drive_params": (RP.parse_duo_drive_params, range(0, 5)),
}
for name, (fn, lens) in PARSERS.items():
    cases = []
    for p in payloads(list(lens)):
        cases.append({"payload": p.hex(), "result": norm(fn(p))})
    out["parsers"][name] = cases
# The real firmware strings seen in the field
for p in (bytes([0x56, 3, 5, 0]), bytes([3, 5, 0]), bytes([0x41, 1, 2, 3]), bytes([0x10, 1, 2, 3])):
    out["parsers"]["sw_version"].append({"payload": p.hex(), "result": norm(RP.parse_sw_version(p))})

for _ in range(60):
    n = rng.randrange(0, 14)
    raw = bytes(rng.randrange(256) for _ in range(n))
    h = RP.parse_header(raw)
    out["headers"].append({"data": raw.hex(), "header": norm(h), "nack": (RP.is_nack(h) if h else None), "ack": (RP.is_ack(h) if h else None)})

# Mapper (deadzone/curve/caps) with ramping disabled; time is frozen so ramp cannot interfere.
import time as _time
from core.mapper import Mapper  # noqa: E402
from core.types import ControlState, DriveMode as DM, MapperConfig  # noqa: E402
import inspect
mcases = []
grid = [-1.0, -0.95, -0.6, -0.3, -0.15, -0.1, -0.05, 0.0, 0.05, 0.1, 0.11, 0.2, 0.5, 0.75, 1.0]
_orig = _time.time
try:
    for mode in (DM.SLOW, DM.NORMAL, DM.FAST, DM.STOP):
        for vx in grid:
            for vy in grid:
                m = Mapper(MapperConfig(ramp_rate=1e9))
                sig = inspect.signature(ControlState)
                kw = {"vx": vx, "vy": vy, "deadman": True, "mode": mode}
                if "timestamp" in sig.parameters: kw["timestamp"] = _orig()
                f = m.map(ControlState(**kw))
                mcases.append({"mode": mode.name.lower(), "vx": vx, "vy": vy, "left": f.left_speed, "right": f.right_speed})
        m = Mapper(MapperConfig(ramp_rate=1e9))
        f = m.map(ControlState(**{**kw, "vx": 1.0, "vy": 0.0, "deadman": False}))
        mcases.append({"mode": mode.name.lower(), "vx": 1.0, "vy": 0.0, "deadman": False, "left": f.left_speed, "right": f.right_speed})
finally:
    _time.time = _orig
out["mapper"] = mcases

Path(__file__).resolve().parent.parent.joinpath("test", "parity.json").write_text(json.dumps(out, indent=1))
print("mapper cases", len(mcases)); print("ok", len(out["builders"]), "builders;", sum(len(v) for v in out["parsers"].values()), "parser cases")
