// Persistent settings (silence thresholds, default export options, etc.)

const KEY = 'qt:settings';

export const DEFAULTS = Object.freeze({
  silenceThreshold: 0.018,
  silenceMinDuration: 0.5,
  silencePadding: 0.1,
  defaultFormat: 'mp4',
  defaultHeight: 'original',
  defaultAspect: 'original',
  normalizeAudio: false,
});

export function getSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    console.warn('settings load failed', err);
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const cur = getSettings();
  const next = { ...cur, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('settings save failed', err);
  }
  return next;
}

export function resetSettings() {
  try { localStorage.removeItem(KEY); } catch (_) {}
}
