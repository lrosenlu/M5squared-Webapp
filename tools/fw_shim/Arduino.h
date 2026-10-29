// Minimal Arduino.h shim so the m25-remote firmware's mapper.cpp compiles natively for differential testing.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <math.h>
#include <algorithm>
extern uint32_t gMillis;
inline uint32_t millis() { return gMillis; }
#ifndef constrain
#define constrain(x, a, b) ((x) < (a) ? (a) : ((x) > (b) ? (b) : (x)))
#endif
using std::min;
using std::max;
