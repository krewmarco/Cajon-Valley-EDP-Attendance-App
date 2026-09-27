import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recognizeFrame, studentPhotoUrl } from './faceRecognitionService';

const BASE = 'http://face.test:8000';
const frame = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('recognizeFrame', () => {
    it('is a no-op when the face service is not configured', async () => {
        const result = await recognizeFrame(frame, 3, '');
        expect(result).toMatchObject({ ok: false, candidates: [] });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts the frame as multipart and maps candidates to ELOP IDs', async () => {
        fetchMock.mockResolvedValue(jsonResponse(200, {
            face_detected: true,
            bounding_box: { x: 10, y: 20, width: 100, height: 120 },
            candidates: [
                { label: '3031', score: 0.71, confidence_level: 'HIGH' },
                { label: '3007', score: 0.21, confidence_level: 'LOW' },
            ],
            inference_time_ms: 12.5,
        }));

        const result = await recognizeFrame(frame, 3, BASE);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`${BASE}/api/v1/recognize`);
        expect(init.method).toBe('POST');
        expect(init.body).toBeInstanceOf(FormData);
        expect((init.body as FormData).get('max_candidates')).toBe('3');
        expect((init.body as FormData).get('frame')).toBeInstanceOf(Blob);
        expect(result).toEqual({
            ok: true,
            faceDetected: true,
            box: { x: 10, y: 20, width: 100, height: 120 },
            candidates: [
                { elopId: '3031', score: 0.71, level: 'HIGH' },
                { elopId: '3007', score: 0.21, level: 'LOW' },
            ],
            inferenceMs: 12.5,
        });
    });

    it('reports no face without candidates', async () => {
        fetchMock.mockResolvedValue(jsonResponse(200, { face_detected: false, bounding_box: null, candidates: [] }));
        expect(await recognizeFrame(frame, 3, BASE)).toMatchObject({ ok: true, faceDetected: false, box: null, candidates: [] });
    });

    it('never throws when the service is down, errors, or returns garbage', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        expect(await recognizeFrame(frame, 3, BASE)).toMatchObject({ ok: false, error: 'Face service unreachable' });

        fetchMock.mockResolvedValueOnce(jsonResponse(500, { detail: 'boom' }));
        expect(await recognizeFrame(frame, 3, BASE)).toMatchObject({ ok: false, error: 'Face service error (HTTP 500)' });

        fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
        expect(await recognizeFrame(frame, 3, BASE)).toMatchObject({ ok: false });
    });
});

describe('studentPhotoUrl', () => {
    it('builds an encoded photo URL', () => {
        expect(studentPhotoUrl('3031', BASE)).toBe(`${BASE}/api/v1/students/3031/photo`);
        expect(studentPhotoUrl('a/b', BASE)).toBe(`${BASE}/api/v1/students/a%2Fb/photo`);
    });
});
