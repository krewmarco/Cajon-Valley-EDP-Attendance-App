#include <Arduino.h>
#include "config.h"
#include "keystroke_engine.h"

// Button state tracking with debounce
static bool lastButtonState = HIGH;
static uint32_t lastDebounceTime = 0;

void printBanner() {
    Serial.println();
    Serial.println("*********************************************************");
    Serial.println("*      ESP32-S3 USB Barcode Scanner Emulator            *");
    Serial.println("*      Phase 1: Native USB HID Keyboard Engine          *");
    Serial.println("*      Cajon Valley Union School District               *");
    Serial.println("*********************************************************");
    Serial.printf(" Active Profile:  %s\n", PROFILE_NAME);
    Serial.printf(" USB VID / PID:   0x%04X : 0x%04X\n", SCANNER_USB_VID, SCANNER_USB_PID);
    Serial.printf(" Burst Speed:     %d ms inter-character delay\n", DEFAULT_INTER_CHAR_DELAY_MS);
    Serial.printf(" Hardware Trigger: Press onboard BOOT button (GPIO %d)\n", PIN_BOOT_BUTTON);
    Serial.println(" Serial Commands:");
    Serial.println("   [t]        Trigger test scan (\"" TEST_INJECTION_PAYLOAD "\")");
    Serial.println("   [i:<id>]   Inject custom ID (e.g. \"i:10087\")");
    Serial.println("   [s]        Report USB host connection status");
    Serial.println("   [h]        Print this help banner");
    Serial.println("*********************************************************");
    Serial.println();
}

void handleSerialCommands() {
    if (!Serial.available()) return;

    String input = Serial.readStringUntil('\n');
    input.trim();
    if (input.length() == 0) return;

    char cmd = input.charAt(0);
    if (cmd == 't' || cmd == 'T') {
        Serial.printf("[COMMAND] Triggering test scan: %s\n", TEST_INJECTION_PAYLOAD);
        injectKeystrokeBurst(TEST_INJECTION_PAYLOAD, SuffixTerminator::ENTER);
    } else if (input.startsWith("i:") || input.startsWith("I:")) {
        String customId = input.substring(2);
        customId.trim();
        Serial.printf("[COMMAND] Triggering custom ID scan: %s\n", customId.c_str());
        injectKeystrokeBurst(customId, SuffixTerminator::ENTER);
    } else if (cmd == 's' || cmd == 'S') {
        bool ready = isUsbHostReady();
        Serial.printf("[STATUS] USB Host Mounted & Ready: %s\n", ready ? "YES" : "NO");
    } else if (cmd == 'h' || cmd == 'H') {
        printBanner();
    } else {
        Serial.printf("[UNKNOWN] Unrecognized command '%s'. Press 'h' for help.\n", input.c_str());
    }
}

void handleButtonTrigger() {
    int reading = digitalRead(PIN_BOOT_BUTTON);

    if (reading != lastButtonState) {
        lastDebounceTime = millis();
    }

    if ((millis() - lastDebounceTime) > BUTTON_DEBOUNCE_MS) {
        // If button transitioned to pressed (LOW)
        static bool buttonPressed = false;
        if (reading == LOW && !buttonPressed) {
            buttonPressed = true;
            Serial.println("\n[BUTTON] BOOT button pressed! Injecting test barcode...");

            if (!isUsbHostReady()) {
                Serial.println("[WARN] USB Host port is not ready. Is device plugged into a host?");
            }

            KeystrokeResult res = injectKeystrokeBurst(TEST_INJECTION_PAYLOAD, SuffixTerminator::ENTER);
            if (!res.success) {
                Serial.printf("[FAILED] Error: %s\n", res.errorMessage ? res.errorMessage : "Unknown error");
            }
        } else if (reading == HIGH) {
            buttonPressed = false;
        }
    }

    lastButtonState = reading;
}

void setup() {
    Serial.begin(115200);
    // Allow small window for serial monitor connection
    delay(1000);

    // Configure BOOT button with internal pull-up
    pinMode(PIN_BOOT_BUTTON, INPUT_PULLUP);

    // Initialize USB HID Keyboard engine
    initKeystrokeEngine();

    printBanner();
}

void loop() {
    // Process serial terminal commands
    handleSerialCommands();

    // Process physical button trigger
    handleButtonTrigger();

    delay(5);
}
