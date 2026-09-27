#include "keystroke_engine.h"
#include "payload_rules.h"
#include "USB.h"
#include "USBHIDKeyboard.h"

static USBHIDKeyboard Keyboard;
static uint32_t lastInjectionTime = 0;

void initKeystrokeEngine() {
    Serial.println("=================================================");
    Serial.printf("Initializing USB HID Keyboard Engine...\n");
    Serial.printf("Profile:       %s\n", PROFILE_NAME);
    Serial.printf("USB VID / PID: 0x%04X : 0x%04X\n", SCANNER_USB_VID, SCANNER_USB_PID);
    Serial.printf("Manufacturer:  %s\n", USB_MANUFACTURER);
    Serial.printf("Product Name:  %s\n", USB_PRODUCT);
    Serial.println("=================================================");

    // Configure custom USB descriptors and IDs
    USB.VID(SCANNER_USB_VID);
    USB.PID(SCANNER_USB_PID);
    USB.productName(USB_PRODUCT);
    USB.manufacturerName(USB_MANUFACTURER);
    USB.serialNumber(USB_SERIAL_NUMBER);

    // Initialize TinyUSB Keyboard interface
    Keyboard.begin();
    USB.begin();

    // Configure status LED if pin is assigned
    if (PIN_STATUS_LED >= 0) {
        pinMode(PIN_STATUS_LED, OUTPUT);
        digitalWrite(PIN_STATUS_LED, LOW);
    }
}

bool isUsbHostReady() {
    // ESPUSB::operator bool() is true once USB has started and the host has mounted it
    return (bool)USB;
}

String sanitizePayload(const String& rawInput) {
    String clean = "";
    clean.reserve(rawInput.length());

    for (size_t i = 0; i < rawInput.length(); i++) {
        char c = rawInput.charAt(i);
        if (isPermittedPayloadChar(c)) {
            clean += c;
        }
    }
    return clean;
}

KeystrokeResult injectKeystrokeBurst(const String& payload, SuffixTerminator terminator, uint16_t delayMs) {
    KeystrokeResult result;
    result.charsInjected = 0;
    result.elapsedMs = 0;
    result.errorMessage = nullptr;

    // Check USB Host readiness
    if (!isUsbHostReady()) {
        result.success = false;
        result.errorMessage = "USB Host not mounted or not ready";
        Serial.println("[ERROR] Keystroke injection aborted: USB Host not ready.");
        return result;
    }

    // Sanitize input (before the cooldown, so rejected payloads don't consume it)
    String cleanPayload = sanitizePayload(payload);
    if (cleanPayload.length() == 0) {
        result.success = false;
        result.errorMessage = "Payload is empty or contained only invalid characters";
        return result;
    }

    // Enforce cooldown rate limiting
    uint32_t now = millis();
    if (!isCooldownElapsed(now, lastInjectionTime, SCAN_COOLDOWN_MS)) {
        result.success = false;
        result.errorMessage = "Rate limit cooldown active";
        Serial.println("[WARN] Keystroke injection throttled: Cooldown active.");
        return result;
    }
    // Reserve 0 as "never injected" for isCooldownElapsed()
    lastInjectionTime = now == 0 ? 1 : now;

    // Clamp timing delay to safe bounds
    delayMs = clampBurstDelay(delayMs, MIN_BURST_DELAY_MS, MAX_BURST_DELAY_MS);

    uint32_t startTime = millis();

    // Turn on status LED if available
    if (PIN_STATUS_LED >= 0) {
        digitalWrite(PIN_STATUS_LED, HIGH);
    }

    Serial.printf("[BURST] Injecting %u characters (delay: %u ms)...\n", cleanPayload.length(), delayMs);

    // High-speed keystroke burst
    for (size_t i = 0; i < cleanPayload.length(); i++) {
        char c = cleanPayload.charAt(i);
        Keyboard.press(c);
        delay(DEFAULT_PRESS_RELEASE_MS);
        Keyboard.release(c);
        delay(delayMs);
        result.charsInjected++;
    }

    // Apply configured terminator suffix
    switch (terminator) {
        case SuffixTerminator::ENTER:
            Keyboard.press(KEY_RETURN);
            delay(DEFAULT_PRESS_RELEASE_MS);
            Keyboard.release(KEY_RETURN);
            result.charsInjected++;
            Serial.println("[BURST] Suffix applied: KEY_RETURN (Enter)");
            break;

        case SuffixTerminator::TAB:
            Keyboard.press(KEY_TAB);
            delay(DEFAULT_PRESS_RELEASE_MS);
            Keyboard.release(KEY_TAB);
            result.charsInjected++;
            Serial.println("[BURST] Suffix applied: KEY_TAB (Tab)");
            break;

        case SuffixTerminator::NONE:
        default:
            Serial.println("[BURST] Suffix applied: NONE");
            break;
    }

    // Turn off status LED
    if (PIN_STATUS_LED >= 0) {
        digitalWrite(PIN_STATUS_LED, LOW);
    }

    result.elapsedMs = millis() - startTime;
    result.success = true;

    Serial.printf("[SUCCESS] Injected %u characters in %u ms.\n", 
                  result.charsInjected, result.elapsedMs);

    return result;
}
