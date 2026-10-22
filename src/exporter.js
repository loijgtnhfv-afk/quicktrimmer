// Video export using ffmpeg.wasm.
//
// Copy or convert:
//   A stream copy (no re-encode, no quality loss) is used only when the result is exact by
//   construction: ONE kept part that starts at the very beginning (no cut / only the end
//   trimmed) or exactly on a keyframe. Everything else — a cut in the middle, a start that is
//   not on a keyframe, speed-ups, format/resolution/aspect/loudness changes — is converted, so
//   frames from a cut part can never come back (2026-10-19, owner's choice "A": OBS puts a
//   keyframe only every ~4.17 s and a copy starts at the keyframe before the cut point).
//
// Engine:
//   The multi-thread ffmpeg core (@ffmpeg/core-mt, ~5× faster converting) when the page can
//   use it — cross-origin isolated + SharedArrayBuffer + Worker + enough cores — else the
//   single-thread core. A job on the multi-thread core is watched: if it stalls, cannot load,
//   runs out of memory or fails, the whole job is redone on the single-thread core.
//   The engine is terminated after every job, so repeated exports never pile up workers or
//   wasm memory (a wasm heap only ever grows).

import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';

const ORIGIN = window.location.origin + '/';
// Single-thread core: committed under public/ffmpeg/ (~32 MB).
const ST_CORE = {
  coreURL: new URL('ffmpeg/ffmpeg-core.js', ORIGIN).href,
  wasmURL: new URL('ffmpeg/ffmpeg-core.wasm', ORIGIN).href,
};
// Multi-thread core: copied from the npm package @ffmpeg/core-mt (pinned version) into
// /ffmpeg/core-mt-<version>/ by the `ffmpegMtCore` plugin in vite.config.js — same origin
// (works under COEP require-corp), immutable caching through vercel.json's /ffmpeg/(.*)
// rule, cache-first in sw.js. The version is in the path so an upgraded core can never be
// mixed with a cached old one.
const MT_DIR = typeof __QT_MT_CORE_DIR__ === 'string' ? __QT_MT_CORE_DIR__ : 'ffmpeg/core-mt-0.12.10/';
const MT_CORE = {
  coreURL: new URL(MT_DIR + 'ffmpeg-core.js', ORIGIN).href,
  wasmURL: new URL(MT_DIR + 'ffmpeg-core.wasm', ORIGIN).href,
  workerURL: new URL(MT_DIR + 'ffmpeg-core.worker.js', ORIGIN).href,
};

// Test builds only (unset in production): VITE_QT_ENGINE=st|mt pins the engine;
// VITE_QT_MT_FILTER_THREADS=0 brings back ffmpeg's default filter threads, i.e. the real
// deadlock, to prove the watchdog.
const FORCED_ENGINE = (import.meta.env && import.meta.env.VITE_QT_ENGINE) || '';
const MT_FILTER_THREADS = String((import.meta.env && import.meta.env.VITE_QT_MT_FILTER_THREADS) || '1');

const MT_LOAD_TIMEOUT_MS = 30000; // loading the multi-thread core (32 pthread workers) took 0.3 s here
const MT_STALL_MS = 25000;        // no log line / progress at all for this long = stuck
const MT_BLOCK_KEY = 'qt:mt-off'; // remembered deadlock on this device (localStorage, 7 days)
const MT_BLOCK_DAYS = 7;

// The one line shown when a job is redone on the single-thread core. Plain words only.
const FALLBACK_STATUS = 'うまく進まなかったので、別のやり方でやり直しています（少し時間がかかります）';

let ffmpegInstance = null;  // the one engine that exists right now (terminated after each job)
let ffmpegKind = null;      // 'mt' | 'st'
let ffmpegLoading = null;   // in-flight load promise
let loadingKind = null;
let loadGeneration = 0;     // bumped by dropEngine()/cancelExport() to disown an in-flight load
let lastActivity = 0;       // performance.now() of the engine's last log line / progress event
let mtOffReason = null;     // set when the multi-thread core failed in this page session
let logBuffer = [];
let cancelRequested = false;

class EngineFailure extends Error {
  constructor(reason, cause) {
    super(`__ENGINE_${reason}__${cause ? ': ' + ((cause && cause.message) || cause) : ''}`);
    this.reason = reason; // 'stall' | 'load'
  }
}
const isEngineFailure = (err) => err instanceof EngineFailure;
const errText = (err) => (err && err.message) ? err.message : String(err);
const isCancelError = (err) => { const m = errText(err); return m.includes('__CANCELLED__') || m.includes('called FFmpeg.terminate()'); };
const looksOutOfMemory = (m) => /memory access out of bounds|out of memory|std::bad_alloc|Aborted\(\)|RangeError|Cannot allocate memory|allocation failed/i.test(m);
// Failures that are about the edit, not the engine — redoing them on another core can't help.
const isUserError = (err) => /全部削除されています|すべてのクリップが空です|結合するには2本以上/.test(errText(err));

export function cancelExport() {
  cancelRequested = true;
  dropEngine();
}

function throwIfCancelled() {
  if (cancelRequested) {
    cancelRequested = false;
    throw new Error('__CANCELLED__');
  }
}

export const CANCELLED_MARKER = '__CANCELLED__';

function pushLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > 300) logBuffer.shift();
}

function tailLog(n) { return logBuffer.slice(-n).join('\n'); }

function touch() { lastActivity = performance.now(); }

// ---------- Which core ----------
function mtBlockedOnThisDevice() {
  try {
    const v = JSON.parse(localStorage.getItem(MT_BLOCK_KEY) || 'null');
    return !!(v && v.core === MT_DIR && v.until > Date.now());
  } catch (_) { return false; }
}
function blockMtOnThisDevice(reason) {
  try { localStorage.setItem(MT_BLOCK_KEY, JSON.stringify({ core: MT_DIR, reason, until: Date.now() + MT_BLOCK_DAYS * 864e5 })); } catch (_) {}
}

function chooseEngine() {
  if (FORCED_ENGINE === 'st') return 'st';
  try {
    if (!self.crossOriginIsolated) return 'st';          // no SharedArrayBuffer without COOP/COEP
    if (typeof SharedArrayBuffer !== 'function') return 'st';
    if (typeof Worker !== 'function') return 'st';
    if (FORCED_ENGINE === 'mt') return 'mt';
    if (mtOffReason) return 'st';                         // failed earlier in this page session
    if ((navigator.hardwareConcurrency || 0) < 4) return 'st'; // little to gain, more to lose
    if (navigator.deviceMemory && navigator.deviceMemory < 4) return 'st'; // its heap is a fixed 1 GB
    if (mtBlockedOnThisDevice()) return 'st';
    return 'mt';
  } catch (_) { return 'st'; }
}

