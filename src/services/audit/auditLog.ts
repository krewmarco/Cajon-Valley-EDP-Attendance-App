// src/services/audit/auditLog.ts
// Fans each audit event out to every configured provider.
//
// PROVIDER SELECTION (VITE_AUDIT_PROVIDERS, comma-separated):
//   google-docs  — Apps Script → Google Docs (needs VITE_GAS_WEBHOOK_URL)
//   local        — logs/dev-audit.jsonl via the Vite dev server (dev mode only)
// When unset: `local` in dev mode, plus `google-docs` whenever
// VITE_GAS_WEBHOOK_URL is set. Point a dev build at a separate Apps Script
// deployment/Drive folder to get a development Google Doc trail.
import { createGoogleDocsAuditProvider } from './googleDocsAuditProvider';
import { createLocalAuditProvider } from './localAuditProvider';
import type { AuditEvent, AuditEventType, AuditProvider } from './types';

export const APP_VERSION = '1.0.0';

export interface AuditEnv {
    isDev: boolean;
    providers?: string;
    gasWebhookUrl?: string;
    gasAuthToken?: string;
}

function envFromVite(): AuditEnv {
    // Each var written out in full so Vite inlines only these
    return {
        isDev: Boolean(import.meta.env.DEV),
        providers: import.meta.env.VITE_AUDIT_PROVIDERS,
        gasWebhookUrl: import.meta.env.VITE_GAS_WEBHOOK_URL,
        gasAuthToken: import.meta.env.VITE_GAS_AUTH_TOKEN,
    };
}

export function providersFromEnv(env: AuditEnv): AuditProvider[] {
    const requested = env.providers
        ? env.providers.split(',').map(p => p.trim()).filter(Boolean)
        : [...(env.isDev ? ['local'] : []), ...(env.gasWebhookUrl ? ['google-docs'] : [])];

    const providers: AuditProvider[] = [];
    for (const name of new Set(requested)) {
        if (name === 'google-docs') {
            if (env.gasWebhookUrl) {
                providers.push(createGoogleDocsAuditProvider({ webhookUrl: env.gasWebhookUrl, authToken: env.gasAuthToken || undefined }));
            } else {
                console.warn('[Audit] google-docs provider requested but VITE_GAS_WEBHOOK_URL is not set');
            }
        } else if (name === 'local') {
            // The endpoint only exists on the Vite dev server
            if (env.isDev) providers.push(createLocalAuditProvider());
        } else {
            console.warn(`[Audit] Unknown provider '${name}'`);
        }
    }
    return providers;
}

let providers: AuditProvider[] | null = null;

export function getAuditProviders(): AuditProvider[] {
    if (!providers) providers = providersFromEnv(envFromVite());
    return providers;
}

/** Replace the active providers (tests, or runtime reconfiguration). */
export function setAuditProviders(next: AuditProvider[] | null): void {
    providers = next;
}

/**
 * Record an event with every provider. Never throws; a failing provider is
 * logged to the console and doesn't affect the others or the UI.
 */
export async function recordAuditEvent(eventType: AuditEventType, payload: Record<string, unknown>): Promise<void> {
    const active = getAuditProviders();
    if (active.length === 0) return;

    const event: AuditEvent = {
        app_version: APP_VERSION,
        sent_at: new Date().toISOString(),
        event_type: eventType,
        ...payload,
    };

    const results = await Promise.allSettled(active.map(p => p.record(event)));
    results.forEach((result, i) => {
        if (result.status === 'rejected') {
            console.warn(`[Audit] ${active[i].name} provider failed for ${eventType}:`, result.reason);
        }
    });
}
