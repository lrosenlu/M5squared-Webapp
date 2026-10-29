# M5Squared Web (PWA)

Unofficial, installable web app for Alber e-motion M25 wheels, ported from
[6static/m5squared](https://github.com/6static/m5squared). It talks to the wheels directly over
**Web Bluetooth** — no server, no account, nothing leaves your device.

> **Not verified on real hardware.** The protocol/crypto layer is tested byte-for-byte against the
> upstream Python (`npm test`), but nobody has driven a wheel with this app yet. Use only on wheels
> you own, with a helper present and the wheels off the ground / in a safe open space the first time.
> Not affiliated with Alber. Not a medical device. Changing wheel settings can void warranty.

## Platform support

| Platform | Works? |
|---|---|
| Android – Chrome / Edge / Samsung Internet | Yes |
| Desktop Chrome / Edge (Win, macOS, Linux, ChromeOS) | Yes |
| **iOS – Safari or Chrome** | **No** (Apple does not provide Web Bluetooth) |
| iOS – **Bluefy** browser (free, App Store) | Yes — open the hosted URL in Bluefy |
| Firefox (any) | No |

Demo mode (Wheels tab) simulates two wheels so you can try every screen on any browser.

## Run it

Web Bluetooth needs **HTTPS** (or `localhost`).

```sh
npm run serve        # http://localhost:8080 — fine for desktop Chrome
npm test             # 39 tests, no dependencies
```

To use it on a phone, host the folder as static files over HTTPS: GitHub Pages, Netlify, Cloudflare
Pages, etc. (no build step). Then on Android choose *Install app* / *Add to Home screen*; in Bluefy use
*Add to Home Screen* too.

### Deploy on GitHub Pages

1. Create a new GitHub repo and push this folder to its `main` branch.
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. The included workflow runs the tests and publishes to `https://<you>.github.io/<repo>/`.
4. Open that URL in Chrome (Android) or Bluefy (iOS) and install it.

Everything uses relative paths, so the `/<repo>/` subpath works. After changing files, bump `VERSION` in
`sw.js` so installed copies refresh.

## Keys

Each wheel needs its own 16-byte AES key: paste the 22-character QR text printed on the wheel, or 32 hex
digits. Keys are stored in this browser's `localStorage` on your device only; they are never shown again
after saving and never logged. Anyone with access to your unlocked browser profile could read them —
use "Forget key" on shared devices.

## Safety behaviour (same deviations as the iOS port)

- Remote drive is **off by default**, needs an explicit arm step and a held dead-man control.
- Speed commands are capped (slow 30 / normal 60 / fast 100, hard limit 250), shaped by a dead-zone and
  curve, and ramped from zero at 50 units/s.
- No input for 0.5 s, or no link for 2 s → zero speed and fail-safe.
- Steering sign is fixed (the upstream quirk is not reproduced).
- Max speed above 6.0 km/h is blocked unless you tick an explicit override; destructive services
  (factory/software reset, pairing, firmware, key management) are not implemented.
- Browsers throttle timers in background tabs: leaving the app while driving triggers the fail-safe.

## Verified against upstream (6static/m5squared)

`npm test` (100 tests) replays results produced by the **upstream Python** itself:

| Area | How it is checked |
|---|---|
| Frame, CRC-16, byte stuffing, AES/CBC/ECB, QR→key | 400 random keys/IVs/payloads, plus wrong-key, bit-flip, truncated and junk-prefixed packets (all must decrypt or fail exactly as upstream does) |
| Packet builders | 300 random commands, byte-for-byte |
| Response parsers | 5,400 random payloads incl. short/invalid ones (same values, same `null`s) |
| Protocol constants | 45 service/param/bit/table/name groups compared mechanically |
| Retry / ACK / NACK / echo / wrong-telegram-id handling | 38 scripted wheel-reply scenarios: same result *and* same number of attempts as `ECSRemote.read_value/write_value` |
| Drive mapper (deadzone, curve, caps, differential, ramp) | 400 random control sequences (8,914 steps) with a fake clock |

Regenerate with `tools/gen_*.py <path-to-upstream>`. **Not** verified: anything on real wheels over BLE.

## Intentional differences from upstream

- **Steering sign:** upstream documents `vy` as "right = +" but computes `left = vx - vy`, which steers the opposite way. Here positive = right turn (`invertSteering` flips it). The mapper test feeds the JS mapper `-vy` to compare everything else.
- **Ramp:** always starts from zero after a stop; time step capped at 0.25 s.
- **Watchdogs:** the link timer only refreshes after a *successful* send (upstream refreshes even on failure); the input timeout only applies while the dead-man is held; 10 Hz loop instead of 20 Hz; no stale-command heartbeat; fail-safe if either wheel link drops.
- **Max speed:** snaps to the wheel's own table (6.0 km/h = 1667) instead of `int(km/h/0.0036)` (1666), is blocked above 6.0 km/h without an explicit override, and is read back after writing.
- **BLE transport:** reassembles notifications and skips stray non-frame bytes (some wheels send `2B 00 00`); writes in 20-byte chunks with response when supported (upstream sends one write, without response when available).
- **Profile level index:** upstream is inconsistent (ECS code uses 0/1, its GUI passes 1/2). This app uses 0 = Normal, 1 = Outdoor, as `ECSRemote` does.
- **Not implemented, on purpose:** factory/software reset, pairing, firmware/memory, key management, Learning level.

## Layout

`src/aes.js` pure-JS AES-128 (WebCrypto has no ECB) · `crypto.js` framing/QR keys · `packets.js` builders &
parsers · `session.js` per-wheel session + mock wheel · `ble.js` Web Bluetooth transport (V2, V1, Nordic
UART) · `drive.js` mapper & supervisor · `app.js` UI · `sw.js` offline cache.

## License

AGPL-3.0-or-later, as upstream. See `LICENSE` and `NOTICE.md`.


## Firmware parity (6static/m25-remote)

The drive path follows the hardware-proven m25-remote firmware: speeds in mm/s (100 % = 10 km/h, capped at 2361 mm/s),
a 4-attempt arming handshake verified by reading back the REMOTE bit, a drive-mode refresh every 80 ms, a stop that
writes speed 0 then leaves cruise, the firmware's mapper semantics (checked against its natively compiled mapper), a 60 s
armed-idle disarm, a low-battery speed cap below 20 % and a drive lockout below 15 %.

Also included: live telemetry (speed, push-rim sensor, push count, wheel error, distance, charging state), a speedometer,
"keep both wheels in sync" for settings, single-wheel drive mode, hill hold, auto-reconnect and a read-only packet probe.

Not available: battery **voltage**. The documented wheel protocol has no voltage read; use the probe on your own wheels to
look for one. Untested on real hardware.

## Upstream parity tests

Each row compares this app's output with the real Python scripts on generated inputs (regenerate with the `tools/gen_*.py` scripts).

| Upstream | What is compared | Test |
|---|---|---|
| m25_crypto, m25_protocol, m25_qr_to_key | frames, CRC, byte stuffing, AES, key conversion | crypto, fuzz |
| m25_ecs ResponseParser / builders | every parser and packet builder | core, session |
| m25_ecs ECSRemote session logic | read/write retries, max-speed read-back | session_fuzz |
| core/mapper.py and the m25-remote firmware mapper | per-step output over random sequences | mapper_fuzz, fw_mapper_fuzz |
| m25_analyzer | parse, warnings, text/JSON/one-line output, 1,000 packets | tools |
| m25_decrypt, m25_encrypt | stdout and diagnostics for good, corrupt, truncated, wrong-key packets, both scopes, multi-key | tools |
| m25_utils.parse_hex | accepted inputs and Python's exact error text | tools |
| ECSRemote.format_wheel_status | status report text, 1,500 payload sets | report |
| m25_ecs_driveprofiles | factory presets and limits | presets |

Known deliberate differences: speed in CRUISE_VALUES is decoded signed (real wheels send reverse as a negative number; upstream documents it as unsigned), and the BMS charging read is experimental because no upstream script uses it.
