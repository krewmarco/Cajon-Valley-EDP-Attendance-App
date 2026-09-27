const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// Mirrors the firmware rules in scanner/include/config.h and payload_rules.h
const SCAN_COOLDOWN_MS = 250;
const MIN_BURST_DELAY_MS = 2;
const MAX_BURST_DELAY_MS = 50;
const VALID_SUFFIXES = ['ENTER', 'TAB', 'NONE'];

class InjectionError extends Error {
    constructor(httpStatus, message) {
        super(message);
        this.httpStatus = httpStatus;
    }
}

function sanitizeRequestId(raw) {
    if (typeof raw !== 'string') return null;
    return raw.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || null;
}

function sanitizePayload(raw) {
    if (raw === undefined || raw === null) return '';
    return String(raw).replace(/[^a-zA-Z0-9-]/g, '');
}

function configFromEnv(env = process.env) {
    return {
        port: parseInt(env.PORT || '8080', 10),
        stationId: env.STATION_ID || 'station-alpha-1',
        authToken: env.AUTH_TOKEN,
        profileName: env.PROFILE_NAME || 'Zebra DS2208 Barcode Scanner',
        usbVid: env.USB_VID || '0x05E0',
        usbPid: env.USB_PID || '0x1200',
        defaultBurstDelayMs: parseInt(env.DEFAULT_BURST_DELAY_MS || '8', 10),
        usbMounted: env.USB_MOUNTED !== 'false',
        cooldownMs: SCAN_COOLDOWN_MS
    };
}

