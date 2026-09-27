# Facial Recognition Attendance System Specification

**Version:** 1.0.0  
**Target Platform:** Mobile / Tablet Web Application (React) & Local Inference Engine  
**Role:** AI-Assisted Student Recognition, Human-in-the-Loop Confirmation & Attendance Dispatch  
**Compliance Target:** FERPA (Family Educational Rights and Privacy Act) & California AB 1584  

---

## Status & Corrections (2026-09-26)

**Status:** specification only; nothing is implemented. A standalone prototype is being built from [`plans/face_recognizer_prototype.md`](../plans/face_recognizer_prototype.md). Where the two disagree, this section and that brief take precedence over the original text below.

1. **Model licensing (§2.1, §6.1):** InsightFace's pretrained models, including `buffalo_l`, are licensed for **non-commercial research only**. A district deployment likely needs a different model or a license. The prototype uses OpenCV **YuNet** (MIT) for detection and **SFace** (Apache-2.0) for embeddings, behind an interface so other models can be benchmarked.
2. **Embeddings are biometric data (§4.2 is incorrect):** published research shows faces can be approximately reconstructed from embeddings, and a stored embedding can still identify a person. Treat embeddings with the same protection as photos (access control, retention limits, deletion on request). Don't describe them as irreversible or anonymous.
3. **Thresholds (§2.2) are placeholders:** 0.74 / 0.58 are not calibrated for any specific model. Thresholds depend on the model (OpenCV's SFace reference is about 0.363) and must be measured, and measured again on the target population. Children's faces differ from adult benchmarks and change over a school year.
4. **Consent and approval come first:** no student photos, embeddings, or recognition trials happen before written district approval, a legal review (FERPA, SOPIPA, CA AB 1584, and any district biometric policy), and parental consent with an opt-out that has a non-biometric check-in path. The prototype enrolls only the project owner, with their consent.
5. **"On-premises" vs. development:** the prototype may run in a cloud development sandbox **only** with the owner's own photos. Student data must stay under the on-premises / district-approved rules in §4.
6. **Integration with the existing app:**
   - Dongle dispatch (§3.2) must go through the dongle manager and `scannerDongleService` (#1), not a client-supplied `target_dongle_url`. Letting the client supply a URL the backend posts to is a server-side request forgery risk.
   - The audit log (§4.3) should be a provider in the audit-log system (#2).
   - The UI (§5.3) must use the app's inline-style conventions; the app doesn't use Tailwind.
   - The app's existing check-in "face verification" is a mock (`ConfirmationModal` / `MockDatabase`, with a hardcoded 0.92 score). That is where a real recognizer would plug in.

---

## 1. System Overview & Workflow

### 1.1 Purpose
The **Facial Recognition Attendance System** accelerates elementary school arrival and departure check-ins by identifying students via a live camera stream on an attendant's tablet or mobile device. Rather than performing unmonitored automated check-ins, the system operates strictly with a **Human-in-the-Loop (HITL)** architecture:
1. The camera captures a student entering the check-in queue.
2. The local inference engine extracts facial embeddings and queries a pre-enrolled vector database.
3. The UI presents the **Top 3 Candidate Matches** with confidence ratings and side-by-side yearbook photos.
4. An authorized staff attendant visually confirms the identity with a single tap (`[ Confirm & Check-In ]`) or manually overrides the selection.
5. Upon confirmation, the verified Student ID is dispatched simultaneously to the primary Attendance Database and the downstream Hardware Scanner Emulator (injecting into the host SIS portal).

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          ATTENDANT TABLET / MOBILE UI                           │
│  ┌───────────────────────────┐         ┌─────────────────────────────────────┐  │
│  │   Live Camera Stream      │         │   Candidate #1 (94% Match)          │  │
│  │   - Face Bounding Box     │ ──────> │   [Yearbook Photo] Liam Garcia, 3rd │  │
│  │   - Focus / Lighting Aid  │         │   Button: [ Confirm & Check-In ]    │  │
│  └───────────────────────────┘         ├─────────────────────────────────────┤  │
│  ┌───────────────────────────┐         │   Candidate #2 (68% Match)          │  │
│  │   Manual Search / Override│         ├─────────────────────────────────────┤  │
│  └───────────────────────────┘         │   Candidate #3 (52% Match)          │  │
│                                        └─────────────────────────────────────┘  │
└───────────────────────────────────────┬─────────────────────────────────────────┘
                                        │ Attendant One-Tap Confirmation
                                        ▼
             ┌──────────────────────────────────────────────────────┐
             │            Local Face Recognition Backend            │
             │  - Ephemeral Vector Extraction (InsightFace ArcFace) │
             │  - Cosine Search (<50ms via ChromaDB / FAISS)        │
             │  - FERPA Data Minimization (Raw photos purged)       │
             └──────────┬────────────────────────────────┬──────────┘
                        │                                │
                        ▼                                ▼
         ┌──────────────────────────────┐ ┌──────────────────────────────┐
         │ Attendance App / Supabase DB │ │ ESP32-S3 Scanner Emulator    │
         │ - Marks Daily Attendance     │ │ - Native USB Keystroke Burst │
         │ - Attendant Audit Log        │ │ - Types ID into SIS Portal   │
         └──────────────────────────────┘ └──────────────────────────────┘
```

---

## 2. Server Architecture & Facial Vector Pipeline

### 2.1 Technology Stack
- **API Runtime:** Python 3.11 with FastAPI (asynchronous, high-throughput REST + WebSockets).
- **Inference Runtime:** ONNX Runtime / TensorRT with CPU and CUDA/Metal acceleration.
- **Face Detection Backbone:** SCRFD (Sample and Computation Redistribution for Efficient Face Detection) — ultra-fast 2.5G FLOPs model optimized for diverse angles and youth facial structures.
- **Feature Extraction / Embedding Model:** ArcFace (ResNet-50 / MobileFaceNet backbone) outputting a **512-dimensional normalized L2 floating-point embedding vector**.
- **Vector Database:** Local embedded ChromaDB or FAISS index storing pre-enrolled vectors indexed by canonical `student_id`.

### 2.2 Matching Algorithm & Confidence Thresholds
Vector similarity is computed using normalized Cosine Similarity:
$$\text{Similarity}(A, B) = \frac{A \cdot B}{\|A\|_2 \|B\|_2} = \sum_{i=1}^{512} A_i B_i$$

| Similarity Score Range | UI Classification | Visual Indicator | System Action |
|---|---|---|---|
| **$\ge 0.74$** | High Confidence | Green Badge | Highlighted as primary recommendation. |
| **$0.58 \le \text{Score} < 0.74$** | Moderate Confidence | Yellow Badge | Displayed as candidate; attendant must scrutinize. |
| **$< 0.58$** | Low Confidence / Ambiguous | Red / Gray Badge | Suppressed or flagged as unverified; prompts manual search. |

### 2.3 Student Pre-Enrollment & Vector Indexing Pipeline
Before real-time recognition operates, the vector index is populated from official student yearbook or SIS enrollment photographs:
1. **Intake:** Ingest high-resolution portrait photos (`POST /api/v1/students/enroll`).
2. **Quality Gates:**
   - Single face detection check (reject photos with multiple individuals).
   - Minimum face bounding box size: $\ge 112 \times 112$ pixels.
   - Yaw / Pitch tilt within $\pm 25^\circ$.
   - Sharpness / Laplacian variance score $\ge 100$.
3. **Embedding Generation:** Extract the 512-dim vector.
4. **Vector Storage:** Persist the vector in ChromaDB with metadata: `{ "student_id": "10042", "grade": "3", "enrolled_at": 1774742000 }`.
5. **Raw Image Disposal:** The raw enrollment image is moved to secure district cloud storage (or Supabase Storage) with restricted RLS; only the vector is kept in the local search index.

---

## 3. Backend API Specifications

### 3.1 Real-Time Recognition Endpoint
`POST /api/v1/recognize`

**Request:** `multipart/form-data`
- `frame`: JPEG/PNG binary image from camera stream.
- `station_id`: String identifier of the check-in station (e.g. `"gate-a-kiosk"`).
- `max_candidates`: Integer (Default: `3`).

**Response Schema (`application/json`):**
```json
{
  "inference_time_ms": 38.4,
  "face_detected": true,
  "bounding_box": {
    "x": 142,
    "y": 88,
    "width": 196,
    "height": 240
  },
  "candidates": [
    {
      "student_id": "10042",
      "first_name": "Liam",
      "last_name": "Garcia",
      "grade": "3",
      "confidence_score": 0.892,
      "confidence_level": "HIGH",
      "yearbook_photo_url": "/api/v1/students/10042/thumbnail"
    },
    {
      "student_id": "10087",
      "first_name": "Mateo",
      "last_name": "Rodriguez",
      "grade": "3",
      "confidence_score": 0.641,
      "confidence_level": "MODERATE",
      "yearbook_photo_url": "/api/v1/students/10087/thumbnail"
    },
    {
      "student_id": "10115",
      "first_name": "Lucas",
      "last_name": "Smith",
      "grade": "4",
      "confidence_score": 0.512,
      "confidence_level": "LOW",
      "yearbook_photo_url": "/api/v1/students/10115/thumbnail"
    }
  ]
}
```

### 3.2 Confirmation & Dispatch Endpoint
`POST /api/v1/attendance/confirm`

Transmits the attendant's verified decision, updating attendance databases and triggering the downstream scanner emulator.

**Request Body Schema:**
```json
{
  "student_id": "10042",
  "attendant_id": "staff_veronica",
  "verification_method": "AI_CONFIRMED",
  "confidence_score": 0.892,
  "station_id": "gate-a-kiosk",
  "target_dongle_url": "http://esp32-scanner-01.local:8080/api/v1/inject",
  "timestamp": "2026-09-26T16:35:00.120Z"
}
```

**Response Body:**
```json
{
  "status": "CONFIRMED",
  "student_id": "10042",
  "attendance_recorded": true,
  "dongle_injected": true,
  "audit_log_id": "aud_8971239841"
}
```

---

## 4. FERPA Compliance, Privacy & Student Data Protection

Elementary school student biometrics are subject to stringent state and federal regulations (**FERPA**, **COPPA**, California Student Online Personal Information Protection Act **SOPIPA**, and CA AB 1584).

```
┌────────────────────────────────────────────────────────────────────────┐
│                   FERPA BIOMETRIC COMPLIANCE PRINCIPLES                │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Data Minimization: Ephemeral RAM processing only (zero disk write)  │
│ 2. Non-Reversibility: Mathematical embeddings cannot reconstruct faces │
│ 3. On-Premises Isolation: No third-party public cloud biometric APIs   │
│ 4. Comprehensive Audit Trail: Every check-in logged to school staff    │
│ 5. Human-in-the-Loop: AI never executes unattended autonomous actions  │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Ephemeral Memory Ingestion (Zero Disk Write Policy)
- Live camera frames submitted to `POST /api/v1/recognize` are held exclusively in volatile RAM buffers during feature extraction.
- **Immediate Purge:** As soon as the 512-dim embedding is extracted, the buffer is explicitly freed and deallocated.
- Temporary files, thumbnail caches of live webcam frames, and unconfirmed capture images are **never written to disk or database logs**.

### 4.2 Irreversibility of Vector Embeddings
- The system stores only high-dimensional coordinate projections ($R^{512}$).
- Mathematical embeddings are mathematically non-invertible: it is computationally impossible to reconstruct a student's original biometric face image from a 512-float vector.

### 4.3 Immutable Audit Logging Schema
To maintain institutional accountability, every check-in event logs the authorizing staff member:

```sql
CREATE TABLE biometric_attendance_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    student_id VARCHAR(64) NOT NULL REFERENCES students(id),
    station_id VARCHAR(64) NOT NULL,
    verified_by_staff_id VARCHAR(64) NOT NULL,
    verification_method VARCHAR(32) NOT NULL, -- 'AI_CONFIRMED' | 'MANUAL_OVERRIDE'
    ai_confidence_score NUMERIC(5, 4),
    target_dongle_ip VARCHAR(45),
    keystroke_injected BOOLEAN NOT NULL DEFAULT FALSE,
    audit_hash VARCHAR(64) NOT NULL -- SHA256(timestamp + student_id + staff_id + method)
);
```

---

## 5. Attendant UI/UX Design & Frontend Workflow

### 5.1 Design Principles & Ergonomics
- **Tablet-First UI:** Optimized for iPads or Android tablets mounted on check-in podiums or carried by staff.
- **Split View:** Left side displays the continuous camera viewfinder; right side displays real-time candidate cards.
- **Large Tap Targets:** Minimum $56 \times 56$ pt touch targets for one-handed thumb interaction during busy morning rushes.
- **High-Visibility Status Badges:** Clear color-coded confidence indicators so attendants can make sub-second decisions.

### 5.2 Attendant Interface Layout (React / Tailwind)

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ [● EDP Attendance] Station: Gate-A Podium  |  Dongle: [● Online (01.local)]  | Staff: VT│
├─────────────────────────────────────────┬───────────────────────────────────────────────┤
│ LIVE CAMERA VIEWFINDER                  │ CANDIDATE SUGGESTIONS                         │
│                                         │                                               │
│  ┌───────────────────────────────────┐  │  ┌─────────────────────────────────────────┐  │
│  │                                   │  │  │ [92% Match] Liam Garcia - Grade 3       │  │
│  │           [ Face Box ]            │  │  │ [Yearbook Img]   Room: 14 | ELOP: 1042  │  │
│  │           Liam Garcia?            │  │  │                                         │  │
│  │           (0.92 Match)            │  │  │  [ ✔ CONFIRM & CHECK-IN (ENTER) ]       │  │
│  │                                   │  │  └─────────────────────────────────────────┘  │
│  │                                   │  │  ┌─────────────────────────────────────────┐  │
│  │                                   │  │  │ [64% Match] Mateo Rodriguez - Grade 3   │  │
│  │                                   │  │  │ [Yearbook Img]   Room: 12 | ELOP: 1087  │  │
│  │                                   │  │  │  [ Select ]                             │  │
│  └───────────────────────────────────┘  │  └─────────────────────────────────────────┘  │
│  [ Flip Camera ]  [ Freeze Viewfinder ] │                                               │
│                                         │  ┌─────────────────────────────────────────┐  │
│  MANUAL OVERRIDE / SEARCH:              │  │ [🔍 Search student by name or ID...   ] │  │
│  [ Type student name or ID...         ] │  │ [ Manual Check-In ]                     │  │
└─────────────────────────────────────────┴───────────────────────────────────────────────┘
```

### 5.3 React UI Component Implementation

```tsx
// src/components/FaceRecognizerAttendant.tsx
import React, { useState, useRef, useEffect, useCallback } from 'react';

interface Candidate {
  student_id: string;
  first_name: string;
  last_name: string;
  grade: string;
  confidence_score: number;
  confidence_level: 'HIGH' | 'MODERATE' | 'LOW';
  yearbook_photo_url: string;
}

export const FaceRecognizerAttendant: React.FC<{
  stationId: string;
  dongleUrl: string;
  attendantId: string;
  onAttendanceConfirmed: (studentId: string) => void;
}> = ({ stationId, dongleUrl, attendantId, onAttendanceConfirmed }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [dongleStatus, setDongleStatus] = useState<'READY' | 'SENDING' | 'ERROR'>('READY');
  const [manualQuery, setManualQuery] = useState('');

  // Start Camera Stream
  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ 
      video: { width: 1280, height: 720, facingMode: 'user' } 
    }).then(stream => {
      if (videoRef.current) videoRef.current.srcObject = stream;
    }).catch(err => console.error("Camera access failed:", err));
  }, []);

  // Frame Capture & Recognition Loop (every 800ms)
  const captureAndRecognize = useCallback(async () => {
    if (isProcessing || !videoRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (video.readyState !== 4) return;

    canvas.width = 480;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(async (blob) => {
      if (!blob) return;
      setIsProcessing(true);
      const formData = new FormData();
      formData.append('frame', blob);
      formData.append('station_id', stationId);

      try {
        const res = await fetch('/api/v1/recognize', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.face_detected && data.candidates) {
          setCandidates(data.candidates);
        }
      } catch (err) {
        console.error("Recognition error:", err);
      } finally {
        setIsProcessing(false);
      }
    }, 'image/jpeg', 0.85);
  }, [isProcessing, stationId]);

  useEffect(() => {
    const timer = setInterval(captureAndRecognize, 800);
    return () => clearInterval(timer);
  }, [captureAndRecognize]);

  // One-Tap Confirmation Action
  const handleConfirm = async (candidate: Candidate) => {
    setDongleStatus('SENDING');
    try {
      // 1. Dispatch confirmation to backend & trigger dongle keystrokes
      const res = await fetch('/api/v1/attendance/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_id: candidate.student_id,
          attendant_id: attendantId,
          verification_method: 'AI_CONFIRMED',
          confidence_score: candidate.confidence_score,
          station_id: stationId,
          target_dongle_url: dongleUrl,
          timestamp: new Date().toISOString()
        })
      });

      if (!res.ok) throw new Error("Confirmation failed");
      
      setDongleStatus('READY');
      onAttendanceConfirmed(candidate.student_id);
      // Reset candidates for next student in queue
      setCandidates([]);
    } catch (err) {
      console.error(err);
      setDongleStatus('ERROR');
    }
  };

  return (
    <div className="flex h-screen bg-slate-900 text-white p-4 gap-4">
      {/* Hidden processing canvas */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Left: Viewfinder */}
      <div className="flex-1 flex flex-col bg-slate-800 rounded-2xl overflow-hidden border border-slate-700">
        <div className="p-3 bg-slate-950/60 flex justify-between items-center">
          <span className="text-sm font-semibold tracking-wide">Live Attendant Viewfinder</span>
          <span className={`text-xs px-2 py-1 rounded font-bold ${
            dongleStatus === 'READY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
          }`}>
            Dongle: {dongleStatus}
          </span>
        </div>
        <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          {/* Target Reticle */}
          <div className="absolute w-64 h-64 border-2 border-indigo-400/60 rounded-3xl pointer-events-none flex items-center justify-center">
            <span className="text-xs text-indigo-300 bg-slate-900/80 px-2 py-1 rounded">Position Student Face</span>
          </div>
        </div>
      </div>

      {/* Right: Candidate Matches */}
      <div className="w-96 flex flex-col bg-slate-800 rounded-2xl border border-slate-700 p-4 gap-3">
        <h2 className="text-base font-bold text-slate-200">Matching Suggestions</h2>

        {candidates.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-sm">
            <span className="material-icons-round text-4xl mb-2 text-slate-500">face</span>
            Waiting for student in viewfinder...
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-3">
            {candidates.map((cand, idx) => (
              <div 
                key={cand.student_id} 
                className={`p-3 rounded-xl border flex flex-col gap-2 ${
                  idx === 0 
                    ? 'bg-slate-700/80 border-indigo-500/60 shadow-lg' 
                    : 'bg-slate-800/80 border-slate-700 opacity-80'
                }`}
              >
                <div className="flex items-center gap-3">
                  <img 
                    src={cand.yearbook_photo_url} 
                    alt={cand.first_name} 
                    className="w-14 h-14 rounded-lg object-cover border border-slate-600 bg-slate-900" 
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h3 className="font-bold text-sm truncate">{cand.first_name} {cand.last_name}</h3>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${
                        cand.confidence_level === 'HIGH' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
                      }`}>
                        {Math.round(cand.confidence_score * 100)}%
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">Grade {cand.grade} • ID: {cand.student_id}</p>
                  </div>
                </div>

                <button
                  onClick={() => handleConfirm(cand)}
                  className={`w-full py-2.5 rounded-lg font-bold text-xs flex items-center justify-center gap-2 ${
                    idx === 0 
                      ? 'bg-indigo-600 hover:bg-indigo-500 text-white' 
                      : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                  }`}
                >
                  <span className="material-icons-round text-base">check_circle</span>
                  Confirm & Check-In
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Manual Fallback Input */}
        <div className="pt-2 border-t border-slate-700">
          <input
            type="text"
            placeholder="Manual Search (Name or ID)..."
            value={manualQuery}
            onChange={(e) => setManualQuery(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-xs text-white placeholder-slate-500 outline-none focus:border-indigo-500"
          />
        </div>
      </div>
    </div>
  );
};
```

---

## 6. Containerization & Deployment Setup

### 6.1 Docker Stack (`docker-compose.yml`)
The full face recognition pipeline is packaged for self-hosted local school deployment:

```yaml
version: '3.8'

services:
  # Python FastAPI Vector Inference Service
  face-inference-engine:
    image: cajonvalley/edp-face-recognizer:1.0.0
    container_name: edp-face-engine
    restart: unless-stopped
    ports:
      - "8000:8000"
    environment:
      - MODEL_NAME=buffalo_l
      - DETECTION_THRESHOLD=0.65
      - MATCH_CONFIDENCE_THRESHOLD=0.58
      - VECTOR_DB_PATH=/data/chroma
      - LOG_LEVEL=info
    volumes:
      - face_vectors_data:/data/chroma
      - ./models:/root/.insightface/models
    deploy:
      resources:
        limits:
          cpus: '4.00'
          memory: 4G

  # Frontend Attendant Web App
  attendant-ui:
    image: node:20-alpine
    container_name: edp-attendant-ui
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - VITE_FACE_API_URL=http://face-inference-engine:8000
    volumes:
      - ./:/app
    working_dir: /app
    command: npm run dev

volumes:
  face_vectors_data:
```

### 6.2 Hardware Sizing Recommendations
- **Edge Mini-PC / Classroom Station:** Intel N100 / Core i5 8GB RAM (runs CPU ONNX inference at ~45ms per frame).
- **Central District Server:** 8-core CPU or NVIDIA RTX A2000 (serves up to 20 simultaneous tablet video streams with latency $<20\text{ms}$).
