"""Shared pieces for the emulator parity harness (reference run + live bridge)."""
import sys, os
UP = os.environ.get('M5SQ_UPSTREAM', '/home/claude/6static/m5squared')
sys.path.insert(0, UP); sys.path.insert(0, os.path.join(UP, 'mock_wheel'))
import m25_crypto
from m25_crypto import M25Encryptor, M25Decryptor
from mock_wheel_simulator import MockWheelSimulator
import logging; logging.disable(logging.CRITICAL)

KEYS = [bytes.fromhex('00112233445566778899aabbccddeeff'), bytes.fromhex('ffeeddccbbaa99887766554433221100')]
WHEEL_IDS = [2, 3]   # SRC_ID_M25_WHEEL_LEFT / RIGHT

def iv(kind, wheel, n):
    k = {'req': 1, 'resp': 2}[kind]
    return bytes(((k * 53 + wheel * 29 + n * 7 + j * 13 + 1) & 0xFF) for j in range(16))

def state_dict(sim):
    s = sim.state
    return {'system_mode': s.system_mode, 'drive_mode': s.drive_mode, 'assist_level': s.assist_level, 'target_speed': s.target_speed,
            'motor_speed': s.motor_speed, 'command_count': s.command_count}

class Emu:
    """Two upstream simulators with deterministic response IVs."""
    def __init__(self):
        self.sims = [MockWheelSimulator(key=KEYS[i], wheel_id=WHEEL_IDS[i]) for i in range(2)]
        self.resp_n = [0, 0]
    def process(self, wheel, enc):
        m25_crypto.get_random_bytes = lambda n, w=wheel, c=self.resp_n[wheel]: iv('resp', w, c)
        out = self.sims[wheel].process_packet(enc)
        if out is not None: self.resp_n[wheel] += 1
        return out
