// Timeline: waveform + drag-to-cut + edge resize + right-drag-subtract
//           + history (undo/redo) + zoom/pan + per-range type/speed

const container = document.getElementById('timelineContainer');
const canvas = document.getElementById('waveform');
const selectionsLayer = document.getElementById('selectionsLayer');
const playhead = document.getElementById('playhead');
const curTimeEl = document.getElementById('curTime');
const totalTimeEl = document.getElementById('totalTime');
const markInLine = document.getElementById('markInLine');

let duration = 0;
let videoEl = null;
let onChangeCb = null;
let ranges = [];     // [{start, end, type: 'cut'|'speedup', speed?: 2}]
let hasAudio = true;
let audioBuffer = null; // kept for re-rendering when viewport changes

// Viewport (zoom/pan state) — defaults to full duration.
let viewport = { start: 0, end: 0 };

export function getHasAudio() {
  return hasAudio;
}

export function getRanges() {
  return ranges.map((r) => ({ ...r }));
}

export function getAudioBuffer() {
  return audioBuffer;
}

export function getDuration() {
  return duration;
}

// Drag state
let dragMode = null;
let dragStartX = 0;
let draftEl = null;
let resizeIndex = -1;

// Which kind of range a left-drag creates. 'cut' (default) or 'speedup' (with a speed).
// Set from the UI mode toggle via setDragTool(); right-drag (subtract) ignores this.
let dragTool = { type: 'cut', speed: 0 };
export function setDragTool(type, speed) {
  if (type === 'speedup') {
    dragTool = { type: 'speedup', speed: [2, 4, 8].includes(speed) ? speed : 2 };
  } else {
    dragTool = { type: 'cut', speed: 0 };
  }
}
let resizeEdge = null;
const MIN_RANGE_SECONDS = 0.05;

// History
const HISTORY_LIMIT = 80;
let history = [[]];
let historyIndex = 0;

function snapshot() {
  return ranges.map((r) => ({ ...r }));
}

function eqRanges(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end ||
        a[i].type !== b[i].type || a[i].speed !== b[i].speed) return false;
  }
  return true;
}

function pushHistory() {
  const snap = snapshot();
  if (historyIndex < history.length - 1) {
    history = history.slice(0, historyIndex + 1);
  }
  if (history.length > 0 && eqRanges(history[history.length - 1], snap)) return;
  history.push(snap);
  if (history.length > HISTORY_LIMIT) history.shift();
  historyIndex = history.length - 1;
}

export function undo() {
  if (historyIndex <= 0) return false;
  historyIndex--;
  ranges = history[historyIndex].map((r) => ({ ...r }));
  renderRanges();
  notify();
  return true;
}

export function redo() {
  if (historyIndex >= history.length - 1) return false;
  historyIndex++;
  ranges = history[historyIndex].map((r) => ({ ...r }));
  renderRanges();
  notify();
  return true;
}

export function canUndo() { return historyIndex > 0; }
export function canRedo() { return historyIndex < history.length - 1; }

// Validate and clamp a range coming from external input (project restore, JSON import).
// Returns a sanitized range or null if invalid.
function validateExternalRange(r) {
  if (!r || !Number.isFinite(r.start) || !Number.isFinite(r.end)) return null;
  let start = Math.max(0, Math.min(duration, r.start));
  let end = Math.max(0, Math.min(duration, r.end));
  if (end <= start) return null;
  if (end - start < MIN_RANGE_SECONDS) return null;
  const type = r.type === 'speedup' ? 'speedup' : 'cut';
  const result = { start, end, type };
  if (type === 'speedup') {
    const speed = Number(r.speed);
    result.speed = [2, 4, 8].includes(speed) ? speed : 2;
  }
  return result;
}

