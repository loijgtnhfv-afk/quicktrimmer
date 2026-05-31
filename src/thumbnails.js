// Generate thumbnail strip from a video element by seeking + capturing frames.

export async function generateThumbnails(videoEl, count, height) {
  if (!videoEl || !videoEl.duration) return [];
  const duration = videoEl.duration;
  // Determine output width from the video's intrinsic aspect ratio
  const aspect = videoEl.videoWidth && videoEl.videoHeight
    ? videoEl.videoWidth / videoEl.videoHeight
    : 16 / 9;
  const w = Math.round(height * aspect);

  // Use an offscreen video element so we don't disturb the user's playback position
  const probe = document.createElement('video');
  probe.src = videoEl.src;
  probe.muted = true;
  probe.crossOrigin = 'anonymous';
  probe.preload = 'auto';
  await new Promise((res, rej) => {
    probe.addEventListener('loadeddata', res, { once: true });
    probe.addEventListener('error', rej, { once: true });
  });

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const thumbs = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count * duration;
    await seekTo(probe, t);
    try {
      ctx.drawImage(probe, 0, 0, w, height);
      thumbs.push(canvas.toDataURL('image/jpeg', 0.55));
    } catch (err) {
      console.warn('thumbnail capture failed at', t, err);
      thumbs.push(null);
    }
  }
  probe.src = '';
  return thumbs;
}

function seekTo(video, time) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    try { video.currentTime = time; } catch (_) { resolve(); }
  });
}
