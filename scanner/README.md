# ESP32-S3 USB Barcode Scanner Emulator

This directory contains the embedded firmware (**Phase 1**) plus a Docker-based virtual dongle and dongle manager (stand-ins for **Phases 3–4**) from the [Scanner Emulator Implementation Plan](file:///Users/ball/Documents/Projects/Cajon-Valley-EDP-Attendance-App/docs/scanner-emulator.md).

The firmware establishes the **Native USB HID Keyboard / Barcode Scanner Engine** running on the ESP32-S3 microcontroller. It emulates a physical hardware barcode scanner connected to a host computer (Chromebook, Mac, PC, Linux) without requiring external drivers.

---

## Directory Structure

```
scanner/
├── platformio.ini               # PlatformIO build config: 4 firmware targets + native test env
├── README.md                    # This documentation file
├── docker-compose.yml           # Two virtual dongles + dongle manager
├── .env.example                 # Token template; copy to .env (git-ignored)
├── include/
│   ├── config.h                 # VID/PID profiles, pin definitions, timing constants
│   ├── keystroke_engine.h       # HID engine interface, sanitization, telemetry structures
│   └── payload_rules.h          # Pure sanitizer/cooldown/clamp rules (unit tested on host)
├── src/
│   ├── keystroke_engine.cpp     # TinyUSB HID burst injector and rate-limiting logic
│   └── main.cpp                 # Entry point, BOOT button trigger, Serial command listener
├── test/
│   ├── test_payload_rules/      # Unity tests for payload_rules.h (pio test -e native)
│   ├── test_keystroke_timing.py # Host-side timing benchmark (run against real hardware)
│   └── test_timing_analysis.py  # Unit tests for the benchmark's analysis logic
├── emulator/                    # Virtual dongle: REST + WebSocket API, web visualizer
└── manager/                     # Dongle manager: multi-station registry + relay
```

---

## Hardware Connection Requirements

> [!IMPORTANT]
> The ESP32-S3 has **two USB ports**:
> 1. **USB (Native USB OTG)** — Connected directly to GPIO 19 (D-) and GPIO 20 (D+). **Use this port for USB HID emulation!**
> 2. **UART / COM** — Connected to a secondary USB-to-UART chip (CH340/CP2102) for serial debugging only.
>
> To test keystroke injection, plug your USB cable into the **USB / OTG port**.

---

## VID/PID Scanner Profiles

District Chromebooks often have USB peripheral whitelisting enabled. The firmware includes 3 configurable hardware profiles in [`include/config.h`](include/config.h) (`SCANNER_USB_VID` / `SCANNER_USB_PID`):

| Profile | Profile ID | Vendor ID (VID) | Product ID (PID) | Emulated Device |
|---|---|---|---|---|
| **Generic** (Default) | `SCANNER_PROFILE=0` | `0x303A` | `0x8002` | Cajon Valley EDP Scanner |
| **Honeywell** | `SCANNER_PROFILE=1` | `0x0C2E` | `0x0BA1` | Honeywell Xenon 1900 |
| **Zebra** | `SCANNER_PROFILE=2` | `0x05E0` | `0x1200` | Zebra DS2208 Scanner |

---

## Building and Flashing

### Option A: Using PlatformIO (Recommended)

1. Open the project root or `scanner/` directory in VS Code / PlatformIO.
2. Select your desired profile environment:
   ```bash
   # Build & flash default Generic profile
   pio run -e esp32s3_generic -t upload

   # Build & flash Honeywell spoofed profile
   pio run -e esp32s3_honeywell -t upload

   # Build & flash Zebra spoofed profile
   pio run -e esp32s3_zebra -t upload

   # For Seeed Studio XIAO ESP32-S3
   pio run -e seeed_xiao_esp32s3 -t upload
   ```
3. Open the Serial Monitor at **115200 baud**:
   ```bash
   pio device monitor -b 115200
   ```

### Option B: Using Arduino IDE (v2.x)

1. Open Arduino IDE and add ESP32 board support:
   - `Preferences` $\rightarrow$ Additional Board Manager URLs:
     `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
2. Tools menu configuration:
   - **Board:** `ESP32S3 Dev Module`
   - **USB Mode:** `USB-OTG (TinyUSB)`
   - **USB CDC On Boot:** `Enabled`
   - **USB Firmware MSC On Boot:** `Disabled`
   - **Upload Mode:** `UART0 / Hardware CDC`
3. Open `src/main.cpp` (or rename to a `.ino` sketch) and click **Upload**.

---

## Testing & Verification

### 1. Physical Hardware Trigger (BOOT Button)
- Connect the ESP32-S3 Native USB port to your computer.
- Open a blank text document, spreadsheet, or browser address bar.
- Press the physical **BOOT** button (GPIO 0) on the ESP32-S3.
- **Expected Output:** The string `TEST-10042` will type instantly into your active window followed by an `Enter` keystroke.

### 2. Serial Terminal Commands
Open a serial terminal connected to the board at `115200` baud:
- Press `t` + Enter: Injects the test payload (`TEST-10042\n`).
- Type `i:998822` + Enter: Injects custom student ID `998822\n`.
- Press `s` + Enter: Queries USB host mounting status (`READY: YES / NO`).
- Press `h` + Enter: Prints the help banner and active profile information.

### 3. Host Benchmark Test (`test/test_keystroke_timing.py`)
Run the Python benchmark on your host computer:
```bash
python3 scanner/test/test_keystroke_timing.py
```
Focus the terminal and press the ESP32-S3 `BOOT` button. The test harness measures character arrival times down to the millisecond, calculating:
- Total burst duration (ms)
- Average inter-character delay (target: ~8–12ms)
- Terminator detection (`\n` vs `\t`)
- Verification pass/fail status

Only `[a-zA-Z0-9-]` is typed; other characters are stripped. Scans closer than 250 ms apart are rejected.

---

## Automated Tests

```bash
# Firmware rules (sanitizer, cooldown, delay clamp) on the host, no hardware needed
cd scanner && pio test -e native

# Benchmark analysis logic
python3 -m unittest discover -s scanner/test -p 'test_timing_analysis.py'

# Virtual dongle and dongle manager
cd scanner/emulator && npm install && npm test
cd scanner/manager  && npm install && npm test
```

---

## Virtual Dongles & Dongle Manager (Docker)

```bash
cp scanner/.env.example scanner/.env   # then replace both tokens
docker compose -f scanner/docker-compose.yml up -d --build
```

| Service | URL | Notes |
|---|---|---|
| Virtual dongle 1 (Zebra) | http://localhost:8080 | Web visualizer; paste `SCANNER_AUTH_TOKEN` to trigger scans |
| Virtual dongle 2 (Honeywell) | http://localhost:8081 | |
| Dongle manager | http://localhost:5050 | Dashboard; paste `MANAGER_CLIENT_TOKEN` to trigger scans |

Dongle API (`X-Scanner-Auth` header):
- `POST /api/v1/inject` `{student_id, suffix: ENTER|TAB|NONE, typing_speed_ms}` → `200 {"status":"INJECTED"}` · `400` invalid input · `401` bad token · `429` cooldown · `503` USB not mounted
- `GET /api/v1/status`, `GET /api/v1/history`
- `ws://…/ws`: `{action:"INJECT", token, student_id, suffix, typing_speed_ms}` → `{status:"INJECTED"}` or `{status:"ERROR", code}`; `{action:"PING"}` → `PONG`

Manager API:
- `GET /api/v1/dongles`: station status, latency, `usb_mounted`, telemetry
- `POST /api/v1/dongles/:stationId/inject` (requires the `X-Manager-Auth` header) → `relay: SUCCESS | REJECTED | FAILED`, passing through the dongle's HTTP status
- Browser access is limited to `ALLOWED_ORIGINS` (default `http://localhost:3000`)

Set `USB_MOUNTED=false` on an emulator to simulate an unplugged dongle.
