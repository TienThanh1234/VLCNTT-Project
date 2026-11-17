#include <assert.h>
#include <math.h>
#include <string.h>
#include "mqtt_support.h"
#include "motor_control.h"

int main()
{
    TelemetrySchedule schedule;
    assert(schedule.take(0) == TelemetryKind::state);
    // A 300ms blocking publish cannot starve either low-priority stream.
    assert(schedule.take(300) == TelemetryKind::vibration);
    assert(schedule.take(600) == TelemetryKind::rpm);
    assert(schedule.take(900) == TelemetryKind::state);
    assert(schedule.take(900) == TelemetryKind::none); // no catch-up burst

    TelemetrySchedule rollover;
    const uint32_t nearWrap = 0xfffffff0UL;
    assert(rollover.take(nearWrap) == TelemetryKind::state);
    assert(rollover.take(20) == TelemetryKind::none);
    assert(rollover.take(70) == TelemetryKind::vibration);

    assert(chooseLoopWork(true, true, TelemetryKind::state) == LoopWork::freshAck);
    assert(chooseLoopWork(false, true, TelemetryKind::state) == LoopWork::repeatAck);
    assert(chooseLoopWork(false, false, TelemetryKind::rpm) == LoopWork::rpm);

    double former = 0.0, reducedLoad = 0.0;
    for (int i = 0; i < 180; ++i) former += (1.0 - former) / 180.0;
    for (int i = 0; i < 36; ++i) reducedLoad += (1.0 - reducedLoad) / 36.0;
    assert(fabs(former - reducedLoad) < .01); // approximately the same 180ms motor lag

    AckDelivery repeat;
    repeat.reset(1000);
    repeat.sent(1000);
    assert(!repeat.ready(2099));
    assert(repeat.ready(2100));

    MotorControl motor;
    assert(strcmp(motor.command("start", "start", true, 4000, .3f, 1000, 1000, false, true),
        "command_accepted_wait_for_rpm") == 0);
    assert(motor.running);
    // The independent control task remains safe even if the MQTT loop is blocked.
    motor.tick(2001, false, true);
    assert(!motor.running && strcmp(motor.stopReason, "lease_expired") == 0);
    assert(strcmp(motor.command("start2", "start", true, 5000, .3f, 1000, 3000, false, true),
        "command_accepted_wait_for_rpm") == 0);
    motor.tick(3001, true, true);
    assert(!motor.running && strcmp(motor.stopReason, "local_stop") == 0);
    return 0;
}