// Worker threads for decoding and for encoding on the multi-thread core. The core has a FIXED
// pool of 32 pthread workers and deadlocks (stuck at the first frame) when a run wants more —
// and ffmpeg's defaults (one thread per logical core for filter graphs, decoders and x264)
// do exactly that on a 16+ thread PC. Measured 2026-10-19 on a 20-thread PC with a 1536×864
// 60 fps replay: 4+4 threads 125 fps, 6+6 158 fps, 8+8 160 fps. 6+6 with the filter graph
// on 1 thread uses about 15 of the 32 workers.
function mtThreads() {
  const hc = navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(6, hc - 2));
}
function withMtThreads(args) {
  const n = String(mtThreads());
  const out = ['-filter_threads', MT_FILTER_THREADS, '-filter_complex_threads', MT_FILTER_THREADS];
  const last = args.length - 1;
  args.forEach((a, i) => {
    if (a === '-i') out.push('-threads', n);  // decoder threads of this input
    if (i === last) out.push('-threads', n);  // encoder threads (the last arg is always the output file)
    out.push(a);
  });
  return out;
}

// ---------- Engine life cycle ----------
// Fetch a core's files to the end (into the browser / service-worker cache) without keeping
// them: the worker's own fetch right after is then served from the cache.
async function downloadAll(cfg) {
  await Promise.all(Object.values(cfg).map(async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    if (res.body) await res.body.pipeTo(new WritableStream());
    else await res.arrayBuffer();
  }));
}

function dropEngine() {
  if (ffmpegInstance) {
    try { ffmpegInstance.terminate(); } catch (err) { console.warn('terminate threw:', err); }
  }
  ffmpegInstance = null;
  ffmpegKind = null;
  // Disown any in-flight load: the resolving loader then terminates its orphaned instance.
  loadGeneration++;
  ffmpegLoading = null;
  loadingKind = null;
}

async function getFFmpeg(kind) {
  if (ffmpegInstance && ffmpegKind === kind) return ffmpegInstance;
  if (ffmpegInstance || (ffmpegLoading && loadingKind !== kind)) dropEngine();
  if (!ffmpegLoading) {
    const gen = loadGeneration;
    loadingKind = kind;
    ffmpegLoading = (async () => {
      const ff = new FFmpeg();
      ff.on('log', ({ type, message }) => {
        touch();
        pushLog(`[${type}] ${message}`);
        console.log('[ffmpeg]', message);
      });
      ff.on('progress', touch);
      let timer = null;
      try {
        if (kind === 'mt') {
          // Download first, with no time limit (a slow line must not count as a broken engine
          // — falling back would then download the second core too), then start it under a
          // time limit: from cache, starting it took ~0.3 s here.
          await downloadAll(MT_CORE);
          await Promise.race([ff.load(MT_CORE), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('multi-thread core did not start in time')), MT_LOAD_TIMEOUT_MS);
          })]);
        } else {
          await ff.load(ST_CORE);
        }
      } catch (err) {
        try { ff.terminate(); } catch (_) {}
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
      // If the engine was dropped (cancel) while we were loading, this instance is orphaned.
      if (gen !== loadGeneration) {
        try { ff.terminate(); } catch (_) {}
        throw new Error('__CANCELLED__');
      }
      ffmpegInstance = ff;
      ffmpegKind = kind;
      return ff;
    })().catch((err) => {
      if (gen === loadGeneration) { ffmpegLoading = null; loadingKind = null; } // allow a retry
      throw err;
    });
  }
  return ffmpegLoading;
}

// Run one ffmpeg command. On the multi-thread core the thread counts are bounded (see
// mtThreads) and a watchdog ends the run when the engine shows no sign of life for
// `stallMs` — the deadlock signature (no log line, no progress) — so the job can be redone
// on the single-thread core instead of hanging forever.
async function execFF(ff, args, { threads = true, stallMs = MT_STALL_MS } = {}) {
  if (ff !== ffmpegInstance || ffmpegKind !== 'mt') return ff.exec(args);
  const a = threads ? withMtThreads(args) : args;
  touch();
  let timer = null;
  const stalled = new Promise((_, reject) => {
    timer = setInterval(() => {
      if (performance.now() - lastActivity > stallMs) {
        clearInterval(timer);
        timer = null;
        reject(new EngineFailure('stall'));
      }
    }, 1000);
  });
  try {
    return await Promise.race([ff.exec(a), stalled]);
  } finally {
    if (timer) clearInterval(timer);
  }
}

function noteMtFailure(err) {
  if (isEngineFailure(err)) {
    mtOffReason = err.reason;
    // A real deadlock is likely to come back on this device: don't make the next visit wait
    // for it again. (A load failure may just be a network blip — this session only.)
    if (err.reason === 'stall') blockMtOnThisDevice('stall');
  } else if (looksOutOfMemory(errText(err))) {
    mtOffReason = 'memory'; // this page session only — it may be just this one big file
  }
}

// Runs a job — `job(ff, status, onProgress)` — on the chosen core, and redoes it once on the
// single-thread core if the multi-thread one fails. The engine is terminated afterwards.
async function runJob(options, job, { formatErrors = true } = {}) {
  const status = options.onStatus || (() => {});
  const onProgress = options.onProgress || (() => {});
  cancelRequested = false;
  logBuffer = [];
  let kind = chooseEngine();
  let redo = false;
  try {
    for (;;) {
      if (!redo) status('FFmpeg を準備中...');
      onProgress(0);
      try {
        let ff;
        try {
          ff = await getFFmpeg(kind);
        } catch (err) {
          if (cancelRequested || isCancelError(err)) throw err;
          if (kind === 'mt') throw new EngineFailure('load', err);
          throw new Error('FFmpeg の読み込みに失敗: ' + errText(err));
        }
        console.info(`[exporter] engine: ${kind === 'mt' ? `multi-thread (${mtThreads()}+${mtThreads()} threads)` : 'single-thread'}${redo ? ' — redo' : ''}`);
        // While a job is redone, its own step texts are not shown: the one-line notice stays up.
        return await job(ff, redo ? () => {} : status, onProgress);
      } catch (err) {
        if (cancelRequested || isCancelError(err)) throw err;
        if (kind === 'mt' && !isUserError(err)) {
          noteMtFailure(err);
          console.warn('[exporter] the multi-thread engine failed — redoing this on the single-thread one:', err);
          dropEngine();
          kind = 'st';
          redo = true;
          logBuffer = [];
          status(FALLBACK_STATUS);
          continue;
        }
        throw err;
      } finally {
        dropEngine(); // nothing stays alive between jobs (workers, wasm heap, MEMFS)
      }
    }
  } catch (err) {
    if (cancelRequested || isCancelError(err)) {
      cancelRequested = false;
      throw new Error('__CANCELLED__');
    }
    if (!formatErrors) throw err;
    const tail = tailLog(20);
    throw new Error(`${errText(err)}\n\n--- FFmpeg log (最後の20行) ---\n${tail || '(ログなし)'}`);
  }
}

