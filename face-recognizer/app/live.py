"""Optional live webcam demo page (LIVE_DEMO=1). The browser captures frames in
memory and posts them to /api/v1/recognize; nothing is recorded or stored."""

LIVE_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Face Recognizer Live Test</title>
<style>
  :root { --bg:#f4f5f7; --card:#fff; --text:#1f2937; --muted:#6b7280; --border:#e5e7eb;
          --high:#059669; --moderate:#d97706; --low:#9ca3af; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f172a; --card:#1e293b; --text:#f1f5f9; --muted:#94a3b8; --border:#334155; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.4 system-ui, sans-serif; }
  main { max-width:1100px; margin:0 auto; padding:16px; display:grid; gap:16px; grid-template-columns: 1fr 300px; }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; } }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px; }
  .stage { position:relative; background:#000; border-radius:10px; overflow:hidden; aspect-ratio:16/9; }
  video, canvas.overlay { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; transform:scaleX(-1); }
  h1 { font-size:18px; margin:0 0 4px; } p.note { color:var(--muted); font-size:13px; margin:0 0 12px; }
  .match { font-size:28px; font-weight:800; margin:4px 0; }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-weight:700; font-size:13px; color:#fff; }
  dl { display:grid; grid-template-columns:auto auto; gap:4px 12px; margin:12px 0 0; font-size:14px; }
  dt { color:var(--muted); } dd { margin:0; text-align:right; font-variant-numeric:tabular-nums; }
  button { margin-top:12px; width:100%; padding:10px; border-radius:10px; border:1px solid var(--border);
           background:var(--card); color:var(--text); font-weight:700; cursor:pointer; }
  .error { color:#dc2626; font-weight:600; }
</style>
</head>
<body>
<main>
  <section class="card">
    <h1>Live recognition test</h1>
    <p class="note">Frames are sent to this machine's local service and discarded after scoring. Nothing is recorded or stored.</p>
    <div class="stage">
      <video id="video" autoplay playsinline muted></video>
      <canvas id="overlay" class="overlay"></canvas>
    </div>
    <p id="status" class="note" style="margin-top:8px">Starting camera…</p>
  </section>
  <aside class="card">
    <div class="note">Top match</div>
    <div id="match" class="match">—</div>
    <span id="badge" class="badge" style="background:var(--low)">waiting</span>
    <dl>
      <dt>Score</dt><dd id="score">—</dd>
      <dt>Inference</dt><dd id="ms">—</dd>
      <dt>Frames sent</dt><dd id="frames">0</dd>
      <dt>Face found</dt><dd id="facePct">—</dd>
      <dt>Matched (≥ threshold)</dt><dd id="matchPct">—</dd>
      <dt>Median score</dt><dd id="median">—</dd>
    </dl>
    <button id="toggle" type="button">Pause</button>
    <button id="reset" type="button">Reset stats</button>
  </aside>
</main>
<script>
const COLORS = { HIGH: '#059669', MODERATE: '#d97706', LOW: '#9ca3af' };
const INTERVAL_MS = 500, SEND_WIDTH = 960;
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const grab = document.createElement('canvas');   // offscreen, never added to the page
const $ = id => document.getElementById(id);
let running = true, busy = false;
let stats = { frames: 0, faces: 0, matched: 0, scores: [] };

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function render(result) {
  const top = result.candidates && result.candidates[0];
  stats.frames++;
  if (result.face_detected) stats.faces++;
  if (top) {
    stats.scores.push(top.score);
    if (top.confidence_level !== 'LOW') stats.matched++;
  }
  $('match').textContent = !result.face_detected ? 'No face' : top && top.confidence_level !== 'LOW' ? top.label : 'Unknown';
  $('badge').textContent = top ? top.confidence_level : (result.face_detected ? 'NO MATCH' : 'NO FACE');
  $('badge').style.background = top ? COLORS[top.confidence_level] : COLORS.LOW;
  $('score').textContent = top ? top.score.toFixed(3) : '—';
  $('ms').textContent = result.inference_time_ms + ' ms';
  $('frames').textContent = stats.frames;
  $('facePct').textContent = Math.round(100 * stats.faces / stats.frames) + '%';
  $('matchPct').textContent = stats.faces ? Math.round(100 * stats.matched / stats.faces) + '%' : '—';
  const med = median(stats.scores);
  $('median').textContent = med === null ? '—' : med.toFixed(3);

  const ctx = overlay.getContext('2d');
  overlay.width = grab.width; overlay.height = grab.height;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (result.bounding_box) {
    const b = result.bounding_box;
    ctx.lineWidth = 4;
    ctx.strokeStyle = top ? COLORS[top.confidence_level] : '#ffffff';
    ctx.strokeRect(b.x, b.y, b.width, b.height);
  }
}

async function tick() {
  if (!running || busy || video.readyState < 2) return;
  busy = true;
  try {
    const scale = SEND_WIDTH / video.videoWidth;
    grab.width = SEND_WIDTH; grab.height = Math.round(video.videoHeight * scale);
    grab.getContext('2d').drawImage(video, 0, 0, grab.width, grab.height);
    const blob = await new Promise(r => grab.toBlob(r, 'image/jpeg', 0.85));
    const form = new FormData();
    form.append('frame', blob, 'frame.jpg');
    const res = await fetch('/api/v1/recognize', { method: 'POST', body: form });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    render(await res.json());
    $('status').textContent = 'Running · one frame every ' + INTERVAL_MS + ' ms';
    $('status').className = 'note';
  } catch (err) {
    $('status').textContent = 'Recognition error: ' + err.message;
    $('status').className = 'note error';
  } finally {
    busy = false;
  }
}

$('toggle').onclick = () => { running = !running; $('toggle').textContent = running ? 'Pause' : 'Resume'; };
$('reset').onclick = () => { stats = { frames: 0, faces: 0, matched: 0, scores: [] }; };

navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: 'user' }, audio: false })
  .then(stream => { video.srcObject = stream; setInterval(tick, INTERVAL_MS); })
  .catch(err => { $('status').textContent = 'Camera unavailable: ' + err.message; $('status').className = 'note error'; });
</script>
</body>
</html>
"""