// Place a new range into `ranges`, ensuring the non-overlap invariant across
// different range types (cut vs speedup, or different speedup speeds).
// The new range "wins" — overlapping portions of differently-typed existing
// ranges are trimmed/split. Same-type adjacent ranges are merged.
function placeRangeInto(currentRanges, newR) {
  const cleaned = [];
  for (const r of currentRanges) {
    if (newR.end <= r.start || newR.start >= r.end) {
      cleaned.push(r);
      continue;
    }
    if (r.type === newR.type && r.speed === newR.speed) {
      // Same kind — will be merged by mergeRanges
      cleaned.push(r);
      continue;
    }
    // Different type/speed — subtract newR's bounds from r. Only keep carved
    // remainders that meet MIN_RANGE_SECONDS so we don't leave un-grabbable
    // sub-0.05s slivers (the invariant every other range path enforces).
    if (newR.start - r.start >= MIN_RANGE_SECONDS) cleaned.push({ ...r, end: newR.start });
    if (r.end - newR.end >= MIN_RANGE_SECONDS) cleaned.push({ ...r, start: newR.end });
  }
  cleaned.push(newR);
  return mergeRanges(cleaned);
}

// External API: add ranges from outside (I/O markers, silence detect, JSON import, autosave restore)
export function addRanges(newRanges) {
  if (!Array.isArray(newRanges)) return;
  let mutated = false;
  for (const r of newRanges) {
    const v = validateExternalRange(r);
    if (!v) continue;
    ranges = placeRangeInto(ranges, v);
    mutated = true;
  }
  if (mutated) {
    renderRanges();
    pushHistory();
    notify();
  }
}

// Replace all ranges
export function setRanges(newRanges) {
  if (!Array.isArray(newRanges)) return;
  ranges = [];
  for (const r of newRanges) {
    const v = validateExternalRange(r);
    if (!v) continue;
    ranges = placeRangeInto(ranges, v);
  }
  renderRanges();
  pushHistory();
  notify();
}

// Update the type/speed of one range by index. Re-normalize for overlaps.
export function updateRangeType(index, type, speed) {
  if (!ranges[index]) return;
  const updated = { ...ranges[index], type };
  if (type === 'speedup') updated.speed = speed || 2;
  else delete updated.speed;
  ranges.splice(index, 1);
  ranges = placeRangeInto(ranges, updated);
  renderRanges();
  pushHistory();
  notify();
}

// ---------- Init ----------
export async function initTimeline(file, video, onChange) {
  videoEl = video;
  onChangeCb = onChange;
  ranges = [];
  history = [[]];
  historyIndex = 0;
  // Emit an "initial" event so the caller can sync UI without persisting the
  // empty state (otherwise the autosave for this filename would be clobbered
  // before the restore prompt has a chance to read it).
  notify({ initial: true });

  await new Promise((resolve, reject) => {
    if (video.readyState >= 1) return resolve();
    // The element may already have errored (e.g. .avi: the browser can't play
    // the container) before we attach the listener.
    if (video.error) return reject(new Error('UNSUPPORTED_MEDIA'));
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    const onLoaded = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const onError = () => { if (settled) return; settled = true; cleanup(); reject(new Error('UNSUPPORTED_MEDIA')); };
    // Backstop: some browsers neither fire 'error' nor 'loadedmetadata' for an
    // unsupported file — don't let the UI hang on "解析中" forever.
    const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); reject(new Error('LOAD_TIMEOUT')); }, 15000);
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
  duration = video.duration;
  viewport = { start: 0, end: duration };
  totalTimeEl.textContent = formatTime(duration);

  await decodeAudio(file);
  drawWaveform();
  renderRanges();

  video.removeEventListener('timeupdate', updatePlayhead);
  video.addEventListener('timeupdate', updatePlayhead);
}

async function decodeAudio(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    audioCtx.close();
    hasAudio = true;
  } catch (err) {
    hasAudio = false;
    audioBuffer = null;
    console.warn('Audio decode failed — exporting as video-only:', err);
  }
}

