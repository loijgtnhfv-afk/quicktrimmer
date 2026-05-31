// Detect silent regions in an AudioBuffer.
// Returns Promise<Array<{ start, end }>> in seconds.
//
// Cooperative chunking: yields to the event loop periodically so the UI
// stays responsive on long videos. Reports progress 0..1 via onProgress.

const MIN_OUTPUT_DURATION = 0.1; // never emit a silence shorter than this after padding

export async function detectSilences(audioBuffer, opts = {}) {
  const threshold = opts.threshold ?? 0.018;
  const minDuration = opts.minDuration ?? 0.5;
  const padding = opts.padding ?? 0.1;
  const onProgress = opts.onProgress || (() => {});
  const cancelToken = opts.cancelToken; // optional { cancelled: boolean }
  if (!audioBuffer) return [];

  const sampleRate = audioBuffer.sampleRate;
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const minSamples = Math.floor(minDuration * sampleRate);
  const innerChunk = Math.max(256, Math.floor(sampleRate / 100)); // ~10ms

  const chans = [];
  for (let c = 0; c < channels; c++) chans.push(audioBuffer.getChannelData(c));

  const silences = [];
  let silStart = -1;

  // Yield every ~5 seconds of audio processed (or every ~512 inner chunks min).
  // This keeps the main thread responsive even on multi-hour files.
  const yieldEvery = Math.max(innerChunk * 512, sampleRate * 5);
  let nextYield = yieldEvery;

  onProgress(0);

  for (let i = 0; i < length; i += innerChunk) {
    if (i >= nextYield) {
      onProgress(i / length);
      // Cooperative yield: lets browser repaint, process input events, etc.
      await new Promise((r) => setTimeout(r, 0));
      if (cancelToken && cancelToken.cancelled) return [];
      nextYield = i + yieldEvery;
    }

    const end = Math.min(i + innerChunk, length);
    let peak = 0;
    for (let c = 0; c < channels; c++) {
      const data = chans[c];
      for (let j = i; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > peak) peak = v;
      }
    }
    const isSilent = peak < threshold;
    if (isSilent) {
      if (silStart < 0) silStart = i;
    } else if (silStart >= 0) {
      maybePush(silences, silStart, i, sampleRate, padding, minSamples);
      silStart = -1;
    }
  }
  if (silStart >= 0) {
    maybePush(silences, silStart, length, sampleRate, padding, minSamples);
  }

  onProgress(1);
  return silences;
}

// Accepts a raw silence span and pushes a padded {start, end} (seconds) iff
// the raw span meets minDuration AND the padded result still has
// >= MIN_OUTPUT_DURATION usable seconds. Padding is clamped per-segment so
// it never inverts or collapses the range.
function maybePush(out, startSample, endSample, sampleRate, padding, minSamples) {
  const rawLen = endSample - startSample;
  if (rawLen < minSamples) return;

  const rawDurSec = rawLen / sampleRate;
  const maxPadEachSide = Math.max(0, (rawDurSec - MIN_OUTPUT_DURATION) / 2);
  const effPadding = Math.min(padding, maxPadEachSide);

  const start = startSample / sampleRate + effPadding;
  const end = endSample / sampleRate - effPadding;
  if (end - start >= MIN_OUTPUT_DURATION) {
    out.push({ start, end });
  }
}
