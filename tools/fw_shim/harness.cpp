// Reads sequences from stdin, runs them through the firmware Mapper, prints "left right" per step.
//   S                      -> start a new sequence (fresh Mapper)
//   C dz curve slow normal fast lowbat ramp reverse turn
//   T ms vx vy deadman mode lowbatActive
#include <cstdio>
#include "mapper.h"
uint32_t gMillis = 0;
int main() {
    char op;
    MapperConfig cfg;
    Mapper* m = new Mapper(cfg);
    while (scanf(" %c", &op) == 1) {
        if (op == 'S') { delete m; cfg = MapperConfig(); m = new Mapper(cfg); gMillis = 0; }
        else if (op == 'C') {
            float dz, cv, rr, rv, tr; int s, n, f, lb;
            scanf("%f %f %d %d %d %d %f %f %f", &dz, &cv, &s, &n, &f, &lb, &rr, &rv, &tr);
            cfg.deadzone = dz; cfg.curve = cv; cfg.maxSpeedSlow = s; cfg.maxSpeedNormal = n; cfg.maxSpeedFast = f;
            cfg.maxSpeedLowBattery = lb; cfg.rampRate = rr; cfg.reverseRatio = rv; cfg.turnReduction = tr;
            m->setConfig(cfg);
        } else if (op == 'T') {
            unsigned ms; float vx, vy; int dm, mode, lb;
            scanf("%u %f %f %d %d %d", &ms, &vx, &vy, &dm, &mode, &lb);
            gMillis = ms;
            ControlState st; st.vx = vx; st.vy = vy; st.deadman = dm; st.mode = (DriveMode)mode; st.timestamp = ms;
            m->setLowBatteryLimit(lb);
            CommandFrame out; m->map(st, out);
            printf("%d %d\n", out.leftSpeed, out.rightSpeed);
        }
    }
    return 0;
}
