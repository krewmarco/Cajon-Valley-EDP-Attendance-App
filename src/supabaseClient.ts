/// <reference types="vite/client" />
// src/supabaseClient.ts
import { createClient } from '@supabase/supabase-js';
import type {
    StudentRecord,
    AttendanceRecord,
    BehaviorLogDB,
    HeadInjuryLogDB,
    CompositeStudent,
    Student
} from './types';

// Dev only: placeholders let the app start (with demo data) without a Supabase
// project. Production builds keep failing fast on missing configuration.
const DEV_PLACEHOLDER_URL = 'https://placeholder.supabase.co';
const DEV_PLACEHOLDER_ANON_KEY = 'placeholder-anon-key';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || (import.meta.env.DEV ? DEV_PLACEHOLDER_URL : undefined);
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || (import.meta.env.DEV ? DEV_PLACEHOLDER_ANON_KEY : undefined);
if (import.meta.env.DEV && supabaseUrl === DEV_PLACEHOLDER_URL) {
    console.warn('[Supabase] VITE_SUPABASE_URL is not set; using a placeholder. Database calls will fail (demo data only).');
}
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// =============================================================================
// DATA FETCHING FUNCTIONS (Supabase v2 patterns)
// =============================================================================

/**
 * Fetches a single student with all related records for today
 */
export async function fetchStudentWithRelations(
    studentId: string,
    date: string = new Date().toISOString().split('T')[0]
): Promise<CompositeStudent | null> {
    // 1. Fetch student record
    const { data: student, error: studentError } = await supabase
        .from('students')
        .select('*')
        .eq('id', studentId)
        .single();

    if (studentError || !student) return null;

    // 2. Fetch today's attendance records (both programs)
    const { data: attendance } = await supabase
        .from('daily_attendance')
        .select('*')
        .eq('student_id', studentId)
        .eq('date', date);

    // 3. Fetch today's behavior logs
    const { data: behaviorLogs } = await supabase
        .from('behavior_logs')
        .select('*')
        .eq('student_id', studentId)
        .gte('created_at', `${date}T00:00:00`)
        .lte('created_at', `${date}T23:59:59`);

    // 4. Fetch today's head injury logs
    const { data: headInjuryLogs } = await supabase
        .from('head_injury_logs')
        .select('*')
        .eq('student_id', studentId)
        .gte('created_at', `${date}T00:00:00`)
        .lte('created_at', `${date}T23:59:59`);

    // 5. Compose the result
    return {
        ...student,
        sunrise_attendance: attendance?.find((a: AttendanceRecord) => a.program === 'sunrise'),
        sunset_attendance: attendance?.find((a: AttendanceRecord) => a.program === 'sunset'),
        behavior_logs_db: behaviorLogs ?? [],
        head_injury_logs_db: headInjuryLogs ?? [],
    };
}

/**
 * Fetches all students with their related records for today (batch for roster)
 */
export async function fetchAllStudentsWithRelations(
    date: string = new Date().toISOString().split('T')[0]
): Promise<CompositeStudent[]> {
    // Fetch all students
    const { data: students, error } = await supabase
        .from('students')
        .select('*')
        .order('last_name');

    if (error || !students) return [];

    // Fetch all today's attendance
    const { data: attendance } = await supabase
        .from('daily_attendance')
        .select('*')
        .eq('date', date);

    // Fetch all today's behavior logs
    const { data: behaviorLogs } = await supabase
        .from('behavior_logs')
        .select('*')
        .gte('created_at', `${date}T00:00:00`)
        .lte('created_at', `${date}T23:59:59`);

    // Fetch all today's head injury logs
    const { data: headInjuryLogs } = await supabase
        .from('head_injury_logs')
        .select('*')
        .gte('created_at', `${date}T00:00:00`)
        .lte('created_at', `${date}T23:59:59`);

    // Map and compose
    return students.map((student: StudentRecord) => ({
        ...student,
        sunrise_attendance: attendance?.find(
            (a: AttendanceRecord) => a.student_id === student.id && a.program === 'sunrise'
        ),
        sunset_attendance: attendance?.find(
            (a: AttendanceRecord) => a.student_id === student.id && a.program === 'sunset'
        ),
        behavior_logs_db: behaviorLogs?.filter((b: BehaviorLogDB) => b.student_id === student.id) ?? [],
        head_injury_logs_db: headInjuryLogs?.filter((h: HeadInjuryLogDB) => h.student_id === student.id) ?? [],
    }));
}

// =============================================================================
// DATA MAPPING FUNCTIONS (Database → Frontend models)
// =============================================================================

/**
 * Maps database student record to frontend Student model
 */
export const mapDbToStudent = (dbStudent: any): Student => ({
    id: dbStudent.id,
    firstName: dbStudent.first_name,
    lastName: dbStudent.last_name,
    grade: dbStudent.grade,
    elopId: dbStudent.elop_id || '',
    asesId: dbStudent.ases_id || '',
    guardians: dbStudent.guardians || [],
    programs: dbStudent.programs || [],
    yearbookPhotoUrl: dbStudent.yearbook_photo_url,
    sunriseStatus: dbStudent.sunrise_status || 'absent',
    sunsetStatus: dbStudent.sunset_status || 'absent',
    sunriseTime: dbStudent.sunrise_checkin_time,
    sunsetTime: dbStudent.sunset_checkin_time,
    sunriseCheckOutTime: dbStudent.sunrise_checkout_time,
    sunsetCheckOutTime: dbStudent.sunset_checkout_time,
    hasSnack: dbStudent.has_snack || false,
    behavior: dbStudent.behavior || 'none',
    behaviorIssues: dbStudent.behavior_issues || [],
    headInjury: dbStudent.head_injury || false,
    headInjuryLogs: dbStudent.head_injury_logs || [],
    sunriseStaff: dbStudent.sunrise_staff,
    sunsetStaff: dbStudent.sunset_staff,
    lastCheckOutBy: dbStudent.last_checkout_by,
    smsSentTime: dbStudent.sms_sent_time,
    checkInPhoto: dbStudent.checkin_photo,
    behaviorTimestamp: dbStudent.behavior_timestamp,
    behaviorStaff: dbStudent.behavior_staff,
    behaviorDescription: dbStudent.behavior_description,
    isCheckInBlocked: dbStudent.is_checkin_blocked || false
});
