# USB Barcode Scanner Emulator Specification

**Version:** 1.0.0  
**Target Platform:** ESP32-S3 (USB OTG Native HID)  
**Host Target:** ChromeOS Chromebook / Web Attendance Portal  
**Role:** Hardware Keystroke Injection Bridge  

---

## 1. System Overview & Problem Statement

### 1.1 Context
Elementary school attendance systems frequently utilize locked-down Chromebooks or browser-based Student Information System (SIS) portals that expect input from physical USB handheld barcode or magnetic stripe scanners. These web applications:
- Listen exclusively for standard USB HID Keyboard input.
- Expect an alphanumeric string (Student ID) received at high burst speeds.
- Require a terminating keystroke (`Enter` or `Tab`) to trigger record lookup and check-in.
- Operate in restricted "Kiosk Mode" or managed Chrome profiles where installing software extensions, background daemons, or custom drivers is forbidden by district IT policies.

### 1.2 Solution
The **ESP32-S3 Scanner Emulator** is an autonomous hardware bridge that connects physically to the Chromebook via USB-C. It registers natively as a standard USB HID Keyboard / Barcode Scanner (zero drivers or ChromeOS permissions required). It exposes a local network API (WebSockets / HTTP REST) over secure school Wi-Fi. 

When external systems (such as the Face Recognizer Attendant App or a central attendance server) verify a student, they transmit an injection command over the local network to the ESP32-S3. The dongle instantly translates the Student ID into native USB HID keystrokes, simulating a laser barcode scan directly into the Chromebook's active input field.

```
┌─────────────────────────────────┐               ┌───────────────────────────────┐
│     Client / Attendance App     │               │     School Chromebook Host    │
│  (Face Recognizer / Tablet UI)  │               │    (Locked SIS Web Portal)    │
└────────────────┬────────────────┘               └───────────────▲───────────────┘
                 │                                                │
                 │ 1. Verified Student ID                         │ 3. Native USB HID
                 │    over Local Wi-Fi / WSS                      │    Keystrokes + Enter
                 ▼                                                │    (5-10ms burst)
┌─────────────────────────────────────────────────────────────────┴───────────────┐
│                      ESP32-S3 Scanner Emulator Dongle                           │
│  - Native USB OTG (TinyUSB HID Keyboard Stack)                                  │
│  - Optional Spoofed Scanner VID/PID (Zebra / Honeywell)                         │
│  - Local WebSocket / REST Server + mDNS (`esp32-scanner-01.local`)             │
│  - HMAC / Pre-Shared Key (PSK) Injection Authentication                         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Hardware Architecture & USB Configuration

### 2.1 Hardware Requirements
- **Microcontroller:** ESP32-S3 (Dual-core Xtensa LX7 @ 240MHz, 512KB SRAM, 4MB+ Flash, integrated USB OTG Full Speed 12 Mbps PHY).
  - *Recommended Boards:* ESP32-S3-DevKitC-1, Waveshare ESP32-S3-Zero, or Seeed Studio XIAO ESP32-S3.
- **Physical Connector:** Direct USB-C male plug or high-quality USB-C to USB-A/C cable connected directly to the Chromebook host port.
- **Power Supply:** Bus-powered directly from the host Chromebook USB port (typical draw: 70–120mA).

### 2.2 USB HID Interface & VID/PID Spoofing
District Chromebook policies may employ USB peripheral whitelisting (blocking unrecognized USB devices while permitting approved HID input devices). The ESP32-S3 firmware configures TinyUSB to present standard USB descriptors mimicking enterprise barcode scanners:

| Parameter | Default Profile (Generic) | Zebra DS2208 Profile | Honeywell Xenon 1900 Profile |
|---|---|---|---|
| **Vendor ID (VID)** | `0x303A` (Espressif) | `0x05E0` (Zebra Technologies) | `0x0C2E` (Honeywell) |
| **Product ID (PID)** | `0x8002` (CDC + HID) | `0x1200` (Barcode Scanner) | `0x0BA1` (Imaging Scanner) |
| **Device Class** | `0x00` (Defined at interface) | `0x00` | `0x00` |
| **Interface Class** | `0x03` (HID) | `0x03` (HID) | `0x03` (HID) |
| **Subclass** | `0x01` (Boot Interface) | `0x01` (Boot Interface) | `0x01` (Boot Interface) |
| **Protocol** | `0x01` (Keyboard) | `0x01` (Keyboard) | `0x01` (Keyboard) |
| **Manufacturer** | `"Cajon Valley USD"` | `"Zebra Technologies"` | `"Honeywell"` |
| **Product Name** | `"EDP Scanner Emulator"` | `"Handheld Barcode Scanner"`| `"Honeywell Barcode Scanner"`|

---

## 3. Network & Service Layer

### 3.1 Network Topology & Connectivity
- **Wi-Fi Station Mode:** Connects to the local school or district IoT Wi-Fi network (WPA2/WPA3 Personal or Enterprise with static IP or DHCP reservation).
- **Auto-Reconnect Daemon:** Runs in a dedicated FreeRTOS task. In the event of Wi-Fi beacon loss or AP roaming, reconnection is automatically re-established without disrupting USB host connectivity.
- **mDNS / Bonjour Discovery:** Advertises hostname `esp32-scanner-<station_id>.local` on service `_scanner-emulator._tcp` port `8080`, allowing automatic client discovery without hardcoding IP addresses.

### 3.2 Inbound Keystroke Injection Protocol
The ESP32-S3 operates an internal WebSocket server and REST endpoint listening on port `8080`.

#### REST Endpoint: `POST /api/v1/inject`
**Headers:**
- `Content-Type: application/json`
- `X-Scanner-Auth: <HMAC_OR_PRESHARED_TOKEN>`

**Request Body Schema:**
```json
{
  "student_id": "10042",
  "prefix": "",
  "suffix": "\n",
  "typing_speed_ms": 8,
  "station_id": "station-alpha-1"
}
```

#### WebSocket Stream: `ws://esp32-scanner-<id>.local:8080/ws`
Bidirectional connection for real-time keystroke triggering and heartbeat status reporting:
- **Client to ESP32:**
  ```json
  {
    "action": "INJECT",
    "token": "secret_station_token_123",
    "student_id": "10042",
    "suffix": "ENTER",
    "burst_delay_ms": 6
  }
  ```