// Fire-and-forget warm-up when a clip is opened: start the engine the export will use, so
// the FIRST export doesn't stall on the ~32 MB core download. Safe to call repeatedly;
// errors are swallowed here (the export retries / falls back and surfaces them). Every
// export terminates its engine at the end, so this never piles up instances.
export function preloadFFmpeg() {
  try { getFFmpeg(chooseEngine()).catch(() => {}); } catch (_) {}
}

// Mount a File as a read-only WORKERFS input instead of copying its bytes into
// MEMFS. For multi-hundred-MB game clips this keeps the whole input OUT of the
// ffmpeg.wasm heap — the old `writeFile(await fetchFile(file))` path held the
// input twice (the File in JS + a full Uint8Array copy inside wasm), spiking peak
// memory and crashing on large clips. Returns the in-wasm path to feed as `-i`.
// Uses `blobs` (not `files`) so the in-wasm name is OUR fixed ASCII name, not the
// source's real filename — keeps the in-wasm path predictable regardless of spaces
// or Japanese in it. (Defensive: exec args pass fine as an array, but a concat-list
// or filter string we build from the name later would not tolerate odd characters.)
async function mountInput(ff, dir, baseName, file) {
  try { await ff.createDir(dir); } catch (_) {} // ignore "exists" left by a prior run
  await ff.mount(FFFSType.WORKERFS, { blobs: [{ name: baseName, data: file }] }, dir);
  return `${dir}/${baseName}`;
}

// Tear down a WORKERFS mount + its MEMFS mountpoint. Best-effort: a terminated
// worker (cancel) makes these throw, which callers swallow.
async function unmountInput(ff, dir) {
  try { await ff.unmount(dir); } catch (_) {}
  try { await ff.deleteDir(dir); } catch (_) {}
}

function getExt(name) {
  const m = /\.[a-zA-Z0-9]+$/.exec(name);
  return m ? m[0].toLowerCase() : '.mp4';
}

// Seconds as passed to -ss / -to. Microsecond precision (ffmpeg's own time base), so a cut
// placed exactly on a keyframe — e.g. 500/60 s = 8.3333… — still lands on it; the old
// 1 ms rounding (8.333) fell just before it and the copy started at the previous keyframe.
const ts = (sec) => sec.toFixed(6);

// Probe the input's real video/audio codecs by running ffmpeg with no output:
// it prints the stream info to the log, then exits non-zero (no output file) —
// that exit is expected, we only want the logged stream lines. Used by the X
// export because the file extension can't be trusted (Steam records HEVC into a
// .mp4, PS5 records VP9/Opus into a .webm — both are silently rejected by X).
async function probeInput(ff, inputName) {
  // Collect THIS probe's log lines via a dedicated handler so codec detection
  // never depends on the shared 300-entry logBuffer (which wraps/drops lines on
  // long runs — a near-full buffer could otherwise make the scan come up empty).
  const lines = [];
  const collect = ({ message }) => lines.push(message);
  ff.on('log', collect);
  try {
    await execFF(ff, ['-hide_banner', '-i', inputName], { threads: false });
  } catch (err) {
    if (isEngineFailure(err) || cancelRequested) throw err;
    // No output file specified → ffmpeg errors out; stream info is already logged.
  } finally {
    try { ff.off('log', collect); } catch (_) {}
  }
  let videoCodec = null;
  let audioCodec = null;
  let width = null;
  let height = null;
  for (const ln of lines) {
    if (!videoCodec) {
      const v = /:\s*Video:\s*([a-z0-9_]+)/i.exec(ln);
      if (v) {
        videoCodec = v[1].toLowerCase();
        const res = /\b(\d{2,5})x(\d{2,5})\b/.exec(ln); // pull WxH off the same line
        if (res) { width = Number(res[1]); height = Number(res[2]); }
      }
    }
    if (!audioCodec) {
      const a = /:\s*Audio:\s*([a-z0-9_]+)/i.exec(ln);
      if (a) audioCodec = a[1].toLowerCase();
    }
  }
  return { videoCodec, audioCodec, width, height };
}

// ---------- Range planning ----------
// Convert delete-only ranges into keep-segments (for stream-copy mode).
function computeKeepSegmentsCutsOnly(cutRanges, duration) {
  const sorted = [...cutRanges].filter((r) => r.type !== 'speedup').sort((a, b) => a.start - b.start);
  const keep = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.start > cursor) keep.push({ start: cursor, end: Math.min(r.start, duration) });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < duration) keep.push({ start: cursor, end: duration });
  return keep.filter((s) => s.end - s.start > 0.05);
}

// Compute a full plan of segments: each segment is either kept-as-is or speed-changed.
// Returns [{ start, end, speed }] where speed=1 means keep normal.
function planSegments(ranges, duration) {
  // Sort ranges by start; assume no overlaps (merged upstream).
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.start > cursor) out.push({ start: cursor, end: r.start, speed: 1 });
    if (r.type === 'speedup') {
      out.push({ start: r.start, end: r.end, speed: r.speed || 2 });
    }
    // 'cut' → just skip (no segment)
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < duration) out.push({ start: cursor, end: duration, speed: 1 });
  return out.filter((s) => s.end - s.start > 0.05);
}

function rangesHaveSpeedup(ranges) {
  return ranges.some((r) => r.type === 'speedup');
}

// Post-trim/speed output duration of a plan's segments (seconds).
function segmentsOutputDuration(segments) {
  return segments.reduce((acc, s) => acc + (s.end - s.start) / (s.speed && s.speed !== 1 ? s.speed : 1), 0);
}

// Fraction done of a conversion. ffmpeg.wasm's own `progress` is time ÷ the INPUT's length,
// so with cuts the bar stalled at e.g. 92 % and jumped to 100 % (and the time left read too
// long). `time` is the output position in µs: divide by the length being written instead.
function progressOf({ progress, time }, outSec) {
  if (typeof time === 'number' && time >= 0 && outSec > 0) return Math.max(0, Math.min(1, time / 1e6 / outSec));
  if (typeof progress === 'number' && progress >= 0) return Math.max(0, Math.min(1, progress));
  return null;
}

