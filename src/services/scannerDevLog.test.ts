import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_SCANNER_LOG_ENDPOINT, logScannerEvent, setScannerDevLogSink } from './scannerDevLog';

const event = { event_type: 'STATUS_CHANGE', from: 'unknown', to: 'ready' } as const;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    setScannerDevLogSink(undefined);
});

afterEach(() => {
    setScannerDevLogSink(undefined);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('scanner dev log default sink', () => {
    it('posts events to the dev endpoint in dev mode', () => {
        vi.stubEnv('DEV', true);
        logScannerEvent(event);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(DEV_SCANNER_LOG_ENDPOINT);
        expect(JSON.parse(init.body)).toMatchObject({ ...event, logged_at: expect.any(String) });
    });

    it('logs nothing outside dev mode (production builds)', () => {
        vi.stubEnv('DEV', false);
        logScannerEvent(event);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('swallows a missing endpoint', async () => {
        vi.stubEnv('DEV', true);
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        expect(() => logScannerEvent(event)).not.toThrow();
        await new Promise(r => setTimeout(r, 0));
    });
});
