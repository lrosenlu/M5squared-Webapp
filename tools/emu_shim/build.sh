#!/usr/bin/env bash
# Build the native harness from the REAL 6static/m25-emulator headers (needs libssl-dev for AES).
set -e
SRC="${M25_EMULATOR:-/home/claude/ref/m25-emulator}"; OUT="${EMU25_BIN:-/tmp/emu_harness}"
cd "$(dirname "$0")"
g++ -std=c++17 -O1 -Wno-deprecated-declarations -I. -I"$SRC" harness.cpp -o "$OUT" -lcrypto
