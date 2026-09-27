const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const { createEmulator, sanitizePayload, SCAN_COOLDOWN_MS } = require('../server');

const TOKEN = 'test-token';

async function startEmulator(overrides = {}) {
    const emulator = createEmulator({ authToken: TOKEN, cooldownMs: 0, ...overrides });
    await new Promise(resolve => emulator.server.listen(0, '127.0.0.1', resolve));
    const { port } = emulator.server.address();
    emulator.baseUrl = `http://127.0.0.1:${port}`;
    emulator.wsUrl = `ws://127.0.0.1:${port}/ws`;
    return emulator;
}

async function stopEmulator(emulator) {
    emulator.wss.clients.forEach(c => c.terminate());
    await new Promise(resolve => emulator.wss.close(resolve));
    await new Promise(resolve => emulator.server.close(resolve));
}

function inject(emulator, body, token = TOKEN) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Scanner-Auth'] = token;
    return fetch(`${emulator.baseUrl}/api/v1/inject`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });
}

// Opens a socket and collects every message it receives.
async function openSocket(url) {
    const ws = new WebSocket(url);
    const messages = [];
    const waiters = [];
    ws.on('message', raw => {
        messages.push(JSON.parse(raw));
        waiters.splice(0).forEach(w => w());
    });
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
    ws.next = async (predicate) => {
        for (;;) {
            const idx = messages.findIndex(predicate);
            if (idx !== -1) return messages.splice(idx, 1)[0];
            await new Promise(resolve => waiters.push(resolve));
        }
    };
    return ws;
}

describe('sanitizePayload', () => {
    test('allows only [a-zA-Z0-9-]', () => {
        assert.equal(sanitizePayload('TEST-10042'), 'TEST-10042');
        assert.equal(sanitizePayload('ABC_123'), 'ABC123');
        assert.equal(sanitizePayload('89\t01\n23; <b>'), '890123b');
    });

    test('stringifies numbers and handles missing input', () => {
        assert.equal(sanitizePayload(890123), '890123');
        assert.equal(sanitizePayload(undefined), '');
        assert.equal(sanitizePayload(null), '');
    });

    test('cooldown matches the firmware (250ms)', () => {
        assert.equal(SCAN_COOLDOWN_MS, 250);
    });
});

describe('createEmulator', () => {
    test('refuses to start without an auth token', () => {
        assert.throws(() => createEmulator({ authToken: undefined }), /AUTH_TOKEN must be set/);
    });
});

describe('REST /api/v1/inject', () => {
    let emulator;
    beforeEach(async () => {
        if (emulator) await stopEmulator(emulator);
        emulator = await startEmulator();
    });
    after(async () => stopEmulator(emulator));

    test('200 with status INJECTED on success', async () => {
        const res = await inject(emulator, { student_id: '890123', suffix: 'ENTER', typing_speed_ms: 8 });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.status, 'INJECTED');
        assert.equal(body.result.student_id, '890123');
        assert.equal(body.result.chars_sent, 7);
        assert.equal(body.result.typing_speed_ms, 8);
    });

    test('401 on missing or wrong token', async () => {
        assert.equal((await inject(emulator, { student_id: '1' }, null)).status, 401);
        assert.equal((await inject(emulator, { student_id: '1' }, 'wrong')).status, 401);
    });

    test('400 when student_id is missing', async () => {
        assert.equal((await inject(emulator, {})).status, 400);
    });

    test('400 (not 429) when payload has only invalid characters', async () => {
        const res = await inject(emulator, { student_id: '__!!' });
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /invalid characters/);
    });

    test('400 on an unknown suffix', async () => {
        const res = await inject(emulator, { student_id: '123', suffix: 'ESCAPE' });
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /Invalid suffix/);
    });

    test('400 when typing_speed_ms is not a number', async () => {
        const res = await inject(emulator, { student_id: '123', typing_speed_ms: 'fast' });
        assert.equal(res.status, 400);
    });

    test('accepts TAB and NONE suffixes', async () => {
        const tab = await (await inject(emulator, { student_id: '123', suffix: 'TAB' })).json();
        assert.equal(tab.result.chars_sent, 4);
        const none = await (await inject(emulator, { student_id: '123', suffix: 'NONE' })).json();
        assert.equal(none.result.chars_sent, 3);
    });

    test('clamps typing speed to 2-50ms', async () => {
        const slow = await (await inject(emulator, { student_id: '1', typing_speed_ms: 500 })).json();
        assert.equal(slow.result.typing_speed_ms, 50);
        const fast = await (await inject(emulator, { student_id: '1', typing_speed_ms: 0 })).json();
        assert.equal(fast.result.typing_speed_ms, 2);
    });
});