function drawWaveform() {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth;
  const h = container.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#FAF8F1';
  ctx.fillRect(0, 0, w, h);

  // Draw ticks first (under waveform)
  drawTicks(ctx, w, h);

  if (!audioBuffer) {
    ctx.fillStyle = '#87867F';
    ctx.font = '12px sans-serif';
    ctx.fillText('音声トラックが見つかりません（映像のみで書き出し可能）', 10, h - 8);
    return;
  }

  const data = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const startSample = Math.max(0, Math.floor(viewport.start * sampleRate));
  const endSample = Math.min(data.length, Math.ceil(viewport.end * sampleRate));
  const samplesInView = endSample - startSample;
  const samplesPerPixel = Math.max(1, Math.floor(samplesInView / w));
  const mid = h / 2;

  ctx.fillStyle = '#6B6862';
  for (let x = 0; x < w; x++) {
    let min = 1.0;
    let max = -1.0;
    const s = startSample + x * samplesPerPixel;
    const e = Math.min(s + samplesPerPixel, endSample);
    for (let i = s; i < e; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const yMax = mid - max * mid * 0.9;
    const yMin = mid - min * mid * 0.9;
    ctx.fillRect(x, yMax, 1, Math.max(1, yMin - yMax));
  }
}

function pickTickInterval(span) {
  // Aim for 5–10 visible ticks across the viewport
  if (span <= 2) return 0.1;
  if (span <= 5) return 0.5;
  if (span <= 20) return 1;
  if (span <= 60) return 5;
  if (span <= 180) return 10;
  if (span <= 600) return 30;
  if (span <= 1800) return 60;
  if (span <= 7200) return 300;
  return 600;
}

function formatTick(t, interval) {
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t);
  if (interval < 1) {
    return sign + t.toFixed(1) + 's';
  }
  const m = Math.floor(t / 60);
  const s = Math.floor(t - m * 60);
  if (m === 0) return sign + s + 's';
  return `${sign}${m}:${s.toString().padStart(2, '0')}`;
}

function drawTicks(ctx, w, h) {
  if (duration === 0) return;
  const span = vpSpan();
  const interval = pickTickInterval(span);
  const firstTick = Math.ceil(viewport.start / interval) * interval;

  ctx.strokeStyle = 'rgba(60, 60, 50, 0.12)';
  ctx.fillStyle = 'rgba(60, 60, 50, 0.55)';
  ctx.font = '10px ui-monospace, "SF Mono", Consolas, monospace';
  ctx.lineWidth = 1;
  ctx.textBaseline = 'top';

  for (let t = firstTick; t <= viewport.end + 1e-6; t += interval) {
    const x = ((t - viewport.start) / span) * w;
    if (x < -10 || x > w + 10) continue;
    // Major line
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, h);
    ctx.stroke();
    // Label at top
    ctx.fillText(formatTick(t, interval), x + 3, 2);
  }
}

// ---------- Coordinate helpers ----------
function vpSpan() { return viewport.end - viewport.start; }
function xToTime(x, rect) {
  const w = (rect || container.getBoundingClientRect()).width;
  return viewport.start + (x / w) * vpSpan();
}
function timeToX(t, rect) {
  const w = (rect || container.getBoundingClientRect()).width;
  return ((t - viewport.start) / vpSpan()) * w;
}

// ---------- Zoom / Pan ----------
function onWheel(e) {
  if (duration === 0) return;
  e.preventDefault();
  const rect = container.getBoundingClientRect();
  const x = clamp(e.clientX - rect.left, 0, rect.width);

  if (e.shiftKey) {
    // Pan horizontally
    const panAmount = (e.deltaY / rect.width) * vpSpan();
    viewport.start += panAmount;
    viewport.end += panAmount;
    if (viewport.start < 0) {
      viewport.end -= viewport.start;
      viewport.start = 0;
    }
    if (viewport.end > duration) {
      viewport.start -= viewport.end - duration;
      viewport.end = duration;
    }
  } else {
    // Zoom around cursor
    const cursorTime = xToTime(x, rect);
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    let span = vpSpan() * factor;
    span = Math.max(0.5, Math.min(duration, span));
    const fracLeft = (cursorTime - viewport.start) / vpSpan();
    viewport.start = cursorTime - fracLeft * span;
    viewport.end = viewport.start + span;
    if (viewport.start < 0) {
      viewport.end -= viewport.start;
      viewport.start = 0;
    }
    if (viewport.end > duration) {
      viewport.start = Math.max(0, viewport.start - (viewport.end - duration));
      viewport.end = duration;
    }
  }
  drawWaveform();
  renderRanges();
  updatePlayhead();
  updateTimeLabels();
}

