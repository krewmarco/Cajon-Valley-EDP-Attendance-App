import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Student } from '../types';
import {
    barcodeForStudent,
    clampTypingSpeed,
    describeInjectFailure,
    getDongleState,
    injectBarcode,
    injectStudentBarcode,
    isConfigured,
    loadSettings,
    refreshDongleStatus,
    sanitizeBarcode,
    saveSettings,
    subscribeDongleState,
    type ScannerSettings,
} from './scannerDongleService';

const SETTINGS: ScannerSettings = {
    managerUrl: 'http://manager.test:5050/',
    clientToken: 'client-token',
    stationId: 'station-alpha-1',
    suffix: 'ENTER',
    typingSpeedMs: 8,
    barcodeField: 'elopId',
};

function memoryStorage(): Storage {
    const data = new Map<string, string>();
    return {
        get length() { return data.size; },
        clear: () => data.clear(),
        getItem: k => data.get(k) ?? null,
        key: i => [...data.keys()][i] ?? null,
        removeItem: k => { data.delete(k); },
        setItem: (k, v) => { data.set(k, String(v)); },
    };
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const student = { id: 'uuid-1', firstName: 'Ava', lastName: 'Lee', elopId: '1042', asesId: 'A1042' } as Student;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('settings', () => {
    it('is not configured without URL, token and station', () => {
        expect(isConfigured({ ...SETTINGS, clientToken: '' })).toBe(false);
        expect(isConfigured({ ...SETTINGS, stationId: '' })).toBe(false);
        expect(isConfigured(SETTINGS)).toBe(true);
    });

    it('round-trips through localStorage and updates the published state', () => {
        saveSettings(SETTINGS);
        expect(loadSettings()).toMatchObject(SETTINGS);
        expect(getDongleState().phase).toBe('unknown');

        saveSettings({ ...SETTINGS, managerUrl: '' });
        expect(getDongleState().phase).toBe('disabled');
    });

    it('falls back to defaults when storage is unavailable', () => {
        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
        expect(loadSettings().suffix).toBe('ENTER');
        expect(() => saveSettings(SETTINGS)).not.toThrow();
    });
});

describe('barcode helpers', () => {
    it('sanitizes to the same character set as the dongle', () => {
        expect(sanitizeBarcode('A_10 42;\n')).toBe('A1042');
        expect(sanitizeBarcode('TEST-10042')).toBe('TEST-10042');
    });

    it('picks the configured student field', () => {
        expect(barcodeForStudent(student, 'elopId')).toBe('1042');
        expect(barcodeForStudent(student, 'asesId')).toBe('A1042');
        expect(barcodeForStudent({ ...student, asesId: undefined }, 'asesId')).toBe('');
    });

    it('clamps typing speed to the test tool range', () => {
        expect(clampTypingSpeed(1)).toBe(4);
        expect(clampTypingSpeed(12.4)).toBe(12);
        expect(clampTypingSpeed(99)).toBe(20);
        expect(clampTypingSpeed(NaN)).toBe(8);
    });
});

describe('injectBarcode', () => {
    it('is a no-op when not configured', async () => {
        const result = await injectBarcode('1042', {}, { ...SETTINGS, managerUrl: '' });
        expect(result).toMatchObject({ ok: false, reason: 'not_configured' });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(describeInjectFailure(result)).toBeNull();
    });

    it('does not call the manager when the ID sanitizes to nothing', async () => {
        const result = await injectBarcode('___', {}, SETTINGS);
        expect(result.reason).toBe('no_barcode');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts to the station relay with the client token', async () => {
        fetchMock.mockResolvedValue(jsonResponse(200, {
            relay: 'SUCCESS',
            dongle_response: { status: 'INJECTED', result: { chars_sent: 5 } },
        }));

        const result = await injectStudentBarcode(student, { ...SETTINGS, suffix: 'TAB', typingSpeedMs: 50 });

        expect(result).toEqual({ ok: true, charsSent: 5 });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://manager.test:5050/api/v1/dongles/station-alpha-1/inject');
        expect(init.method).toBe('POST');
        expect(init.headers['X-Manager-Auth']).toBe('client-token');
        expect(JSON.parse(init.body)).toEqual({ student_id: '1042', suffix: 'TAB', typing_speed_ms: 20 });
        expect(getDongleState().phase).toBe('ready');
    });

    it('publishes "sending" while the request is in flight', async () => {
        let resolve!: (r: Response) => void;
        fetchMock.mockReturnValue(new Promise<Response>(r => { resolve = r; }));
        const phases: string[] = [];
        const unsubscribe = subscribeDongleState(s => phases.push(s.phase));

        const pending = injectBarcode('1042', {}, SETTINGS);
        expect(getDongleState().phase).toBe('sending');
        resolve(jsonResponse(200, { relay: 'SUCCESS', dongle_response: {} }));
        await pending;
        unsubscribe();

        expect(phases).toEqual(['sending', 'ready']);
    });

    it('never throws when the manager is unreachable', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

        const result = await injectBarcode('1042', {}, SETTINGS);

        expect(result).toMatchObject({ ok: false, reason: 'offline' });
        expect(describeInjectFailure(result)).toBe('Dongle offline - check-in recorded locally');
        expect(getDongleState().phase).toBe('offline');
    });

    it('treats a 502 FAILED relay as offline', async () => {
        fetchMock.mockResolvedValue(jsonResponse(502, { relay: 'FAILED', error: 'connect ECONNREFUSED' }));
        const result = await injectBarcode('1042', {}, SETTINGS);
        expect(result).toMatchObject({ ok: false, reason: 'offline', status: 502 });
    });

    it.each([
        [503, 'USB Host not mounted or not ready', 'Scanner not plugged in - check-in recorded locally', 'no_usb'],
        [429, 'Rate limit cooldown active', 'Scanner busy - check-in recorded locally, rescan if needed', 'ready'],
        [401, 'Unauthorized', 'Scanner token rejected - check dongle settings', 'ready'],
        [400, 'Invalid suffix', 'Scanner error (Invalid suffix) - check-in recorded locally', 'ready'],
    ])('maps dongle %i to a staff-facing warning', async (status, error, warning, phase) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetchMock.mockResolvedValue(jsonResponse(status, { relay: 'REJECTED', dongle_response: { error } }));

        const result = await injectBarcode('1042', {}, SETTINGS);

        expect(result).toMatchObject({ ok: false, reason: 'rejected', status, message: error });
        expect(describeInjectFailure(result)).toBe(warning);
        expect(getDongleState().phase).toBe(phase);
    });

    it('handles non-JSON error responses', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetchMock.mockResolvedValue(new Response('Bad Gateway', { status: 500 }));
        const result = await injectBarcode('1042', {}, SETTINGS);
        expect(result).toMatchObject({ ok: false, reason: 'rejected', status: 500, message: 'HTTP 500' });
    });
});

