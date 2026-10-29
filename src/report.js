// Port of ECSRemote.format_wheel_status (m25_ecs.py): the plain-text status report, identical to upstream's.
import { PROFILE_NAMES_UPSTREAM } from './report_names.js';

const fix = (n, d) => n.toFixed(d);
const z = (n, w) => String(n).padStart(w, '0');

/** Convert this app's parsed values (src/packets.js) to the dict shape upstream's ResponseParser returns. */
export function toUpstreamStatus(s) {
  return {
    battery: s.battery ?? null,
    assist_level: s.assistLevel != null ? { value: s.assistLevel } : null,
    drive_mode: s.driveMode ? { auto_hold: !!s.driveMode.autoHold } : null,
    profile: s.profile != null ? { name: PROFILE_NAMES_UPSTREAM[s.profile] ?? `Unknown(${s.profile})` } : null,
    profile_params: s.params ? { max_torque: s.params.maxTorque, max_speed: s.params.maxSpeedRaw * 0.0036, speed_bias: s.params.speedBias,
      slope_inc: s.params.slopeInc, slope_dec: s.params.slopeDec, p_factor: s.params.pFactor, speed_factor: s.params.speedFactor,
      rotation_threshold: s.params.rotationThreshold } : null,
    cruise_values: s.cruise ? { distance_km: s.cruise.distanceKm } : null,
    duo_drive: s.duo ? { mounting_name: s.duo.mountingName, speed_sensibility: s.duo.speedSensibility, steering_dynamic: s.duo.steeringDynamic } : null,
    sw_version: s.firmware ? { version_str: s.firmware.text } : null,
  };
}

export function formatWheelStatus(st, wheelName, address) {
  const l = [`${wheelName} Wheel (${address})`];
  l.push(st.battery != null ? `  Battery:           ${st.battery}%` : '  Battery:           --');
  if (st.assist_level) {
    const v = st.assist_level.value + 1;
    l.push(v === 3 ? `  Assist Level:      ${v} (Learning Mode)` : `  Assist Level:      ${v}`);
  } else l.push('  Assist Level:      --');
  l.push(st.drive_mode ? `  Auto Hold:         ${st.drive_mode.auto_hold ? 'On' : 'Off'}` : '  Auto Hold:         --');
  l.push(st.profile ? `  Profile:           ${st.profile.name}` : '  Profile:           --');
  const p = st.profile_params;
  if (p) {
    l.push(`  Max Torque:        ${p.max_torque}%`);
    l.push(`  Max Speed:         ${fix(p.max_speed, 2)} km/h`);
    l.push(`  Sensor Sens.:      ${p.speed_bias} (speedBias)`);
    l.push(`  Startup Time:      ${p.slope_inc} (slopeInc)`);
    l.push(`  Coasting Time:     ${p.slope_dec} (slopeDec)`);
    l.push(`  P-Factor:          ${p.p_factor}`);
    l.push(`  Speed Factor:      ${p.speed_factor}`);
    l.push(`  Rot. Threshold:    ${p.rotation_threshold}`);
  }
  l.push(st.cruise_values ? `  Distance:          ${fix(st.cruise_values.distance_km, 2)} km` : '  Distance:          --');
  const d = st.duo_drive;
  if (d) l.push(`  DuoDrive:          side=${d.mounting_name}, sens=${d.speed_sensibility}, dynamic=${d.steering_dynamic}`);
  l.push(st.sw_version ? `  Firmware:          ${st.sw_version.version_str}` : '  Firmware:          --');
  return l.join('\n');
}
