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

## Layout

`src/aes.js` pure-JS AES-128 (WebCrypto has no ECB) · `crypto.js` framing/QR keys · `packets.js` builders &
parsers · `session.js` per-wheel session + mock wheel · `ble.js` Web Bluetooth transport (V2, V1, Nordic
UART) · `drive.js` mapper & supervisor · `app.js` UI · `sw.js` offline cache.

## License

AGPL-3.0-or-later, as upstream. See `LICENSE` and `NOTICE.md`.