// ---------- Would a stream copy start exactly where the kept part starts? ----------
// A stream copy can only begin on a keyframe: for `-ss X -i … -c copy` ffmpeg 5.1 starts
// at the last keyframe shown at or before X (5 ms before a keyframe already means the one
// 4 s earlier on an OBS clip) and keeps everything from there. Ask ffmpeg itself: the very
// same input seek, copying only the first few video packets into a tiny framecrc text whose
// timestamps are relative to X. ffmpeg's own seek decides, so the answer is exact for every
// container (MP4/MOV/MKV) and edit list. Nothing is decoded and only the index + a few
// packets are read (~60 ms), never the whole file.
// Returns { offset, frame } in seconds — offset < 0: the copy would start that long BEFORE
// X (cut frames leak in), > 0: after X (kept frames lost); frame: the frame length there —
// or null when it can't be told (the caller then plays safe and converts).
const COPY_CHECK_PACKETS = 12; // keyframe + the frames after it, enough to see leading B-frames of an open GOP
async function copyStartOffset(ff, inputName, startSec) {
  const name = 'copycheck.txt';
  const ss = ts(startSec); // the same string the real copy passes to -ss
  let code;
  try {
    // A copy check reads no frame data; a huge MKV without an index may still need a long
    // seek with no log output, hence the longer watchdog.
    code = await execFF(ff, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', ss, '-i', inputName,
      '-map', '0:v:0', '-c', 'copy', '-frames:v', String(COPY_CHECK_PACKETS),
      '-avoid_negative_ts', 'disabled', // keep the times relative to X (negative = before X)
      '-f', 'framecrc', '-y', name,
    ], { threads: false, stallMs: 90000 });
  } catch (err) {
    if (isEngineFailure(err) || cancelRequested) throw err;
    return null;
  }
  let txt = '';
  try {
    if (code === 0) txt = new TextDecoder().decode(await ff.readFile(name));
  } catch (_) {
    txt = '';
  }
  try { await ff.deleteFile(name); } catch (_) {}
  if (!txt) return null;
  const tb = /#tb 0:\s*(\d+)\/(\d+)/.exec(txt);
  if (!tb || !Number(tb[1]) || !Number(tb[2])) return null;
  const unit = Number(tb[1]) / Number(tb[2]);
  const pts = [];
  let firstDur = 0;
  // framecrc rows: stream, dts, pts, duration, size, crc[, F=flags]
  for (const line of txt.split('\n')) {
    if (!line || line[0] === '#') continue;
    const c = line.split(',');
    if (c.length < 6 || c[0].trim() !== '0') continue;
    const p = Number(c[2]);
    if (!Number.isFinite(p) || Math.abs(p * unit) > 1e6) return null; // no/garbage timestamp → can't tell
    if (!pts.length) firstDur = Number(c[3]) * unit;
    pts.push(p * unit);
  }
  if (!pts.length) return null;
  // Frame length near the start: the smallest gap between the copied frames' times (works
  // for constant and variable frame rates alike), else the first packet's own duration.
  const sorted = [...pts].sort((a, b) => a - b);
  let frame = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 1e-6 && d < frame) frame = d;
  }
  if (!Number.isFinite(frame)) frame = firstDur > 0 ? firstDur : 0;
  // offset relative to the user's real cut point, not to its rounded -ss string
  return { offset: sorted[0] + (Number(ss) - startSec), frame };
}

// Can this cut-only export be a stream copy and still be exact? Only as ONE part:
//  - joining two or more copied parts is never exact — with B-frames each part runs 2–4
//    frames on into the cut, and the sound drifts at every join (measured 65 → 88 ms on an
//    OBS-like clip even with every part starting exactly on a keyframe);
//  - a part starting at the very beginning (no cut, or only the end trimmed) is fine;
//  - a part starting later must start (within half a frame) exactly on a keyframe.
// Anything unclear → false: the caller converts and the cut is exact — the safe side.
async function copyWouldBeExact(ff, inputName, keep, status) {
  if (keep.length !== 1) return false;
  const seg = keep[0];
  if (!(seg.start > 0)) return true;
  status('カットの位置を確かめています...');
  const r = await copyStartOffset(ff, inputName, seg.start);
  if (!r || !(r.frame > 0)) return false;
  if (Math.abs(r.offset) > r.frame / 2) {
    console.info(`[exporter] a stream copy would start ${(-r.offset).toFixed(3)} s before the kept part at ${seg.start.toFixed(3)} s → converting so the cut is exact`);
    return false;
  }
  return true;
}

// Shown while a cut-only export is converted because a copy would have kept part of a cut.
// Plain words (no "keyframe" / "re-encode"): the user only needs to know why it is slower.
const EXACT_CUT_STATUS = 'カットした所をぴったり消すため、変換しています（少し時間がかかります）';

// ---------- Stream-copy export (fast, lossless) ----------
// Always outputs `.mp4` regardless of input container. The caller must only
// invoke this when the input is known MP4-compatible (mp4/m4v/mov family) AND
// the requested output format is mp4. If streams aren't actually copyable into
// MP4, ff.exec will return non-zero and the caller falls back to re-encode.
async function exportStreamCopy(ff, inputName, keep, status, onProgress) {
  const segExt = '.mp4';
  const segFiles = [];
  try {
    for (let i = 0; i < keep.length; i++) {
      const seg = keep[i];
      const segName = `seg${i}${segExt}`;
      status(`セグメント ${i + 1}/${keep.length} を抽出中（高速モード）...`);
      onProgress((i + 0.5) / (keep.length + 1));

      const code = await execFF(ff, [
        '-ss', ts(seg.start),
        '-to', ts(seg.end),
        '-i', inputName,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart', // moov at front: single-segment output is otherwise non-faststart
        '-map', '0:v', '-map', '0:a?', // video + all audio; skip subtitle/data/attachment streams MP4 can't hold (e.g. OBS MKV) — avoids a wasted failed copy then transcode
        '-y', segName,
      ]);
      if (code !== 0) throw new Error(`セグメント ${i + 1} の抽出に失敗 (exit ${code})`);
      segFiles.push(segName);
    }

    let outputName;
    if (segFiles.length === 1) {
      outputName = segFiles[0];
    } else {
      const listContent = segFiles.map((f) => `file '${f}'`).join('\n');
      await ff.writeFile('concat.txt', new TextEncoder().encode(listContent));
      status('セグメントを結合中...');
      onProgress(keep.length / (keep.length + 1));
      const code = await execFF(ff, [
        '-f', 'concat',
        '-safe', '0',
        '-i', 'concat.txt',
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y', 'output' + segExt,
      ]);
      if (code !== 0) throw new Error(`結合に失敗 (exit ${code})`);
      outputName = 'output' + segExt;
    }

    onProgress(1);
    const data = await ff.readFile(outputName);
    for (const f of segFiles) { try { await ff.deleteFile(f); } catch (_) {} }
    if (outputName !== segFiles[0]) {
      try { await ff.deleteFile(outputName); } catch (_) {}
      try { await ff.deleteFile('concat.txt'); } catch (_) {}
    }
    return data;
  } catch (err) {
    // A stuck engine is about to be thrown away (and would never answer): no clean-up then.
    if (isEngineFailure(err) || cancelRequested) throw err;
    // Clean any partial MEMFS files — including the segment that just failed, which
    // isn't in segFiles yet — so a fallback transcode in this job doesn't carry them.
    for (let i = 0; i < keep.length; i++) { try { await ff.deleteFile(`seg${i}${segExt}`); } catch (_) {} }
    try { await ff.deleteFile('concat.txt'); } catch (_) {}
    try { await ff.deleteFile('output' + segExt); } catch (_) {}
    throw err;
  }
}

