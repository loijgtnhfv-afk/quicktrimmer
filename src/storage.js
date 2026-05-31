// LocalStorage-based project autosave + JSON import/export.

const PREFIX = 'qt:project:';

function key(filename) {
  return PREFIX + filename;
}

// Returns true on success, false if the write failed (quota exceeded, storage
// disabled in private mode, etc.) so callers can surface the failure instead of
// silently losing autosave data.
export function saveProject(filename, data) {
  if (!filename) return false;
  try {
    const payload = {
      filename,
      savedAt: Date.now(),
      version: 1,
      ...data,
    };
    localStorage.setItem(key(filename), JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn('saveProject failed:', err);
    return false;
  }
}

export function loadProject(filename) {
  if (!filename) return null;
  try {
    const raw = localStorage.getItem(key(filename));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn('loadProject failed:', err);
    return null;
  }
}

export function deleteProject(filename) {
  try { localStorage.removeItem(key(filename)); } catch (_) {}
}

export function listProjects() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) {
      try {
        const v = JSON.parse(localStorage.getItem(k));
        out.push(v);
      } catch (_) {}
    }
  }
  return out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

// JSON export/import helpers
export function downloadProjectJson(filename, data) {
  const payload = {
    filename,
    savedAt: Date.now(),
    version: 1,
    ...data,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename.replace(/\.[^.]+$/, '')}_quicktrimmer.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function parseProjectJson(file) {
  const text = await file.text();
  return JSON.parse(text);
}
