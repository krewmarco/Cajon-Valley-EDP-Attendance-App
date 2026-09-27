// src/App.tsx
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { supabase, mapDbToStudent } from './supabaseClient';
import type { Student, Staff, ParentReport, BiometricLog, ProgramType, AttendanceStatus } from './types';
import { GRADES } from './constants';
import { INITIAL_STAFF, INITIAL_STUDENTS } from './utils/mockData';
import { sendSmsMock } from './utils/sms';
import { MockDatabase, PasskeyService } from './utils/mock';
import { playAlarm } from './utils/helpers';
import Toast from './components/Toast';
import StaffLogin from './components/StaffLogin';
import StudentDetailModal from './components/StudentDetailModal';
import ConfirmationModal from './components/ConfirmationModal';
import LeaderDashboard from './components/LeaderDashboard';
import ParentReportModal from './components/ParentReportModal';
import { gdLogBehaviorTicket, gdLogBiometric, gdLogCheckIn, gdLogCheckOut, gdLogHeadInjury, gdLogParentReport, gdLogWeCareReport, gdSyncStudentProfile, gdUploadPhoto } from './services/googleDriveService';

const PROFILE_FIELDS: (keyof Student)[] = ['firstName', 'lastName', 'grade', 'elopId', 'asesId', 'programs', 'guardians', 'hasSnack', 'isCheckInBlocked', 'yearbookPhotoUrl'];

/** Audit events implied by a student record change. */
function logStudentChanges(before: Student, after: Student, staff: Staff) {
    if (PROFILE_FIELDS.some(f => JSON.stringify(before[f]) !== JSON.stringify(after[f]))) {
        gdSyncStudentProfile(after);
    }
    const behaviorSubmitted = !before.behaviorSubmittedAt && after.behaviorSubmittedAt;
    const behaviorEdited = (after.behaviorEditCount ?? 0) > (before.behaviorEditCount ?? 0);
    if (behaviorSubmitted || behaviorEdited) gdLogBehaviorTicket(after, staff);

    const weCareSubmitted = !before.weCareSubmittedAt && after.weCareSubmittedAt;
    const weCareEdited = (after.weCareEditCount ?? 0) > (before.weCareEditCount ?? 0);
    if (weCareSubmitted || weCareEdited) gdLogWeCareReport(after, staff);

    if ((after.headInjuryLogs?.length ?? 0) > (before.headInjuryLogs?.length ?? 0)) gdLogHeadInjury(after, staff);
}

