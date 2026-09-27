// src/components/FaceCheckIn.tsx
// Demo: camera-first check-in. The face service suggests the top 3 students;
// the attendant confirms one (human in the loop). Frames stay in memory.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProgramType, Student } from '../types';
import {
    recognizeFrame,
    studentPhotoUrl,
    type ConfidenceLevel,
    type FaceBox,
    type RecognitionResult,
} from '../services/faceRecognitionService';

export type CheckInVerification =
    | { method: 'FACE_CONFIRMED'; confidenceScore: number }
    | { method: 'MANUAL' };

interface FaceCheckInProps {
    students: Student[];
    program: ProgramType;
    canCheckIn: boolean;
    onConfirm: (student: Student, verification: CheckInVerification) => void;
    onClose: () => void;
}

const FRAME_INTERVAL_MS = 600;
const SEND_WIDTH = 960;
const HOLD_LAST_MATCH_MS = 1500;   // keep candidates briefly if the face drops out
const PAUSE_AFTER_CONFIRM_MS = 2500;
const LEVEL_COLORS: Record<ConfidenceLevel, string> = { HIGH: '#10b981', MODERATE: '#f59e0b', LOW: '#9ca3af' };

interface ShownCandidate {
    student: Student;
    score: number;
    level: ConfidenceLevel;
}

function statusFor(student: Student, program: ProgramType) {
    return program === 'sunrise' ? student.sunriseStatus : student.sunsetStatus;
}

