// Native shim so the m25-emulator ESP32 headers (protocol.h, crypto.h, packet.h, command.h, state.h, safety.h) compile on Linux.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
extern unsigned long gMillis;
inline unsigned long millis() { return gMillis; }
inline uint32_t esp_random() { static uint32_t x = 0x1234567u; x = x * 1664525u + 1013904223u; return x; }
#define F(s) (s)
struct SerialShim {
  void print(const char* s) { fputs(s, stderr); }
  void print(int v) { fprintf(stderr, "%d", v); }
  void println() { fputc('\n', stderr); }
  void println(const char* s) { fprintf(stderr, "%s\n", s); }
  void printf(const char* f, ...) { va_list a; va_start(a, f); vfprintf(stderr, f, a); va_end(a); }
};
extern SerialShim Serial;
#define PROGMEM
#define pgm_read_word(p) (*(p))
#define HIGH 1
#define LOW 0
inline int digitalRead(int) { return 1; }
inline unsigned long abs_(long v) { return v < 0 ? -v : v; }