// ---------- Re-encode export ----------
// Builds a complete filter_complex graph that:
//   1. Trims each input segment (with optional speed change)
//   2. Concats to intermediate [v_pre] (and [a_pre] if hasAudio)
//   3. Applies scale / fps to [v_pre] → [outv]
//   4. Applies loudnorm or anull to [a_pre] → [outa]  (audio branch independent of video branch)
//
// hasAudio MUST be false for format='gif' (caller's responsibility).
function buildReencodeFilter(segments, hasAudio, opts) {
  const normalize = !!opts.normalize;
  const height = opts.height;
  const format = opts.format || 'mp4';
  const parts = [];
  let concatInputs = '';

  segments.forEach((seg, i) => {
    let vChain = `[0:v]trim=${seg.start.toFixed(3)}:${seg.end.toFixed(3)},setpts=PTS-STARTPTS`;
    if (seg.speed !== 1) vChain += `,setpts=PTS/${seg.speed}`;
    vChain += `[v${i}]`;
    parts.push(vChain);

    if (hasAudio) {
      let aChain = `[0:a:0]atrim=${seg.start.toFixed(3)}:${seg.end.toFixed(3)},asetpts=PTS-STARTPTS`;
      if (seg.speed !== 1) {
        let s = seg.speed;
        while (s > 2.0) { aChain += `,atempo=2.0`; s /= 2.0; }
        if (s > 1.001 || s < 0.999) aChain += `,atempo=${s.toFixed(4)}`;
      }
      aChain += `[a${i}]`;
      parts.push(aChain);
      concatInputs += `[v${i}][a${i}]`;
    } else {
      concatInputs += `[v${i}]`;
    }
  });

  // Concat to intermediate labels
  parts.push(
    `${concatInputs}concat=n=${segments.length}:v=1:a=${hasAudio ? 1 : 0}[v_pre]` +
    (hasAudio ? '[a_pre]' : '')
  );

  // Video chain: format-specific post-processing
  const aspect = opts.aspect;
  if (format === 'gif') {
    const gifH = height && height !== 'original' ? Number(height) : 360;
    parts.push(`[v_pre]fps=12,scale=-2:${gifH}:flags=lanczos[outv]`);
  } else if (aspect === '1:1' || aspect === '9:16') {
    // Letterbox (pad) into the target canvas — never crop, so HUD/killfeed stay.
    const [cw, ch] = aspect === '1:1' ? [1080, 1080] : [1080, 1920];
    parts.push(`[v_pre]scale=${cw}:${ch}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[outv]`);
  } else if (height && height !== 'original') {
    parts.push(`[v_pre]scale=-2:${Number(height)}[outv]`);
  } else {
    parts.push(`[v_pre]null[outv]`);
  }

  // Audio chain (independent of video, only when audio is present)
  if (hasAudio) {
    if (normalize) {
      parts.push(`[a_pre]loudnorm=I=-16:LRA=11:TP=-1.5[outa]`);
    } else {
      parts.push(`[a_pre]anull[outa]`);
    }
  }
  return parts.join(';');
}

// H.264 rate ceiling (Mbit/s). The X export never leaves 1080p, and 20 Mbit/s keeps even
// X's longest free clip (2:20) at ≤ ~360 MB, well inside its 512 MB. The plain export
// keeps the source size, so >1080p output gets a ceiling scaled by its pixel count.
const X_MAXRATE_MBPS = 20;
function plainMaxrateMbps(opts) {
  if ((opts.height && opts.height !== 'original') || opts.aspect === '1:1' || opts.aspect === '9:16') return X_MAXRATE_MBPS;
  const px = (Number(opts.sourceWidth) || 0) * (Number(opts.sourceHeight) || 0);
  return Math.max(X_MAXRATE_MBPS, Math.round(X_MAXRATE_MBPS * px / (1920 * 1080)));
}

async function exportReencode(ff, inputName, ranges, duration, hasAudio, options, status, onProgress) {
  const segments = planSegments(ranges, duration);
  if (segments.length === 0) throw new Error('全部削除されています。');

  const format = options.format || 'mp4';
  // GIF has no audio in output. Otherwise audio passthrough depends on source.
  const includeAudio = hasAudio && format !== 'gif';

  const filterComplex = buildReencodeFilter(segments, includeAudio, {
    normalize: options.normalizeAudio,
    height: options.height,
    aspect: options.aspect,
    format,
  });

  const args = [
    '-i', inputName,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
  ];
  if (includeAudio) args.push('-map', '[outa]');

  if (format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32');
    if (includeAudio) args.push('-c:a', 'libopus', '-b:a', '96k');
  } else if (format === 'gif') {
    // GIF: no audio, no codec args needed (gif encoder is auto-selected)
    args.push('-loop', '0');
  } else {
    // ultrafast: ffmpeg.wasm's H.264 DECODE is the bottleneck (54 fps single-thread on a
    // 26 Mbit/s 1536×864 replay), so slower presets cost a lot of time for little gain
    // (superfast 1.6×, veryfast 2.5× slower, 2026-10-19). crf 18 keeps the picture close to
    // the source: on the owner's 3-min replay VMAF 96.0 vs 89.9 with the old crf 23 +
    // 12 Mbit/s cap (311 vs 187 MB). The VBV cap bounds the size (see X_MAXRATE_MBPS) and,
    // for X, stays well under its ~25 Mbit/s ceiling.
    const cap = options.xSafe ? X_MAXRATE_MBPS : plainMaxrateMbps(options);
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-maxrate', `${cap}M`, '-bufsize', `${cap * 2}M`);
    if (includeAudio) args.push('-c:a', 'aac', '-b:a', '128k');
    args.push('-movflags', '+faststart');
  }

  // Keep each frame's own time. ffmpeg's default for MP4 is a constant frame rate, which on a
  // variable-frame-rate source (phones, some recorders) padded the gaps with duplicate frames
  // (466 on a 35 s test clip) and let the picture drift up to 43 ms from the sound.
  args.push('-fps_mode', 'passthrough');

  const outExt = format === 'webm' ? '.webm' : (format === 'gif' ? '.gif' : '.mp4');
  args.push('-y', 'output' + outExt);

  // Forward ffmpeg's fine-grained progress for the (potentially long) re-encode.
  // Scoped to this function only: the stream-copy path drives its own coarse,
  // monotonic onProgress, so letting both sources write the same bar there made
  // it oscillate. Removed in finally so it never leaks onto a later export.
  // determinate:true marks this as ffmpeg's REAL time-based progress (vs the coarse
  // synthetic steps of the stream-copy path), so the UI can show a trustworthy ETA.
  const outSec = segmentsOutputDuration(segments);
  const progressHandler = (ev) => {
    const p = progressOf(ev, outSec);
    if (p !== null) onProgress(p, { determinate: true });
  };
  ff.on('progress', progressHandler);

  status(options.statusText || '変換中（再エンコード）… 動画が長いほど時間がかかります');
  let code;
  try {
    code = await execFF(ff, args);
  } finally {
    try { ff.off('progress', progressHandler); } catch (_) {}
  }
  if (code !== 0) throw new Error(`再エンコードに失敗 (exit ${code})`);
  const data = await ff.readFile('output' + outExt);
  try { await ff.deleteFile('output' + outExt); } catch (_) {}
  onProgress(1);
  return { data, ext: outExt };
}

