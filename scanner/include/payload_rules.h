#pragma once

// Pure, dependency-free injection rules shared by the firmware and the
// native unit tests (test/test_payload_rules). Keep this free of Arduino APIs.

#include <stddef.h>
#include <stdint.h>

// Only [a-zA-Z0-9-] may be typed; anything else could inject control sequences.
inline bool isPermittedPayloadChar(char c) {
    return (c >= '0' && c <= '9') ||
           (c >= 'a' && c <= 'z') ||
           (c >= 'A' && c <= 'Z') ||
           c == '-';
}

// Copies permitted characters from `in` into `out` (NUL-terminated, at most
// outSize - 1 chars). Returns the number of characters written.
inline size_t sanitizePayloadChars(const char* in, char* out, size_t outSize) {
    if (outSize == 0) return 0;
    size_t written = 0;
    for (const char* p = in; p && *p && written < outSize - 1; p++) {
        if (isPermittedPayloadChar(*p)) {
            out[written++] = *p;
        }
    }
    out[written] = '\0';
    return written;
}

// True once `cooldownMs` has passed since `lastMs`. Unsigned subtraction keeps
// this correct across the ~49.7 day millis() rollover. `lastMs == 0` means no
// injection has happened yet.
inline bool isCooldownElapsed(uint32_t nowMs, uint32_t lastMs, uint32_t cooldownMs) {
    return lastMs == 0 || (uint32_t)(nowMs - lastMs) >= cooldownMs;
}

inline uint16_t clampBurstDelay(uint16_t delayMs, uint16_t minMs, uint16_t maxMs) {
    if (delayMs < minMs) return minMs;
    if (delayMs > maxMs) return maxMs;
    return delayMs;
}
