/**
 * src/services/scannerDevLog.ts
 *
 * Development-only diagnostic log of scanner dongle activity, written to
 * logs/dev-scanner.jsonl by the Vite dev server (vite-plugins/devAuditLog.ts).
 *
 * This is NOT the audit trail: events here are never sent to Google Docs.
 * Whether real scan outcomes belong in the audit trail is an open question
 * (GitHub issue #3). Production builds log nothing.
 *
 * Each SCAN carries a request_id that the app sends as X-Request-Id; the
 * dongle manager's [RELAY] log line and the emulator's scan history include
 * the same ID, so one scan can be followed across all three.
 */

export const DEV_SCANNER_LOG_ENDPOINT = '/__dev/scanner-log';

export type ScanSource = 'test' | 'check-in';

export interface ScanLogEvent {
    event_type: 'SCAN';
    source: ScanSource;
    request_id: string | null;   // null when no request was sent
    station_id: string;
    barcode: string;
    suffix: string;
    typing_speed_ms: number;
    ok: boolean;
    reason?: string;
    http_status?: number;
    message?: string;
    elapsed_ms: number;
}

export interface StatusChangeLogEvent {
    event_type: 'STATUS_CHANGE';
    from: string;
    to: string;
    detail?: string;
}

export interface SettingsSavedLogEvent {
    event_type: 'SETTINGS_SAVED';
    manager_url: string;
    station_id: string;
    suffix: string;
    typing_speed_ms: number;
    barcode_field: string;
    has_client_token: boolean;   // never the token itself
}

export type ScannerDevEvent = ScanLogEvent | StatusChangeLogEvent | SettingsSavedLogEvent;

export type ScannerDevLogSink = (entry: Record<string, unknown>) => void | Promise<void>;

function defaultSink(): ScannerDevLogSink | null {
    if (!import.meta.env.DEV) return null;
    return async entry => {
        await fetch(DEV_SCANNER_LOG_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry),
        });
    };
}

// undefined = not yet resolved; null = logging disabled
let sink: ScannerDevLogSink | null | undefined;

/** Replace where events go (tests). Pass undefined to restore the default. */
export function setScannerDevLogSink(next: ScannerDevLogSink | null | undefined): void {
    sink = next;
}

/** Fire-and-forget; never throws and never blocks the caller. */
export function logScannerEvent(event: ScannerDevEvent): void {
    if (sink === undefined) sink = defaultSink();
    if (!sink) return;

    const entry = { logged_at: new Date().toISOString(), ...event };
    console.debug(`[ScannerDevLog] ${event.event_type}`, entry);
    try {
        Promise.resolve(sink(entry)).catch(() => { /* dev endpoint missing: ignore */ });
    } catch {
        // A throwing sink must never affect scanning
    }
}
