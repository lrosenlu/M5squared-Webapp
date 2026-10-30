// Drives the REAL m25-emulator headers over stdin/stdout. Mirrors do_process_frame() / do_send_response_for() in m25_emulator.ino.
//   K <32 hex>      set wheel key           R   reset state        M <ms>  set millis
//   F <hex frame>   process a wire frame -> "OK|FAIL <ACK|SPEED|IGNORE> <response frame hex or ->"
//   W               run the command-timeout check (safety_cmd_timeout) -> "TIMEOUT|NO"
//   S               print state: speed driveMode hillHold assist battery profile cruise
#include <cstdio>
#include <string>
#include "Arduino.h"
unsigned long gMillis = 0;
SerialShim Serial;
#include "config.h"
#include "protocol.h"
#include "crypto.h"
#include "packet.h"
#include "command.h"
#include "state.h"
#include "safety.h"
static uint8_t hexv(char c) { return c <= '9' ? c - '0' : (c | 32) - 'a' + 10; }
int main() {
  uint8_t key[16] = {0}; WheelState w; state_init(&w);
  char op; char buf[1024];
  while (scanf(" %c", &op) == 1) {
    if (op == 'K') { scanf("%1023s", buf); for (int i = 0; i < 16; i++) key[i] = hexv(buf[2*i]) << 4 | hexv(buf[2*i+1]); }
    else if (op == 'R') state_init(&w);
    else if (op == 'M') { unsigned long m; scanf("%lu", &m); gMillis = m; }
    else if (op == 'W') puts(safety_cmd_timeout(&w) ? "TIMEOUT" : "NO");
    else if (op == 'S') printf("%d %d %d %d %d %d %d\n", w.speed, w.driveMode, w.hillHold, w.assistLevel, w.battery, w.driveProfile, w.cruiseSpeed);
    else if (op == 'F') {
      scanf("%1023s", buf); size_t n = strlen(buf) / 2; uint8_t raw[512];
      for (size_t i = 0; i < n; i++) raw[i] = hexv(buf[2*i]) << 4 | hexv(buf[2*i+1]);
      uint8_t spp[64]; size_t sl = 0;
      if (!packet_decode(raw, n, key, spp, &sl)) { puts("FAIL IGNORE -"); continue; }
      CmdResult r = command_apply(spp, sl, &w, false);
      if (r == CMD_SEND_ACK) {
        uint8_t fr[128]; size_t fl = packet_encode_response(spp[4], spp[5], &w, key, fr);
        printf("OK ACK "); for (size_t i = 0; i < fl; i++) printf("%02x", fr[i]); puts("");
      } else printf("OK %s -\n", r == CMD_SPEED_UPDATE ? "SPEED" : "IGNORE");
    }
    fflush(stdout);
  }
}
