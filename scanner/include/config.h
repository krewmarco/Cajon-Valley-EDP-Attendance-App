#pragma once

#include <Arduino.h>

// =============================================================================
// SCANNER EMULATOR PROFILES & USB DESCRIPTORS
// =============================================================================
// 0 = Generic EDP Scanner (0x303A : 0x8002)
// 1 = Honeywell Xenon 1900 (0x0C2E : 0x0BA1)
// 2 = Zebra DS2208 Handheld Scanner (0x05E0 : 0x1200)

#ifndef SCANNER_PROFILE
#define SCANNER_PROFILE 0
#endif

#if SCANNER_PROFILE == 1
  #define SCANNER_USB_VID             0x0C2E
  #define SCANNER_USB_PID             0x0BA1
  #define USB_MANUFACTURER    "Honeywell"
  #define USB_PRODUCT         "Honeywell Xenon 1900 Scanner"
  #define PROFILE_NAME        "Honeywell Xenon 1900"
#elif SCANNER_PROFILE == 2
  #define SCANNER_USB_VID             0x05E0
  #define SCANNER_USB_PID             0x1200
  #define USB_MANUFACTURER    "Zebra Technologies"
  #define USB_PRODUCT         "Zebra DS2208 Barcode Scanner"
  #define PROFILE_NAME        "Zebra DS2208"
#else
  #define SCANNER_USB_VID             0x303A
  #define SCANNER_USB_PID             0x8002
  #define USB_MANUFACTURER    "Cajon Valley USD"
  #define USB_PRODUCT         "EDP Scanner Emulator"
  #define PROFILE_NAME        "Generic EDP Scanner"
#endif

// Serial number presented over USB
#define USB_SERIAL_NUMBER     "CVUSD-SCAN-0001"

// =============================================================================
// HARDWARE PIN ASSIGNMENTS
// =============================================================================

// Standard BOOT button on ESP32-S3 boards (Active LOW)
#define PIN_BOOT_BUTTON       0

// Status LED (GPIO 48 on ESP32-S3-DevKitC-1 RGB / GPIO 21 on XIAO)
#if defined(BOARD_SEEED_XIAO)
  #define PIN_STATUS_LED      21
#elif defined(PIN_NEOPIXEL)
  #define PIN_STATUS_LED      PIN_NEOPIXEL
#else
  #define PIN_STATUS_LED      -1  // No fixed LED pin by default
#endif

// =============================================================================
// KEYSTROKE BURST & TIMING DEFAULTS
// =============================================================================

// Default inter-character delay in milliseconds (simulating physical laser beam scan)
#define DEFAULT_INTER_CHAR_DELAY_MS   8

// Key hold duration in milliseconds before key release
#define DEFAULT_PRESS_RELEASE_MS      4

// Minimum allowed delay for safety clamp (prevents dropped events on ChromeOS)
#define MIN_BURST_DELAY_MS            2

// Maximum allowed delay
#define MAX_BURST_DELAY_MS            50

// Cooldown between successive scans to prevent double-injections (ms)
#define SCAN_COOLDOWN_MS              250

// Button debounce duration in milliseconds
#define BUTTON_DEBOUNCE_MS            50

// Test payload injected upon pressing the BOOT button
#define TEST_INJECTION_PAYLOAD        "TEST-10042"
