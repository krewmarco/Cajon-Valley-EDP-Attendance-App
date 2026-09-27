/**
 * src/services/googleDriveService.ts
 *
 * EDP Attendance App — Audit Trail Events
 * =======================================
 * Builds a structured audit event for every student action and hands it to
 * the audit log (src/services/audit/auditLog.ts), which fans it out to the
 * configured providers:
 *   google-docs — EDP_StudentSync Google Apps Script → per-student Google Docs
 *                 (VITE_GAS_WEBHOOK_URL, see docs/GOOGLE_DRIVE_SETUP.md)
 *   local       — logs/dev-audit.jsonl via the Vite dev server (dev mode)
 * With no providers configured, every function is a no-op.
 *
 * USAGE (called from the event handlers in App.tsx):
 *   import { gdLogCheckIn } from './services/googleDriveService';
 *   // Call after the Supabase update succeeds:
 *   gdLogCheckIn(student, currentStaff, 'sunrise');
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVENT TYPES SENT TO GAS:
 *   STUDENT_PROFILE_SYNC   — student created or guardian info updated
 *   CHECK_IN               — student checked in to Sunrise or Sunset
 *   CHECK_OUT              — student checked out (normal or batch)
 *   BEHAVIOR_TICKET        — Green Card behavior ticket submitted
 *   WE_CARE_REPORT         — We Care incident report submitted
 *   HEAD_INJURY_REPORT     — Head Injury Report stage logged
 *   PARENT_COMMUNICATION   — Parent report sent or draft saved
 *   PHOTO_UPLOAD           — check-in or yearbook photo captured
 *   BIOMETRIC_LOG          — biometric verification audit entry
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
    Student,
    Staff,
    ParentReport,
    BiometricLog,
    ProgramType,
} from '../types';

import { recordAuditEvent } from './audit/auditLog';
import type { AuditEventType } from './audit/types';

// ─── Internal helpers ─────────────────────────────────────────────────────────

function nowISO(): string {
    return new Date().toISOString();
}

function todayLabel(): string {
    return new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit',
    });
}

function timeLabel(): string {
    return new Date().toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    });
}

/** Fire-and-forget; never blocks or crashes the UI. */
function postEvent(eventType: AuditEventType, payload: Record<string, unknown>): Promise<void> {
    return recordAuditEvent(eventType, payload);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Upsert the student's Drive folder and profile document whenever a student
 * record is created or guardian information changes.
 */
export async function gdSyncStudentProfile(student: Student): Promise<void> {
    await postEvent('STUDENT_PROFILE_SYNC', {
        student_id: student.id,
        student_name: `${student.firstName} ${student.lastName}`,
        grade: student.grade,
        elop_id: student.elopId,
        ases_id: student.asesId ?? null,
        programs: student.programs,
        has_snack: student.hasSnack,
        is_check_in_blocked: student.isCheckInBlocked ?? false,
        yearbook_photo_url: student.yearbookPhotoUrl ?? null,
        guardians: student.guardians.map(g => ({
            type: g.type,
            first_name: g.firstName,
            last_name: g.lastName,
            phone: g.phone,
            email: g.email ?? null,
            relationship: g.relationship ?? null,
            notify_sms: g.notifySms ?? false,
            notify_email: g.notifyEmail ?? false,
            authorized_by: g.authorizedBy ?? null,
            auth_date: g.authDate ?? null,
        })),
        updated_at: nowISO(),
    });
}

/**
 * Log a student check-in event with full staff and program context.
 */
export async function gdLogCheckIn(
    student: Student,
    staff: Staff,
    program: ProgramType,
): Promise<void> {
    await postEvent('CHECK_IN', {
        student_id: student.id,
        student_name: `${student.firstName} ${student.lastName}`,
        grade: student.grade,
        elop_id: student.elopId,
        program,
        check_in_time: program === 'sunrise' ? student.sunriseTime : student.sunsetTime,
        check_in_staff: staff.name,
        check_in_staff_id: staff.id,
        check_in_staff_role: staff.role,
        check_in_staff_org: staff.organization,
        attendance_code: student.attendanceCode ?? null,
        has_snack: student.hasSnack,
        date: todayLabel(),
        timestamp: nowISO(),
    });
}

/**
 * Log a student checkout (individual or batch).
 */
export async function gdLogCheckOut(
    student: Student,
    staff: Staff,
    program: ProgramType,
    pickupName?: string,
    isBatch = false,
): Promise<void> {
    await postEvent('CHECK_OUT', {
        student_id: student.id,
        student_name: `${student.firstName} ${student.lastName}`,
        grade: student.grade,
        elop_id: student.elopId,
        program,
        check_out_time: program === 'sunrise'
            ? student.sunriseCheckOutTime
            : student.sunsetCheckOutTime,
        check_out_staff: program === 'sunrise'
            ? (student.sunriseCheckoutBy ?? staff.name)
            : (student.sunsetCheckoutBy ?? staff.name),
        performing_staff: staff.name,
        performing_staff_id: staff.id,
        pickup_name: pickupName ?? student.pickupName ?? null,
        is_batch_checkout: isBatch,
        date: todayLabel(),
        timestamp: nowISO(),
    });
}

/**
 * Log a Green Card behavior ticket when submitted/saved.
 */
export async function gdLogBehaviorTicket(
    student: Student,
    staff: Staff,
): Promise<void> {
    await postEvent('BEHAVIOR_TICKET', {
        student_id: student.id,
        student_name: `${student.firstName} ${student.lastName}`,
        grade: student.grade,
        elop_id: student.elopId,
        ticket_level: student.behavior,
        handling_staff: student.behaviorStaff ?? staff.name,
        handling_staff_id: staff.id,
        staff_closest_to_situation: student.behaviorStaffSupport ?? null,
        behaviors_checked: student.behaviorIssues,
        incident_description: student.behaviorDescription ?? null,
        actions_taken: student.behaviorActions ?? null,
        submitted_at: student.behaviorSubmittedAt
            ? new Date(student.behaviorSubmittedAt).toISOString()
            : nowISO(),
        edit_count: student.behaviorEditCount ?? 0,
        last_edited_at: student.behaviorLastEditedAt
            ? new Date(student.behaviorLastEditedAt).toISOString()
            : null,
        date: todayLabel(),
        time: timeLabel(),
    });
}

/**
 * Log a We Care Report submission.
 */
export async function gdLogWeCareReport(
    student: Student,
    staff: Staff,
): Promise<void> {
    await postEvent('WE_CARE_REPORT', {
        student_id: student.id,
        student_name: `${student.firstName} ${student.lastName}`,
        grade: student.grade,
        elop_id: student.elopId,
        reporting_staff: student.weCareStaff ?? staff.name,
        reporting_staff_id: staff.id,
        activity: student.weCareActivity ?? null,
        first_aid_provided: student.weCareFirstAid ?? [],
        additional_info: student.weCareInfo ?? null,
        submitted_at: student.weCareSubmittedAt
            ? new Date(student.weCareSubmittedAt).toISOString()
            : nowISO(),
        edit_count: student.weCareEditCount ?? 0,
        date: todayLabel(),
        time: timeLabel(),
    });
}

/**
 * Log a Head Injury Report assessment stage.
 * Call once per stage (0min, 15min, 30min) as each is completed.
 */
export async function gdLogHeadInjury(
    student: Student,
    staff: Staff,
): Promise<void> {
    const latestLog = student.headInjuryLogs.length > 0
        ? student.headInjuryLogs[student.headInjuryLogs.length - 1]
        : null;

    await postEvent('HEAD_INJURY_REPORT', {
        student_id: student.id,
        student_name: `${student.firstName} ${student.lastName}`,
        grade: student.grade,
        elop_id: student.elopId,
        witness: student.headInjuryWitness ?? null,
        witness_description: student.headInjuryWitnessDesc ?? null,
        incident_timestamp: student.headInjuryTimestamp ?? null,
        injury_start_time: student.headInjuryStartTime
            ? new Date(student.headInjuryStartTime).toISOString()
            : null,
        total_assessments_completed: student.headInjuryLogs.length,
        latest_assessment_stage: latestLog?.stage ?? null,
        latest_assessment_symptoms: latestLog?.symptoms ?? {},
        latest_assessment_notes: latestLog?.notes ?? null,
        latest_assessment_staff: latestLog?.staffName ?? staff.name,
        latest_assessment_completed_at: latestLog?.completedAt ?? null,
        all_assessment_stages: student.headInjuryLogs.map(log => ({
            stage: log.stage,
            completed_at: log.completedAt,
            staff: log.staffName,
            symptoms: log.symptoms,
            notes: log.notes ?? null,
        })),
        submitting_staff: staff.name,
        submitting_staff_id: staff.id,
        date: todayLabel(),
        time: timeLabel(),
    });
}

/**
 * Log a parent communication (draft saved or report sent).
 */
export async function gdLogParentReport(
    student: Student,
    report: ParentReport,
    staff: Staff,
): Promise<void> {
    await postEvent('PARENT_COMMUNICATION', {
        student_id: student.id,
        student_name: `${student.firstName} ${student.lastName}`,
        grade: student.grade,
        elop_id: student.elopId,
        report_id: report.id,
        report_type: report.type,
        behavior_level: report.behaviorLevel ?? null,
        delivery_method: report.method,
        status: report.status,
        message_preview: report.message.substring(0, 500),
        full_message: report.message,
        filed_by_staff: staff.name,
        filed_by_staff_id: staff.id,
        report_staff_id: report.staffId,
        edit_logs: report.editLogs ?? [],
        created_at: report.createdAt,
        actioned_at: nowISO(),
    });
}

/**
 * Upload a check-in or yearbook photo to the student's Drive Photos folder.
 * Accepts a base64 data URL string (e.g. from a <canvas> capture).
 *
 * @param label  e.g. 'check-in', 'yearbook', 'biometric-live'
 */
export async function gdUploadPhoto(
    student: Student,
    photoBase64: string,
    label: 'check-in' | 'yearbook' | 'biometric-live' | 'biometric-reference',
    staff?: Staff,
): Promise<void> {
    // Trim the data URL header if present (data:image/jpeg;base64,...)
    const base64Data = photoBase64.includes(',')
        ? photoBase64.split(',')[1]
        : photoBase64;

    await postEvent('PHOTO_UPLOAD', {
        student_id: student.id,
        student_name: `${student.firstName} ${student.lastName}`,
        grade: student.grade,
        elop_id: student.elopId,
        photo_label: label,
        photo_base64: base64Data,        // GAS will decode and upload as Drive file
        mime_type: 'image/jpeg',
        uploaded_by_staff: staff?.name ?? 'system',
        uploaded_by_staff_id: staff?.id ?? null,
        date: todayLabel(),
        time: timeLabel(),
        timestamp: nowISO(),
    });
}

/**
 * Append a biometric verification audit record.
 */
export async function gdLogBiometric(
    log: BiometricLog,
    staff: Staff,
): Promise<void> {
    await postEvent('BIOMETRIC_LOG', {
        log_id: log.id,
        student_id: log.studentId,
        student_name: log.studentName,
        verified_by_staff: staff.name,
        verified_by_staff_id: staff.id,
        match_score: log.matchScore,
        anomaly_score: log.anomalyScore,
        anomaly_detected: log.anomalyDetected,
        // Photos stored separately via gdUploadPhoto to keep this payload small
        has_live_photo: !!log.livePhoto,
        has_yearbook_photo: !!log.yearbookPhoto,
        has_previous_photo: !!log.previousPhoto,
        timestamp: log.timestamp,
        date: todayLabel(),
    });
}

// =============================================================================
// FUTURE API STUBS
// =============================================================================
// These functions are intentionally left as stubs. When the district's IT team
// provides ELOP, ASES, and Yearbook API credentials, implement the bodies and
// set the corresponding VITE_* env vars. The function signatures and data
// shapes are already defined to match the Student type.
// =============================================================================

/**
 * STUB — ELOP Check-In API
 * When implemented, POST the check-in event to the district's ELOP system.
 * Env var: VITE_ELOP_API_BASE_URL, VITE_ELOP_API_KEY
 */
export async function elopCheckIn(
    _student: Student,
    _staff: Staff,
    _program: ProgramType,
): Promise<void> {
    const baseUrl = import.meta.env.VITE_ELOP_API_BASE_URL ?? '';
    const apiKey = import.meta.env.VITE_ELOP_API_KEY ?? '';
    if (!baseUrl || !apiKey) return; // Not configured

    // TODO: Implement when district provides ELOP API docs
    // Example shape expected by most ELOP systems:
    // POST /api/attendance/checkin
    // { student_id, elop_id, timestamp, program, staff_id, site_code }
    console.info('[ELOP] Check-in stub — implement when API credentials are provided.');
}

/**
 * STUB — ELOP Check-Out API
 * Env var: VITE_ELOP_API_BASE_URL, VITE_ELOP_API_KEY
 */
export async function elopCheckOut(
    _student: Student,
    _staff: Staff,
    _program: ProgramType,
    _pickupName?: string,
): Promise<void> {
    const baseUrl = import.meta.env.VITE_ELOP_API_BASE_URL ?? '';
    const apiKey = import.meta.env.VITE_ELOP_API_KEY ?? '';
    if (!baseUrl || !apiKey) return;

    // TODO: Implement when district provides ELOP API docs
    console.info('[ELOP] Check-out stub — implement when API credentials are provided.');
}

/**
 * STUB — ASES Attendance Sync
 * Env var: VITE_ASES_API_BASE_URL, VITE_ASES_API_KEY
 */
export async function asesSync(
    _student: Student,
    _eventType: 'check_in' | 'check_out',
    _timestamp: string,
): Promise<void> {
    const baseUrl = import.meta.env.VITE_ASES_API_BASE_URL ?? '';
    const apiKey = import.meta.env.VITE_ASES_API_KEY ?? '';
    if (!baseUrl || !apiKey) return;

    // TODO: Implement when district provides ASES API docs
    console.info('[ASES] Sync stub — implement when API credentials are provided.');
}

/**
 * STUB — Yearbook Photo Sync
 * Fetches the student's official yearbook photo from the district's photo
 * system and stores it on the Student record as yearbookPhotoUrl.
 * Env var: VITE_YEARBOOK_PHOTO_API_URL, VITE_YEARBOOK_API_KEY
 *
 * @returns URL of the photo, or null if not found / not configured
 */
export async function syncYearbookPhoto(
    _student: Student,
): Promise<string | null> {
    const baseUrl = import.meta.env.VITE_YEARBOOK_PHOTO_API_URL ?? '';
    const apiKey = import.meta.env.VITE_YEARBOOK_API_KEY ?? '';
    if (!baseUrl || !apiKey) return null;

    // TODO: Implement when district photo system API is available.
    // Expected flow:
    //   GET {baseUrl}/students/{elopId}/photo
    //   Authorization: Bearer {apiKey}
    //   → returns { photo_url: string } or 404
    console.info('[Yearbook] Photo sync stub — implement when API is available.');
    return null;
}