export function resetZoom() {
  viewport = { start: 0, end: duration };
  drawWaveform();
  renderRanges();
  updatePlayhead();
  updateTimeLabels();
}

function updateTimeLabels() {
  totalTimeEl.textContent = `${formatTime(viewport.start)} 〜 ${formatTime(viewport.end)}（全体 ${formatTime(duration)}）`;
}

// ---------- Drag interactions ----------
function setupInteractions() {
  container.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  container.addEventListener('contextmenu', (e) => e.preventDefault());
  container.addEventListener('wheel', onWheel, { passive: false });
}

function findRangeIndexAt(x, rect) {
  if (duration === 0) return -1;
  const t = xToTime(x, rect);
  for (let i = 0; i < ranges.length; i++) {
    if (t >= ranges[i].start && t <= ranges[i].end) return i;
  }
  return -1;
}

function subtractFromRanges(rs, sub) {
  const out = [];
  for (const r of rs) {
    if (sub.end <= r.start || sub.start >= r.end) { out.push(r); continue; }
    if (sub.start <= r.start && sub.end >= r.end) continue;
    if (sub.start <= r.start && sub.end < r.end) {
      out.push({ ...r, start: sub.end, end: r.end }); continue;
    }
    if (sub.start > r.start && sub.end >= r.end) {
      out.push({ ...r, start: r.start, end: sub.start }); continue;
    }
    out.push({ ...r, start: r.start, end: sub.start });
    out.push({ ...r, start: sub.end, end: r.end });
  }
  return out.filter((r) => r.end - r.start >= MIN_RANGE_SECONDS);
}

function onDown(e) {
  if (duration === 0) return;

  if (e.button === 2) {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    dragStartX = clamp(e.clientX - rect.left, 0, rect.width);
    dragMode = 'subtract';
    draftEl = document.createElement('div');
    draftEl.className = 'range-selection drafting subtract';
    draftEl.style.left = dragStartX + 'px';
    draftEl.style.width = '0px';
    selectionsLayer.appendChild(draftEl);
    seekVideoToX(e.clientX);
    return;
  }

  if (e.button !== 0) return;

  if (e.target && e.target.classList.contains('range-handle')) {
    e.preventDefault();
    e.stopPropagation();
    resizeIndex = parseInt(e.target.dataset.index, 10);
    resizeEdge = e.target.dataset.edge;
    dragMode = 'resize';
    seekVideoToX(e.clientX);
    return;
  }

  const rect = container.getBoundingClientRect();
  dragStartX = clamp(e.clientX - rect.left, 0, rect.width);
  dragMode = 'create';
  draftEl = document.createElement('div');
  draftEl.className = 'range-selection drafting' + (dragTool.type === 'speedup' ? ' speedup' : '');
  draftEl.style.left = dragStartX + 'px';
  draftEl.style.width = '0px';
  selectionsLayer.appendChild(draftEl);
  seekVideoToX(e.clientX);
}

// Coalesced video scrubbing. Setting video.currentTime on every mousemove floods
// the decoder with seeks it can't keep up with — very visible when dragging
// backwards (a backward seek must re-decode from the previous keyframe). Instead
// we keep only the LATEST target time and apply it at most once per animation
// frame, and never while a previous seek is still in flight. This makes the
// preview follow the cursor smoothly in both directions.
let pendingSeekTime = null;
let seekRafQueued = false;

