// GENERATED from upstream m25_ecs_driveprofiles.py (tools/gen_presets.py). Do not edit.
export const PRESETS = {
 "Standard": {
  "id": 1,
  "level_1": {
   "max_torque": 45,
   "max_speed": 1111,
   "speed_bias": 20,
   "slope_inc": 28,
   "slope_dec": 56,
   "p_factor": 5,
   "speed_factor": 11,
   "rotation_threshold": 2
  },
  "level_2": {
   "max_torque": 75,
   "max_speed": 2361,
   "speed_bias": 20,
   "slope_inc": 42,
   "slope_dec": 42,
   "p_factor": 5,
   "speed_factor": 11,
   "rotation_threshold": 2
  }
 },
 "Active": {
  "id": 4,
  "level_1": {
   "max_torque": 45,
   "max_speed": 1250,
   "speed_bias": 30,
   "slope_inc": 56,
   "slope_dec": 56,
   "p_factor": 5,
   "speed_factor": 11,
   "rotation_threshold": 2
  },
  "level_2": {
   "max_torque": 90,
   "max_speed": 2361,
   "speed_bias": 20,
   "slope_inc": 70,
   "slope_dec": 28,
   "p_factor": 5,
   "speed_factor": 11,
   "rotation_threshold": 2
  }
 },
 "Sensitive": {
  "id": 2,
  "level_1": {
   "max_torque": 60,
   "max_speed": 1111,
   "speed_bias": 30,
   "slope_inc": 42,
   "slope_dec": 42,
   "p_factor": 5,
   "speed_factor": 11,
   "rotation_threshold": 2
  },
  "level_2": {
   "max_torque": 95,
   "max_speed": 2361,
   "speed_bias": 40,
   "slope_inc": 42,
   "slope_dec": 28,
   "p_factor": 5,
   "speed_factor": 11,
   "rotation_threshold": 2
  }
 },
 "Soft": {
  "id": 3,
  "level_1": {
   "max_torque": 35,
   "max_speed": 833,
   "speed_bias": 20,
   "slope_inc": 28,
   "slope_dec": 56,
   "p_factor": 5,
   "speed_factor": 11,
   "rotation_threshold": 2
  },
  "level_2": {
   "max_torque": 50,
   "max_speed": 2361,
   "speed_bias": 10,
   "slope_inc": 28,
   "slope_dec": 56,
   "p_factor": 5,
   "speed_factor": 11,
   "rotation_threshold": 2
  }
 },
 "SensitivePlus": {
  "id": 5,
  "level_1": {
   "max_torque": 65,
   "max_speed": 1389,
   "speed_bias": 50,
   "slope_inc": 70,
   "slope_dec": 28,
   "p_factor": 5,
   "speed_factor": 50,
   "rotation_threshold": 1
  },
  "level_2": {
   "max_torque": 100,
   "max_speed": 2361,
   "speed_bias": 50,
   "slope_inc": 70,
   "slope_dec": 20,
   "p_factor": 5,
   "speed_factor": 50,
   "rotation_threshold": 1
  }
 }
};
export const SLOPE_VALUES = [70, 56, 42, 28, 20];
export const SPEED_BIAS_VALUES = [10, 20, 30, 40, 50];