// ---------- X (Twitter) optimized export ----------
// X accepts only H.264 (High Profile) video + AAC audio in an MP4/MOV container.
// Most game-capture defaults (Xbox Game Bar, Switch, Xbox console, NVIDIA/AMD)
// already are H.264/AAC MP4, so we stream-copy them losslessly. The exceptions —
// HEVC (Steam recorder), VP9/Opus (PS5 WebM), AV1, or any speed-up range — must
// be transcoded to H.264/AAC, which we detect from the probed codecs (not the
// extension). Output is always .mp4; resolution/audio-normalize are intentionally
// not applied here so the lossless copy path stays available.
async function exportForX(ff, inputName, ranges, duration, hasAudio, aspect, status, onProgress) {
  status('コーデックを確認中...');
  const { videoCodec, audioCodec, width, height } = await probeInput(ff, inputName);
  throwIfCancelled(); // a cancel during the probe must abort cleanly, not fall through

  // Trust the probe (the ground truth for what's inside the file) over the
  // caller's hasAudio flag and the file extension.
  const audioPresent = audioCodec !== null;
  const videoXok = videoCodec === 'h264' || videoCodec === 'avc' || videoCodec === 'avc1';
  const audioXok = !audioPresent || audioCodec === 'aac';
  const hasSpeedup = rangesHaveSpeedup(ranges);
  const aspectChange = aspect && aspect !== 'original'; // padding to 1:1 / 9:16 needs a re-encode
  // Downscale only LANDSCAPE/square clips above 1080p (1440p/4K 16:9) to X's safe
  // 1080p target. A portrait clip (e.g. 1080x1920) has height>1080 but is X-fine,
  // so don't shrink it just because the tall side exceeds 1080.
  const overSized = !!(width && height && width >= height && height > 1080);
  const canCopy = videoXok && audioXok && !hasSpeedup && !overSized && !aspectChange;

  let exactCut = false; // converting only because a copy would not cut exactly
  if (canCopy) {
    const keep = computeKeepSegmentsCutsOnly(ranges, duration);
    if (keep.length === 0) throw new Error('全部削除されています。');
    const exact = await copyWouldBeExact(ff, inputName, keep, status);
    throwIfCancelled();
    if (exact) {
      try {
        const data = await exportStreamCopy(ff, inputName, keep, status, onProgress);
        status('完了！X用MP4（画質ロスなし）');
        return new Blob([data.buffer], { type: 'video/mp4' });
      } catch (err) {
        if (isEngineFailure(err) || cancelRequested) throw err;
        // -c copy can still fail (e.g. an uncopyable data/subtitle stream in an MKV);
        // fall back to a transcode so the user always gets an X-uploadable file.
        console.warn('[exporter] X stream-copy failed, transcoding:', err);
        onProgress(0);
      }
    } else {
      exactCut = true;
    }
  }

  const why = !videoXok
    ? `${videoCodec || '不明な動画コーデック'} → H.264`
    : (!audioXok ? `${audioCodec || '音声'} → AAC`
      : (aspectChange ? `${aspect === '9:16' ? '縦9:16' : '正方形1:1'} に変換`
        : (overSized ? `${height}p → 1080p` : '倍速処理')));
  status(exactCut ? EXACT_CUT_STATUS : `X用に再エンコード中（${why}）...`);
  const { data } = await exportReencode(
    ff, inputName, ranges, duration, audioPresent,
    { format: 'mp4', height: overSized ? 1080 : 'original', aspect, normalizeAudio: false, xSafe: true,
      statusText: exactCut ? EXACT_CUT_STATUS : undefined },
    status, onProgress
  );
  status('完了！X用MP4');
  return new Blob([data.buffer], { type: 'video/mp4' });
}

// ---------- Main export ----------
// Returns the output as a Blob (the caller owns the object-URL lifecycle so the
// export-done panel can keep it alive and revoke it on close).
export function exportVideo(file, ranges, duration, options = {}) {
  return runJob(options, (ff, status, onProgress) => exportVideoJob(ff, status, onProgress, file, ranges, duration, options));
}

async function exportVideoJob(ff, status, onProgress, file, ranges, duration, options) {
  const hasAudio = options.hasAudio !== false;
  const requestedMode = options.mode || 'auto';
  const format = options.format || 'mp4';
  const height = options.height || 'original';
  const normalizeAudio = !!options.normalizeAudio;
  const aspect = options.aspect || 'original';

  const ext = getExt(file.name);
  status('動画ファイルを準備中...');
  // WORKERFS-mount the source (no MEMFS copy). inputName is the in-wasm path.
  // (No unmount needed: the engine is terminated after the job.)
  const inputName = await mountInput(ff, '/in', 'input' + ext, file);
  throwIfCancelled();

  // X (Twitter) optimized export: probe the real codecs and produce an
  // X-uploadable H.264/AAC MP4 — lossless stream-copy when already compatible,
  // transcode only for HEVC/AV1/VP9/Opus sources, speed-ups or inexact cuts.
  if (options.xOptimize) {
    return exportForX(ff, inputName, ranges, duration, hasAudio, aspect, status, onProgress);
  }

  // Decide whether stream-copy is possible.
  // Stream-copy only when the input container is MP4-family AND output is MP4.
  // Otherwise re-encode so the output bytes actually match the requested container.
  const inputIsMp4Family = /\.(mp4|m4v|mov|m4a)$/i.test(file.name);
  const hasSpeedup = rangesHaveSpeedup(ranges);
  const needsReencode =
    hasSpeedup ||
    format !== 'mp4' ||
    height !== 'original' ||
    aspect !== 'original' ||
    normalizeAudio ||
    requestedMode === 'precise' ||
    !inputIsMp4Family;

  let exactCut = false; // converting only because a copy would not cut exactly

  if (!needsReencode && (requestedMode === 'auto' || requestedMode === 'fast')) {
    const keep = computeKeepSegmentsCutsOnly(ranges, duration);
    if (keep.length === 0) throw new Error('全部削除されています。');
    // 'fast' = the caller explicitly asked for the quick copy (cut points snap to keyframes).
    let exact = true;
    if (requestedMode === 'auto') {
      exact = await copyWouldBeExact(ff, inputName, keep, status);
      throwIfCancelled();
    }
    if (exact) {
      try {
        const data = await exportStreamCopy(ff, inputName, keep, status, onProgress);
        status('完了！（高速モード・画質ロスなし）');
        return new Blob([data.buffer], { type: 'video/mp4' });
      } catch (err) {
        if (requestedMode === 'fast' || isEngineFailure(err) || cancelRequested) throw err;
        console.warn('[exporter] stream copy failed:', err);
        status('高速モード失敗、再エンコードに切り替え...');
        onProgress(0);
      }
    } else {
      exactCut = true;
      status(EXACT_CUT_STATUS);
    }
  }

  throwIfCancelled();
  const { data, ext: outExt } = await exportReencode(
    ff, inputName, ranges, duration, hasAudio,
    { format, height, normalizeAudio, aspect, statusText: exactCut ? EXACT_CUT_STATUS : undefined,
      sourceWidth: options.sourceWidth, sourceHeight: options.sourceHeight },
    status, onProgress
  );
  const mime = outExt === '.webm' ? 'video/webm' : (outExt === '.gif' ? 'image/gif' : 'video/mp4');
  status('完了！');
  return new Blob([data.buffer], { type: mime });
}