const FaceCheckIn = ({ students, program, canCheckIn, onConfirm, onClose }: FaceCheckInProps) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const grabRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
    const busyRef = useRef(false);
    const pausedRef = useRef(false);
    const lastMatchAtRef = useRef(0);

    const [cameraError, setCameraError] = useState<string | null>(null);
    const [serviceError, setServiceError] = useState<string | null>(null);
    const [candidates, setCandidates] = useState<ShownCandidate[]>([]);
    const [faceDetected, setFaceDetected] = useState(false);
    const [inferenceMs, setInferenceMs] = useState<number | null>(null);
    const [confirmed, setConfirmed] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [testPhotoUrl, setTestPhotoUrl] = useState<string | null>(null);

    const byElopId = useMemo(() => new Map(students.map(s => [s.elopId, s])), [students]);

    const drawBox = useCallback((box: FaceBox | null, width: number, height: number, level?: ConfidenceLevel) => {
        const canvas = overlayRef.current;
        if (!canvas) return;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, width, height);
        if (box) {
            ctx.lineWidth = Math.max(3, width / 240);
            ctx.strokeStyle = level ? LEVEL_COLORS[level] : '#ffffff';
            ctx.strokeRect(box.x, box.y, box.width, box.height);
        }
    }, []);

    const applyResult = useCallback((result: RecognitionResult, width: number, height: number) => {
        if (!result.ok) {
            setServiceError(result.error ?? 'Face service error');
            return;
        }
        setServiceError(null);
        setInferenceMs(result.inferenceMs ?? null);
        setFaceDetected(result.faceDetected);
        const shown = result.candidates
            .map(c => ({ student: byElopId.get(c.elopId), score: c.score, level: c.level }))
            .filter((c): c is ShownCandidate => Boolean(c.student));
        drawBox(result.box, width, height, shown[0]?.level);
        if (shown.length) {
            lastMatchAtRef.current = Date.now();
            setCandidates(shown);
        } else if (Date.now() - lastMatchAtRef.current > HOLD_LAST_MATCH_MS) {
            setCandidates([]);
        }
    }, [byElopId, drawBox]);

    // Camera (dev: ?camera=off skips it, e.g. to rehearse with test photos)
    useEffect(() => {
        if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('camera') === 'off') {
            setCameraError('camera disabled (?camera=off)');
            return;
        }
        let stream: MediaStream | null = null;
        navigator.mediaDevices?.getUserMedia({ video: { width: 1280, height: 720, facingMode: 'user' }, audio: false })
            .then(s => {
                stream = s;
                if (videoRef.current) videoRef.current.srcObject = s;
            })
            .catch(err => setCameraError(err?.message ?? 'Camera unavailable'));
        return () => stream?.getTracks().forEach(track => track.stop());
    }, []);

    // Recognition loop
    useEffect(() => {
        const timer = setInterval(async () => {
            const video = videoRef.current;
            if (busyRef.current || pausedRef.current || testPhotoUrl || !video || video.readyState < 2) return;
            busyRef.current = true;
            try {
                const grab = grabRef.current;
                grab.width = SEND_WIDTH;
                grab.height = Math.round(video.videoHeight * (SEND_WIDTH / video.videoWidth));
                grab.getContext('2d')?.drawImage(video, 0, 0, grab.width, grab.height);
                const blob = await new Promise<Blob | null>(resolve => grab.toBlob(resolve, 'image/jpeg', 0.85));
                if (blob && !pausedRef.current) applyResult(await recognizeFrame(blob), grab.width, grab.height);
            } finally {
                busyRef.current = false;
            }
        }, FRAME_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [applyResult, testPhotoUrl]);

    // Dev only: recognize a still photo instead of the camera
    const handleTestPhoto = async (file: File) => {
        if (testPhotoUrl) URL.revokeObjectURL(testPhotoUrl);
        const url = URL.createObjectURL(file);
        setTestPhotoUrl(url);
        const img = new Image();
        img.src = url;
        await img.decode();
        applyResult(await recognizeFrame(file), img.naturalWidth, img.naturalHeight);
    };
    const backToCamera = () => {
        if (testPhotoUrl) URL.revokeObjectURL(testPhotoUrl);
        setTestPhotoUrl(null);
        setCandidates([]);
        drawBox(null, 1, 1);
    };

    const confirm = (student: Student, verification: CheckInVerification) => {
        onConfirm(student, verification);
        pausedRef.current = true;
        setConfirmed(`${student.firstName} ${student.lastName}`);
        setCandidates([]);
        setQuery('');
        drawBox(null, 1, 1);
        setTimeout(() => {
            pausedRef.current = false;
            setConfirmed(null);
        }, PAUSE_AFTER_CONFIRM_MS);
    };

    const blockedReason = (student: Student, level?: ConfidenceLevel): string | null => {
        if (!canCheckIn) return 'You do not have check-in permission';
        // Below the match threshold: show for context, but don't invite a confirm (spec §2.2)
        if (level === 'LOW') return 'Low confidence — use manual search';
        if (student.isCheckInBlocked) return 'Check-in blocked — contact Lead';
        if (statusFor(student, program) !== 'absent') return 'Already checked in';
        return null;
    };

    const searchResults = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        return students
            .filter(s => `${s.firstName} ${s.lastName}`.toLowerCase().includes(q) || s.elopId.includes(q))
            .slice(0, 5);
    }, [query, students]);

    const card: React.CSSProperties = { backgroundColor: 'var(--bg-card)', borderRadius: '16px', padding: '16px', border: '1px solid var(--border-subtle)' };

    return (
        <div role="dialog" aria-modal="true" aria-labelledby="face-checkin-title" style={{ position: 'fixed', top: '80px', left: 0, right: 0, bottom: 0, zIndex: 2500, backgroundColor: 'var(--bg-app)', overflowY: 'auto' }}>
            <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                    <div>
                        <h2 id="face-checkin-title" style={{ margin: 0, fontSize: '20px', fontWeight: 800, color: 'var(--text-main)' }}>Face Check-In</h2>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            Demo classroom: adult volunteers and public photos · {program === 'sunrise' ? 'Sunrise' : 'Sunset'}
                        </div>
                    </div>
                    <button onClick={onClose} aria-label="Close face check-in" style={{ padding: '8px', borderRadius: '10px', border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                        <span className="material-icons-round">close</span>
                    </button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px', alignItems: 'start' }}>
                    {/* Camera */}
                    <div style={card}>
                        <div style={{ position: 'relative', backgroundColor: '#000', borderRadius: '12px', overflow: 'hidden', aspectRatio: '16 / 9' }}>
                            {/* The video stays mounted so the camera stream survives test-photo mode */}
                            <video ref={videoRef} autoPlay playsInline muted style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', transform: 'scaleX(-1)', visibility: testPhotoUrl ? 'hidden' : 'visible' }} />
                            {testPhotoUrl && (
                                <img src={testPhotoUrl} alt="Test photo" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }} />
                            )}
                            <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', transform: testPhotoUrl ? 'none' : 'scaleX(-1)', pointerEvents: 'none' }} />
                            {confirmed && (
                                <div role="status" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(16,185,129,0.85)', color: 'white', fontSize: '22px', fontWeight: 800, textAlign: 'center', padding: '16px' }}>
                                    <span className="material-icons-round" style={{ fontSize: '32px', marginRight: '8px' }}>check_circle</span>
                                    Checked in: {confirmed}
                                </div>
                            )}
                        </div>
                        <div style={{ marginTop: '8px', fontSize: '12px', color: cameraError || serviceError ? 'var(--color-danger)' : 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                            <span>
                                {cameraError ? `Camera unavailable: ${cameraError}` : serviceError ? serviceError
                                    : testPhotoUrl ? 'Test photo' : faceDetected ? 'Face detected' : 'Looking for a face…'}
                            </span>
                            {inferenceMs !== null && !serviceError && <span>{Math.round(inferenceMs)} ms</span>}
                        </div>
                        {import.meta.env.DEV && (
                            <div style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', color: 'var(--text-secondary)' }}>
                                <label style={{ cursor: 'pointer', textDecoration: 'underline' }}>
                                    Use test photo (dev)
                                    <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => e.target.files?.[0] && handleTestPhoto(e.target.files[0])} />
                                </label>
                                {testPhotoUrl && <button type="button" onClick={backToCamera} style={{ fontSize: '12px', border: 'none', background: 'none', color: 'var(--color-primary)', cursor: 'pointer' }}>Back to camera</button>}
                            </div>
                        )}
                    </div>

                    {/* Candidates */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-main)' }}>Matching suggestions</div>
                        {candidates.length === 0 && (
                            <div style={{ ...card, textAlign: 'center', color: 'var(--text-secondary)', fontSize: '14px' }}>
                                <span className="material-icons-round" style={{ fontSize: '36px', display: 'block', marginBottom: '4px' }}>face</span>
                                {confirmed ? 'Ready for the next student…' : 'Waiting for a student in front of the camera…'}
                            </div>
                        )}
                        {candidates.length > 0 && candidates[0].level === 'LOW' && (
                            <div role="status" style={{ ...card, borderColor: '#f59e0b', color: 'var(--text-main)', fontSize: '14px', fontWeight: 600 }}>
                                No confident match in this class. Check the student manually below.
                            </div>
                        )}
                        {candidates.map((c, i) => {
                            const reason = blockedReason(c.student, c.level);
                            const color = LEVEL_COLORS[c.level];
                            return (
                                <div key={c.student.id} style={{ ...card, borderColor: i === 0 ? color : 'var(--border-subtle)', borderWidth: i === 0 ? '2px' : '1px', opacity: i === 0 ? 1 : 0.85 }}>
                                    <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                                        <img src={c.student.yearbookPhotoUrl || studentPhotoUrl(c.student.elopId)} alt="" style={{ width: '64px', height: '64px', borderRadius: '12px', objectFit: 'cover', backgroundColor: 'var(--bg-input)', flexShrink: 0 }} />
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                                                <span style={{ fontWeight: 800, fontSize: '16px', color: 'var(--text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {c.student.firstName} {c.student.lastName}
                                                </span>
                                                <span style={{ fontSize: '12px', fontWeight: 800, color: 'white', backgroundColor: color, padding: '2px 8px', borderRadius: '999px', whiteSpace: 'nowrap' }}>
                                                    {Math.round(c.score * 100)}% · {c.level}
                                                </span>
                                            </div>
                                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Grade {c.student.grade} · ELOP {c.student.elopId}</div>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={Boolean(reason) || Boolean(confirmed)}
                                        onClick={() => confirm(c.student, { method: 'FACE_CONFIRMED', confidenceScore: c.score })}
                                        style={{ marginTop: '12px', width: '100%', minHeight: '48px', borderRadius: '12px', border: 'none', fontWeight: 800, fontSize: '15px', cursor: reason ? 'not-allowed' : 'pointer', backgroundColor: reason ? 'var(--bg-hover)' : i === 0 ? '#8b5cf6' : 'var(--text-main)', color: reason ? 'var(--text-secondary)' : i === 0 ? 'white' : 'var(--bg-card)' }}
                                    >
                                        {reason ?? 'Confirm & Check-In'}
                                    </button>
                                </div>
                            );
                        })}

                        {/* Manual fallback */}
                        <div style={card}>
                            <label htmlFor="face-manual-search" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>Manual search</label>
                            <input
                                id="face-manual-search"
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder="Student name or ELOP ID"
                                style={{ marginTop: '6px', width: '100%', padding: '12px', borderRadius: '10px', border: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-input)', color: 'var(--text-main)', fontSize: '15px', boxSizing: 'border-box' }}
                            />
                            {searchResults.map(s => {
                                const reason = blockedReason(s);
                                return (
                                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                                        <span style={{ fontSize: '14px', color: 'var(--text-main)' }}>{s.firstName} {s.lastName} <span style={{ color: 'var(--text-secondary)' }}>· {s.elopId}</span></span>
                                        <button type="button" disabled={Boolean(reason)} onClick={() => confirm(s, { method: 'MANUAL' })} style={{ padding: '8px 12px', borderRadius: '10px', border: 'none', fontWeight: 700, fontSize: '13px', cursor: reason ? 'not-allowed' : 'pointer', backgroundColor: reason ? 'var(--bg-hover)' : 'var(--text-main)', color: reason ? 'var(--text-secondary)' : 'var(--bg-card)' }}>
                                            {reason ?? 'Check In'}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default FaceCheckIn;
