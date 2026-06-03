// Browser-local AI subtitle generation via Whisper (Transformers.js).
//
// No upload — the model and inference run entirely in the browser, consistent
// with QuickTrimmer's local-only brand. The ~75–290MB model is lazy-loaded
// (dynamic import + fetch only on first "generate subtitles" click) so the
// initial app payload is unaffected.
//
// COEP note: the app ships Cross-Origin-Embedder-Policy: require-corp (needed by
// ffmpeg.wasm). Cross-origin CDN wasm is blocked under that policy, so we serve
// the ONNX Runtime wasm from our own origin (/ort/, copied from onnxruntime-web).
// Model weights load from HuggingFace via a CORS fetch, which COEP permits.

let envConfigured = false;
let transcriberPromise = null;
let loadedModelId = null;

// Multilingual Whisper checkpoints (JP-capable). Bigger = more accurate, slower,
// larger download. `base` is the default per the v0.2 plan.
const MODELS = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
  small: 'Xenova/whisper-small',
};

async function getTransformers() {
  const t = await import('@huggingface/transformers');
  if (!envConfigured) {
    const { env } = t;
    // Serve ORT wasm from same-origin (COEP:require-corp blocks cross-origin CDN
    // wasm). Files live in public/ort/ — see copy step in the build/repo.
    env.backends.onnx.wasm.wasmPaths = '/ort/';
    // We have crossOriginIsolated (COOP/COEP), so threaded wasm + SharedArrayBuffer
    // are available — let ORT use multiple threads for faster inference.
    env.backends.onnx.wasm.numThreads =
      Math.min(8, (navigator.hardwareConcurrency || 4));
    // Weights come from HuggingFace, never a bundled local copy.
    env.allowLocalModels = false;
    envConfigured = true;
  }
  return t;
}

// Prefer WebGPU when an adapter is actually obtainable (much faster), else use
// threaded wasm. We probe navigator.gpu.requestAdapter() rather than just
// checking `'gpu' in navigator`: the property can be present while the adapter
// is unavailable (disabled/blocklisted/headless GPU), and a *failed* webgpu
// pipeline poisons the cached model so a later wasm retry also fails — so we
// must decide correctly up front.
//
// dtype is fp32 on both: the q8/q4 quantized Whisper decoders trip an ONNX
// Runtime bug ("MatMulNBits Missing required scale") and fail to create a
// session, so we trade a larger one-time download for reliability.
async function pickBackend() {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return { device: 'webgpu', dtype: 'fp32' };
    } catch (_) { /* fall through to wasm */ }
  }
  return { device: 'wasm', dtype: 'fp32' };
}

// Load (and cache) the ASR pipeline for the chosen model. `onProgress` receives
// Transformers.js progress events: { status, file, progress, loaded, total }.
// `backend` optionally overrides the auto-picked { device, dtype }.
export async function loadTranscriber(modelKey, onProgress, backend) {
  const modelId = MODELS[modelKey] || MODELS.base;
  if (transcriberPromise && loadedModelId === modelId) return transcriberPromise;
  // Switching models: drop the old pipeline so we reload the right weights.
  // Build the new pipeline's promise first, then publish loadedModelId and
  // transcriberPromise together — assigning the id before the promise lets two
  // concurrent loads of different models desync (id points at one model while
  // the cached promise resolves to another).
  const prevPromise = transcriberPromise;
  const promise = (async () => {
    const { pipeline } = await getTransformers();
    const primary = backend || await pickBackend();
    const build = (b) => pipeline('automatic-speech-recognition', modelId, {
      progress_callback: onProgress,
      device: b.device,
      dtype: b.dtype,
    });

    let pipe;
    try {
      pipe = await build(primary);
    } catch (err) {
      // WebGPU can be advertised (navigator.gpu present) yet fail to obtain an
      // adapter — disabled, blocklisted, or headless GPU. Fall back to the
      // always-available threaded-wasm path so subtitles still work.
      if (primary.device !== 'wasm') {
        console.warn('[subtitles] backend', primary.device, 'failed, falling back to wasm:', err);
        pipe = await build({ device: 'wasm', dtype: 'fp32' });
      } else {
        throw err;
      }
    }

    // Release the previously cached pipeline's WASM/WebGPU session so switching
    // models doesn't leak a multi-hundred-MB runtime each time.
    if (prevPromise) {
      try {
        const old = await prevPromise;
        if (old && old !== pipe) await old.dispose?.();
      } catch (_) { /* prior load already failed/disposed */ }
    }
    return pipe;
  })();

  loadedModelId = modelId;
  transcriberPromise = promise;
  // Reset cache on failure (only if we're still the current load) so a retry
  // rebuilds instead of returning the rejected promise forever.
  promise.catch(() => {
    if (transcriberPromise === promise) {
      transcriberPromise = null;
      loadedModelId = null;
    }
  });
  return promise;
}

