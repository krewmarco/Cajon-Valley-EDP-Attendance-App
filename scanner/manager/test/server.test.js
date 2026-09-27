const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { createManager, parseRegistry, parseOrigins } = require('../server');

const DONGLE_TOKEN = 'dongle-token';
const CLIENT_TOKEN = 'client-token';
const APP_ORIGIN = 'http://localhost:3000';

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${server.address().port}`);
    }));
}

// Minimal stand-in for a dongle whose inject response each test controls.
function createFakeDongle() {
    const dongle = {
        requests: [],
        injectResponse: { status: 200, body: JSON.stringify({ status: 'INJECTED' }) },
        statusBody: { usb_mounted: true, profile: { name: 'Fake' }, telemetry: { total_scans: 3 } }
    };
    dongle.server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            dongle.requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
            if (req.url === '/api/v1/status') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(dongle.statusBody));
            }
            res.writeHead(dongle.injectResponse.status, { 'Content-Type': 'application/json' });
            res.end(dongle.injectResponse.body);
        });
    });
    return dongle;
}

describe('parsers', () => {
    test('parseRegistry reads id=url pairs', () => {
        const stations = parseRegistry('a-1=http://x:1, b=http://y:2,broken');
        assert.deepEqual([...stations.keys()], ['a-1', 'b']);
        assert.equal(stations.get('a-1').url, 'http://x:1');
        assert.equal(stations.get('a-1').name, 'A 1');
    });

    test('parseOrigins trims and drops empties', () => {
        assert.deepEqual(parseOrigins(' http://a , ,http://b'), ['http://a', 'http://b']);
    });
});

describe('createManager', () => {
    test('requires both tokens', () => {
        assert.throws(() => createManager({ dongleToken: undefined, clientToken: 'x' }), /SCANNER_AUTH_TOKEN/);
        assert.throws(() => createManager({ dongleToken: 'x', clientToken: undefined }), /MANAGER_CLIENT_TOKEN/);
    });
});

describe('relay', () => {
    let dongle, dongleUrl, managerServer, baseUrl, manager;

    before(async () => {
        dongle = createFakeDongle();
        dongleUrl = await listen(dongle.server);
        manager = createManager({
            dongleToken: DONGLE_TOKEN,
            clientToken: CLIENT_TOKEN,
            registry: `station-1=${dongleUrl},station-dead=http://127.0.0.1:1`,
            allowedOrigins: [APP_ORIGIN],
            requestTimeoutMs: 500
        });
        managerServer = http.createServer(manager.app);
        baseUrl = await listen(managerServer);
    });

    after(async () => {
        await new Promise(r => managerServer.close(r));
        await new Promise(r => dongle.server.close(r));
    });

    beforeEach(() => {
        dongle.requests = [];
        dongle.injectResponse = { status: 200, body: JSON.stringify({ status: 'INJECTED' }) };
    });

    function relayInject(stationId, body, token = CLIENT_TOKEN) {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['X-Manager-Auth'] = token;
        return fetch(`${baseUrl}/api/v1/dongles/${stationId}/inject`, {
            method: 'POST', headers, body: JSON.stringify(body)
        });
    }

    test('401 without a client token, and nothing is forwarded', async () => {
        assert.equal((await relayInject('station-1', { student_id: '1' }, null)).status, 401);
        assert.equal((await relayInject('station-1', { student_id: '1' }, 'wrong')).status, 401);
        assert.equal(dongle.requests.length, 0);
    });

    test('forwards with the dongle token and reports SUCCESS', async () => {
        const res = await relayInject('station-1', { student_id: '890123', suffix: 'TAB', typing_speed_ms: 10 });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.relay, 'SUCCESS');
        assert.equal(body.dongle_response.status, 'INJECTED');

        const [forwarded] = dongle.requests;
        assert.equal(forwarded.headers['x-scanner-auth'], DONGLE_TOKEN);
        assert.equal(forwarded.headers['x-manager-auth'], undefined);
        assert.deepEqual(JSON.parse(forwarded.body), { student_id: '890123', suffix: 'TAB', typing_speed_ms: 10 });
    });

    test('dongle rejection is reported as REJECTED with the dongle status', async () => {
        for (const status of [401, 429, 503]) {
            dongle.injectResponse = { status, body: JSON.stringify({ error: 'nope' }) };
            const res = await relayInject('station-1', { student_id: '1' });
            assert.equal(res.status, status);
            const body = await res.json();
            assert.equal(body.relay, 'REJECTED');
            assert.equal(body.dongle_response.error, 'nope');
        }
    });

    test('non-JSON dongle response does not become a 502', async () => {
        dongle.injectResponse = { status: 500, body: 'Internal Server Error' };
        const res = await relayInject('station-1', { student_id: '1' });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.relay, 'REJECTED');
        assert.equal(body.dongle_response.raw, 'Internal Server Error');
    });

    test('502 FAILED when the dongle is unreachable', async () => {
        const res = await relayInject('station-dead', { student_id: '1' });
        assert.equal(res.status, 502);
        assert.equal((await res.json()).relay, 'FAILED');
    });

    test('404 for unknown station, 400 for missing student_id', async () => {
        assert.equal((await relayInject('nope', { student_id: '1' })).status, 404);
        assert.equal((await relayInject('station-1', {})).status, 400);
    });

    test('health poll marks stations ONLINE/OFFLINE and surfaces usb_mounted', async () => {
        await manager.pollDongleHealth();
        const data = await (await fetch(`${baseUrl}/api/v1/dongles`)).json();
        assert.equal(data.total_stations, 2);
        assert.equal(data.online_stations, 1);

        const byId = Object.fromEntries(data.stations.map(s => [s.id, s]));
        assert.equal(byId['station-1'].status, 'ONLINE');
        assert.equal(byId['station-1'].usb_mounted, true);
        assert.equal(byId['station-1'].telemetry.total_scans, 3);
        assert.equal(byId['station-dead'].status, 'OFFLINE');
        assert.equal(byId['station-dead'].usb_mounted, null);
    });

    test('CORS allows only configured origins', async () => {
        const allowed = await fetch(`${baseUrl}/api/v1/dongles`, { headers: { Origin: APP_ORIGIN } });
        assert.equal(allowed.headers.get('access-control-allow-origin'), APP_ORIGIN);

        const denied = await fetch(`${baseUrl}/api/v1/dongles`, { headers: { Origin: 'http://evil.example' } });
        assert.equal(denied.headers.get('access-control-allow-origin'), null);

        const preflightOk = await fetch(`${baseUrl}/api/v1/dongles/station-1/inject`, {
            method: 'OPTIONS', headers: { Origin: APP_ORIGIN }
        });
        assert.equal(preflightOk.status, 204);
        assert.match(preflightOk.headers.get('access-control-allow-headers'), /X-Manager-Auth/);
        assert.match(preflightOk.headers.get('access-control-allow-headers'), /X-Request-Id/);

        const preflightBad = await fetch(`${baseUrl}/api/v1/dongles/station-1/inject`, {
            method: 'OPTIONS', headers: { Origin: 'http://evil.example' }
        });
        assert.equal(preflightBad.status, 403);
    });

    test('passes the client X-Request-Id to the dongle, logs it, and returns it', async () => {
        const logs = [];
        const original = console.log;
        console.log = (...args) => logs.push(args.join(' '));
        try {
            const res = await fetch(`${baseUrl}/api/v1/dongles/station-1/inject`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Manager-Auth': CLIENT_TOKEN, 'X-Request-Id': 'abc-123' },
                body: JSON.stringify({ student_id: '1' })
            });
            assert.equal((await res.json()).request_id, 'abc-123');
        } finally {
            console.log = original;
        }
        assert.equal(dongle.requests[0].headers['x-request-id'], 'abc-123');
        assert.ok(logs.some(l => l.includes('req=abc-123') && l.includes('SUCCESS')), logs.join('\n'));
    });

    test('sanitizes a hostile X-Request-Id and generates one when missing', async () => {
        const original = console.log;
        console.log = () => {};
        try {
            const hostile = await fetch(`${baseUrl}/api/v1/dongles/station-1/inject`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Manager-Auth': CLIENT_TOKEN, 'X-Request-Id': 'a;b\\nFAKE LOG' },
                body: JSON.stringify({ student_id: '1' })
            });
            assert.equal((await hostile.json()).request_id, 'abnFAKELOG');

            const missing = await relayInject('station-1', { student_id: '1' });
            assert.match((await missing.json()).request_id, /^[0-9a-f-]{36}$/);
        } finally {
            console.log = original;
        }
    });

    test('dashboard does not embed any token and does not use alert()', async () => {
        const html = await (await fetch(`${baseUrl}/`)).text();
        assert.ok(!html.includes(CLIENT_TOKEN));
        assert.ok(!html.includes(DONGLE_TOKEN));
        assert.ok(!html.includes('alert('));
    });
});
