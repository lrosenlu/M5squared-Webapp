"""Run scripted scenarios through upstream ECSRemote against upstream's MockWheelSimulator and record every exchange.
Output: test/emulator_ref.json. Usage: python tools/gen_emulator_ref.py"""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from emu_common import *
import m25_ecs
from m25_ecs import ECSRemote, ECSPacketBuilder, ResponseParser

time.sleep = lambda s: None   # no real waiting

SCENARIOS = {
  'status_both': [(0, {'op': 'status'}), (1, {'op': 'status'})],
  'assist_levels': [(0, {'op': 'assist', 'level': 0}), (0, {'op': 'assist', 'level': 1}), (0, {'op': 'assist', 'level': 2}), (1, {'op': 'assist', 'level': 1}), (1, {'op': 'status'})],
  'auto_hold': [(0, {'op': 'autohold', 'on': True}), (0, {'op': 'status'}), (0, {'op': 'autohold', 'on': False}), (1, {'op': 'autohold', 'on': True})],
  'remote_drive': [(0, {'op': 'remote_on'}), (1, {'op': 'remote_on'}), (0, {'op': 'speed', 'v': 40}), (1, {'op': 'speed', 'v': -40}),
                   (0, {'op': 'speed', 'v': 0}), (1, {'op': 'speed', 'v': 0}), (0, {'op': 'speed', 'v': -250}), (1, {'op': 'speed', 'v': 250}),
                   (0, {'op': 'status'}), (0, {'op': 'remote_off'}), (1, {'op': 'remote_off'})],
  'max_speed_unsupported': [(0, {'op': 'max_speed', 'level': 0, 'kmh': 4.5}), (0, {'op': 'params', 'level': 1})],
}

class RefConn:
    def __init__(self, emu, w, log):
        self.emu, self.w, self.log = emu, w, log
        self.enc, self.dec = M25Encryptor(KEYS[w]), M25Decryptor(KEYS[w]); self.req_n = 0; self.name = ['left', 'right'][w]
    def _x(self, spp):
        m25_crypto.get_random_bytes = lambda n, w=self.w, c=self.req_n: iv('req', w, c)
        enc = self.enc.encrypt_packet(spp); self.req_n += 1
        resp = self.emu.process(self.w, enc)
        self.log.append({'w': self.w, 'tx_spp': spp.hex(), 'tx': enc.hex(), 'rx': resp.hex() if resp is not None else None})
        return resp
    def send_packet(self, spp): self._x(spp); return None
    def transact(self, spp, timeout=1.0):
        resp = self._x(spp)
        return self.dec.decrypt_packet(resp) if resp else None

def run(name, ops):
    emu, log, states = Emu(), [], []
    conns = [RefConn(emu, i, log) for i in range(2)]
    builders = [ECSPacketBuilder(), ECSPacketBuilder()]
    r = ECSRemote(conns[0], conns[1])
    results = []
    for w, op in ops:
        c, b = conns[w], builders[w]
        k = op['op']
        if k == 'status': res = r.read_wheel_status(c, b)
        elif k == 'assist': res = r.write_assist_level(c, b, op['level'])
        elif k == 'autohold': res = r.write_auto_hold(c, b, op['on'])
        elif k == 'remote_on': res = r.write_remote_mode(c, b, True)
        elif k == 'remote_off': res = r.write_remote_mode(c, b, False)
        elif k == 'speed': res = r.write_remote_speed(c, b, op['v'])
        elif k == 'max_speed': res = r.write_max_speed(c, b, op['level'], op['kmh'])
        elif k == 'params': res = r.read_profile_params(c, b, op['level'])
        results.append(json.loads(json.dumps(res, default=str)))
        states.append([state_dict(s) for s in emu.sims])
    return {'ops': ops, 'log': log, 'results': results, 'states': states}

# ---- upstream core path: core.transport.bluetooth.BluetoothTransport (what the m5squared remote/supervisor uses), real class, patched only at the socket edge
import asyncio
import core.transport.bluetooth as bt
from core.types import CommandFrame
from m25_transport import TRANSPORT_RFCOMM

CORE_FRAMES = [(30, 30), (50, -20), (-40, 10), (0, 0), (100, 100), (-100, 100), (7, -7), (0, 0)]

def run_core():
    emu, log = Emu(), []
    conns = {'left': RefConn(emu, 0, log), 'right': RefConn(emu, 1, log)}
    real_sleep = asyncio.sleep
    async def nosleep(*a, **k): return None
    asyncio.sleep = nosleep; bt.asyncio.sleep = nosleep
    t = bt.BluetoothTransport(force_rfcomm=True)
    async def sel(addr): return TRANSPORT_RFCOMM
    t._select_transport = sel
    t._build_connection = lambda addr, key, name, kind: conns[name]
    async def conn_wheel(conn, kind, channel=6): return True
    t._connect_wheel = conn_wheel
    async def disc(conn, kind): return None
    t._disconnect_wheel = disc
    async def go():
        ok = await t.connect('L', 'R', KEYS[0], KEYS[1])
        sent = [await t.send_command(CommandFrame(l, r)) for l, r in CORE_FRAMES]
        await t.disconnect()
        return ok, sent
    ok, sent = asyncio.run(go())
    asyncio.sleep = real_sleep
    return {'frames': CORE_FRAMES, 'log': log, 'ok': ok, 'sent': sent, 'states': [[state_dict(s) for s in emu.sims]]}

out = {n: run(n, ops) for n, ops in SCENARIOS.items()}
out['core_remote'] = run_core()
out['keys'] = [k.hex() for k in KEYS]; out['wheel_ids'] = WHEEL_IDS
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
json.dump(out, open(os.path.join(root, 'test/emulator_ref.json'), 'w'))
print({n: len(v['log']) for n, v in out.items() if isinstance(v, dict) and 'log' in v})