// ---------- Rescue: convert a browser-unplayable file into an editable MP4 ----------
// A clip can fail to load in the <video> element for two distinct reasons:
//   (1) a CONTAINER the browser can't demux (MKV / AVI) but whose codecs it COULD
//       decode (H.264 + AAC, the common OBS-MKV case) → a fast, LOSSLESS remux to
//       MP4 (-c copy) makes it playable with zero quality loss.
//   (2) a CODEC the browser can't decode (HEVC / AV1 / DivX-Xvid, etc.) → TRANSCODE
//       to H.264/AAC MP4 so the editor's <video> can scrub/preview/decode-waveform it.
// 100% local, same as every other path. Returns { blob, method:'remux'|'transcode',
// fromCodec }. Honors cancelExport() via the shared cancelRequested/terminate path.
export function rescueToPlayable(file, options = {}) {
  return runJob(options, (ff, status, onProgress) => rescueJob(ff, status, onProgress, file), { formatErrors: false });
}

async function rescueJob(ff, status, onProgress, file) {
  status('変換の準備をしています…');
  const ext = getExt(file.name);
  const inputName = await mountInput(ff, '/rescue', 'input' + ext, file);
  throwIfCancelled();

  status('ファイルの形式を確認しています…');
  const { videoCodec, audioCodec } = await probeInput(ff, inputName);
  throwIfCancelled();

  // Codecs the browser <video> can actually decode inside an MP4 container.
  const videoPlayable = videoCodec === 'h264' || videoCodec === 'avc' || videoCodec === 'avc1';
  const audioPlayable = audioCodec === null || audioCodec === 'aac' || audioCodec === 'mp3';

  let method = null;
  if (videoPlayable && audioPlayable) {
    // Container-only problem (e.g. OBS MKV with H.264/AAC): remux losslessly.
    status('MP4に変換しています（画質そのまま・このPCの中だけで処理）…');
    const code = await execFF(ff, [
      '-i', inputName,
      // First video + first audio only, matching the transcode branch and the
      // editor's single-track model (avoids a rescued file with extra audio
      // tracks that a remux→transcode fallback would then silently drop).
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y', 'rescued.mp4',
    ]);
    if (code === 0) method = 'remux';
    else { console.warn('[rescue] remux failed, falling back to transcode'); throwIfCancelled(); }
  }

  if (method !== 'remux') {
    method = 'transcode';
    status('再生できる形式に変換しています（再エンコード・このPCの中だけで処理）…');
    const includeAudio = audioCodec !== null;
    const args = ['-i', inputName, '-map', '0:v:0'];
    if (includeAudio) args.push('-map', '0:a:0?');
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-crf', '23');
    if (includeAudio) args.push('-c:a', 'aac', '-b:a', '128k');
    args.push('-movflags', '+faststart', '-y', 'rescued.mp4');
    // Real ffmpeg progress → determinate:true so the UI shows a trustworthy ETA.
    const progressHandler = (ev) => {
      const p = progressOf(ev, 0); // no cut here: ffmpeg's own fraction is right
      if (p !== null) onProgress(p, { determinate: true });
    };
    ff.on('progress', progressHandler);
    let code;
    try { code = await execFF(ff, args); }
    finally { try { ff.off('progress', progressHandler); } catch (_) {} }
    if (code !== 0) throw new Error(`変換に失敗 (exit ${code})`);
  }

  const data = await ff.readFile('rescued.mp4');
  try { await ff.deleteFile('rescued.mp4'); } catch (_) {}
  onProgress(1);
  status('');
  return { blob: new Blob([data.buffer], { type: 'video/mp4' }), method, fromCodec: videoCodec };
}

// ---------- Multi-clip concat ("highlights") export ----------
// Combine several clips — each already middle-cut / sped-up with its own ranges —
// into ONE X-uploadable MP4. Cross-clip stream-copy is impossible (clips differ in
// codec/resolution/fps/SAR/audio), so we re-encode: each clip is normalized to a
// COMMON canvas + 30fps CFR + H.264 High/4.1 + AAC 48k stereo, written to an
// MPEG-TS intermediate (TS carries in-band SPS/PPS so independently-encoded
// segments concat-copy cleanly — far more robust than concatenating .mp4s), then
// the .ts files are concat-demuxed with `-c copy` (+aac_adtstoasc to mux ADTS→MP4)
// and faststart. Clips are processed ONE AT A TIME (write→encode→delete input) to
// bound ffmpeg.wasm MEMFS memory; game clips can be hundreds of MB each.

function canvasFor(aspect) {
  if (aspect === '1:1') return [1080, 1080];
  if (aspect === '9:16') return [1080, 1920];
  return [1920, 1080]; // 'original' / default → landscape 1080p
}

