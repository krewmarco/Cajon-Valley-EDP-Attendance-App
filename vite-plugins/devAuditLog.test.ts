import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalAuditProvider } from '../src/services/audit/localAuditProvider';
import { createDevLogHandler, devAuditLog, readDevAuditLog } from './devAuditLog';

let dir: string;
let logFile: string;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-audit-'));
    logFile = path.join(dir, 'nested', 'dev-audit.jsonl');
    const handler = createDevLogHandler(logFile);
    server = http.createServer((req, res) => { void handler(req, res); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => fs.rmSync(logFile, { force: true }));

const post = (body: string) => fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

describe('dev audit log endpoint', () => {
    it('appends each event as a JSON line with received_at, creating the directory', async () => {
        expect((await post(JSON.stringify({ event_type: 'CHECK_IN', student_id: 's1' }))).status).toBe(204);
        expect((await post(JSON.stringify({ event_type: 'CHECK_OUT', student_id: 's1' }))).status).toBe(204);

        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0])).toMatchObject({ event_type: 'CHECK_IN', student_id: 's1', received_at: expect.any(String) });
    });

    it('rejects non-JSON, events without event_type, and oversized bodies', async () => {
        expect((await post('not json')).status).toBe(400);
        expect((await post(JSON.stringify({ student_id: 's1' }))).status).toBe(400);
        const big = await post(JSON.stringify({ event_type: 'PHOTO_UPLOAD', photo_base64: 'x'.repeat(1_100_000) })).catch(() => null);
        expect(big === null || big.status === 413).toBe(true);
        expect(fs.existsSync(logFile)).toBe(false);
    });

    it('GET returns the log as an array and DELETE clears it (from loopback)', async () => {
        expect(await (await fetch(baseUrl)).json()).toEqual([]);
        await post(JSON.stringify({ event_type: 'CHECK_IN' }));
        expect(await (await fetch(baseUrl)).json()).toHaveLength(1);

        expect((await fetch(baseUrl, { method: 'DELETE' })).status).toBe(204);
        expect(readDevAuditLog(logFile)).toEqual([]);
    });

    it('405 for other methods', async () => {
        expect((await fetch(baseUrl, { method: 'PUT' })).status).toBe(405);
    });

    it('end to end: the local provider writes through the endpoint with photos redacted', async () => {
        vi.spyOn(console, 'debug').mockImplementation(() => {});
        const provider = createLocalAuditProvider({ endpoint: baseUrl });
        await provider.record({ app_version: '1.0.0', sent_at: 'now', event_type: 'PHOTO_UPLOAD', photo_base64: 'QUJD' });

        expect(readDevAuditLog(logFile)).toEqual([
            expect.objectContaining({ event_type: 'PHOTO_UPLOAD', photo_base64: '<base64 image, 4 chars>' }),
        ]);
    });
});

describe('devAuditLog plugin', () => {
    it('registers separate audit and scanner endpoints writing to separate files', () => {
        const uses: [string, unknown][] = [];
        const server = {
            config: { root: '/project', logger: { info: vi.fn() } },
            middlewares: { use: (endpoint: string, handler: unknown) => uses.push([endpoint, handler]) },
        };
        const plugin = devAuditLog();
        expect(plugin.apply).toBe('serve');
        (plugin.configureServer as (s: unknown) => void)(server);

        expect(uses.map(([endpoint]) => endpoint)).toEqual(['/__dev/audit-log', '/__dev/scanner-log']);
        const logged = server.config.logger.info.mock.calls.map(([msg]: [string]) => msg).join('\n');
        expect(logged).toContain('dev-audit.jsonl');
        expect(logged).toContain('dev-scanner.jsonl');
    });
});