// Resample an arbitrary-rate AudioBuffer (often 44.1/48k, stereo) to the 16kHz
// mono Float32Array Whisper expects. OfflineAudioContext downmixes to mono via
// its single-channel destination.
export async function audioBufferTo16kMono(audioBuffer) {
  const targetRate = 16000;
  const frames = Math.max(1, Math.ceil(audioBuffer.duration * targetRate));
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new OfflineCtx(1, frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

// Run Whisper over the whole clip. Returns [{ start, end, text }] sorted by time.
// `language` is a Whisper language name ('japanese', 'english', ...) or null to
// auto-detect. `onModel` reports download/load progress; `onChunk` fires roughly
// per 30s window so the UI can show inference progress.
export async function transcribe(audioBuffer, opts = {}) {
  const {
    model = 'base',
    language = 'japanese',
    onModel = () => {},
    backend, // optional { device, dtype } override (defaults to auto)
  } = opts;

  const transcriber = await loadTranscriber(model, onModel, backend);
  const audio = await audioBufferTo16kMono(audioBuffer);
  const totalSec = audioBuffer.duration;

  // Note: transformers.js 4.x ASR exposes no per-chunk progress hook (the
  // `chunk_callback` option is silently ignored), so inference runs as a single
  // opaque step — the UI shows an indeterminate "transcribing" state.
  const result = await transcriber(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    language: language || null,
    task: 'transcribe',
  });

  const raw = Array.isArray(result?.chunks) ? result.chunks : [];
  const segments = raw
    .map((c, i) => {
      const t = c.timestamp || [];
      let start = typeof t[0] === 'number' ? t[0] : 0;
      let end = typeof t[1] === 'number' ? t[1] : null;
      // Whisper sometimes emits a null end on the final chunk — clamp to clip end.
      if (end == null) end = totalSec || start;
      return { start, end, text: (c.text || '').trim() };
    })
    .filter((s) => s.text.length > 0);

  // Defensive: monotonic, non-overlapping, no zero/negative spans. Starts from
  // a prevEnd of 0 so segment 0 is repaired too (a null/zero first timestamp
  // would otherwise serialize an invalid zero-duration cue).
  segments.sort((a, b) => a.start - b.start);
  let prevEnd = 0;
  for (const s of segments) {
    if (s.start < prevEnd) s.start = prevEnd;
    if (s.end <= s.start) s.end = s.start + 0.1;
    prevEnd = s.end;
  }
  return segments;
}

// ---------- Subtitle serialization ----------
function pad(n, len = 2) { return String(n).padStart(len, '0'); }

function fmtTimestamp(t, srt) {
  // Round to whole milliseconds FIRST, then split — rounding the fractional part
  // separately can yield a 1000ms field (e.g. 1.9995 → 00:00:01,1000), which no
  // SRT/VTT parser accepts.
  const totalMs = (isFinite(t) && t > 0) ? Math.round(t * 1000) : 0;
  const ms = totalMs % 1000;
  let s = Math.floor(totalMs / 1000);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const sep = srt ? ',' : '.';
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

export function toSRT(segments) {
  return segments
    .map((s, i) => `${i + 1}\n${fmtTimestamp(s.start, true)} --> ${fmtTimestamp(s.end, true)}\n${s.text}`)
    .join('\n\n') + '\n';
}

export function toVTT(segments) {
  return 'WEBVTT\n\n' + segments
    .map((s) => `${fmtTimestamp(s.start, false)} --> ${fmtTimestamp(s.end, false)}\n${s.text}`)
    .join('\n\n') + '\n';
}