- **ESP32 to Client (Execution Status):**
  ```json
  {
    "status": "SUCCESS",
    "injected_id": "10042",
    "chars_sent": 5,
    "elapsed_ms": 36,
    "usb_mounted": true,
    "timestamp": 1774742100
  }
  ```

### 3.3 Security & Injection Protection
1. **Pre-Shared Key (PSK) / HMAC Validation:** Every incoming command must supply a cryptographically validated token. Rogue devices on the school Wi-Fi network cannot inject keystrokes into teacher Chromebooks.
2. **Rate Limiting & Anti-Flood:** The firmware enforces a cooldown threshold (minimum 250ms between successive scan commands) to prevent buffer overflows or accidental double-check-in scans.
3. **Character Whitelist:** Injected strings are strictly filtered to alphanumeric characters `[a-zA-Z0-9-]`. Escape characters, control codes (except authorized terminators `\n`, `\t`), and shell metacharacters are purged.

---

## 4. Keystroke Burst Generation & Scancode Translation

### 4.1 USB HID Scancode Mapping
Physical barcode scanners simulate keyboard typists, but transmit characters at high burst frequencies. Standard ASCII characters are mapped directly to USB HID usage tables:

| Character | USB HID Scancode | Modifier |
|---|---|---|
| `'0'` – `'9'` | `0x27` (0), `0x1E` – `0x26` (1–9) | `0x00` (None) |
| `'A'` – `'Z'` | `0x04` – `0x1D` | `0x02` (Left Shift) |
| `'a'` – `'z'` | `0x04` – `0x1D` | `0x00` (None) |
| `'-'` (Hyphen) | `0x2D` | `0x00` (None) |
| `'\n'` (Enter) | `0x28` (`KEY_ENTER`) | `0x00` (None) |
| `'\t'` (Tab) | `0x2B` (`KEY_TAB`) | `0x00` (None) |

### 4.2 Timing and Inter-Character Burst Delay
- **Laser Scanner Emulation:** Real laser scanners emit characters with a 4ms to 12ms inter-character delay. 
- Sending keystrokes with 0ms delay will overload ChromeOS JavaScript input event listeners (`onkeydown`, `oninput`), causing dropped digits.
- **Recommended Default:** `8ms` key-press duration followed by `4ms` release delay per character.

---

## 5. ESP32-S3 Firmware Implementation (C++ / Arduino IDE / PlatformIO)

The complete firmware implementation using the Arduino ESP32 core (`v3.x` with native USB support):