// Build the per-clip filter_complex that trims+speeds the clip's segments, concats
// them, then conforms video to the common canvas (letterbox/pillarbox — never crop)
// at 30fps, and audio to 48k stereo. Returns { filter, hasAudioOut }.
function buildClipNormalizeFilter(segments, hasAudio, canvas) {
  const [CW, CH] = canvas;
  const parts = [];
  segments.forEach((seg, i) => {
    let v = `[0:v]trim=${seg.start.toFixed(3)}:${seg.end.toFixed(3)},setpts=PTS-STARTPTS`;
    if (seg.speed && seg.speed !== 1) v += `,setpts=PTS/${seg.speed}`;
    v += `[v${i}]`;
    parts.push(v);
    if (hasAudio) {
      let a = `[0:a:0]atrim=${seg.start.toFixed(3)}:${seg.end.toFixed(3)},asetpts=PTS-STARTPTS`;
      if (seg.speed && seg.speed !== 1) {
        let s = seg.speed;
        while (s > 2.0) { a += `,atempo=2.0`; s /= 2.0; }
        if (s > 1.001 || s < 0.999) a += `,atempo=${s.toFixed(4)}`;
      }
      a += `[a${i}]`;
      parts.push(a);
    }
  });
  const n = segments.length;
  const vpad = `scale=${CW}:${CH}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
    `pad=${CW}:${CH}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30`;
  if (hasAudio) {
    let concatIn = '';
    for (let i = 0; i < n; i++) concatIn += `[v${i}][a${i}]`;
    parts.push(`${concatIn}concat=n=${n}:v=1:a=1[vc][ac]`);
    parts.push(`[vc]${vpad}[outv]`);
    parts.push(`[ac]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[outa]`);
  } else {
    let concatIn = '';
    for (let i = 0; i < n; i++) concatIn += `[v${i}]`;
    parts.push(`${concatIn}concat=n=${n}:v=1:a=0[vc]`);
    parts.push(`[vc]${vpad}[outv]`);
  }
  return { filter: parts.join(';'), hasAudioOut: hasAudio };
}

async function encodeClipToTs(ff, inputName, segments, hasAudio, canvas, outName, status, onProgress) {
  const { filter } = buildClipNormalizeFilter(segments, hasAudio, canvas);
  const outSec = segmentsOutputDuration(segments);
  const args = ['-i', inputName];
  // Clips with no usable audio still get a silent stereo track — bounded to the
  // exact kept-segments length via `-t` — so EVERY intermediate has an identical
  // stream layout; otherwise concat-copy of mixed has-audio/no-audio segments breaks.
  if (!hasAudio) {
    const silenceDur = Math.max(0.05, outSec);
    args.push('-f', 'lavfi', '-t', silenceDur.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
  }
  args.push('-filter_complex', filter, '-map', '[outv]');
  if (hasAudio) args.push('-map', '[outa]');
  else args.push('-map', '1:a');
  args.push(
    // Same libx264 ultrafast / yuv420p settings as the single-clip X export, so
    // every intermediate is bit-for-bit uniform in codec params → concat-copy is
    // valid. (ultrafast emits Constrained Baseline, which X accepts.)
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-maxrate', '12M', '-bufsize', '24M',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-f', 'mpegts', '-y', outName
  );

  const progressHandler = (ev) => {
    const p = progressOf(ev, outSec);
    if (p !== null) onProgress(p, { determinate: true });
  };
  ff.on('progress', progressHandler);
  status('変換中（再エンコード）…');
  let code;
  try { code = await execFF(ff, args); }
  finally { try { ff.off('progress', progressHandler); } catch (_) {} }
  if (code !== 0) throw new Error(`クリップのエンコードに失敗 (exit ${code})`);
}

// clips: [{ file, ranges, duration, hasAudio }]. Output: a combined X-ready .mp4 Blob.
export function exportConcat(clips, options = {}) {
  // Plan each clip's kept/sped segments; drop clips that are fully cut away. (Checked before
  // any engine starts: these are edit problems, not engine problems.)
  const plans = clips
    .map((c) => ({ clip: c, segments: planSegments(c.ranges || [], c.duration) }))
    .filter((p) => p.segments.length > 0);
  if (plans.length === 0) return Promise.reject(new Error('すべてのクリップが空です（カットで全部消えています）。'));
  if (plans.length < 2) return Promise.reject(new Error('結合するには2本以上の有効なクリップが必要です。'));
  const canvas = canvasFor(options.aspect || 'original');
  return runJob(options, (ff, status, onProgress) => concatJob(ff, status, onProgress, plans, canvas));
}

async function concatJob(ff, status, onProgress, plans, canvas) {
  const tsFiles = [];
  const N = plans.length;
  for (let i = 0; i < N; i++) {
    throwIfCancelled();
    const { clip, segments } = plans[i];
    const dir = `/cin${i}`;
    status(`クリップ ${i + 1}/${N} を準備中...`);
    // WORKERFS-mount this clip's source (no MEMFS copy of the whole file).
    const inputName = await mountInput(ff, dir, `cin${i}${getExt(clip.file.name)}`, clip.file);
    throwIfCancelled();

    // Ground-truth audio presence per clip (don't trust an upstream flag): a clip
    // the user never opened in the editor would otherwise default to has-audio and
    // make the [0:a:0] filter fail on a genuinely silent source.
    const probe = await probeInput(ff, inputName);
    throwIfCancelled();
    const clipHasAudio = probe.audioCodec !== null;

    const tsName = `cseg${i}.ts`;
    await encodeClipToTs(
      ff, inputName, segments, clipHasAudio, canvas, tsName,
      (msg) => status(`クリップ ${i + 1}/${N}: ${msg}`),
      // Deliberately DROP the determinate flag here: the combined value
      // (i+p)/(N+1) is a piecewise per-clip fraction, NOT ffmpeg's real
      // time-proportional progress, so feeding it to the ETA estimator would
      // extrapolate the whole job from clip 1's speed and show a misleading
      // countdown. concat shows %+「クリップ i/N」status only — honest, no fake ETA.
      (p) => onProgress((i + p) / (N + 1))
    );
    tsFiles.push(tsName);
    // Unmount the source immediately so only ONE clip's bytes are ever mapped —
    // peak memory stays ~one clip + the (small, H.264-compressed) intermediates.
    await unmountInput(ff, dir);
  }

  throwIfCancelled();
  status('クリップを結合中...');
  onProgress(N / (N + 1));
  const list = tsFiles.map((f) => `file '${f}'`).join('\n');
  await ff.writeFile('clist.txt', new TextEncoder().encode(list));
  const code = await execFF(ff, [
    '-f', 'concat', '-safe', '0', '-i', 'clist.txt',
    '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart', '-y', 'combined.mp4',
  ]);
  if (code !== 0) throw new Error(`結合に失敗 (exit ${code})`);

  const data = await ff.readFile('combined.mp4');
  onProgress(1);
  status('完了！つなげたハイライトをXにアップロードできます。');
  return new Blob([data.buffer], { type: 'video/mp4' });
}

// Expose helper for UI to predict output extension
export function predictOutputExt(format) {
  return format === 'webm' ? '.webm' : (format === 'gif' ? '.gif' : '.mp4');
}