describe('refreshDongleStatus', () => {
    function stations(...list: object[]) {
        return jsonResponse(200, { stations: list });
    }

    it('is disabled when not configured', async () => {
        const state = await refreshDongleStatus({ ...SETTINGS, stationId: '' });
        expect(state.phase).toBe('disabled');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports ready for an online station with USB mounted', async () => {
        fetchMock.mockResolvedValue(stations({ id: 'station-alpha-1', status: 'ONLINE', usb_mounted: true, profile: { name: 'Zebra DS2208' } }));
        const state = await refreshDongleStatus(SETTINGS);
        expect(state).toMatchObject({ phase: 'ready', detail: 'Zebra DS2208' });
        expect(fetchMock.mock.calls[0][0]).toBe('http://manager.test:5050/api/v1/dongles');
    });

    it('reports no_usb when the dongle is not plugged into a host', async () => {
        fetchMock.mockResolvedValue(stations({ id: 'station-alpha-1', status: 'ONLINE', usb_mounted: false }));
        expect((await refreshDongleStatus(SETTINGS)).phase).toBe('no_usb');
    });

    it('reports offline for an offline, missing, or unreachable station', async () => {
        fetchMock.mockResolvedValue(stations({ id: 'station-alpha-1', status: 'OFFLINE' }));
        expect((await refreshDongleStatus(SETTINGS)).phase).toBe('offline');

        fetchMock.mockResolvedValue(stations({ id: 'other', status: 'ONLINE' }));
        expect(await refreshDongleStatus(SETTINGS)).toMatchObject({ phase: 'offline', detail: "Station 'station-alpha-1' is not registered" });

        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        expect(await refreshDongleStatus(SETTINGS)).toMatchObject({ phase: 'offline', detail: 'Dongle manager unreachable' });
    });

    it('does not overwrite an in-flight "sending" state', async () => {
        let resolveInject!: (r: Response) => void;
        fetchMock.mockReturnValueOnce(new Promise<Response>(r => { resolveInject = r; }));
        const pending = injectBarcode('1042', {}, SETTINGS);

        fetchMock.mockResolvedValueOnce(stations({ id: 'station-alpha-1', status: 'ONLINE', usb_mounted: true }));
        await refreshDongleStatus(SETTINGS);
        expect(getDongleState().phase).toBe('sending');

        resolveInject(jsonResponse(200, { relay: 'SUCCESS', dongle_response: {} }));
        await pending;
        expect(getDongleState().phase).toBe('ready');
    });
});