function createEmulator(overrides = {}) {
    const config = { ...configFromEnv(), ...overrides };
    if (!config.authToken) {
        throw new Error('AUTH_TOKEN must be set');
    }

    const {
        stationId: STATION_ID,
        authToken: AUTH_TOKEN,
        profileName: PROFILE_NAME,
        usbVid: USB_VID,
        usbPid: USB_PID,
        defaultBurstDelayMs: DEFAULT_BURST_DELAY_MS
    } = config;

    const app = express();
    app.use(express.json());

    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server, path: '/ws' });

    // State
    let lastInjectionTime = 0;
    let totalScans = 0;
    let lastScanEvent = null;
    const scanHistory = [];

    async function simulateBurstKeystroke(payload, suffix = 'ENTER', delayMs = DEFAULT_BURST_DELAY_MS, requestId = null) {
        if (!VALID_SUFFIXES.includes(suffix)) {
            throw new InjectionError(400, `Invalid suffix '${suffix}'; expected one of ${VALID_SUFFIXES.join(', ')}`);
        }
        if (typeof delayMs !== 'number' || !Number.isFinite(delayMs)) {
            throw new InjectionError(400, 'typing_speed_ms must be a number');
        }

        const cleanId = sanitizePayload(payload);
        if (!cleanId) {
            throw new InjectionError(400, 'Payload is empty or contained only invalid characters');
        }

        if (!config.usbMounted) {
            throw new InjectionError(503, 'USB Host not mounted or not ready');
        }

        const now = Date.now();
        if (lastInjectionTime !== 0 && now - lastInjectionTime < config.cooldownMs) {
            throw new InjectionError(429, 'Rate limit cooldown active');
        }
        lastInjectionTime = now;

        const clampedDelay = Math.max(MIN_BURST_DELAY_MS, Math.min(MAX_BURST_DELAY_MS, delayMs));

        // Simulate key delays
        const totalSimulatedDuration = (cleanId.length * clampedDelay) + (suffix !== 'NONE' ? clampedDelay : 0);
        await new Promise(r => setTimeout(r, Math.min(totalSimulatedDuration, 30)));

        totalScans++;

        const scanEvent = {
            id: `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            station_id: STATION_ID,
            request_id: requestId,
            student_id: cleanId,
            suffix: suffix,
            typing_speed_ms: clampedDelay,
            chars_sent: cleanId.length + (suffix !== 'NONE' ? 1 : 0),
            elapsed_ms: Math.round(totalSimulatedDuration),
            timestamp: new Date().toISOString(),
            usb_mounted: config.usbMounted,
            profile: PROFILE_NAME
        };

        lastScanEvent = scanEvent;
        scanHistory.unshift(scanEvent);
        if (scanHistory.length > 50) scanHistory.pop();

        // Broadcast to all WebSocket subscribers (UI visualizer & managers)
        broadcastWebSocket({
            type: 'SCAN_INJECTED',
            data: scanEvent
        });

        console.log(`[EMULATOR] req=${requestId ?? '-'} Injected ID: ${cleanId} (${scanEvent.chars_sent} chars, ${scanEvent.elapsed_ms}ms, suffix: ${suffix})`);
        return scanEvent;
    }

    function broadcastWebSocket(msg) {
        const data = JSON.stringify(msg);
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });
    }

    // REST API Endpoints
    app.post('/api/v1/inject', async (req, res) => {
        const authHeader = req.headers['x-scanner-auth'];
        if (!authHeader || authHeader !== AUTH_TOKEN) {
            return res.status(401).json({ error: 'Unauthorized: Invalid or missing X-Scanner-Auth token' });
        }

        const { student_id, suffix = 'ENTER', typing_speed_ms = DEFAULT_BURST_DELAY_MS } = req.body || {};
        if (!student_id) {
            return res.status(400).json({ error: 'Missing student_id' });
        }

        try {
            const result = await simulateBurstKeystroke(student_id, suffix, typing_speed_ms, sanitizeRequestId(req.headers['x-request-id']));
            return res.status(200).json({
                status: 'INJECTED',
                message: 'Keystrokes injected into host',
                result
            });
        } catch (err) {
            return res.status(err.httpStatus || 500).json({ error: err.message });
        }
    });

    app.get('/api/v1/status', (req, res) => {
        res.json({
            station_id: STATION_ID,
            status: 'ONLINE',
            usb_mounted: config.usbMounted,
            profile: {
                name: PROFILE_NAME,
                vid: USB_VID,
                pid: USB_PID
            },
            telemetry: {
                total_scans: totalScans,
                last_scan: lastScanEvent,
                uptime_seconds: Math.round(process.uptime()),
                connected_clients: wss.clients.size
            }
        });
    });

    app.get('/api/v1/history', (req, res) => {
        res.json({ history: scanHistory });
    });

    // WebSocket Handling
    wss.on('connection', (ws) => {
        // Send initial status
        ws.send(JSON.stringify({
            type: 'STATUS',
            station_id: STATION_ID,
            profile: PROFILE_NAME,
            total_scans: totalScans,
            usb_mounted: config.usbMounted
        }));

        ws.on('message', async (message) => {
            let data;
            try {
                data = JSON.parse(message);
            } catch (err) {
                return ws.send(JSON.stringify({ status: 'ERROR', code: 400, message: 'Invalid JSON' }));
            }

            if (data.action === 'INJECT') {
                if (data.token !== AUTH_TOKEN) {
                    return ws.send(JSON.stringify({ status: 'UNAUTHORIZED', code: 401 }));
                }

                try {
                    const result = await simulateBurstKeystroke(
                        data.student_id,
                        data.suffix || 'ENTER',
                        data.typing_speed_ms ?? DEFAULT_BURST_DELAY_MS,
                        sanitizeRequestId(data.request_id)
                    );

                    ws.send(JSON.stringify({
                        status: 'INJECTED',
                        injected_id: result.student_id,
                        chars_sent: result.chars_sent,
                        elapsed_ms: result.elapsed_ms,
                        usb_mounted: result.usb_mounted
                    }));
                } catch (err) {
                    ws.send(JSON.stringify({ status: 'ERROR', code: err.httpStatus || 500, message: err.message }));
                }
            } else if (data.action === 'PING') {
                ws.send(JSON.stringify({ action: 'PONG', timestamp: Date.now() }));
            }
        });
    });

    // Built-in Web Visualizer UI
    app.get('/', (req, res) => {
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ESP32-S3 Scanner Emulator — Station: ${STATION_ID}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;800&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --accent: #38bdf8;
      --success: #10b981;
      --warning: #f59e0b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      padding: 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
    }
    .container { width: 100%; max-width: 900px; display: flex; flex-direction: column; gap: 20px; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 700;
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      border: 1px solid var(--success);
    }
    .badge.unmounted {
      background: rgba(245, 158, 11, 0.15);
      color: var(--warning);
      border-color: var(--warning);
    }
    .badge.pulse::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 8px currentColor;
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    h2 { font-size: 16px; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: 0.5px; }
    .device-box {
      border: 2px dashed #475569;
      border-radius: 12px;
      padding: 20px;
      background: #090d16;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      position: relative;
    }
    .led {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #334155;
      transition: background 0.1s, box-shadow 0.1s;
    }
    .led.active {
      background: #10b981;
      box-shadow: 0 0 16px #10b981, 0 0 24px #10b981;
    }
    .btn {
      padding: 12px 20px;
      border-radius: 10px;
      border: none;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.15s ease;
    }
    .btn-primary { background: #3b82f6; color: white; }
    .btn-primary:hover { background: #2563eb; }
    .btn-trigger {
      background: #8b5cf6;
      color: white;
      width: 100%;
      padding: 14px;
      font-size: 15px;
      box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
    }
    .btn-trigger:hover { background: #7c3aed; }
    .input-group { display: flex; gap: 8px; }
    input {
      flex: 1;
      padding: 12px 14px;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: white;
      font-family: 'JetBrains Mono', monospace;
      font-size: 14px;
      outline: none;
    }
    input:focus { border-color: var(--accent); }
    .chromebook-preview {
      background: #000;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 16px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      min-height: 100px;
      color: #38bdf8;
      display: flex;
      flex-direction: column;
      gap: 8px;
      overflow-y: auto;
    }
    .history-list {
      max-height: 250px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .history-item {
      padding: 10px 12px;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .sound-toggle {
      font-size: 12px;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .inject-error { font-size: 12px; color: var(--warning); min-height: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1 style="font-size: 18px; font-weight: 800;">Virtual ESP32-S3 Scanner Emulator</h1>
        <p style="font-size: 12px; color: var(--text-muted);">Station: <strong style="color:var(--text);">${STATION_ID}</strong> • Profile: <strong style="color:var(--accent);">${PROFILE_NAME}</strong></p>
      </div>
      <div style="display: flex; gap: 12px; align-items: center;">
        <label class="sound-toggle">
          <input type="checkbox" id="soundToggle" checked> Laser Beep
        </label>
        <span class="badge pulse${config.usbMounted ? '' : ' unmounted'}">${config.usbMounted ? 'USB HID MOUNTED' : 'USB NOT MOUNTED'}</span>
      </div>
    </header>

    <div class="grid">
      <!-- Device Simulation Box -->
      <div class="card">
        <h2>Hardware Simulation (ESP32-S3)</h2>
        <div class="device-box">
          <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
            <span style="font-size: 11px; color:#64748b; font-family:'JetBrains Mono'">USB VID: ${USB_VID} | PID: ${USB_PID}</span>
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:10px; color:#64748b;">LED</span>
              <div id="ledIndicator" class="led"></div>
            </div>
          </div>
          <div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 13px;">
            Simulating native TinyUSB keyboard burst typing with ${DEFAULT_BURST_DELAY_MS}ms inter-character delay.
          </div>
          <button id="btnHardwareTrigger" class="btn btn-trigger">
            ⚡ Press Virtual BOOT Button
          </button>
        </div>

        <div>
          <label style="font-size: 12px; color: var(--text-muted); margin-bottom: 6px; display: block;">Scanner Auth Token (X-Scanner-Auth):</label>
          <input type="password" id="authToken" placeholder="Paste AUTH_TOKEN" autocomplete="off" style="width:100%;">
        </div>

        <div>
          <label style="font-size: 12px; color: var(--text-muted); margin-bottom: 6px; display: block;">Inject Custom Barcode / Student ID:</label>
          <div class="input-group">
            <input type="text" id="customStudentId" placeholder="e.g. 10087" value="10087">
            <button id="btnInjectCustom" class="btn btn-primary">Inject</button>
          </div>
          <div id="injectError" class="inject-error"></div>
        </div>
      </div>

      <!-- Chromebook Input Monitor -->
      <div class="card">
        <h2>Chromebook Host Active Input Stream</h2>
        <div class="chromebook-preview" id="screenMonitor">
          <div style="color: #64748b;">[Ready for USB HID keystrokes...]</div>
        </div>

        <div style="font-size: 12px; color: var(--text-muted); display:flex; justify-content:space-between;">
          <span>Total Scans: <strong id="totalScansCounter" style="color:white">${totalScans}</strong></span>
          <span>REST API: <code style="color:var(--accent)">POST /api/v1/inject</code></span>
        </div>
      </div>
    </div>

    <!-- Scan History Log -->
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2>Real-Time Scan Event Log</h2>
        <span style="font-size: 12px; color: var(--text-muted);">WebSocket: <code>/ws</code></span>
      </div>
      <div class="history-list" id="historyList">
        <div style="color: #64748b; font-size: 13px; text-align: center; padding: 20px;">No scan events yet. Trigger a scan above or via REST API.</div>
      </div>
    </div>
  </div>

  <script>
    // Web Audio API Laser Scanner Beep Synth
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    function playScannerBeep() {
      if (!document.getElementById('soundToggle').checked) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(2600, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.08);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.08);
    }

    const led = document.getElementById('ledIndicator');
    const screenMonitor = document.getElementById('screenMonitor');
    const historyList = document.getElementById('historyList');
    const totalScansCounter = document.getElementById('totalScansCounter');
    const authTokenInput = document.getElementById('authToken');
    const injectError = document.getElementById('injectError');

    // The token is entered by the operator and kept only in this tab's session.
    try { authTokenInput.value = sessionStorage.getItem('scannerAuthToken') || ''; } catch (e) {}
    authTokenInput.addEventListener('change', () => {
      try { sessionStorage.setItem('scannerAuthToken', authTokenInput.value); } catch (e) {}
    });

    function flashLed() {
      led.classList.add('active');
      setTimeout(() => led.classList.remove('active'), 250);
    }

    function appendScreenLog(studentId, suffix, elapsedMs) {
      const line = document.createElement('div');
      line.innerHTML = '<span style="color:#64748b;">[' + new Date().toLocaleTimeString() + ']</span> ' +
                       '<span style="color:#10b981; font-weight:700;">SCAN:</span> ' +
                       '<strong>' + studentId + '</strong>' +
                       (suffix === 'ENTER' ? ' <span style="color:#a855f7;">[ENTER]</span>' : '') +
                       ' <span style="color:#64748b; font-size:11px;">(' + elapsedMs + 'ms)</span>';
      screenMonitor.appendChild(line);
      screenMonitor.scrollTop = screenMonitor.scrollHeight;
    }

    function addHistoryItem(event) {
      if (historyList.children.length === 1 && historyList.children[0].innerText.includes('No scan events')) {
        historyList.innerHTML = '';
      }
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = '<div>' +
                       '<span style="color:var(--accent); font-weight:700;">' + event.student_id + '</span> ' +
                       '<span style="color:#64748b;">(Suffix: ' + event.suffix + ')</span>' +
                       '</div>' +
                       '<div style="color:var(--text-muted); font-size:11px;">' +
                       event.elapsed_ms + 'ms • ' + new Date(event.timestamp).toLocaleTimeString() +
                       '</div>';
      historyList.insertBefore(item, historyList.firstChild);
    }

    // Connect WebSocket
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsProto + '//' + window.location.host + '/ws');

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'SCAN_INJECTED') {
        flashLed();
        playScannerBeep();
        appendScreenLog(msg.data.student_id, msg.data.suffix, msg.data.elapsed_ms);
        addHistoryItem(msg.data);
        const curr = parseInt(totalScansCounter.innerText, 10) || 0;
        totalScansCounter.innerText = curr + 1;
      }
    };

    async function inject(studentId) {
      injectError.textContent = '';
      const res = await fetch('/api/v1/inject', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Scanner-Auth': authTokenInput.value
        },
        body: JSON.stringify({ student_id: studentId, suffix: 'ENTER' })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        injectError.textContent = res.status + ': ' + (body.error || res.statusText);
      }
    }

    // Button triggers
    document.getElementById('btnHardwareTrigger').addEventListener('click', () => inject('TEST-10042'));

    document.getElementById('btnInjectCustom').addEventListener('click', () => {
      const id = document.getElementById('customStudentId').value.trim();
      if (id) inject(id);
    });
  </script>
</body>
</html>`);
    });

    return { app, server, wss, config };
}

module.exports = { createEmulator, sanitizePayload, SCAN_COOLDOWN_MS };

if (require.main === module) {
    let emulator;
    try {
        emulator = createEmulator();
    } catch (err) {
        console.error(`[EMULATOR] ${err.message}`);
        process.exit(1);
    }
    const { server, config } = emulator;
    server.listen(config.port, '0.0.0.0', () => {
        console.log(`=======================================================`);
        console.log(`  Virtual ESP32-S3 USB Barcode Scanner Emulator        `);
        console.log(`  Station ID: ${config.stationId}                      `);
        console.log(`  Profile:    ${config.profileName}                    `);
        console.log(`  Server:     http://localhost:${config.port}          `);
        console.log(`  WebSocket:  ws://localhost:${config.port}/ws         `);
        console.log(`=======================================================`);
    });
}
