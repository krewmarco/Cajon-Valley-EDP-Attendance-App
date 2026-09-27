#pragma once

#include <Arduino.h>
#include "config.h"

// Suffix terminators supported by barcode scanners
enum class SuffixTerminator {
    ENTER,   // Standard '\n' (USB HID KEY_RETURN)
    TAB,     // Standard '\t' (USB HID KEY_TAB)
    NONE     // Raw characters only (no terminator)
};

// Execution telemetry result structure
struct KeystrokeResult {
    bool success;
    uint16_t charsInjected;
    uint32_t elapsedMs;
    const char* errorMessage;
};

/**
 * Initializes the USB HID Keyboard stack and hardware pins.
 */
void initKeystrokeEngine();

/**
 * Checks if the USB host (Chromebook/PC/Mac) has mounted the HID interface.
 */
bool isUsbHostReady();

/**
 * Injects an alphanumeric string with burst timing and terminator.
 *
 * @param payload      The student ID or barcode string to inject.
 * @param terminator   The suffix key to press (ENTER, TAB, or NONE).
 * @param delayMs      Inter-character burst delay in milliseconds (clamped to MIN/MAX).
 * @return             KeystrokeResult containing execution telemetry.
 */
KeystrokeResult injectKeystrokeBurst(
    const String& payload, 
    SuffixTerminator terminator = SuffixTerminator::ENTER, 
    uint16_t delayMs = DEFAULT_INTER_CHAR_DELAY_MS
);

/**
 * Sanitizes input string, keeping only [a-zA-Z0-9-] (see payload_rules.h).
 */
String sanitizePayload(const String& rawInput);