```cpp
#include <WiFi.h>
#include <ESPmDNS.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include "USB.h"
#include "USBHIDKeyboard.h"

// Configuration constants
const char* WIFI_SSID     = "CVUSD_Staff_IoT";
const char* WIFI_PASSWORD = "DistrictSecurePassword!";
const char* AUTH_TOKEN    = "cvusd_scanner_secret_token_8971";
const char* MDNS_NAME     = "esp32-scanner-01";

// Peripherals
USBHIDKeyboard Keyboard;
AsyncWebServer server(8080);
AsyncWebSocket ws("/ws");

void executeKeystrokeInjection(const String& id, const String& suffix, int delayMs) {
    if (!USB.ready()) {
        Serial.println("Error: USB host port not mounted.");
        return;
    }
    
    // Safety clamp on delay
    delayMs = constrain(delayMs, 2, 50);

    Serial.printf("Injecting ID: %s (burst delay: %d ms)\n", id.c_str(), delayMs);

    for (size_t i = 0; i < id.length(); i++) {
        char c = id.charAt(i);
        // Only allow safe alphanumeric characters
        if (isAlphaNumeric(c) || c == '-') {
            Keyboard.write(c);
            delay(delayMs);
        }
    }

    // Apply terminator suffix
    if (suffix == "ENTER" || suffix == "\n") {
        Keyboard.press(KEY_RETURN);
        delay(delayMs);
        Keyboard.release(KEY_RETURN);
    } else if (suffix == "TAB" || suffix == "\t") {
        Keyboard.press(KEY_TAB);
        delay(delayMs);
        Keyboard.release(KEY_TAB);
    }
}

void onWebSocketEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, 
                    AwsEventType type, void *arg, uint8_t *data, size_t len) {
    if (type == WS_EVT_DATA) {
        AwsFrameInfo *info = (AwsFrameInfo*)arg;
        if (info->final && info->index == 0 && info->len == len && info->opcode == WS_TEXT) {
            JsonDocument doc;
            DeserializationError err = deserializeJson(doc, (char*)data, len);
            if (err) return;

            const char* token = doc["token"] | "";
            if (strcmp(token, AUTH_TOKEN) != 0) {
                client->text("{\"status\":\"UNAUTHORIZED\"}");
                return;
            }

            const char* action = doc["action"] | "";
            if (strcmp(action, "INJECT") == 0) {
                String studentId = doc["student_id"].as<String>();
                String suffix    = doc["suffix"] | "ENTER";
                int burstDelay   = doc["burst_delay_ms"] | 8;

                executeKeystrokeInjection(studentId, suffix, burstDelay);

                JsonDocument res;
                res["status"] = "SUCCESS";
                res["student_id"] = studentId;
                res["usb_mounted"] = (bool)USB.ready();

                String resStr;
                serializeJson(res, resStr);
                client->text(resStr);
            }
        }
    }
}

void setup() {
    Serial.begin(115200);

    // Initialize Native USB HID Keyboard
    Keyboard.begin();
    USB.begin();

    // Connect to Local Wi-Fi
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    while (WiFi.status() != WL_CONNECTED) {
        delay(250);
        Serial.print(".");
    }
    Serial.printf("\nConnected. IP: %s\n", WiFi.localIP().toString().c_str());

    // Register mDNS
    if (MDNS.begin(MDNS_NAME)) {
        MDNS.addService("scanner-emulator", "tcp", 8080);
        Serial.printf("mDNS responder started: %s.local\n", MDNS_NAME);
    }

    // Configure REST Endpoint
    server.on("/api/v1/inject", HTTP_POST, [](AsyncWebServerRequest *request){}, NULL,
        [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
            if (!request->hasHeader("X-Scanner-Auth") || 
                request->getHeader("X-Scanner-Auth")->value() != AUTH_TOKEN) {
                request->send(401, "application/json", "{\"error\":\"Unauthorized\"}");
                return;
            }

            JsonDocument doc;
            if (deserializeJson(doc, data, len)) {
                request->send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
                return;
            }

            String studentId = doc["student_id"].as<String>();
            String suffix    = doc["suffix"] | "ENTER";
            int burstDelay   = doc["typing_speed_ms"] | 8;

            executeKeystrokeInjection(studentId, suffix, burstDelay);
            request->send(200, "application/json", "{\"status\":\"INJECTED\"}");
        }
    );

    // Configure WebSocket Endpoint
    ws.onEvent(onWebSocketEvent);
    server.addHandler(&ws);

    server.begin();
    Serial.println("HTTP & WebSocket server running on port 8080.");
}

void loop() {
    ws.cleanupClients();
    delay(10);
}
```

---

## 6. Central Dongle Manager Service (Docker Relay)

When multiple classrooms or check-in stations operate simultaneously, a central Node.js/FastAPI broker maintains persistent connections to all dongles.

