# Notice

This project is a derivative work of **m5squared** by 6static
(<https://github.com/6static/m5squared>, AGPL-3.0), itself a fork of **roll2own/m5squared**.
The protocol knowledge (frame format, byte stuffing, CRC table, key derivation, packet and
parameter layouts, BLE profiles, supervisor/mapper design) comes from those projects; the Swift
code re-implements it and is distributed under the same license, GNU AGPL v3 (see `LICENSE`).

`M25Kit/Sources/M25Kit/Generated.swift` is generated directly from the upstream Python sources.
Not affiliated with or endorsed by Alber GmbH.

## 6static/m25-remote

The remote-drive path (mm/s speed units, arming handshake, drive-mode refresh, stop sequence, mapper behaviour and
feel presets) is re-implemented from the behaviour of https://github.com/6static/m25-remote, the firmware proven on
real wheels. That repository carries no licence file, so no code was copied; behaviour was ported and verified
against a natively compiled copy of its mapper (test/fw_mapper_fuzz.test.mjs).

## jsQR (vendor/jsQR.js)

QR decoding fallback for browsers without BarcodeDetector. jsQR 1.4.0, Apache License 2.0, (c) Cosmo Wolfe. Licence text: vendor/jsQR.LICENSE.
