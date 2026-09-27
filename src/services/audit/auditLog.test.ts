import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Staff, Student } from '../../types';
import { gdLogCheckIn, gdUploadPhoto } from '../googleDriveService';
import { APP_VERSION, providersFromEnv, recordAuditEvent, setAuditProviders } from './auditLog';
import { createGoogleDocsAuditProvider } from './googleDocsAuditProvider';
import { createLocalAuditProvider, DEV_AUDIT_ENDPOINT, redactForLocalLog } from './localAuditProvider';
import type { AuditEvent, AuditProvider } from './types';

function recordingProvider(name = 'recorder'): AuditProvider & { events: AuditEvent[] } {
    const events: AuditEvent[] = [];
    return { name, events, record: async e => { events.push(e); } };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
    setAuditProviders(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('providersFromEnv', () => {
    const names = (env: Parameters<typeof providersFromEnv>[0]) => providersFromEnv(env).map(p => p.name);

    it('defaults to local in dev, plus google-docs when the webhook is set', () => {
        expect(names({ isDev: true })).toEqual(['local']);
        expect(names({ isDev: true, gasWebhookUrl: 'https://gas.test/exec' })).toEqual(['local', 'google-docs']);
    });

    it('defaults to nothing in production without a webhook, google-docs with one', () => {
        expect(names({ isDev: false })).toEqual([]);
        expect(names({ isDev: false, gasWebhookUrl: 'https://gas.test/exec' })).toEqual(['google-docs']);
    });

    it('honours an explicit VITE_AUDIT_PROVIDERS list', () => {
        expect(names({ isDev: true, providers: 'google-docs', gasWebhookUrl: 'https://gas.test/exec' })).toEqual(['google-docs']);
        expect(names({ isDev: true, providers: ' local , local ' })).toEqual(['local']);
    });

    it('never enables local outside dev (no endpoint in production builds)', () => {
        expect(names({ isDev: false, providers: 'local' })).toEqual([]);
    });

    it('skips google-docs without a webhook and ignores unknown names, with warnings', () => {
        expect(names({ isDev: true, providers: 'google-docs,splunk' })).toEqual([]);
        expect(console.warn).toHaveBeenCalledTimes(2);
    });
});

describe('recordAuditEvent', () => {
    it('sends one enveloped event to every provider', async () => {
        const a = recordingProvider('a');
        const b = recordingProvider('b');
        setAuditProviders([a, b]);

        await recordAuditEvent('CHECK_IN', { student_id: 's1' });

        expect(a.events).toHaveLength(1);
        expect(b.events[0]).toBe(a.events[0]);
        expect(a.events[0]).toMatchObject({ app_version: APP_VERSION, event_type: 'CHECK_IN', student_id: 's1' });
        expect(new Date(a.events[0].sent_at).toString()).not.toBe('Invalid Date');
    });

    it('a failing provider does not stop the others and does not throw', async () => {
        const good = recordingProvider();
        setAuditProviders([{ name: 'broken', record: async () => { throw new Error('boom'); } }, good]);

        await expect(recordAuditEvent('CHECK_OUT', {})).resolves.toBeUndefined();

        expect(good.events).toHaveLength(1);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('broken provider failed for CHECK_OUT'), expect.any(Error));
    });

    it('is a no-op with no providers', async () => {
        setAuditProviders([]);
        await recordAuditEvent('CHECK_IN', {});
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('google-docs provider', () => {
    const event: AuditEvent = { app_version: '1', sent_at: 'now', event_type: 'CHECK_IN', student_id: 's1' };

    it('posts the event as text/plain JSON to the Apps Script webhook', async () => {
        await createGoogleDocsAuditProvider({ webhookUrl: 'https://gas.test/exec' }).record(event);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://gas.test/exec');
        expect(init.headers['Content-Type']).toBe('text/plain');
        expect(JSON.parse(init.body)).toEqual(event);
    });

    it('adds auth_token when configured (matches CONFIG.AUTH_TOKEN in the script)', async () => {
        await createGoogleDocsAuditProvider({ webhookUrl: 'https://gas.test/exec', authToken: 'secret' }).record(event);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).auth_token).toBe('secret');
    });
});

describe('local provider', () => {
    it('posts JSON to the dev endpoint', async () => {
        await createLocalAuditProvider().record({ app_version: '1', sent_at: 'now', event_type: 'CHECK_IN' });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(DEV_AUDIT_ENDPOINT);
        expect(init.headers['Content-Type']).toBe('application/json');
    });

    it('replaces photo data with a size marker', () => {
        const redacted = redactForLocalLog({ app_version: '1', sent_at: 'now', event_type: 'PHOTO_UPLOAD', photo_base64: 'x'.repeat(5000) });
        expect(redacted.photo_base64).toBe('<base64 image, 5000 chars>');
    });

    it('throws when the dev endpoint is missing so the audit log can warn', async () => {
        fetchMock.mockResolvedValue(new Response('Not Found', { status: 404 }));
        await expect(createLocalAuditProvider().record({ app_version: '1', sent_at: 'now', event_type: 'CHECK_IN' }))
            .rejects.toThrow('HTTP 404');
    });
});

describe('googleDriveService events go through the providers', () => {
    const student = {
        id: 's1', firstName: 'Ava', lastName: 'Smith', grade: 'TK', elopId: '1002', programs: ['ELOP'],
        hasSnack: true, sunriseTime: '7:02 AM', guardians: [], headInjuryLogs: [], behaviorIssues: [],
    } as unknown as Student;
    const staff = { id: 'st1', name: 'Veronica Thomas', role: 'Lead', organization: 'EDP' } as Staff;

    it('gdLogCheckIn produces a CHECK_IN event with staff attribution', async () => {
        const recorder = recordingProvider();
        setAuditProviders([recorder]);

        await gdLogCheckIn(student, staff, 'sunrise');

        expect(recorder.events[0]).toMatchObject({
            event_type: 'CHECK_IN', student_id: 's1', student_name: 'Ava Smith', elop_id: '1002',
            program: 'sunrise', check_in_time: '7:02 AM', check_in_staff: 'Veronica Thomas', check_in_staff_role: 'Lead',
        });
    });

    it('gdUploadPhoto strips the data-URL header before sending', async () => {
        const recorder = recordingProvider();
        setAuditProviders([recorder]);
        await gdUploadPhoto(student, 'data:image/jpeg;base64,QUJD', 'check-in', staff);
        expect(recorder.events[0]).toMatchObject({ event_type: 'PHOTO_UPLOAD', photo_base64: 'QUJD', photo_label: 'check-in' });
    });
});