function pumpSeek() {
  seekRafQueued = false;
  if (pendingSeekTime == null || !videoEl) return;
  if (videoEl.seeking) { queueSeek(); return; } // a seek is still running — retry next frame
  const t = pendingSeekTime;
  pendingSeekTime = null;
  // fastSeek (Safari/Firefox) is a much cheaper keyframe-accurate scrub; Chrome
  // lacks it, so the coalescing above is what keeps Chrome smooth.
  if (typeof videoEl.fastSeek === 'function') videoEl.fastSeek(t);
  else videoEl.currentTime = t;
}

function queueSeek() {
  if (seekRafQueued) return;
  seekRafQueued = true;
  requestAnimationFrame(pumpSeek);
}

function seekVideoToX(clientX) {
  if (!videoEl) return;
  const rect = container.getBoundingClientRect();
  const x = clamp(clientX - rect.left, 0, rect.width);
  pendingSeekTime = clamp(xToTime(x, rect), 0, duration);
  if (!videoEl.paused) videoEl.pause();
  queueSeek();
}

function onMove(e) {
  if (!dragMode) return;
  const rect = container.getBoundingClientRect();
  const x = clamp(e.clientX - rect.left, 0, rect.width);

  if ((dragMode === 'create' || dragMode === 'subtract') && draftEl) {
    const left = Math.min(dragStartX, x);
    const width = Math.abs(x - dragStartX);
    draftEl.style.left = left + 'px';
    draftEl.style.width = width + 'px';
    seekVideoToX(e.clientX);
    return;
  }

  if (dragMode === 'resize' && resizeIndex >= 0) {
    const r = ranges[resizeIndex];
    if (!r) return;
    const t = xToTime(x, rect);
    if (resizeEdge === 'left') {
      r.start = clamp(t, 0, r.end - MIN_RANGE_SECONDS);
    } else {
      r.end = clamp(t, r.start + MIN_RANGE_SECONDS, duration);
    }
    // Live visual feedback only — do NOT notify() here. notify() persists to
    // localStorage and rebuilds the ranges list + minimap, which on every
    // mousemove (~60-120Hz) janks the drag and hammers storage. onUp commits
    // the final state once (renderRanges + pushHistory + notify).
    renderRanges();
    seekVideoToX(e.clientX);
  }
}

function onUp() {
  if (!dragMode) return;

  if (dragMode === 'resize') {
    // The range at resizeIndex was mutated in place during drag.
    // Re-place it via placeRangeInto so it correctly trims any newly-overlapped
    // different-typed neighbors (cut vs speedup or different speeds).
    const idx = resizeIndex;
    dragMode = null;
    resizeIndex = -1;
    resizeEdge = null;
    if (ranges[idx]) {
      const moved = { ...ranges[idx] };
      ranges.splice(idx, 1);
      ranges = placeRangeInto(ranges, moved);
    } else {
      ranges = mergeRanges(ranges);
    }
    renderRanges();
    pushHistory();
    notify();
    return;
  }

  if (dragMode === 'create' && draftEl) {
    const rect = container.getBoundingClientRect();
    const left = parseFloat(draftEl.style.left);
    const width = parseFloat(draftEl.style.width);
    draftEl.remove();
    draftEl = null;
    dragMode = null;

    if (width < 4) return;
    const startTime = xToTime(left, rect);
    const endTime = xToTime(left + width, rect);
    addRange(startTime, endTime);
    return;
  }

  if (dragMode === 'subtract' && draftEl) {
    const rect = container.getBoundingClientRect();
    const left = parseFloat(draftEl.style.left);
    const width = parseFloat(draftEl.style.width);
    draftEl.remove();
    draftEl = null;
    dragMode = null;

    if (width < 4) {
      const idx = findRangeIndexAt(left, rect);
      if (idx >= 0) {
        ranges.splice(idx, 1);
        renderRanges();
        pushHistory();
        notify();
      } else if (videoEl) {
        videoEl.currentTime = clamp(xToTime(left, rect), 0, duration);
        videoEl.play().catch(() => {});
      }
      return;
    }

    const startTime = xToTime(left, rect);
    const endTime = xToTime(left + width, rect);
    ranges = subtractFromRanges(ranges, { start: startTime, end: endTime });
    renderRanges();
    pushHistory();
    notify();
  }
}

