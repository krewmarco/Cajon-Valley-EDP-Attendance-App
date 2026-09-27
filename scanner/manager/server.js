const express = require('express');

const DEFAULT_ALLOWED_ORIGINS = 'http://localhost:3000';

// Format: "station-1=http://scanner-emulator-1:8080,station-2=http://scanner-emulator-2:8080"
function parseRegistry(config) {
    const stations = new Map();
    (config || '').split(',').forEach(pair => {
        const [id, url] = pair.split('=');
        if (id && url) {
            stations.set(id.trim(), {
                id: id.trim(),
                url: url.trim(),
                name: id.trim().replace(/-/g, ' ').toUpperCase(),
                status: 'UNKNOWN',
                usb_mounted: null,
                lastCheck: null,
                telemetry: null
            });
        }
    });
    return stations;
}

function parseOrigins(config) {
    return (config || '').split(',').map(o => o.trim()).filter(Boolean);
}

function configFromEnv(env = process.env) {
    return {
        port: parseInt(env.PORT || '5050', 10),
        // Token the manager presents to each dongle (X-Scanner-Auth)
        dongleToken: env.SCANNER_AUTH_TOKEN,
        // Token clients must present to the manager (X-Manager-Auth)
        clientToken: env.MANAGER_CLIENT_TOKEN,
        registry: env.DONGLE_REGISTRY || '',
        allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS),
        pollIntervalMs: 5000,
        requestTimeoutMs: 2000
    };
}

