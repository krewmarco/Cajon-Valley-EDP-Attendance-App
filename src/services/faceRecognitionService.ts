/**
 * src/services/faceRecognitionService.ts
 *
 * Client for the local face recognizer (face-recognizer/, FastAPI). Used by the
 * Face Check-In demo screen: a camera frame goes in, the top candidates come
 * back keyed by ELOP ID, and an attendant confirms one.
 *
 * ACTIVATION: set VITE_FACE_API_URL (e.g. http://localhost:8000). When unset,
 * the feature is hidden and every call is a no-op.
 *
 * PRIVACY: frames are sent only to that local service, which scores them in
 * memory and discards them. Nothing here stores a frame.
 */

export type ConfidenceLevel = 'HIGH' | 'MODERATE' | 'LOW';

export interface FaceCandidate {
    elopId: string;
    score: number;
    level: ConfidenceLevel;
}

export interface FaceBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface RecognitionResult {
    ok: boolean;
    faceDetected: boolean;
    box: FaceBox | null;
    candidates: FaceCandidate[];
    inferenceMs?: number;
    error?: string;
}

const REQUEST_TIMEOUT_MS = 3000;

export function faceApiUrl(): string {
    return (import.meta.env.VITE_FACE_API_URL ?? '').replace(/\/+$/, '');
}

export function isFaceRecognitionEnabled(): boolean {
    return Boolean(faceApiUrl());
}

const EMPTY: RecognitionResult = { ok: false, faceDetected: false, box: null, candidates: [] };

/** Score one frame. Resolves (never rejects); `ok: false` on any failure. */
export async function recognizeFrame(frame: Blob, maxCandidates = 3, baseUrl = faceApiUrl()): Promise<RecognitionResult> {
    if (!baseUrl) return { ...EMPTY, error: 'Face recognition is not configured' };

    const form = new FormData();
    form.append('frame', frame, 'frame.jpg');
    form.append('max_candidates', String(maxCandidates));

    let res: Response;
    try {
        res = await fetch(`${baseUrl}/api/v1/recognize`, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch {
        return { ...EMPTY, error: 'Face service unreachable' };
    }
    if (!res.ok) return { ...EMPTY, error: `Face service error (HTTP ${res.status})` };

    let body: any;
    try {
        body = await res.json();
    } catch {
        return { ...EMPTY, error: 'Face service returned an invalid response' };
    }

    return {
        ok: true,
        faceDetected: Boolean(body.face_detected),
        box: body.bounding_box ?? null,
        candidates: (body.candidates ?? []).map((c: any) => ({
            elopId: String(c.label),
            score: Number(c.score),
            level: c.confidence_level as ConfidenceLevel,
        })),
        inferenceMs: body.inference_time_ms,
    };
}

export function studentPhotoUrl(elopId: string, baseUrl = faceApiUrl()): string {
    return `${baseUrl}/api/v1/students/${encodeURIComponent(elopId)}/photo`;
}
