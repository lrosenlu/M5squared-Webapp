"""Regenerate src/presets.js and test/presets.json from the upstream toolkit.
Usage: python tools/gen_presets.py /path/to/6static/m5squared
"""
import json, sys, os
up = sys.argv[1]; sys.path.insert(0, up)
from m25_ecs_driveprofiles import PROFILES
from m25_protocol_data import SLOPE_VALUES, SPEED_BIAS_VALUES, MAX_SPEED_VALUES
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
json.dump({'profiles': PROFILES, 'slope': SLOPE_VALUES, 'bias': SPEED_BIAS_VALUES, 'speeds': MAX_SPEED_VALUES},
          open(os.path.join(root, 'test/presets.json'), 'w'), indent=1)
open(os.path.join(root, 'src/presets.js'), 'w').write(
    "// GENERATED from upstream m25_ecs_driveprofiles.py (tools/gen_presets.py). Do not edit.\n"
    "export const PRESETS = " + json.dumps(PROFILES, indent=1) + ";\n"
    "export const SLOPE_VALUES = " + json.dumps(SLOPE_VALUES) + ";\n"
    "export const SPEED_BIAS_VALUES = " + json.dumps(SPEED_BIAS_VALUES) + ";\n")
