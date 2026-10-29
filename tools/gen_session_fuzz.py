#!/usr/bin/env python3
"""
Scripted wheel-reply scenarios run through the UPSTREAM ECSRemote.read_value / write_value; results saved to
test/session_fuzz.json for test/session_fuzz.test.mjs.   python3 tools/gen_session_fuzz.py /path/to/m5squared
"""
import json, sys, time
from pathlib import Path
if len(sys.argv) != 2:
    sys.exit(__doc__)
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
time.sleep = lambda s: None  # skip retry delays
from m25_ecs import ECSRemote, ECSPacketBuilder, ResponseParser

def reply(req, spec):
    if spec.get("none"):
        return None
    if "raw" in spec:
        return bytes.fromhex(spec["raw"])
    tid = (req[1] + spec.get("tidAdd", 0)) & 0xFF
    svc = req[4] if spec.get("service", "req") == "req" else spec["service"]
    prm = req[5] if spec.get("param", "req") == "req" else spec["param"]
    return bytes([1, tid, 3, 5, svc, prm]) + bytes.fromhex(spec.get("payload", ""))

class Conn:
    def __init__(self, specs): self.specs, self.calls = specs, 0
    def transact(self, packet, timeout=None):
        spec = self.specs[min(self.calls, len(self.specs) - 1)]; self.calls += 1
        return reply(packet, spec)

A = {"param": 0xFF}
scen = {
    "status_ok": [{"param": 0x12, "payload": "4d"}],
    "echo_read_param": [{"payload": "4d"}],
    "ack_with_payload": [{"param": 0xFF, "payload": "4d"}],
    "ack_empty": [{"param": 0xFF}],
    "nack_82": [{"param": 0x82}],
    "nack_88": [{"param": 0x88}],
    "param_0x89_not_nack": [{"param": 0x89, "payload": "4d"}],
    "wrong_tid": [{"param": 0x12, "payload": "4d", "tidAdd": 1}],
    "same_service_other_param": [{"param": 0x55, "payload": "4d"}],
    "other_service_other_param": [{"service": 9, "param": 0x55, "payload": "4d"}],
    "no_reply": [{"none": True}],
    "short_raw": [{"raw": "010203"}],
    "empty_payload_status": [{"param": 0x12}],
    "none_then_ok": [{"none": True}, {"param": 0x12, "payload": "4d"}],
    "wrongtid_then_ok": [{"param": 0x12, "payload": "4d", "tidAdd": 5}, {"param": 0x12, "payload": "4d"}],
    "empty_then_ok": [{"param": 0x12}, {"param": 0x12, "payload": "4d"}],
    "nack_then_ok": [{"param": 0x82}, {"param": 0x12, "payload": "4d"}],
    "ack_then_ok_write": [{"param": 0xFF}],
    "short_then_ok": [{"raw": "0102"}, {"param": 0x12, "payload": "4d"}],
}
out = []
for name, specs in scen.items():
    for kind in ("read", "write"):
        r = ECSRemote(None, None, retries=2)
        c = Conn(specs); b = ECSPacketBuilder()
        if kind == "read":
            res = r.read_value(c, b.build_read_soc, 0x12, ResponseParser.parse_soc)
        else:
            res = r.write_value(c, b.build_write_drive_mode(1), "w")
        out.append({"name": name, "kind": kind, "specs": specs, "result": res, "calls": c.calls})
Path(__file__).resolve().parent.parent.joinpath("test", "session_fuzz.json").write_text(json.dumps(out, indent=1))
print(len(out), "scenarios")
