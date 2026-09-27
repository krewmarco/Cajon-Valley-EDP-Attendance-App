// src/services/audit/localAuditProvider.ts
// Development destination: posts events to the Vite dev server, which appends
// them to logs/dev-audit.jsonl (see vite-plugins/devAuditLog.ts) so they can
// be reviewed while testing. Only enabled in `vite` dev mode.
import type { AuditEvent, AuditProvider } from './types';

export const DEV_AUDIT_ENDPOINT = '/__dev/audit-log';

/** Photos are replaced with a size marker so the dev log stays readable. */
export function redactForLocalLog(event: AuditEvent): AuditEvent {
    if (typeof event.photo_base64 !== 'string') return event;
    return { ...event, photo_base64: `<base64 image, ${event.photo_base64.length} chars>` };
}

export function createLocalAuditProvider({ endpoint = DEV_AUDIT_ENDPOINT }: { endpoint?: string } = {}): AuditProvider {
    return {
        name: 'local',
        async record(event: AuditEvent) {
            const entry = redactForLocalLog(event);
            console.debug(`[Audit:local] ${entry.event_type}`, entry);
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(entry),
            });
            if (!res.ok) throw new Error(`Dev audit endpoint returned HTTP ${res.status}`);
        },
    };
}