### 6.1 Docker Deployment (`docker-compose.yml`)
```yaml
version: '3.8'

services:
  dongle-manager:
    image: node:20-alpine
    container_name: edp-dongle-manager
    restart: unless-stopped
    ports:
      - "5050:5050"
    environment:
      - PORT=5050
      - SCANNER_AUTH_TOKEN=cvusd_scanner_secret_token_8971
      - DONGLE_REGISTRY=station-1=esp32-scanner-01.local:8080,station-2=esp32-scanner-02.local:8080
    working_dir: /app
    volumes:
      - ./dongle-relay:/app
    command: npm start
```

### 6.2 Relay Architecture
```
┌────────────────────────┐      POST /inject (station_id: "station-1")     ┌────────────────────────┐
│  Face Recognizer App   │ ──────────────────────────────────────────────> │  Docker Dongle Manager │
└────────────────────────┘                                                 └───────────┬────────────┘
                                                                                       │ WebSocket
                                                                                       ▼ Forward
                                                                           ┌────────────────────────┐
                                                                           │  ESP32-S3 Dongle #1    │
                                                                           └────────────────────────┘
```

---

## 7. Chromebook Inspection & Integration Verification Protocol

Prior to deploying the emulator to a live elementary school front desk, the hardware bridge must be verified against the specific district Chromebook model and web portal:

```
┌────────────────────────────────────────────────────────────────────────┐
│               PRE-DEPLOYMENT VERIFICATION CHECKLIST                    │
├────────────────────────────────────────────────────────────────────────┤
│ [ ] Check 1: USB Device Enumeration on ChromeOS                        │
│ [ ] Check 2: Input Field Focus & Barcode Terminator Inspection         │
│ [ ] Check 3: Burst Rate & JavaScript Event Stress Test (Google Docs)   │
│ [ ] Check 4: QWERTY Keyboard Mapping Verification                      │
│ [ ] Check 5: Chromebook Sleep / Power Cycle Auto-Recovery              │
└────────────────────────────────────────────────────────────────────────┘
```

### Step 1: USB Device Enumeration Inspection
1. Plug the ESP32-S3 into the Chromebook USB-C port.
2. In Chrome, open `chrome://system` or `chrome://device-log`.
3. Filter by **USB** / **HID**.
4. Confirm device enumerates as a recognized HID Keyboard without errors or policy blocks.

### Step 2: Input Field Focus & Terminator Inspection
Different SIS portals expect different keystroke terminators:
1. Open the target attendance web portal on the Chromebook and place the cursor in the student search input field.
2. Trigger a test injection via curl:
   ```bash
   curl -X POST http://esp32-scanner-01.local:8080/api/v1/inject \
     -H "X-Scanner-Auth: cvusd_scanner_secret_token_8971" \
     -H "Content-Type: application/json" \
     -d '{"student_id":"TEST999","suffix":"ENTER","typing_speed_ms":8}'
   ```
3. Observe portal behavior:
   - If the portal submits and loads the student: **Terminator is `Enter`**.
   - If the portal jumps to the next input field without submitting: **Terminator is `Tab`** (change `suffix` to `\t`).
   - If the ID is typed but requires a manual button click: Set `suffix` to `""`.

### Step 3: Burst Speed & Character Loss Stress Test
1. Open a blank Google Doc on the Chromebook.
2. Send a 20-character test alphanumeric string at varying speeds (`4ms`, `8ms`, `12ms`, `20ms`):
   ```bash
   for delay in 4 6 8 10 15; do
     curl -s -X POST http://esp32-scanner-01.local:8080/api/v1/inject \
       -H "X-Scanner-Auth: cvusd_scanner_secret_token_8971" \
       -H "Content-Type: application/json" \
       -d "{\"student_id\":\"SPEEDTEST_1234567890_\$delay\",\"suffix\":\"\\n\",\"typing_speed_ms\":\$delay}"
     sleep 1
   done
   ```
3. Verify that zero characters are dropped or transposed. Select the lowest delay that maintains 100% fidelity (typically **6ms to 8ms**).

### Step 4: Physical Keyboard Scancode Layout Alignment
Confirm that numbers `0–9` and uppercase letters type identical characters regardless of whether the Chromebook's physical keyboard has `Caps Lock` or external regional layouts enabled.

### Step 5: Sleep / Wake & USB Power Cycle Recovery
1. Close the Chromebook lid to initiate sleep mode for 60 seconds.
2. Open the lid and log back into ChromeOS.
3. Verify via `ping esp32-scanner-01.local` that the dongle automatically re-acquired Wi-Fi and the USB descriptor remained mounted without requiring a manual re-plug.