// Contract test: the app's dongle client against the real relay + virtual dongle
// from scanner/ (not mocks). Skipped unless `npm install` has been run in
// scanner/manager and scanner/emulator.
import { existsSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Student } from '../types';
import {
    describeInjectFailure,
    injectBarcode,
    injectStudentBarcode,
    refreshDongleStatus,
    type ScannerSettings,
} from './scannerDongleService';
import { setScannerDevLogSink } from './scannerDevLog';

const require = createRequire(import.meta.url);
const scannerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scanner');
const hasScannerDeps = ['manager', 'emulator'].every(pkg => existsSync(path.join(scannerDir, pkg, 'node_modules')));

const DONGLE_TOKEN = 'contract-dongle-token';
const CLIENT_TOKEN = 'contract-client-token';

function listen(server: http.Server): Promise<string> {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        resolve(`http://127.0.0.1:${port}`);
    }));
}

function close(server: http.Server): Promise<void> {
    return new Promise(resolve => server.close(() => resolve()));
}

describe.skipIf(!hasScannerDeps)('scanner dongle client ↔ scanner/manager + scanner/emulator', () => {
    const { createEmulator } = hasScannerDeps ? require(path.join(scannerDir, 'emulator/server.js')) : ({} as any);
    const { createManager } = hasScannerDeps ? require(path.join(scannerDir, 'manager/server.js')) : ({} as any);

    let dongle: any;
    let unpluggedDongle: any;
    let manager: any;
    let managerServer: http.Server;
    let settings: ScannerSettings;
    const devLog: Record<string, any>[] = [];

    const student = { id: 'uuid-1', firstName: 'Ava', lastName: 'Lee', elopId: '1042', asesId: 'A1042' } as Student;

    async function history(emulator: any) {
        const { port } = emulator.server.address();
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/history`);
        return (await res.json()).history;
    }

    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'debug').mockImplementation(() => {});
        setScannerDevLogSink(entry => { devLog.push(entry); });

        dongle = createEmulator({ authToken: DONGLE_TOKEN, stationId: 'station-1' });
        unpluggedDongle = createEmulator({ authToken: DONGLE_TOKEN, stationId: 'station-2', usbMounted: false });
        const dongleUrl = await listen(dongle.server);
        const unpluggedUrl = await listen(unpluggedDongle.server);

        manager = createManager({
            dongleToken: DONGLE_TOKEN,
            clientToken: CLIENT_TOKEN,
            registry: `station-1=${dongleUrl},station-2=${unpluggedUrl},station-dead=http://127.0.0.1:1`,
            allowedOrigins: ['http://localhost:3000'],
            requestTimeoutMs: 1000,
        });
        managerServer = http.createServer(manager.app);
        const managerUrl = await listen(managerServer);
        await manager.pollDongleHealth();

        settings = {
            managerUrl,
            clientToken: CLIENT_TOKEN,
            stationId: 'station-1',
            suffix: 'ENTER',
            typingSpeedMs: 12,
            barcodeField: 'elopId',
        };
    });

    afterAll(async () => {
        await close(managerServer);
        for (const emulator of [dongle, unpluggedDongle]) {
            emulator.wss.close();
            await close(emulator.server);
        }
        setScannerDevLogSink(undefined);
        vi.restoreAllMocks();
    });

    it('a check-in types the student ID on the station dongle', async () => {
        const result = await injectStudentBarcode(student, settings);
        expect(result).toEqual({ ok: true, status: 200, charsSent: 5 });

        const [event] = await history(dongle);
        expect(event).toMatchObject({ student_id: '1042', suffix: 'ENTER', typing_speed_ms: 12, station_id: 'station-1' });
    });

    it('one scan can be traced across the app dev log, the manager log, and the dongle', async () => {
        await new Promise(r => setTimeout(r, 300));
        const logSpy = vi.mocked(console.log);
        logSpy.mockClear();

        const result = await injectBarcode('TRACE-1', {}, settings, { source: 'test' });
        expect(result.ok).toBe(true);

        const scan = devLog.filter(e => e.event_type === 'SCAN').at(-1)!;
        expect(scan).toMatchObject({ source: 'test', barcode: 'TRACE-1', ok: true, http_status: 200 });

        const [event] = await history(dongle);
        expect(event).toMatchObject({ student_id: 'TRACE-1', request_id: scan.request_id });

        const relayLines = logSpy.mock.calls.map(args => args.join(' ')).filter(l => l.startsWith('[RELAY]'));
        expect(relayLines.some(l => l.includes(`req=${scan.request_id}`) && l.includes('SUCCESS'))).toBe(true);
    });

    it('a back-to-back scan hits the dongle cooldown and is reported as busy', async () => {
        await new Promise(r => setTimeout(r, 300));
        expect((await injectBarcode('2001', {}, settings)).ok).toBe(true);
        const result = await injectBarcode('2002', {}, settings);
        expect(result).toMatchObject({ ok: false, reason: 'rejected', status: 429 });
        expect(describeInjectFailure(result)).toMatch(/Scanner busy/);
    });

    it('status for a healthy station is ready', async () => {
        expect((await refreshDongleStatus(settings)).phase).toBe('ready');
    });

    it('an unplugged dongle is reported as no_usb (status and inject)', async () => {
        const unplugged = { ...settings, stationId: 'station-2' };
        expect((await refreshDongleStatus(unplugged)).phase).toBe('no_usb');
        const result = await injectBarcode('1042', {}, unplugged);
        expect(result).toMatchObject({ ok: false, status: 503 });
        expect(describeInjectFailure(result)).toMatch(/not plugged in/);
    });

    it('an unreachable dongle is reported offline', async () => {
        const dead = { ...settings, stationId: 'station-dead' };
        expect((await refreshDongleStatus(dead)).phase).toBe('offline');
        const result = await injectBarcode('1042', {}, dead);
        expect(result).toMatchObject({ ok: false, reason: 'offline', status: 502 });
    });

    it('a wrong client token is rejected before reaching the dongle', async () => {
        const before = (await history(dongle)).length;
        const result = await injectBarcode('1042', {}, { ...settings, clientToken: 'wrong' });
        expect(result).toMatchObject({ ok: false, status: 401 });
        expect((await history(dongle)).length).toBe(before);
    });

    it('an unknown station is reported, not thrown', async () => {
        const result = await injectBarcode('1042', {}, { ...settings, stationId: 'nope' });
        expect(result).toMatchObject({ ok: false, reason: 'rejected', status: 404 });
        expect((await refreshDongleStatus({ ...settings, stationId: 'nope' })).detail).toMatch(/not registered/);
    });
});