function addRange(start, end) {
  // Clamp to current media bounds (defensive — should already be in-range from drag math)
  start = Math.max(0, Math.min(duration, start));
  end = Math.max(0, Math.min(duration, end));
  if (end - start < MIN_RANGE_SECONDS) return;
  const r = dragTool.type === 'speedup'
    ? { start, end, type: 'speedup', speed: dragTool.speed || 2 }
    : { start, end, type: 'cut' };
  ranges = placeRangeInto(ranges, r);
  renderRanges();
  pushHistory();
  notify();
}

function mergeRanges(rs) {
  if (rs.length === 0) return rs;
  const sorted = [...rs].sort((a, b) => a.start - b.start);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    // Only merge if same type and same speed
    if (cur.start <= last.end && last.type === cur.type && last.speed === cur.speed) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push(cur);
    }
  }
  return out;
}

function renderRanges() {
  selectionsLayer.querySelectorAll('.range-selection').forEach((el) => el.remove());
  if (duration === 0) return;
  const rect = container.getBoundingClientRect();
  ranges.forEach((r, i) => {
    const left = timeToX(r.start, rect);
    const right = timeToX(r.end, rect);
    if (right < 0 || left > rect.width) return; // off-screen

    const el = document.createElement('div');
    el.className = 'range-selection ' + (r.type === 'speedup' ? 'speedup' : 'cut');
    el.style.left = Math.max(0, left) + 'px';
    el.style.width = (Math.min(rect.width, right) - Math.max(0, left)) + 'px';
    el.title = r.type === 'speedup' ? `${r.speed}x 倍速（右クリックで削除）` : '右クリックで削除';

    if (r.type === 'speedup') {
      const label = document.createElement('span');
      label.className = 'speedup-label';
      label.textContent = `${r.speed}x`;
      el.appendChild(label);
    }

    const lh = document.createElement('div');
    lh.className = 'range-handle left';
    lh.dataset.edge = 'left';
    lh.dataset.index = i;
    el.appendChild(lh);

    const rh = document.createElement('div');
    rh.className = 'range-handle right';
    rh.dataset.edge = 'right';
    rh.dataset.index = i;
    el.appendChild(rh);

    selectionsLayer.appendChild(el);
  });
}

function updatePlayhead() {
  if (!videoEl || duration === 0) return;
  const rect = container.getBoundingClientRect();
  const x = timeToX(videoEl.currentTime, rect);
  playhead.style.left = x + 'px';
  curTimeEl.textContent = formatTime(videoEl.currentTime);
}

function notify(opts) {
  if (onChangeCb) onChangeCb(getRanges(), opts || {});
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function formatTime(t) {
  if (!isFinite(t)) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

export function removeRangeAt(index) {
  ranges.splice(index, 1);
  renderRanges();
  pushHistory();
  notify();
}

export function clearRanges() {
  ranges = [];
  renderRanges();
  pushHistory();
  notify();
}

// ---------- Mark-in indicator (for I/O keyboard markers) ----------
export function showMarkInAt(time) {
  if (!markInLine) return;
  const rect = container.getBoundingClientRect();
  const x = timeToX(time, rect);
  markInLine.style.left = x + 'px';
  markInLine.style.display = 'block';
  markInLine.dataset.time = time;
}
export function hideMarkIn() {
  if (markInLine) markInLine.style.display = 'none';
}

window.addEventListener('resize', () => {
  if (videoEl && videoEl.src) {
    drawWaveform();
    renderRanges();
    updatePlayhead();
  }
});

setupInteractions();
