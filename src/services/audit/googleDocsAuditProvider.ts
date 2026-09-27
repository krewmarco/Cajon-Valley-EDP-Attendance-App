// src/services/audit/googleDocsAuditProvider.ts
// Sends events to the EDP_StudentSync Google Apps Script web app, which writes
// them into per-student Google Docs in Drive (see docs/GOOGLE_DRIVE_SETUP.md).
import type { AuditEvent, AuditProvider } from './types';

export interface GoogleDocsAuditProviderOptions {
    webhookUrl: string;
    /** Must match CONFIG.AUTH_TOKEN in EDP_StudentSync.gs. Ships in the browser bundle. */
    authToken?: string;
}

export function createGoogleDocsAuditProvider({ webhookUrl, authToken }: GoogleDocsAuditProviderOptions): AuditProvider {
    return {
        name: 'google-docs',
        async record(event: AuditEvent) {
            await fetch(webhookUrl, {
                method: 'POST',
                // text/plain avoids a CORS preflight, which Apps Script can't answer;
                // the JSON body is parsed inside doPost()
                headers: { 'Content-Type': 'text/plain' },
                body: JSON.stringify(authToken ? { ...event, auth_token: authToken } : event),
            });
        },
    };
}
