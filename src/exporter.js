// Video export using ffmpeg.wasm.
// Default mode for pure cuts: stream copy (no re-encode, no quality loss).
// If any range is "speedup" OR resolution/format options are set, switches to re-encode.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

const coreURL = new URL('ffmpeg/ffmpeg-core.js', window.location.origin + '/').href;
const wasmURL = new URL('ffmpeg/ffmpeg-core.wasm', window.location.origin + '/').href;

let ffmpegInstance = null;
let logBuffer = [];
let cancelRequested = false;

export function cancelExport() {
  cancelRequested = true;
  if (ffmpegInstance) {
    try {
      ffmpegInstance.terminate();
    } catch (err) {
      console.warn('terminate threw:', err);
    }
    ffmpegInstance = null;
  }
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

async function getFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  const ff = new FFmpeg();
  ff.on('log', ({ type, message }) => {
    pushLog(`[${type}] ${message}`);
    console.log('[ffmpeg]', message);
  });
  await ff.load({ coreURL, wasmURL });
  ffmpegInstance = ff;
  return ff;
}

function getExt(name) {
  const m = /\.[a-zA-Z0-9]+$/.exec(name);
  return m ? m[0].toLowerCase() : '.mp4';
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

// ---------- Stream-copy export (fast, lossless) ----------
// Always outputs `.mp4` regardless of input container. The caller must only
// invoke this when the input is known MP4-compatible (mp4/m4v/mov family) AND
// the requested output format is mp4. If streams aren't actually copyable into
// MP4, ff.exec will return non-zero and the caller falls back to re-encode.
async function exportStreamCopy(ff, inputName, keep, status, onProgress) {
  const segExt = '.mp4';
  const segFiles = [];
  for (let i = 0; i < keep.length; i++) {
    const seg = keep[i];
    const segName = `seg${i}${segExt}`;
    status(`セグメント ${i + 1}/${keep.length} を抽出中（高速モード）...`);
    onProgress((i + 0.5) / (keep.length + 1));

    const code = await ff.exec([
      '-ss', seg.start.toFixed(3),
      '-to', seg.end.toFixed(3),
      '-i', inputName,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-map', '0',
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
    const code = await ff.exec([
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
  if (format === 'gif') {
    const gifH = height && height !== 'original' ? Number(height) : 360;
    parts.push(`[v_pre]fps=12,scale=-2:${gifH}:flags=lanczos[outv]`);
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

async function exportReencode(ff, inputName, ranges, duration, hasAudio, options, status, onProgress) {
  const segments = planSegments(ranges, duration);
  if (segments.length === 0) throw new Error('全部削除されています。');

  const format = options.format || 'mp4';
  // GIF has no audio in output. Otherwise audio passthrough depends on source.
  const includeAudio = hasAudio && format !== 'gif';

  const filterComplex = buildReencodeFilter(segments, includeAudio, {
    normalize: options.normalizeAudio,
    height: options.height,
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
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
    if (includeAudio) args.push('-c:a', 'aac', '-b:a', '128k');
    args.push('-movflags', '+faststart');
  }

  const outExt = format === 'webm' ? '.webm' : (format === 'gif' ? '.gif' : '.mp4');
  args.push('-y', 'output' + outExt);

  // Forward ffmpeg's fine-grained progress for the (potentially long) re-encode.
  // Scoped to this function only: the stream-copy path drives its own coarse,
  // monotonic onProgress, so letting both sources write the same bar there made
  // it oscillate. Removed in finally so it never leaks onto a later export.
  const progressHandler = ({ progress }) => {
    if (typeof progress === 'number' && progress >= 0) {
      onProgress(Math.max(0, Math.min(1, progress)));
    }
  };
  ff.on('progress', progressHandler);

  status('再エンコード中... (時間かかります)');
  let code;
  try {
    code = await ff.exec(args);
  } finally {
    try { ff.off('progress', progressHandler); } catch (_) {}
  }
  if (code !== 0) throw new Error(`再エンコードに失敗 (exit ${code})`);
  const data = await ff.readFile('output' + outExt);
  try { await ff.deleteFile('output' + outExt); } catch (_) {}
  onProgress(1);
  return { data, ext: outExt };
}

// ---------- Main export ----------
export async function exportVideo(file, ranges, duration, options = {}) {
  const status = options.onStatus || (() => {});
  const onProgress = options.onProgress || (() => {});
  const hasAudio = options.hasAudio !== false;
  const requestedMode = options.mode || 'auto';
  const format = options.format || 'mp4';
  const height = options.height || 'original';
  const normalizeAudio = !!options.normalizeAudio;

  cancelRequested = false;
  logBuffer = [];
  status('FFmpeg を準備中...');
  onProgress(0);

  let ff;
  try { ff = await getFFmpeg(); }
  catch (err) { throw new Error('FFmpeg の読み込みに失敗: ' + (err.message || err)); }

  try {
    const ext = getExt(file.name);
    const inputName = 'input' + ext;
    status('動画ファイルを準備中...');
    await ff.writeFile(inputName, await fetchFile(file));

    throwIfCancelled();
    // Decide whether stream-copy is possible.
    // Stream-copy only when the input container is MP4-family AND output is MP4.
    // Otherwise re-encode so the output bytes actually match the requested container.
    const inputIsMp4Family = /\.(mp4|m4v|mov|m4a)$/i.test(file.name);
    const hasSpeedup = rangesHaveSpeedup(ranges);
    const needsReencode =
      hasSpeedup ||
      format !== 'mp4' ||
      height !== 'original' ||
      normalizeAudio ||
      requestedMode === 'precise' ||
      !inputIsMp4Family;

    let outputBlob;

    if (!needsReencode && (requestedMode === 'auto' || requestedMode === 'fast')) {
      const keep = computeKeepSegmentsCutsOnly(ranges, duration);
      if (keep.length === 0) throw new Error('全部削除されています。');
      try {
        const data = await exportStreamCopy(ff, inputName, keep, status, onProgress);
        status('完了！（高速モード・画質ロスなし）');
        outputBlob = new Blob([data.buffer], { type: 'video/mp4' });
        return URL.createObjectURL(outputBlob);
      } catch (err) {
        if (requestedMode === 'fast') throw err;
        console.warn('[exporter] stream copy failed:', err);
        status('高速モード失敗、再エンコードに切り替え...');
        onProgress(0);
      }
    }

    throwIfCancelled();
    const { data, ext: outExt } = await exportReencode(
      ff, inputName, ranges, duration, hasAudio,
      { format, height, normalizeAudio }, status, onProgress
    );
    const mime = outExt === '.webm' ? 'video/webm' : (outExt === '.gif' ? 'image/gif' : 'video/mp4');
    status('完了！');
    outputBlob = new Blob([data.buffer], { type: mime });
    return URL.createObjectURL(outputBlob);
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    // A cancel during re-encode rejects ff.exec() with a terminate error rather
    // than our sentinel; normalize it so the UI shows the cancel message instead
    // of a failure dump. (The stream-copy path is already handled by
    // throwIfCancelled before reaching here.)
    if (cancelRequested || msg.includes('__CANCELLED__') || msg.includes('called FFmpeg.terminate()')) {
      cancelRequested = false;
      throw new Error('__CANCELLED__');
    }
    const tail = tailLog(20);
    throw new Error(`${msg}\n\n--- FFmpeg log (最後の20行) ---\n${tail || '(ログなし)'}`);
  }
}

// Expose helper for UI to predict output extension
export function predictOutputExt(format) {
  return format === 'webm' ? '.webm' : (format === 'gif' ? '.gif' : '.mp4');
}
