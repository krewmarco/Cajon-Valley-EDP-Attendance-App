// src/services/audit/types.ts — shared audit trail types

export type AuditEventType =
    | 'STUDENT_PROFILE_SYNC'
    | 'CHECK_IN'
    | 'CHECK_OUT'
    | 'BEHAVIOR_TICKET'
    | 'WE_CARE_REPORT'
    | 'HEAD_INJURY_REPORT'
    | 'PARENT_COMMUNICATION'
    | 'PHOTO_UPLOAD'
    | 'BIOMETRIC_LOG';

/** Envelope sent to every provider: metadata plus the event-specific payload. */
export interface AuditEvent {
    app_version: string;
    sent_at: string;          // ISO timestamp (device clock)
    event_type: AuditEventType;
    [field: string]: unknown;
}

/**
 * A destination for audit events (Google Docs via Apps Script, a local dev
 * file, ...). `record` may throw; the audit log catches per provider so one
 * failing destination never affects the others or the UI.
 */
export interface AuditProvider {
    readonly name: string;
    record(event: AuditEvent): Promise<void>;
}
