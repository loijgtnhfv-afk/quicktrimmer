// Video export using ffmpeg.wasm.
// Default mode for pure cuts: stream copy (no re-encode, no quality loss).
// If any range is "speedup" OR resolution/format options are set, switches to re-encode.

import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';

const coreURL = new URL('ffmpeg/ffmpeg-core.js', window.location.origin + '/').href;
const wasmURL = new URL('ffmpeg/ffmpeg-core.wasm', window.location.origin + '/').href;

let ffmpegInstance = null;
let ffmpegLoading = null;   // in-flight load promise (dedupes preload + first export racing)
let loadGeneration = 0;     // bumped by cancelExport() to disown an in-flight load
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
  // Disown any in-flight load: bumping the generation makes the resolving loader
  // terminate its (now orphaned) instance instead of installing it, and clearing
  // the promise lets the next export start a fresh load.
  loadGeneration++;
  ffmpegLoading = null;
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
  // Dedupe concurrent loads: preloadFFmpeg() may have a load in flight when the
  // user clicks export. Without this guard both would `new FFmpeg().load()`,
  // fetching the ~32MB core twice and leaking the first instance.
  if (!ffmpegLoading) {
    const gen = loadGeneration;
    ffmpegLoading = (async () => {
      const ff = new FFmpeg();
      ff.on('log', ({ type, message }) => {
        pushLog(`[${type}] ${message}`);
        console.log('[ffmpeg]', message);
      });
      await ff.load({ coreURL, wasmURL });
      // If cancelExport() ran while we were loading, this instance is orphaned —
      // terminate it rather than installing a half-cancelled core for the next export.
      if (gen !== loadGeneration) {
        try { ff.terminate(); } catch (_) {}
        throw new Error('__CANCELLED__');
      }
      ffmpegInstance = ff;
      return ff;
    })().catch((err) => {
      if (gen === loadGeneration) ffmpegLoading = null; // allow retry after a failed load
      throw err;
    });
  }
  return ffmpegLoading;
}