const App = () => {
    const [staffList, setStaffList] = useState<Staff[]>(INITIAL_STAFF);
    const [user, setUser] = useState<Staff | null>(null);
    const [students, setStudents] = useState<Student[]>(INITIAL_STUDENTS);
    const [program, setProgram] = useState<ProgramType>('sunrise');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedGrade, setSelectedGrade] = useState<string | null>(null);
    const [activeStudentId, setActiveStudentId] = useState<string | null>(null);
    const [showConfirmId, setShowConfirmId] = useState<string | null>(null);
    const [showLeaderDashboard, setShowLeaderDashboard] = useState(false);
    const [dashboardKey, setDashboardKey] = useState(0);
    const [toast, setToast] = useState<{ msg: string, type: 'success' | 'info' | 'warning' | 'error' } | null>(null);
    const [darkMode, setDarkMode] = useState(false);
    const [isDemoMode, setIsDemoMode] = useState(false);
    const [isLeadMode, setIsLeadMode] = useState(true);
    const [scheduledBatchCheckoutTime, setScheduledBatchCheckoutTime] = useState<string | null>(null);
    const [defaultBatchTime, setDefaultBatchTime] = useState<string>('08:00');
    const [isBatchDefaultEnabled, setIsBatchDefaultEnabled] = useState(false);
    const [reportData, setReportData] = useState<{ student: Student, type: 'injury' | 'behavior' } | null>(null);
    const [parentReports, setParentReports] = useState<ParentReport[]>([]);
    const [biometricLogs, setBiometricLogs] = useState<BiometricLog[]>([]);
    const [rosterStatusFilter, setRosterStatusFilter] = useState<'all' | 'checked_in' | 'checked_out'>('all');
    const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
    // Latest students for timers/closures that would otherwise see stale state (audit logging)
    const studentsRef = useRef(students);
    studentsRef.current = students;

    // Fetch initial data from Supabase
    useEffect(() => {
        const fetchInitialData = async () => {
            try {
                const { data, error } = await supabase.from('students').select('*');
                if (error) console.error('Error fetching students:', error);
                if (data && data.length > 0) {
                    setStudents(data.map(mapDbToStudent));
                }
            } catch (err) {
                console.error('Fetch failed:', err);
            }
        };
        fetchInitialData();

        supabase.auth.getSession().then(({ data: { session } }) => {
            if (session?.user?.email) {
                const staffMember = staffList.find(s => s.email === session.user.email);
                if (staffMember) setUser(staffMember);
            }
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            if (session?.user?.email) {
                if (!user || user.email !== session.user.email) {
                    const staffMember = staffList.find(s => s.email === session.user.email);
                    if (staffMember) setUser(staffMember);
                }
            } else if (event === 'SIGNED_OUT') {
                setUser(null);
            }
        });

        return () => { subscription.unsubscribe(); };
    }, [user, staffList]);

    // Supabase Realtime subscription
    useEffect(() => {
        const channel = supabase
            .channel('students-realtime')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, (payload) => {
                if (payload.eventType === 'UPDATE' && payload.new) {
                    setStudents(prev => prev.map(s => s.id === payload.new.id ? { ...s, ...mapDbToStudent(payload.new) } : s));
                    setLastSyncTime(new Date());
                } else if (payload.eventType === 'DELETE' && payload.old) {
                    setStudents(prev => prev.filter(s => s.id !== payload.old.id));
                }
            })
            .subscribe();
        return () => { supabase.removeChannel(channel); };
    }, []);

    // Program auto-switch based on time
    useEffect(() => {
        const checkTime = () => {
            const hour = new Date().getHours();
            setProgram(hour < 12 ? 'sunrise' : 'sunset');
        };
        checkTime();
        const interval = setInterval(checkTime, 60000);
        return () => clearInterval(interval);
    }, []);

    // Head injury timer alerts
    useEffect(() => {
        const interval = setInterval(() => {
            students.forEach(s => {
                if (s.headInjury && s.headInjuryStartTime) {
                    const elapsed = Number(Date.now()) - s.headInjuryStartTime;
                    const logsCount = s.headInjuryLogs.length;
                    const nextCheckMs = logsCount === 1 ? 15 * 60 * 1000 : logsCount === 2 ? 30 * 60 * 1000 : -1;
                    if (nextCheckMs !== -1 && Math.abs(nextCheckMs - elapsed) < 1000) {
                        showToast(`Time for ${s.firstName}'s next check!`, 'warning');
                        playAlarm();
                    }
                }
            });
        }, 1000);
        return () => clearInterval(interval);
    }, [students]);

    // Dark mode detection
    useEffect(() => {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        setDarkMode(isDark);
        const handler = (e: MediaQueryListEvent) => setDarkMode(e.matches);
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', handler);
        return () => window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', handler);
    }, []);

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    }, [darkMode]);

    // Batch checkout scheduler
    useEffect(() => {
        if (!scheduledBatchCheckoutTime || program !== 'sunrise') return;
        const interval = setInterval(() => {
            const now = new Date();
            const currentTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            if (currentTime === scheduledBatchCheckoutTime) {
                if (user) {
                    studentsRef.current
                        .filter(s => s.sunriseStatus === 'present' || s.sunriseStatus === 'pending_parent')
                        .forEach(s => gdLogCheckOut({ ...s, sunriseStatus: 'checked_out', sunriseCheckOutTime: `Auto-Check-Out at ${scheduledBatchCheckoutTime}` }, user, 'sunrise', undefined, true));
                }
                setStudents(prev => prev.map(s => {
                    if (s.sunriseStatus === 'present' || s.sunriseStatus === 'pending_parent') {
                        return { ...s, sunriseStatus: 'checked_out' as AttendanceStatus, sunriseCheckOutTime: `Auto-Check-Out at ${scheduledBatchCheckoutTime}` };
                    }
                    return s;
                }));
                showToast(`Batch checkout executed at ${scheduledBatchCheckoutTime}`, 'success');
                setScheduledBatchCheckoutTime(null);
            }
        }, 1000);
        return () => clearInterval(interval);
    }, [scheduledBatchCheckoutTime, program, user]);

    const showToast = (msg: string, type: 'success' | 'info' | 'warning' | 'error') => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 3000);
    };

    const filteredStudents = useMemo(() => {
        let result = students;
        if (user && user.role !== 'Lead' && user.assignedGrades && user.assignedGrades.length > 0) {
            result = result.filter(s => user.assignedGrades?.includes(s.grade));
        }
        if (rosterStatusFilter === 'checked_in') {
            result = result.filter(s => (program === 'sunrise' ? s.sunriseStatus : s.sunsetStatus) === 'present');
        } else if (rosterStatusFilter === 'checked_out') {
            result = result.filter(s => (program === 'sunrise' ? s.sunriseStatus : s.sunsetStatus) === 'checked_out');
        }
        if (selectedGrade && selectedGrade !== 'All') {
            result = result.filter(s => s.grade === selectedGrade);
        }
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            result = result.filter(s => s.firstName.toLowerCase().includes(q) || s.lastName.toLowerCase().includes(q) || s.elopId.includes(q));
        }
        return result.sort((a, b) => {
            const gradeOrder = ['TK', 'K', '1', '2', '3', '4', '5'];
            const gradeIndexA = gradeOrder.indexOf(a.grade);
            const gradeIndexB = gradeOrder.indexOf(b.grade);
            if (gradeIndexA !== gradeIndexB) return gradeIndexA - gradeIndexB;
            const nameCompare = a.firstName.localeCompare(b.firstName);
            if (nameCompare !== 0) return nameCompare;
            return a.lastName.localeCompare(b.lastName);
        });
    }, [students, selectedGrade, searchQuery, program, user, rosterStatusFilter]);

    const handleStudentAction = (student: Student) => {
        if (user && user.role !== 'Lead') {
            const staffMember = staffList.find(s => s.id === user.id);
            if (staffMember?.canCheckIn === false) {
                showToast("You do not have permission to check-in students.", "error");
                return;
            }
        }
        const latestStudent = students.find(s => s.id === student.id) || student;
        if (latestStudent.isCheckInBlocked) {
            showToast("This student is blocked from check-in. Contact Lead.", "error");
            return;
        }
        const status = program === 'sunrise' ? student.sunriseStatus : student.sunsetStatus;
        if (status === 'absent') {
            setShowConfirmId(student.id);
        } else {
            setActiveStudentId(student.id);
        }
    };

    const handleCheckIn = async (studentId: string, photo?: string, biometricData?: any) => {
        const now = new Date();
        const timeString = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const staffName = user ? `${user.name} (${user.organization})` : 'Staff';

        const checkInStudent = students.find(s => s.id === studentId);
        if (user && checkInStudent) {
            const checkedIn: Student = program === 'sunrise'
                ? { ...checkInStudent, sunriseStatus: 'present', sunriseTime: timeString, sunriseStaff: staffName }
                : { ...checkInStudent, sunsetStatus: 'present', sunsetTime: timeString, sunsetStaff: staffName };
            gdLogCheckIn(checkedIn, user, program);
            if (photo) gdUploadPhoto(checkedIn, photo, 'check-in', user);
        }

        setStudents(prev => prev.map(s => {
            if (s.id === studentId) {
                const update = program === 'sunrise'
                    ? { sunriseStatus: 'present' as AttendanceStatus, sunriseTime: timeString, sunriseStaff: staffName }
                    : { sunsetStatus: 'present' as AttendanceStatus, sunsetTime: timeString, sunsetStaff: staffName };
                return { ...s, ...update, checkInPhoto: photo, checkInSmsSent: true, checkInSmsTime: timeString };
            }
            return s;
        }));

        try {
            const updateData = program === 'sunrise'
                ? { sunrise_status: 'present', sunrise_checkin_time: timeString, sunrise_staff: staffName, checkin_photo: photo }
                : { sunset_status: 'present', sunset_checkin_time: timeString, sunset_staff: staffName, checkin_photo: photo };

            const student = students.find(s => s.id === studentId);
            if (student) {
                const contact1 = student.guardians.find(g => g.type === 'Contact 1');
                if (contact1?.phone) {
                    sendSmsMock(contact1.phone, 'checkin_notification', { student_name: student.firstName, time: timeString, staff_name: staffName, program: program.charAt(0).toUpperCase() + program.slice(1) });
                }
            }

            await supabase.from('students').update(updateData).eq('id', studentId);
        } catch (err) {
            console.error('Failed to update Supabase:', err);
            showToast('Offline mode: Change saved locally', 'info');
        }

        const student = students.find(s => s.id === studentId);
        if (student) {
            showToast(`Checked-In: ${student.firstName}`, 'success');
            if (biometricData) {
                const mockPhotos = MockDatabase.getPhotosForStudent(student);
                const newLog: BiometricLog = {
                    id: Date.now().toString(),
                    studentId,
                    studentName: `${student.firstName} ${student.lastName}`,
                    timestamp: new Date().toLocaleString(),
                    matchScore: 0.92,
                    anomalyScore: biometricData.anomalyScore,
                    anomalyDetected: biometricData.visualAnomalyDetected,
                    livePhoto: photo || '',
                    yearbookPhoto: student.yearbookPhotoUrl || mockPhotos.yearbook,
                    previousPhoto: student.lastCheckInPhoto || mockPhotos.previous
                };
                setBiometricLogs(prev => [newLog, ...prev]);
                if (user) gdLogBiometric(newLog, user);
                if (biometricData.visualAnomalyDetected) {
                    showToast('Visual Anomaly Detected - Review in dashboard', 'warning');
                }
                PasskeyService.uploadToDrive(photo || '', studentId);
            }
        }
        setShowConfirmId(null);
        setSearchQuery('');
    };

    const handleCheckOut = async (studentId: string, smsTime: string, checkOutBy?: string) => {
        setStudents(prev => prev.map(s => {
            if (s.id === studentId) {
                const update = program === 'sunrise'
                    ? { sunriseStatus: 'pending_parent' as AttendanceStatus }
                    : { sunsetStatus: 'pending_parent' as AttendanceStatus };
                return { ...s, ...update, smsSentTime: smsTime, lastCheckOutBy: checkOutBy };
            }
            return s;
        }));

        try {
            const updateData = program === 'sunrise'
                ? { sunrise_status: 'pending_parent', sms_sent_time: smsTime, last_checkout_by: checkOutBy }
                : { sunset_status: 'pending_parent', sms_sent_time: smsTime, last_checkout_by: checkOutBy };
            await supabase.from('students').update(updateData).eq('id', studentId);
        } catch (err) {
            console.error('Supabase update failed:', err);
        }

        setTimeout(() => {
            const now = new Date();
            const timeString = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const student = studentsRef.current.find(s => s.id === studentId);
            if (user && student) {
                const checkedOut: Student = program === 'sunrise'
                    ? { ...student, sunriseStatus: 'checked_out', sunriseCheckOutTime: timeString }
                    : { ...student, sunsetStatus: 'checked_out', sunsetCheckOutTime: timeString };
                gdLogCheckOut(checkedOut, user, program, checkOutBy);
            }
            setStudents(prev => prev.map(s => {
                if (s.id === studentId) {
                    const update = program === 'sunrise'
                        ? { sunriseStatus: 'checked_out' as AttendanceStatus, sunriseCheckOutTime: timeString }
                        : { sunsetStatus: 'checked_out' as AttendanceStatus, sunsetCheckOutTime: timeString };
                    const dbUpdate = program === 'sunrise'
                        ? { sunrise_status: 'checked_out', sunrise_checkout_time: timeString }
                        : { sunset_status: 'checked_out', sunset_checkout_time: timeString };
                    supabase.from('students').update(dbUpdate).eq('id', studentId);
                    return { ...s, ...update };
                }
                return s;
            }));
        }, 5000);
    };

    const handleSaveStudent = async (updatedStudent: Student) => {
        const oldStudent = students.find(s => s.id === updatedStudent.id);
        setStudents(prev => prev.map(s => s.id === updatedStudent.id ? updatedStudent : s));

        try {
            const updateData: any = {
                first_name: updatedStudent.firstName,
                last_name: updatedStudent.lastName,
                grade: updatedStudent.grade,
                elop_id: updatedStudent.elopId,
                ases_id: updatedStudent.asesId,
                guardians: updatedStudent.guardians,
                programs: updatedStudent.programs,
                has_snack: updatedStudent.hasSnack,
                behavior: updatedStudent.behavior,
                behavior_issues: updatedStudent.behaviorIssues,
                head_injury: updatedStudent.headInjury,
                head_injury_logs: updatedStudent.headInjuryLogs,
            };
            await supabase.from('students').update(updateData).eq('id', updatedStudent.id);
        } catch (err) {
            console.error('Failed to update student:', err);
            showToast('Failed to save changes to DB', 'error');
        }

        if (user && oldStudent) logStudentChanges(oldStudent, updatedStudent, user);

        // Auto-create head injury report draft
        if (oldStudent && !oldStudent.headInjury && updatedStudent.headInjury) {
            const headInjuryReport: ParentReport = {
                id: Date.now().toString(),
                studentId: updatedStudent.id,
                studentName: `${updatedStudent.firstName} ${updatedStudent.lastName}`,
                type: 'injury',
                message: `HEAD INJURY REPORT\n\nStudent: ${updatedStudent.firstName} ${updatedStudent.lastName}\nDate/Time: ${new Date().toLocaleString()}`,
                method: 'both',
                status: 'draft',
                createdAt: new Date().toISOString(),
                staffId: user?.id || 'unknown'
            };
            setParentReports(prev => [...prev, headInjuryReport]);
            showToast('Head Injury draft created', 'info');
        }

        // Auto-create behavior report draft when ticket is SUBMITTED (not just when behavior selected)
        const behaviorJustSubmitted = oldStudent && !oldStudent.behaviorSubmittedAt && updatedStudent.behaviorSubmittedAt;
        if (behaviorJustSubmitted) {
            const behaviorLabelMap: Record<string, string> = { green: 'Level 1 (Green)', yellow: 'Level 2 (Yellow)', red: 'Level 3 (Red)' };
            const ticketLevel = behaviorLabelMap[updatedStudent.behavior as string] || updatedStudent.behavior;
            const behaviorList = (updatedStudent.behaviorIssues || []).length > 0
                ? updatedStudent.behaviorIssues.map((b: string) => `• ${b}`).join('\n')
                : '• General behavior concern';
            const behaviorMessage = [
                `BEHAVIOR REPORT`,
                ``,
                `Student: ${updatedStudent.firstName} ${updatedStudent.lastName}`,
                `Date: ${new Date().toLocaleDateString()}`,
                `Time: ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
                `Ticket Level: ${ticketLevel}`,
                `Handling Staff: ${updatedStudent.behaviorStaff || 'EDP Staff'}`,
                `Staff Closest to Situation: ${updatedStudent.behaviorStaffSupport || 'N/A'}`,
                ``,
                `Checked Behaviors:`,
                behaviorList,
                ``,
                `Details of the Incident:`,
                updatedStudent.behaviorDescription || 'No details provided.',
                ``,
                `Actions Taken by Staff:`,
                updatedStudent.behaviorActions || 'No actions recorded.',
            ].join('\n');
            const behaviorReport: ParentReport = {
                id: Date.now().toString(),
                studentId: updatedStudent.id,
                studentName: `${updatedStudent.firstName} ${updatedStudent.lastName}`,
                type: 'behavior',
                message: behaviorMessage,
                method: 'both',
                status: 'draft',
                createdAt: new Date().toISOString(),
                staffId: user?.id || 'unknown'
            };
            setParentReports(prev => [...prev, behaviorReport]);
            showToast('Behavior report draft created', 'info');
        }
    };

    const logParentReport = (report: ParentReport, previous?: ParentReport) => {
        if (!user) return;
        // Log new reports and status changes (draft -> sent), not every draft keystroke
        if (previous && previous.status === report.status) return;
        const student = students.find(s => s.id === report.studentId);
        if (student) gdLogParentReport(student, report, user);
    };

    if (!user) return <StaffLogin onLogin={setUser} onToggleDemo={() => setIsDemoMode(!isDemoMode)} isDemoMode={isDemoMode} staffList={staffList} />;

    const activeStudent = students.find(s => s.id === activeStudentId);
    const confirmStudent = students.find(s => s.id === showConfirmId);

    return (
        <>
            <div className="sticky-header" style={{ position: 'fixed', top: 0, left: 0, right: 0, height: '80px', zIndex: 9999, backgroundColor: 'var(--bg-app)', paddingTop: 'env(safe-area-inset-top)', display: 'flex', flexDirection: 'column', borderBottom: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-sm)' }}>
                <header style={{ backgroundColor: 'var(--bg-header)', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '16px', width: '100%', flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                        <div style={{ width: '36px', height: '36px', borderRadius: '10px', backgroundColor: program === 'sunrise' ? 'var(--color-sunrise)' : 'var(--color-sunset)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white' }}>
                            <span className="material-icons-round" style={{ fontSize: '20px' }}>{program === 'sunrise' ? 'wb_sunny' : 'nights_stay'}</span>
                        </div>
                        <div>
                            <h1 style={{ margin: 0, fontSize: '16px', fontWeight: '800', color: 'var(--text-main)' }}>{program === 'sunrise' ? 'Sunrise' : 'Sunset'} {isDemoMode && <span style={{ fontSize: '10px', color: '#8b5cf6' }}>DEMO</span>}</h1>
                            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{new Date().toLocaleDateString()}</div>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <div onClick={() => setIsLeadMode(!isLeadMode)} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', borderRadius: '16px', backgroundColor: isLeadMode ? 'rgba(139,92,246,0.1)' : 'var(--bg-hover)', border: `1px solid ${isLeadMode ? '#8b5cf6' : 'var(--border-subtle)'}`, cursor: 'pointer' }}>
                            <span className="material-icons-round" style={{ fontSize: '16px', color: isLeadMode ? '#8b5cf6' : 'var(--text-secondary)' }}>{isLeadMode ? 'admin_panel_settings' : 'person'}</span>
                            <span style={{ fontSize: '11px', fontWeight: '700', color: isLeadMode ? '#8b5cf6' : 'var(--text-secondary)' }}>{isLeadMode ? 'LEAD' : 'STAFF'}</span>
                        </div>
                        <button onClick={() => { setActiveStudentId(null); setShowLeaderDashboard(false); setShowConfirmId(null); setReportData(null); }} style={{ padding: '6px', borderRadius: '10px', border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }} title="Home">
                            <span className="material-icons-round" style={{ fontSize: '20px' }}>home</span>
                        </button>
                        {isLeadMode && (
                            <button onClick={() => { setShowLeaderDashboard(true); setDashboardKey(prev => prev + 1); }} style={{ padding: '6px', borderRadius: '10px', border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }} title="Dashboard">
                                <span className="material-icons-round" style={{ fontSize: '20px' }}>dashboard</span>
                            </button>
                        )}
                        <button onClick={() => setDarkMode(!darkMode)} style={{ padding: '6px', borderRadius: '10px', border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }} title="Toggle Theme">
                            <span className="material-icons-round" style={{ fontSize: '20px' }}>{darkMode ? 'light_mode' : 'dark_mode'}</span>
                        </button>
                        <button onClick={() => setUser(null)} style={{ padding: '6px', borderRadius: '10px', border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-danger)', cursor: 'pointer' }} title="Logout">
                            <span className="material-icons-round" style={{ fontSize: '20px' }}>logout</span>
                        </button>
                        <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#374151', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '700' }}>{user.name.charAt(0)}</div>
                    </div>
                </header>
            </div>

            <main style={{ paddingTop: '80px', flex: 1, overflowY: 'auto', paddingBottom: '100px', height: '100%' }}>
                {!showLeaderDashboard && (
                    <div style={{ padding: '16px', backgroundColor: 'var(--bg-header)', borderBottom: '1px solid var(--border-subtle)', marginBottom: '16px', position: 'sticky', top: 0, zIndex: 900 }}>
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                            {['all', 'checked_in', 'checked_out'].map(tab => (
                                <button key={tab} onClick={() => setRosterStatusFilter(tab as any)} style={{ flex: 1, padding: '12px 16px', borderRadius: '12px', border: 'none', backgroundColor: rosterStatusFilter === tab ? 'var(--text-main)' : (darkMode ? 'rgba(255,255,255,0.1)' : '#e5e7eb'), color: rosterStatusFilter === tab ? 'var(--bg-card)' : (darkMode ? 'rgba(255,255,255,0.7)' : 'var(--text-main)'), fontWeight: '800', fontSize: '14px', cursor: 'pointer', transition: 'all 0.2s' }}>
                                    {tab === 'all' ? 'All Students' : tab === 'checked_in' ? 'Checked-In' : 'Checked-Out'}
                                </button>
                            ))}
                        </div>
                        <div style={{ position: 'relative', marginBottom: '16px' }}>
                            <span className="material-icons-round" style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', color: darkMode ? 'rgba(255,255,255,0.5)' : 'var(--text-muted)', fontSize: '20px' }}>search</span>
                            <input type="text" placeholder="Search student..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} style={{ width: '100%', padding: '16px 16px 16px 48px', borderRadius: '16px', border: 'none', backgroundColor: darkMode ? 'rgba(255,255,255,0.1)' : '#f3f4f6', fontSize: '16px', color: darkMode ? 'white' : 'var(--text-main)', boxSizing: 'border-box', outline: 'none' }} />
                        </div>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            {GRADES.map(g => (
                                <button key={g} onClick={() => setSelectedGrade(prev => prev === g ? 'All' : g)} style={{ padding: '10px 16px', borderRadius: '12px', border: 'none', backgroundColor: selectedGrade === g ? 'var(--text-main)' : (darkMode ? 'rgba(255,255,255,0.1)' : '#e5e7eb'), color: selectedGrade === g ? 'var(--bg-card)' : (darkMode ? 'rgba(255,255,255,0.7)' : 'var(--text-main)'), fontWeight: '800', fontSize: '14px', cursor: 'pointer', minWidth: '48px', transition: 'all 0.2s' }}>{g}</button>
                            ))}
                        </div>
                    </div>
                )}

                <div style={{ paddingTop: '16px' }}>
                    {filteredStudents.length === 0 ? (
                        <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                            <span className="material-icons-round" style={{ fontSize: '64px', marginBottom: '16px' }}>school</span>
                            <div style={{ fontSize: '18px', fontWeight: '600', marginBottom: '8px' }}>No Students Found</div>
                            <div style={{ fontSize: '14px' }}>Try adjusting your search or filters</div>
                        </div>
                    ) : (
                        filteredStudents.map(student => {
                            const status = program === 'sunrise' ? student.sunriseStatus : student.sunsetStatus;
                            const isPresent = status === 'present';
                            const isCheckedOut = status === 'checked_out' || status === 'pending_parent';
                            return (
                                <div key={student.id} className="student-card" onClick={() => !isPresent && !isCheckedOut ? handleStudentAction(student) : null} style={{ backgroundColor: 'var(--bg-card)', padding: '16px', borderRadius: '16px', marginBottom: '12px', boxShadow: 'var(--shadow-sm)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderLeft: `4px solid ${isPresent || isCheckedOut ? (status === 'checked_out' ? '#9ca3af' : '#10b981') : 'transparent'}`, cursor: isPresent || isCheckedOut ? 'default' : 'pointer', opacity: student.isCheckInBlocked ? 0.5 : 1 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                                        <div style={{ width: '48px', height: '48px', borderRadius: '12px', backgroundColor: 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: '700', color: 'var(--text-secondary)' }}>{student.grade}</div>
                                        <div>
                                            <div style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text-main)', marginBottom: '4px' }}>{student.firstName} {student.lastName}</div>
                                            <div style={{ display: 'flex', gap: '6px' }}>
                                                {student.programs.includes('ELOP') && <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', backgroundColor: '#dbeafe', color: '#1e40af', fontWeight: '700' }}>ELOP</span>}
                                                {student.programs.includes('ASES') && <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', backgroundColor: '#f3e8ff', color: '#6b21a8', fontWeight: '700' }}>ASES</span>}
                                            </div>
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                        {student.headInjury && <span className="material-icons-round" style={{ color: '#ef4444' }}>personal_injury</span>}
                                        {student.behavior !== 'none' && <span className="material-icons-round" style={{ color: '#10b981' }}>warning</span>}
                                        {status === 'absent' ? (
                                            <span className="material-icons-round" style={{ color: 'var(--border-subtle)' }}>radio_button_unchecked</span>
                                        ) : (
                                            <div style={{ textAlign: 'right' }}>
                                                <div style={{ fontSize: '12px', fontWeight: '700', color: status === 'checked_out' ? '#9ca3af' : status === 'pending_parent' ? '#8b5cf6' : '#10b981', textTransform: 'uppercase' }}>
                                                    {status === 'checked_out' ? 'CHECKED-OUT' : status === 'pending_parent' ? 'WAITING' : 'CHECKED-IN'}
                                                </div>
                                                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                                                    {status === 'checked_out'
                                                        ? `${program === 'sunrise' ? student.sunriseCheckOutTime : student.sunsetCheckOutTime} by ${program === 'sunrise' ? (student.sunriseStaff || 'Staff') : (student.sunsetStaff || 'Staff')}`
                                                        : `${program === 'sunrise' ? student.sunriseTime : student.sunsetTime} by ${program === 'sunrise' ? (student.sunriseStaff || 'Staff') : (student.sunsetStaff || 'Staff')}`
                                                    }
                                                </div>
                                            </div>
                                        )}
                                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                            {(isPresent || isCheckedOut) && (
                                                <>
                                                    {student.checkInPhoto && (
                                                        <img src={student.checkInPhoto} alt="Check-in" style={{ width: '40px', height: '40px', borderRadius: '50%', border: '2px solid #8b5cf6', objectFit: 'cover' }} />
                                                    )}
                                                    {student.yearbookPhotoUrl && (
                                                        <img src={student.yearbookPhotoUrl} alt="Yearbook" style={{ width: '40px', height: '40px', borderRadius: '50%', border: '2px solid var(--border-subtle)', objectFit: 'cover' }} />
                                                    )}
                                                </>
                                            )}
                                            <button onClick={(e) => { e.stopPropagation(); handleStudentAction(student); }} style={{ background: 'none', border: 'none', padding: '8px', cursor: 'pointer', color: 'var(--text-secondary)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                <span className="material-icons-round">more_vert</span>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </main>

            {showConfirmId && confirmStudent && createPortal(
                <ConfirmationModal student={confirmStudent} title="Check-In?" message={`Mark ${confirmStudent.firstName} as present?`} onConfirm={(photo, biometricData) => handleCheckIn(confirmStudent.id, photo, biometricData)} onCancel={() => setShowConfirmId(null)} showPhotoOption={true} isDemoMode={isDemoMode} darkMode={darkMode} />,
                document.body
            )}

            {activeStudentId && activeStudent && createPortal(
                <div style={{ position: 'fixed', top: '80px', left: 0, right: 0, bottom: 0, zIndex: 1000, backgroundColor: 'var(--bg-app)', overflowY: 'auto' }}>
                    <StudentDetailModal student={activeStudent} onClose={() => setActiveStudentId(null)} onSave={handleSaveStudent} onCheckOut={handleCheckOut} currentStaff={user} program={program} isLeadMode={isLeadMode} darkMode={darkMode} onUpdateReport={(report) => { setParentReports(prev => [...prev, report]); logParentReport(report); }} showToast={showToast} staffList={staffList} parentReports={parentReports} />
                </div>,
                document.body
            )}

            {showLeaderDashboard && createPortal(
                <div key={dashboardKey} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'var(--bg-app)', zIndex: 2000 }}>
                    <LeaderDashboard user={user} students={students} staffList={staffList} parentReports={parentReports} biometricLogs={biometricLogs} onClose={() => setShowLeaderDashboard(false)} onImport={(newStudents) => { setStudents([...students, ...newStudents]); newStudents.forEach(gdSyncStudentProfile); }} onAddStudent={(newStudent) => { setStudents([...students, newStudent]); gdSyncStudentProfile(newStudent); }} onUpdateStaff={(updatedStaff) => setStaffList(updatedStaff)} onUpdateStudent={handleSaveStudent} onUpdateReport={(updatedReport) => { logParentReport(updatedReport, parentReports.find(r => r.id === updatedReport.id)); setParentReports(prev => prev.some(r => r.id === updatedReport.id) ? prev.map(r => r.id === updatedReport.id ? updatedReport : r) : [...prev, updatedReport]); }} onDeleteReport={(reportId) => setParentReports(prev => prev.filter(r => r.id !== reportId))} onScheduleBatchCheckout={(time) => setScheduledBatchCheckoutTime(time)} showToast={showToast} isBatchDefaultEnabled={isBatchDefaultEnabled} setIsBatchDefaultEnabled={setIsBatchDefaultEnabled} defaultBatchTime={defaultBatchTime} setDefaultBatchTime={setDefaultBatchTime} scheduledBatchCheckoutTime={scheduledBatchCheckoutTime} darkMode={darkMode} />
                </div>,
                document.body
            )}

            {reportData && (
                <ParentReportModal student={reportData.student} type={reportData.type} onClose={() => setReportData(null)} onSend={(report) => { setParentReports(prev => [...prev, report]); logParentReport(report); showToast('Report sent!', 'success'); setReportData(null); }} onSaveDraft={(report) => { setParentReports(prev => [...prev, report]); logParentReport(report); showToast('Draft saved!', 'info'); setReportData(null); }} staffId={user?.id || 'unknown'} />
            )}

            {toast && <Toast message={toast.msg} type={toast.type} />}
        </>
    );
};

export default App;
