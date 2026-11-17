#pragma once
#include <stddef.h>
#include <stdint.h>

// One low-priority publish per loop; poll/ACK handling runs between messages.
// No catch-up bursts after a slow call. These are telemetry deadlines, not an FFT sampler.
enum class TelemetryKind { none, state, vibration, rpm };
struct TelemetrySchedule
{
    static constexpr uint32_t periodMs = 250;
    bool initialized = false;
    uint32_t dueAt = 0;
    TelemetryKind next = TelemetryKind::state;
    void reset(uint32_t now)
    {
        initialized = true;
        dueAt = now;
        next = TelemetryKind::state;
    }
    TelemetryKind take(uint32_t now)
    {
        if (!initialized) reset(now);
        if ((int32_t)(now - dueAt) < 0) return TelemetryKind::none;
        TelemetryKind result = next;
        next = next == TelemetryKind::state ? TelemetryKind::vibration :
            next == TelemetryKind::vibration ? TelemetryKind::rpm : TelemetryKind::state;
        // Schedule from actual service time: skip missed slots and never emit a catch-up burst.
        dueAt = now + periodMs / 3;
        return result;
    }
};

enum class LoopWork { none, freshAck, repeatAck, state, vibration, rpm };
inline LoopWork chooseLoopWork(bool freshAck, bool repeatAck, TelemetryKind telemetry)
{
    if (freshAck) return LoopWork::freshAck;
    if (repeatAck) return LoopWork::repeatAck;
    if (telemetry == TelemetryKind::state) return LoopWork::state;
    if (telemetry == TelemetryKind::vibration) return LoopWork::vibration;
    if (telemetry == TelemetryKind::rpm) return LoopWork::rpm;
    return LoopWork::none;
}

struct LoopTimings
{
    uint32_t pollUs = 0, publishUs = 0, imuUs = 0, gapUs = 0, ackQueueMs = 0;
    uint32_t previousLoopUs = 0, nextReportMs = 0;
    bool started = false;
    static void maximum(uint32_t &field, uint32_t value) { if (value > field) field = value; }
    void loop(uint32_t nowUs)
    {
        if (started) maximum(gapUs, nowUs - previousLoopUs);
        previousLoopUs = nowUs;
        started = true;
    }
    void clearPeaks() { pollUs = publishUs = imuUs = gapUs = ackQueueMs = 0; }
};

// Repeat an identical application ACK once. MQTT PUBACK covers only the
// publisher-to-broker hop; it is not confirmation from the backend.
// This schedule never executes a motor command or modifies its lease.
struct AckDelivery
{
    uint8_t attempts = 0;
    uint32_t nextAt = 0;

    void reset(uint32_t now) { attempts = 0; nextAt = now; }
    bool ready(uint32_t now) const { return attempts < 2 && (int32_t)(now - nextAt) >= 0; }
    bool sent(uint32_t now)
    {
        ++attempts;
        // Give the next 1-second web renew priority over this optional duplicate.
        nextAt = now + 1100;
        return attempts >= 2;
    }
};

// ArduinoMqttClient.available() is remaining payload length, not buffered TCP bytes.
// A failed read must return to the caller instead of retrying forever on that length.
template <typename Stream, typename Text>
bool readMqttPayload(Stream &stream, Text &text, size_t limit)
{
    while (stream.available() > 0)
    {
        int value = stream.read();
        if (value < 0 || text.length() >= limit)
        {
            return false;
        }
        text += (char)value;
    }
    return true;
}

inline uint32_t mqttNamespaceHash(const char *prefix)
{
    uint32_t hash = 2166136261UL;
    while (*prefix)
    {
        hash = (hash ^ (uint8_t)*prefix++) * 16777619UL;
    }
    return hash;
}
