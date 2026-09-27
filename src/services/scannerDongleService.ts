/**
 * src/services/scannerDongleService.ts
 *
 * EDP Attendance App — USB Scanner Dongle Service
 * ================================================
 * Talks to the dongle manager relay (scanner/manager) so that confirming a
 * check-in in this app "scans" the student's ID into the SIS portal on the
 * Chromebook the ESP32-S3 dongle is plugged into.
 *
 * ACTIVATION:
 *   Each device is configured from the Scanner Dongle test tool (header pill),
 *   which stores the manager URL, client token, and station ID in localStorage.
 *   VITE_SCANNER_MANAGER_URL / VITE_SCANNER_MANAGER_TOKEN / VITE_SCANNER_STATION_ID
 *   provide defaults for local development. Leave the token env var blank in
 *   production builds — anything in VITE_* is readable in the shipped bundle.
 *   When no manager URL + token are set, every function is a graceful no-op.
 *
 * FAILURE POLICY:
 *   Nothing here throws. Check-ins are recorded in Supabase regardless of the
 *   dongle; callers get a result object and decide whether to warn staff.
 */

import type { Student } from '../types';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ScannerSuffix = 'ENTER' | 'TAB' | 'NONE';
export type BarcodeField = 'elopId' | 'asesId';

export interface ScannerSettings {
    managerUrl: string;
    clientToken: string;
    stationId: string;
    suffix: ScannerSuffix;
    typingSpeedMs: number;
    barcodeField: BarcodeField;
}

export type InjectFailureReason = 'not_configured' | 'no_barcode' | 'offline' | 'rejected';

// Flat shape (not a discriminated union) because the project isn't in strict
// mode, where TypeScript won't narrow on `ok`.
export interface InjectResult {
    ok: boolean;
    reason?: InjectFailureReason;
    status?: number;
    message?: string;
    charsSent?: number;
}

export type DonglePhase = 'disabled' | 'ready' | 'sending' | 'offline' | 'no_usb' | 'unknown';

export interface DongleState {
    phase: DonglePhase;
    detail?: string;
    lastCheckedAt?: string;
}

// ─── Settings ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'edp.scannerDongle.settings';
const REQUEST_TIMEOUT_MS = 3000;
export const MIN_TYPING_SPEED_MS = 4;
export const MAX_TYPING_SPEED_MS = 20;

function envDefaults(): ScannerSettings {
    // Written out in full (no alias) so Vite inlines only these vars, not the whole env object
    return {
        managerUrl: import.meta.env.VITE_SCANNER_MANAGER_URL ?? '',
        clientToken: import.meta.env.VITE_SCANNER_MANAGER_TOKEN ?? '',
        stationId: import.meta.env.VITE_SCANNER_STATION_ID ?? '',
        suffix: 'ENTER',
        typingSpeedMs: 8,
        barcodeField: 'elopId',
    };
}

export function loadSettings(): ScannerSettings {
    const defaults = envDefaults();
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return defaults;
        return { ...defaults, ...JSON.parse(raw) };
    } catch {
        return defaults;
    }
}

export function saveSettings(settings: ScannerSettings): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // Private mode / storage disabled: settings last for this session only
    }
    setState(isConfigured(settings) ? { phase: 'unknown' } : { phase: 'disabled' });
}

export function isConfigured(settings: ScannerSettings = loadSettings()): boolean {
    return Boolean(settings.managerUrl && settings.clientToken && settings.stationId);
}

function baseUrl(settings: ScannerSettings): string {
    return settings.managerUrl.replace(/\/+$/, '');
}

// ─── Observable state (drives the header pill) ───────────────────────────────

let state: DongleState = { phase: isConfigured() ? 'unknown' : 'disabled' };
const listeners = new Set<(s: DongleState) => void>();

function setState(next: DongleState): void {
    state = next;
    listeners.forEach(l => l(state));
}

export function getDongleState(): DongleState {
    return state;
}