describe('cooldown', () => {
    let emulator;
    before(async () => { emulator = await startEmulator({ cooldownMs: SCAN_COOLDOWN_MS }); });
    after(async () => stopEmulator(emulator));

    test('429 only for back-to-back scans; invalid payloads do not consume the cooldown', async () => {
        assert.equal((await inject(emulator, { student_id: '!!' })).status, 400);
        assert.equal((await inject(emulator, { student_id: '111' })).status, 200);
        const throttled = await inject(emulator, { student_id: '222' });
        assert.equal(throttled.status, 429);
        assert.match((await throttled.json()).error, /cooldown/);

        await new Promise(r => setTimeout(r, SCAN_COOLDOWN_MS + 20));
        assert.equal((await inject(emulator, { student_id: '333' })).status, 200);
    });
});

describe('USB not mounted', () => {
    let emulator;
    before(async () => { emulator = await startEmulator({ usbMounted: false }); });
    after(async () => stopEmulator(emulator));

    test('503 on inject and usb_mounted=false in status', async () => {
        assert.equal((await inject(emulator, { student_id: '123' })).status, 503);
        const status = await (await fetch(`${emulator.baseUrl}/api/v1/status`)).json();
        assert.equal(status.usb_mounted, false);
    });
});

describe('status, history and UI', () => {
    let emulator;
    before(async () => { emulator = await startEmulator({ stationId: 'station-test' }); });
    after(async () => stopEmulator(emulator));

    test('status and history reflect injections', async () => {
        await inject(emulator, { student_id: 'A1' });
        const status = await (await fetch(`${emulator.baseUrl}/api/v1/status`)).json();
        assert.equal(status.station_id, 'station-test');
        assert.equal(status.usb_mounted, true);
        assert.equal(status.telemetry.total_scans, 1);
        assert.equal(status.telemetry.last_scan.student_id, 'A1');

        const { history } = await (await fetch(`${emulator.baseUrl}/api/v1/history`)).json();
        assert.equal(history.length, 1);
    });

    test('visualizer page does not leak the auth token', async () => {
        const html = await (await fetch(`${emulator.baseUrl}/`)).text();
        assert.ok(html.includes('Virtual ESP32-S3 Scanner Emulator'));
        assert.ok(!html.includes(TOKEN), 'auth token must not appear in served HTML');
    });
});

describe('WebSocket /ws', () => {
    let emulator;
    let ws;
    before(async () => {
        emulator = await startEmulator();
        ws = await openSocket(emulator.wsUrl);
    });
    after(async () => {
        ws.close();
        await stopEmulator(emulator);
    });

    test('sends STATUS on connect', async () => {
        const msg = await ws.next(m => m.type === 'STATUS');
        assert.equal(msg.usb_mounted, true);
    });

    test('INJECT uses typing_speed_ms and replies INJECTED', async () => {
        ws.send(JSON.stringify({ action: 'INJECT', token: TOKEN, student_id: '4455', typing_speed_ms: 12 }));
        const reply = await ws.next(m => m.status);
        assert.equal(reply.status, 'INJECTED');
        assert.equal(reply.injected_id, '4455');

        const event = await ws.next(m => m.type === 'SCAN_INJECTED');
        assert.equal(event.data.typing_speed_ms, 12);
    });

    test('INJECT with a bad token is UNAUTHORIZED', async () => {
        ws.send(JSON.stringify({ action: 'INJECT', token: 'nope', student_id: '1' }));
        const reply = await ws.next(m => m.status);
        assert.deepEqual(reply, { status: 'UNAUTHORIZED', code: 401 });
    });

    test('INJECT validation errors carry the HTTP-equivalent code', async () => {
        ws.send(JSON.stringify({ action: 'INJECT', token: TOKEN, student_id: '1', suffix: 'BOGUS' }));
        const reply = await ws.next(m => m.status);
        assert.equal(reply.status, 'ERROR');
        assert.equal(reply.code, 400);
    });

    test('invalid JSON returns an error instead of crashing', async () => {
        ws.send('not json');
        const reply = await ws.next(m => m.status);
        assert.equal(reply.code, 400);
    });

    test('PING -> PONG', async () => {
        ws.send(JSON.stringify({ action: 'PING' }));
        const reply = await ws.next(m => m.action === 'PONG');
        assert.equal(typeof reply.timestamp, 'number');
    });
});