function createManager(overrides = {}) {
    const config = { ...configFromEnv(), ...overrides };
    if (!config.dongleToken) throw new Error('SCANNER_AUTH_TOKEN must be set');
    if (!config.clientToken) throw new Error('MANAGER_CLIENT_TOKEN must be set');

    const stations = parseRegistry(config.registry);
    let pollTimer = null;

    // Background health checker for registered dongles
    async function pollDongleHealth() {
        await Promise.all(Array.from(stations.values()).map(async station => {
            const start = Date.now();
            try {
                const res = await fetch(`${station.url}/api/v1/status`, {
                    signal: AbortSignal.timeout(config.requestTimeoutMs)
                });

                if (res.ok) {
                    const data = await res.json();
                    station.status = 'ONLINE';
                    station.latency_ms = Date.now() - start;
                    station.usb_mounted = data.usb_mounted ?? null;
                    station.telemetry = data.telemetry;
                    station.profile = data.profile;
                } else {
                    station.status = 'ERROR';
                }
            } catch (err) {
                station.status = 'OFFLINE';
                station.usb_mounted = null;
            }
            station.lastCheck = new Date().toISOString();
        }));
    }

    const app = express();
    app.use(express.json());

    // CORS: only reflect origins that are explicitly allowed
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        res.header('Vary', 'Origin');
        if (origin && config.allowedOrigins.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
            res.header('Access-Control-Allow-Headers', 'Content-Type, X-Manager-Auth');
            res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        }
        if (req.method === 'OPTIONS') return res.sendStatus(origin && config.allowedOrigins.includes(origin) ? 204 : 403);
        next();
    });

    function requireClientAuth(req, res, next) {
        if (req.headers['x-manager-auth'] !== config.clientToken) {
            console.log(`[RELAY] ${req.params.stationId} -> 401 (${req.headers['x-manager-auth'] ? 'wrong' : 'missing'} X-Manager-Auth)`);
            return res.status(401).json({ error: 'Unauthorized: Invalid or missing X-Manager-Auth token' });
        }
        next();
    }

    // List all registered stations
    app.get('/api/v1/dongles', (req, res) => {
        const list = Array.from(stations.values());
        res.json({
            total_stations: list.length,
            online_stations: list.filter(s => s.status === 'ONLINE').length,
            stations: list
        });
    });

    // Relay injection to a specific station
    app.post('/api/v1/dongles/:stationId/inject', requireClientAuth, async (req, res) => {
        const stationId = req.params.stationId;
        const station = stations.get(stationId);

        if (!station) {
            console.log(`[RELAY] ${stationId} -> 404 (not in DONGLE_REGISTRY)`);
            return res.status(404).json({ error: `Station '${stationId}' not found in registry.` });
        }

        const { student_id, suffix = 'ENTER', typing_speed_ms = 8 } = req.body || {};
        if (!student_id) {
            return res.status(400).json({ error: 'Missing student_id' });
        }

        let forwardRes;
        try {
            forwardRes = await fetch(`${station.url}/api/v1/inject`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Scanner-Auth': config.dongleToken
                },
                body: JSON.stringify({ student_id, suffix, typing_speed_ms }),
                signal: AbortSignal.timeout(config.requestTimeoutMs)
            });
        } catch (err) {
            console.log(`[RELAY] ${stationId} student=${student_id} -> FAILED (${err.message})`);
            return res.status(502).json({
                relay: 'FAILED',
                station_id: stationId,
                error: `Failed to communicate with dongle at ${station.url}: ${err.message}`
            });
        }

        const text = await forwardRes.text();
        console.log(`[RELAY] ${stationId} student=${student_id} suffix=${suffix} -> ${forwardRes.ok ? 'SUCCESS' : 'REJECTED'} (dongle HTTP ${forwardRes.status})`);
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            data = { raw: text };
        }

        return res.status(forwardRes.status).json({
            relay: forwardRes.ok ? 'SUCCESS' : 'REJECTED',
            station_id: stationId,
            dongle_response: data
        });
    });

    // Built-in Manager Dashboard (client-rendered; polls /api/v1/dongles)
    app.get('/', (req, res) => {
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>EDP Dongle Manager — Central Station Relay</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    body { background: #0f172a; color: #f8fafc; font-family: 'Inter', sans-serif; padding: 24px; margin: 0; }
    .container { max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
    header { background: #1e293b; padding: 20px; border-radius: 16px; border: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    .station-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
    .badge { padding: 4px 10px; border-radius: 9999px; font-size: 11px; font-weight: 700; }
    .badge-online { background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid #10b981; }
    .badge-offline { background: rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid #ef4444; }
    .btn { padding: 8px 14px; border-radius: 8px; border: none; background: #3b82f6; color: white; font-weight: 600; cursor: pointer; font-size: 13px; }
    .btn:hover { background: #2563eb; }
    input { background:#0f172a; border:1px solid #334155; color:white; padding:8px 10px; border-radius:8px; font-family:'JetBrains Mono', monospace; font-size:12px; }
    code { font-family: 'JetBrains Mono', monospace; color: #38bdf8; font-size: 12px; }
    .meta { font-size: 12px; color: #94a3b8; display:flex; flex-direction:column; gap:4px; }
    .result { font-size: 12px; min-height: 16px; }
    .result.ok { color: #10b981; }
    .result.err { color: #f59e0b; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1 style="font-size: 20px; font-weight: 800; margin: 0;">Central Dongle Manager Relay</h1>
        <p id="summary" style="font-size: 13px; color: #94a3b8; margin: 4px 0 0;">Loading stations…</p>
      </div>
      <input type="password" id="clientToken" placeholder="X-Manager-Auth token" autocomplete="off">
    </header>
    <div class="station-grid" id="stations"></div>
  </div>

  <template id="stationTemplate">
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h2 data-field="name" style="font-size: 16px; margin: 0;"></h2>
        <span data-field="status" class="badge"></span>
      </div>
      <div class="meta">
        <div>Target URL: <code data-field="url"></code></div>
        <div>Profile: <strong data-field="profile"></strong></div>
        <div>USB Mounted: <strong data-field="usb"></strong></div>
        <div>Latency: <strong data-field="latency"></strong></div>
        <div>Total Scans: <strong data-field="scans"></strong></div>
      </div>
      <div style="display:flex; gap: 8px; margin-top: 8px;">
        <input type="text" data-field="input" value="TEST-10042" style="flex:1;">
        <button class="btn" data-field="button">Test Scan</button>
      </div>
      <div class="result" data-field="result"></div>
    </div>
  </template>

  <script>
    const tokenInput = document.getElementById('clientToken');
    try { tokenInput.value = sessionStorage.getItem('managerClientToken') || ''; } catch (e) {}
    tokenInput.addEventListener('change', () => {
      try { sessionStorage.setItem('managerClientToken', tokenInput.value); } catch (e) {}
    });

    const cards = new Map();

    function field(card, name) { return card.querySelector('[data-field="' + name + '"]'); }

    function createCard(station) {
      const card = document.getElementById('stationTemplate').content.firstElementChild.cloneNode(true);
      field(card, 'button').addEventListener('click', () => injectTest(station.id, card));
      document.getElementById('stations').appendChild(card);
      cards.set(station.id, card);
      return card;
    }

    function render(data) {
      document.getElementById('summary').textContent =
        data.online_stations + ' of ' + data.total_stations + ' station(s) online';
      for (const s of data.stations) {
        const card = cards.get(s.id) || createCard(s);
        field(card, 'name').textContent = s.name;
        const status = field(card, 'status');
        status.textContent = s.status;
        status.className = 'badge ' + (s.status === 'ONLINE' ? 'badge-online' : 'badge-offline');
        field(card, 'url').textContent = s.url;
        field(card, 'profile').textContent = s.profile ? s.profile.name : 'Unknown';
        field(card, 'usb').textContent = s.usb_mounted === null ? 'Unknown' : (s.usb_mounted ? 'Yes' : 'No');
        field(card, 'latency').textContent = s.latency_ms ? s.latency_ms + 'ms' : 'N/A';
        field(card, 'scans').textContent = s.telemetry ? s.telemetry.total_scans : 0;
      }
    }

    async function refresh() {
      try {
        const res = await fetch('/api/v1/dongles');
        render(await res.json());
      } catch (err) {
        document.getElementById('summary').textContent = 'Manager unreachable: ' + err.message;
      }
    }

    async function injectTest(stationId, card) {
      const result = field(card, 'result');
      const studentId = field(card, 'input').value;
      result.className = 'result';
      result.textContent = 'Sending…';
      try {
        const res = await fetch('/api/v1/dongles/' + encodeURIComponent(stationId) + '/inject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Manager-Auth': tokenInput.value },
          body: JSON.stringify({ student_id: studentId, suffix: 'ENTER' })
        });
        const data = await res.json();
        if (data.relay === 'SUCCESS') {
          result.className = 'result ok';
          result.textContent = 'Injected ' + studentId;
        } else {
          const detail = data.error || (data.dongle_response && data.dongle_response.error) || res.statusText;
          result.className = 'result err';
          result.textContent = res.status + ': ' + detail;
        }
      } catch (err) {
        result.className = 'result err';
        result.textContent = 'Relay error: ' + err.message;
      }
    }

    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`);
    });

    function start() {
        pollDongleHealth();
        pollTimer = setInterval(pollDongleHealth, config.pollIntervalMs);
    }

    function stop() {
        clearInterval(pollTimer);
        pollTimer = null;
    }

    return { app, stations, config, pollDongleHealth, start, stop };
}

module.exports = { createManager, parseRegistry, parseOrigins };

if (require.main === module) {
    let manager;
    try {
        manager = createManager();
    } catch (err) {
        console.error(`[MANAGER] ${err.message}`);
        process.exit(1);
    }
    const { app, config, stations, start } = manager;
    start();
    app.listen(config.port, '0.0.0.0', () => {
        console.log(`=======================================================`);
        console.log(`  Central Dongle Manager Service Running              `);
        console.log(`  Port:      http://localhost:${config.port}           `);
        console.log(`  Stations:  ${stations.size} configured               `);
        console.log(`  Origins:   ${config.allowedOrigins.join(', ')}       `);
        console.log(`=======================================================`);
    });
}