// Fire-and-forget warm-up: start fetching/instantiating the core so the FIRST
// export doesn't stall on the ~32MB download. Safe to call repeatedly; errors are
// swallowed here (the real export surfaces them).
export function preloadFFmpeg() {
  try { getFFmpeg().catch(() => {}); } catch (_) {}
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
    await ff.exec(['-hide_banner', '-i', inputName]);
  } catch (_) {
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

      const code = await ff.exec([
        '-ss', seg.start.toFixed(3),
        '-to', seg.end.toFixed(3),
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
  } catch (err) {
    // Clean any partial MEMFS files — including the segment that just failed, which
    // isn't in segFiles yet — so a fallback transcode / later export doesn't leak.
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
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
    if (options.xSafe) {
      // Cap peak bitrate near X's sweet spot (well under its ~25 Mbps ceiling) so
      // the output stays small and X's own server-side re-encode adds minimal loss.
      args.push('-maxrate', '12M', '-bufsize', '24M');
    }
    if (includeAudio) args.push('-c:a', 'aac', '-b:a', '128k');
    args.push('-movflags', '+faststart');
  }

  const outExt = format === 'webm' ? '.webm' : (format === 'gif' ? '.gif' : '.mp4');
  args.push('-y', 'output' + outExt);

  // Forward ffmpeg's fine-grained progress for the (potentially long) re-encode.
  // Scoped to this function only: the stream-copy path drives its own coarse,
  // monotonic onProgress, so letting both sources write the same bar there made
  // it oscillate. Removed in finally so it never leaks onto a later export.
  // determinate:true marks this as ffmpeg's REAL time-based progress (vs the coarse
  // synthetic steps of the stream-copy path), so the UI can show a trustworthy ETA.
  const progressHandler = ({ progress }) => {
    if (typeof progress === 'number' && progress >= 0) {
      onProgress(Math.max(0, Math.min(1, progress)), { determinate: true });
    }
  };
  ff.on('progress', progressHandler);

  status('変換中（再エンコード）… 動画が長いほど時間がかかります');
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

  if (canCopy) {
    const keep = computeKeepSegmentsCutsOnly(ranges, duration);
    if (keep.length === 0) throw new Error('全部削除されています。');
    try {
      const data = await exportStreamCopy(ff, inputName, keep, status, onProgress);
      status('完了！X用MP4（画質ロスなし）');
      return new Blob([data.buffer], { type: 'video/mp4' });
    } catch (err) {
      if (cancelRequested) throw err;
      // -c copy can still fail (e.g. an uncopyable data/subtitle stream in an MKV);
      // fall back to a transcode so the user always gets an X-uploadable file.
      console.warn('[exporter] X stream-copy failed, transcoding:', err);
      onProgress(0);
    }
  }

  const why = !videoXok
    ? `${videoCodec || '不明な動画コーデック'} → H.264`
    : (!audioXok ? `${audioCodec || '音声'} → AAC`
      : (aspectChange ? `${aspect === '9:16' ? '縦9:16' : '正方形1:1'} に変換`
        : (overSized ? `${height}p → 1080p` : '倍速処理')));
  status(`X用に再エンコード中（${why}）...`);
  const { data } = await exportReencode(
    ff, inputName, ranges, duration, audioPresent,
    { format: 'mp4', height: overSized ? 1080 : 'original', aspect, normalizeAudio: false, xSafe: true },
    status, onProgress
  );
  status('完了！X用MP4');
  return new Blob([data.buffer], { type: 'video/mp4' });
}

// ---------- Main export ----------
// Returns the output as a Blob (the caller owns the object-URL lifecycle so the
// export-done panel can keep it alive and revoke it on close).
export async function exportVideo(file, ranges, duration, options = {}) {
  const status = options.onStatus || (() => {});
  const onProgress = options.onProgress || (() => {});
  const hasAudio = options.hasAudio !== false;
  const requestedMode = options.mode || 'auto';
  const format = options.format || 'mp4';
  const height = options.height || 'original';
  const normalizeAudio = !!options.normalizeAudio;
  const aspect = options.aspect || 'original';

  cancelRequested = false;
  logBuffer = [];
  status('FFmpeg を準備中...');
  onProgress(0);

  let ff;
  try { ff = await getFFmpeg(); }
  catch (err) { throw new Error('FFmpeg の読み込みに失敗: ' + (err.message || err)); }

  let inputDir = null;
  try {
    const ext = getExt(file.name);
    inputDir = '/in';
    status('動画ファイルを準備中...');
    // WORKERFS-mount the source (no MEMFS copy). inputName is the in-wasm path.
    const inputName = await mountInput(ff, inputDir, 'input' + ext, file);

    throwIfCancelled();

    // X (Twitter) optimized export: probe the real codecs and produce an
    // X-uploadable H.264/AAC MP4 — lossless stream-copy when already compatible,
    // transcode only for HEVC/AV1/VP9/Opus sources or speed-up ranges.
    if (options.xOptimize) {
      const blob = await exportForX(ff, inputName, ranges, duration, hasAudio, aspect, status, onProgress);
      return blob;
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

    let outputBlob;

    if (!needsReencode && (requestedMode === 'auto' || requestedMode === 'fast')) {
      const keep = computeKeepSegmentsCutsOnly(ranges, duration);
      if (keep.length === 0) throw new Error('全部削除されています。');
      try {
        const data = await exportStreamCopy(ff, inputName, keep, status, onProgress);
        status('完了！（高速モード・画質ロスなし）');
        outputBlob = new Blob([data.buffer], { type: 'video/mp4' });
        return outputBlob;
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
      { format, height, normalizeAudio, aspect }, status, onProgress
    );
    const mime = outExt === '.webm' ? 'video/webm' : (outExt === '.gif' ? 'image/gif' : 'video/mp4');
    status('完了！');
    outputBlob = new Blob([data.buffer], { type: mime });
    return outputBlob;
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
  } finally {
    // Release the WORKERFS-mounted input. No MEMFS copy was ever made, so there's
    // nothing to deleteFile — just unmount + drop the mountpoint dir. The output
    // bytes are already read into a JS Blob above, so this is safe.
    if (inputDir) { await unmountInput(ff, inputDir); }
  }
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

// Post-trim/speed output duration of a clip's kept segments (seconds).
function segmentsOutputDuration(segments) {
  return segments.reduce((acc, s) => acc + (s.end - s.start) / (s.speed && s.speed !== 1 ? s.speed : 1), 0);
}

async function encodeClipToTs(ff, inputName, segments, hasAudio, canvas, outName, status, onProgress) {
  const { filter } = buildClipNormalizeFilter(segments, hasAudio, canvas);
  const args = ['-i', inputName];
  // Clips with no usable audio still get a silent stereo track — bounded to the
  // exact kept-segments length via `-t` — so EVERY intermediate has an identical
  // stream layout; otherwise concat-copy of mixed has-audio/no-audio segments breaks.
  if (!hasAudio) {
    const silenceDur = Math.max(0.05, segmentsOutputDuration(segments));
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

  const progressHandler = ({ progress }) => {
    if (typeof progress === 'number' && progress >= 0) onProgress(Math.max(0, Math.min(1, progress)), { determinate: true });
  };
  ff.on('progress', progressHandler);
  status('変換中（再エンコード）…');
  let code;
  try { code = await ff.exec(args); }
  finally { try { ff.off('progress', progressHandler); } catch (_) {} }
  if (code !== 0) throw new Error(`クリップのエンコードに失敗 (exit ${code})`);
}

// clips: [{ file, ranges, duration, hasAudio }]. Output: a combined X-ready .mp4 Blob.
export async function exportConcat(clips, options = {}) {
  const status = options.onStatus || (() => {});
  const onProgress = options.onProgress || (() => {});
  const canvas = canvasFor(options.aspect || 'original');

  cancelRequested = false;
  logBuffer = [];
  status('FFmpeg を準備中...');
  onProgress(0);

  let ff;
  try { ff = await getFFmpeg(); }
  catch (err) { throw new Error('FFmpeg の読み込みに失敗: ' + (err.message || err)); }

  // Plan each clip's kept/sped segments; drop clips that are fully cut away.
  const plans = clips
    .map((c) => ({ clip: c, segments: planSegments(c.ranges || [], c.duration) }))
    .filter((p) => p.segments.length > 0);
  if (plans.length === 0) throw new Error('すべてのクリップが空です（カットで全部消えています）。');
  if (plans.length < 2) throw new Error('結合するには2本以上の有効なクリップが必要です。');

  const tsFiles = [];
  const tempFiles = []; // every MEMFS path we create, so cleanup uses real names
  let mountedDir = null; // WORKERFS mount held this iteration (unmounted before the next)
  try {
    const N = plans.length;
    for (let i = 0; i < N; i++) {
      throwIfCancelled();
      const { clip, segments } = plans[i];
      const dir = `/cin${i}`;
      status(`クリップ ${i + 1}/${N} を準備中...`);
      // WORKERFS-mount this clip's source (no MEMFS copy of the whole file).
      const inputName = await mountInput(ff, dir, `cin${i}${getExt(clip.file.name)}`, clip.file);
      mountedDir = dir;
      throwIfCancelled();

      // Ground-truth audio presence per clip (don't trust an upstream flag): a clip
      // the user never opened in the editor would otherwise default to has-audio and
      // make the [0:a:0] filter fail on a genuinely silent source.
      const probe = await probeInput(ff, inputName);
      throwIfCancelled();
      const clipHasAudio = probe.audioCodec !== null;

      const tsName = `cseg${i}.ts`;
      tempFiles.push(tsName);
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
      mountedDir = null;
    }

    throwIfCancelled();
    status('クリップを結合中...');
    onProgress(N / (N + 1));
    const list = tsFiles.map((f) => `file '${f}'`).join('\n');
    tempFiles.push('clist.txt', 'combined.mp4');
    await ff.writeFile('clist.txt', new TextEncoder().encode(list));
    const code = await ff.exec([
      '-f', 'concat', '-safe', '0', '-i', 'clist.txt',
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart', '-y', 'combined.mp4',
    ]);
    if (code !== 0) throw new Error(`結合に失敗 (exit ${code})`);

    const data = await ff.readFile('combined.mp4');
    onProgress(1);
    for (const f of tempFiles) { try { await ff.deleteFile(f); } catch (_) {} }
    status('完了！つなげたハイライトをXにアップロードできます。');
    return new Blob([data.buffer], { type: 'video/mp4' });
  } catch (err) {
    // Best-effort cleanup by REAL tracked names (plans was filtered+reindexed, so
    // recomputing names from the original clips[] would miss/mis-target files).
    // Skip if the worker was already terminated by cancel.
    if (!cancelRequested) {
      if (mountedDir) await unmountInput(ff, mountedDir);
      for (const f of tempFiles) { try { await ff.deleteFile(f); } catch (_) {} }
    }
    const msg = (err && err.message) ? err.message : String(err);
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