export function subscribeDongleState(listener: (s: DongleState) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

// ─── Barcode helpers ─────────────────────────────────────────────────────────

/** Mirrors the dongle's filter: only [a-zA-Z0-9-] is ever typed. */
export function sanitizeBarcode(raw: string): string {
    return raw.replace(/[^a-zA-Z0-9-]/g, '');
}

export function barcodeForStudent(student: Student, field: BarcodeField = loadSettings().barcodeField): string {
    return sanitizeBarcode(student[field] ?? '');
}

export function clampTypingSpeed(ms: number): number {
    if (!Number.isFinite(ms)) return 8;
    return Math.min(MAX_TYPING_SPEED_MS, Math.max(MIN_TYPING_SPEED_MS, Math.round(ms)));
}

// ─── Manager API ─────────────────────────────────────────────────────────────

/**
 * Ask the manager to type `barcode` on this device's station.
 * Resolves (never rejects) with what happened.
 */
export async function injectBarcode(
    barcode: string,
    overrides: Partial<Pick<ScannerSettings, 'suffix' | 'typingSpeedMs' | 'stationId'>> = {},
    settings: ScannerSettings = loadSettings(),
): Promise<InjectResult> {
    const s = { ...settings, ...overrides };
    if (!isConfigured(s)) {
        return { ok: false, reason: 'not_configured', message: 'Scanner dongle is not configured on this device' };
    }

    const studentId = sanitizeBarcode(barcode);
    if (!studentId) {
        return { ok: false, reason: 'no_barcode', message: 'Student has no scannable ID' };
    }

    setState({ phase: 'sending' });

    let res: Response;
    try {
        res = await fetch(`${baseUrl(s)}/api/v1/dongles/${encodeURIComponent(s.stationId)}/inject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Manager-Auth': s.clientToken },
            body: JSON.stringify({
                student_id: studentId,
                suffix: s.suffix,
                typing_speed_ms: clampTypingSpeed(s.typingSpeedMs),
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (err) {
        console.warn('[ScannerDongle] Manager unreachable:', err);
        setState({ phase: 'offline', detail: 'Dongle manager unreachable' });
        return { ok: false, reason: 'offline', message: 'Dongle manager unreachable' };
    }

    let body: any = null;
    try {
        body = await res.json();
    } catch {
        // Non-JSON error page; fall through with status only
    }

    if (res.ok && body?.relay === 'SUCCESS') {
        setState({ phase: 'ready', lastCheckedAt: new Date().toISOString() });
        return { ok: true, charsSent: body?.dongle_response?.result?.chars_sent };
    }

    const message = body?.dongle_response?.error ?? body?.error ?? `HTTP ${res.status}`;

    // 502 = manager up, dongle unreachable
    if (res.status === 502 || body?.relay === 'FAILED') {
        setState({ phase: 'offline', detail: 'Dongle unreachable' });
        return { ok: false, reason: 'offline', status: res.status, message };
    }
    if (res.status === 503) {
        setState({ phase: 'no_usb', detail: 'Dongle not plugged into a computer' });
    } else {
        setState({ phase: 'ready' });
    }
    console.warn('[ScannerDongle] Injection rejected:', res.status, message);
    return { ok: false, reason: 'rejected', status: res.status, message };
}

/** Convenience wrapper used by the check-in flow. */
export function injectStudentBarcode(student: Student, settings: ScannerSettings = loadSettings()): Promise<InjectResult> {
    return injectBarcode(barcodeForStudent(student, settings.barcodeField), {}, settings);
}

/** Refresh this device's station status from the manager and publish it. */
export async function refreshDongleStatus(settings: ScannerSettings = loadSettings()): Promise<DongleState> {
    if (!isConfigured(settings)) {
        setState({ phase: 'disabled' });
        return state;
    }
    let next: DongleState;
    try {
        const res = await fetch(`${baseUrl(settings)}/api/v1/dongles`, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const data = await res.json();
        const station = (data.stations ?? []).find((st: any) => st.id === settings.stationId);
        const lastCheckedAt = new Date().toISOString();
        if (!station) {
            next = { phase: 'offline', detail: `Station '${settings.stationId}' is not registered`, lastCheckedAt };
        } else if (station.status !== 'ONLINE') {
            next = { phase: 'offline', detail: `Station is ${station.status}`, lastCheckedAt };
        } else if (station.usb_mounted === false) {
            next = { phase: 'no_usb', detail: 'Dongle not plugged into a computer', lastCheckedAt };
        } else {
            next = { phase: 'ready', detail: station.profile?.name, lastCheckedAt };
        }
    } catch {
        next = { phase: 'offline', detail: 'Dongle manager unreachable', lastCheckedAt: new Date().toISOString() };
    }

    // Don't clobber an in-flight injection's "sending" indicator
    if (state.phase !== 'sending') setState(next);
    return next;
}

/** Staff-facing wording for a failed injection (null = stay quiet). */
export function describeInjectFailure(result: InjectResult): string | null {
    if (result.ok || result.reason === 'not_configured') return null;
    switch (result.reason) {
        case 'offline':
            return 'Dongle offline - check-in recorded locally';
        case 'no_barcode':
            return 'No scanner ID on file - check-in recorded locally';
        case 'rejected':
            if (result.status === 503) return 'Scanner not plugged in - check-in recorded locally';
            if (result.status === 429) return 'Scanner busy - check-in recorded locally, rescan if needed';
            if (result.status === 401) return 'Scanner token rejected - check dongle settings';
            return `Scanner error (${result.message}) - check-in recorded locally`;
        default:
            return 'Scanner error - check-in recorded locally';
    }
}
