import {
  initTimeline,
  removeRangeAt,
  clearRanges,
  getHasAudio,
  getRanges,
  getAudioBuffer,
  getDuration,
  undo,
  redo,
  canUndo,
  canRedo,
  addRanges,
  updateRangeType,
  showMarkInAt,
  hideMarkIn,
  resetZoom,
} from './timeline.js';
import { exportVideo, cancelExport } from './exporter.js';
import { detectSilences } from './silence.js';
import { transcribe, toSRT, toVTT } from './subtitles.js';
import { saveProject, loadProject, downloadProjectJson, parseProjectJson } from './storage.js';
import { getSettings, saveSettings, resetSettings, DEFAULTS } from './settings.js';
import { inject as injectAnalytics } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';

// Vercel Web Analytics + Speed Insights (RUM). Same-origin /_vercel/* scripts,
// so COEP require-corp is unaffected. No-op off Vercel; console debug in dev.
injectAnalytics();
injectSpeedInsights();

// --- Element refs ---
const fileInput = document.getElementById('fileInput');
const video = document.getElementById('player');
const exportBtn = document.getElementById('exportBtn');
const xExportBtn = document.getElementById('xExportBtn');
const xLimitBadge = document.getElementById('xLimitBadge');
const rangesList = document.getElementById('rangesList');
const statusEl = document.getElementById('status');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const cancelExportBtn = document.getElementById('cancelExportBtn');
const playerCard = document.getElementById('playerCard');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const previewBtn = document.getElementById('previewBtn');
const silenceBtn = document.getElementById('silenceBtn');
const resetZoomBtn = document.getElementById('resetZoomBtn');
const captureFrameBtn = document.getElementById('captureFrameBtn');
const formatSelect = document.getElementById('formatSelect');
const heightSelect = document.getElementById('heightSelect');
const aspectSelect = document.getElementById('aspectSelect');
const normalizeAudioChk = document.getElementById('normalizeAudioChk');
const saveJsonBtn = document.getElementById('saveJsonBtn');
const loadJsonInput = document.getElementById('loadJsonInput');
const helpBtn = document.getElementById('helpBtn');
const helpModal = document.getElementById('helpModal');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const installBtn = document.getElementById('installBtn');

// Subtitle (Whisper) panel refs
const subModelSelect = document.getElementById('subModelSelect');
const subLangSelect = document.getElementById('subLangSelect');
const genSubBtn = document.getElementById('genSubBtn');
const subProgressWrap = document.getElementById('subProgressWrap');
const subProgressFill = document.getElementById('subProgressFill');
const subProgressLabel = document.getElementById('subProgressLabel');
const subStatus = document.getElementById('subStatus');
const subResult = document.getElementById('subResult');
const subCount = document.getElementById('subCount');
const subList = document.getElementById('subList');
const dlSrtBtn = document.getElementById('dlSrtBtn');
const dlVttBtn = document.getElementById('dlVttBtn');

// Minimap refs
const minimapRanges = document.getElementById('minimapRanges');
const minimapPlayhead = document.getElementById('minimapPlayhead');

// Settings UI
const silenceThreshold = document.getElementById('silenceThreshold');
const silenceThresholdVal = document.getElementById('silenceThresholdVal');
const silenceMinDuration = document.getElementById('silenceMinDuration');
const silenceMinDurationVal = document.getElementById('silenceMinDurationVal');
const silencePadding = document.getElementById('silencePadding');
const silencePaddingVal = document.getElementById('silencePaddingVal');
const defaultFormat = document.getElementById('defaultFormat');
const defaultHeight = document.getElementById('defaultHeight');
const defaultNormalize = document.getElementById('defaultNormalize');
const resetSettingsBtn = document.getElementById('resetSettingsBtn');

// --- App state ---
let currentFile = null;
let cutRanges = [];
let previewMode = false;
let markInTime = null;
let settings = getSettings();
let exporting = false;
let deferredInstallPrompt = null;
let autosaveWarned = false;
let subSegments = [];
let generatingSubs = false;
const subDlFiles = new Map(); // file -> {loaded,total} for aggregate model-DL progress

// Accept any video/* MIME, but fall back to a known video extension: many real
// files (notably .mkv/.avi on Windows, especially when drag-dropped) report an
// empty or non-video MIME. The exporter re-encodes any non-mp4 container, so
// honoring the extension here keeps the load gate and export pipeline consistent.
const VIDEO_EXT_RE = /\.(mp4|m4v|mov|mkv|avi|webm|m4a|flv|wmv|mpg|mpeg|m2ts|mts|ts|3gp|ogv|ogg)$/i;

// X (Twitter) free-tier upload caps — used by the live limit badge (F3).
const X_MAX_SECONDS = 140;          // 2:20
const X_MAX_BYTES = 512 * 1024 * 1024;

// --- Initial settings application ---
function applySettingsToUI() {
  formatSelect.value = settings.defaultFormat;
  heightSelect.value = settings.defaultHeight;
  normalizeAudioChk.checked = settings.normalizeAudio;
  // Settings modal fields
  silenceThreshold.value = settings.silenceThreshold;
  silenceMinDuration.value = settings.silenceMinDuration;
  silencePadding.value = settings.silencePadding;
  silenceThresholdVal.textContent = Number(settings.silenceThreshold).toFixed(3);
  silenceMinDurationVal.textContent = Number(settings.silenceMinDuration).toFixed(1) + 's';
  silencePaddingVal.textContent = Number(settings.silencePadding).toFixed(2) + 's';
  defaultFormat.value = settings.defaultFormat;
  defaultHeight.value = settings.defaultHeight;
  defaultNormalize.checked = settings.normalizeAudio;
}
applySettingsToUI();

// --- Progress UI ---
function setProgress(value) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  progressFill.style.width = pct + '%';
  progressLabel.textContent = pct + '%';
}
function showProgress(show) {
  progressWrap.hidden = !show;
  if (show) setProgress(0);
}
function showCancelBtn(show) { cancelExportBtn.hidden = !show; }

// --- Load file ---
async function loadFile(file) {
  const looksLikeVideo = file && (file.type.startsWith('video/') || VIDEO_EXT_RE.test(file.name));
  if (!looksLikeVideo) {
    setStatus('動画ファイルを選んでください。');
    return;
  }
  autosaveWarned = false;
  currentFile = file;
  resetSubtitlePanel();
  video.src = URL.createObjectURL(file);
  playerCard.classList.remove('empty');
  setStatus('波形を解析しています...');

  // Snapshot any prior autosave BEFORE init so we can offer restore.
  // (Belt: we read it here. Suspenders: initTimeline's initial notify uses
  //  opts.initial so the callback below won't persist the empty state.)
  const saved = loadProject(file.name);

  try {
    await initTimeline(file, video, (ranges, opts = {}) => {
      cutRanges = ranges;
      exportBtn.disabled = ranges.length === 0;
      renderRangesList(ranges);
      updateUndoRedo();
      updateMinimap();
      updateXLimit();
      // Skip persistence during the initial reset — otherwise we'd clobber the
      // saved project for this filename before the restore prompt can fire.
      if (!opts.initial) {
        const ok = saveProject(file.name, { ranges, duration: video.duration });
        if (!ok && !autosaveWarned) {
          autosaveWarned = true;
          setStatus('⚠ 自動保存に失敗しました（ストレージ容量不足またはブラウザ設定）。書き出しは引き続き可能です。');
        }
      }
    });
    silenceBtn.disabled = !getHasAudio();
    genSubBtn.disabled = !getHasAudio();
    captureFrameBtn.disabled = false;
    // The X export is usable even with zero cuts (e.g. just making a HEVC/PS5
    // clip X-uploadable), so enable it as soon as a file loads.
    xExportBtn.disabled = false;
    updateXLimit();
    setStatus('');

    // Offer to restore previous session
    if (saved && saved.ranges && saved.ranges.length > 0) {
      const ago = Math.round((Date.now() - (saved.savedAt || 0)) / 1000 / 60);
      if (confirm(`前回のカット範囲（${saved.ranges.length}件、${ago}分前）を復元しますか？`)) {
        addRanges(saved.ranges);
      } else {
        // User declined — clear the stale autosave so we don't keep prompting.
        saveProject(file.name, { ranges: [], duration: video.duration });
      }
    }
  } catch (err) {
    console.error(err);
    if (err && (err.message === 'UNSUPPORTED_MEDIA' || err.message === 'LOAD_TIMEOUT')) {
      setStatus('このファイル形式はブラウザで再生できないため読み込めませんでした（.avi や一部の .mkv など）。MP4 / WebM / MOV に変換してからお試しください。');
    } else {
      setStatus('読み込みエラー: ' + (err.message || err));
    }
    // Reset so the player doesn't sit on a broken/blank source and the user can
    // pick another file.
    if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); video.load(); }
    currentFile = null;
    xExportBtn.disabled = true;
    genSubBtn.disabled = true;
    updateXLimit();
    playerCard.classList.add('empty');
  }
}

function setStatus(text) {
  statusEl.textContent = '';
  if (typeof text === 'string') statusEl.textContent = text;
}

// --- File input + drag-drop ---
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) await loadFile(file);
});

let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragCounter++;
  document.body.classList.add('drag-over');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) document.body.classList.remove('drag-over');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  document.body.classList.remove('drag-over');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) await loadFile(file);
});
function hasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  return Array.from(dt.types || []).includes('Files');
}

// --- Undo / Redo ---
undoBtn.addEventListener('click', () => { undo(); updateUndoRedo(); });
redoBtn.addEventListener('click', () => { redo(); updateUndoRedo(); });
function updateUndoRedo() {
  undoBtn.disabled = !canUndo();
  redoBtn.disabled = !canRedo();
}

// --- Preview mode ---
previewBtn.addEventListener('click', togglePreview);
function togglePreview() {
  previewMode = !previewMode;
  previewBtn.classList.toggle('active', previewMode);
  if (previewMode) {
    skipIfInCut();
    video.play().catch(() => {});
  }
}
function skipIfInCut() {
  const t = video.currentTime;
  for (const r of getRanges()) {
    if (r.type === 'cut' && t >= r.start && t < r.end) {
      video.currentTime = r.end + 0.01;
      return;
    }
  }
}
video.addEventListener('timeupdate', () => {
  if (previewMode) skipIfInCut();
  updateMinimapPlayhead();
});

// --- Reset zoom ---
resetZoomBtn.addEventListener('click', () => resetZoom());

// --- Silence detect (uses settings) ---
silenceBtn.addEventListener('click', async () => {
  const buf = getAudioBuffer();
  if (!buf) {
    setStatus('音声トラックがないので無音検出できません。');
    return;
  }
  silenceBtn.disabled = true;
  showProgress(true);
  setStatus('無音区間を検出中（長い動画は時間がかかります）...');
  try {
    const silences = await detectSilences(buf, {
      threshold: Number(settings.silenceThreshold),
      minDuration: Number(settings.silenceMinDuration),
      padding: Number(settings.silencePadding),
      onProgress: (p) => setProgress(p),
    });
    if (silences.length === 0) {
      setStatus('無音区間は見つかりませんでした（設定でしきい値を緩めると検出される可能性あり）');
    } else {
      addRanges(silences.map((s) => ({ start: s.start, end: s.end, type: 'cut' })));
      setStatus(`${silences.length}個の無音区間を削除候補に追加しました`);
    }
  } catch (err) {
    console.error('[silence detect] error:', err);
    setStatus('無音検出エラー: ' + (err.message || err));
  } finally {
    silenceBtn.disabled = false;
    setTimeout(() => showProgress(false), 800);
  }
});

// --- AI subtitle generation (Whisper, local) ---
function setSubProgress(p, label) {
  subProgressWrap.hidden = false;
  const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
  subProgressFill.style.width = pct + '%';
  subProgressLabel.textContent = pct + '%';
  if (label !== undefined) subStatus.textContent = label;
}

function resetSubtitlePanel() {
  subSegments = [];
  subResult.hidden = true;
  subProgressWrap.hidden = true;
  subStatus.textContent = '';
  subList.innerHTML = '';
  subDlFiles.clear();
}

function renderSubtitles(segs) {
  subCount.textContent = `${segs.length}件`;
  subList.innerHTML = '';
  segs.forEach((s) => {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 'sub-time';
    t.textContent = formatTime(s.start);
    t.title = 'クリックで動画をこの位置へ';
    t.onclick = () => { video.currentTime = s.start; };
    const txt = document.createElement('span');
    txt.className = 'sub-text';
    txt.textContent = s.text;
    li.appendChild(t);
    li.appendChild(txt);
    subList.appendChild(li);
  });
}

genSubBtn.addEventListener('click', async () => {
  if (generatingSubs) return;
  const buf = getAudioBuffer();
  if (!buf) {
    subStatus.textContent = '音声トラックがないので字幕を生成できません。';
    return;
  }
  generatingSubs = true;
  genSubBtn.disabled = true;
  subResult.hidden = true;
  subDlFiles.clear();
  setSubProgress(0, 'モデルを準備中…（初回はモデルのダウンロードに時間がかかります）');
  try {
    const lang = subLangSelect.value === 'auto' ? null : subLangSelect.value;
    const segs = await transcribe(buf, {
      model: subModelSelect.value,
      language: lang,
      onModel: (p) => {
        if (p.status === 'progress' && p.file && typeof p.total === 'number') {
          subDlFiles.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
          let loaded = 0, total = 0;
          for (const f of subDlFiles.values()) { loaded += f.loaded; total += f.total; }
          if (total > 0) {
            setSubProgress(loaded / total,
              `モデルをダウンロード中… ${(loaded / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB（初回のみ・以後はキャッシュ）`);
          }
        } else if (p.status === 'ready') {
          // transformers.js ASR gives no inference progress, so switch to an
          // indeterminate state instead of a stuck percentage.
          subProgressWrap.hidden = true;
          subStatus.textContent = '文字起こし中…（動画の長さに応じて時間がかかります）';
        }
      },
    });
    subSegments = segs;
    subProgressWrap.hidden = true;
    if (segs.length === 0) {
      subStatus.textContent = '字幕を検出できませんでした（無音、またはBGM/効果音のみの可能性）。';
    } else {
      renderSubtitles(segs);
      subResult.hidden = false;
      subStatus.textContent = `${segs.length}個の字幕セグメントを生成しました。SRT / VTT で書き出せます。`;
    }
  } catch (err) {
    console.error('[subtitles] error:', err);
    subProgressWrap.hidden = true;
    subStatus.textContent = '字幕生成に失敗: ' + (err && err.message ? err.message : String(err));
  } finally {
    generatingSubs = false;
    genSubBtn.disabled = !getHasAudio();
  }
});

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

dlSrtBtn.addEventListener('click', () => {
  if (!subSegments.length) return;
  const base = (currentFile && currentFile.name ? currentFile.name : 'video').replace(/\.[^.]+$/, '');
  downloadText(`${base}.srt`, toSRT(subSegments), 'application/x-subrip;charset=utf-8');
});
dlVttBtn.addEventListener('click', () => {
  if (!subSegments.length) return;
  const base = (currentFile && currentFile.name ? currentFile.name : 'video').replace(/\.[^.]+$/, '');
  downloadText(`${base}.vtt`, toVTT(subSegments), 'text/vtt;charset=utf-8');
});

// --- Frame capture ---
captureFrameBtn.addEventListener('click', () => {
  if (!currentFile || !video.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);
  canvas.toBlob((blob) => {
    if (!blob) {
      setStatus('フレームのキャプチャに失敗しました');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const base = (currentFile.name || 'video').replace(/\.[^.]+$/, '');
    const tStr = video.currentTime.toFixed(2).replace('.', '_');
    a.download = `${base}_frame_${tStr}s.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus(`フレームを保存しました（${video.currentTime.toFixed(2)}秒地点）`);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, 'image/png');
});

// --- Project save/load ---
saveJsonBtn.addEventListener('click', () => {
  if (!currentFile) {
    setStatus('動画が読み込まれていません');
    return;
  }
  downloadProjectJson(currentFile.name, { ranges: getRanges(), duration: getDuration() });
});
loadJsonInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const data = await parseProjectJson(file);
    if (!Array.isArray(data.ranges)) {
      setStatus('無効なプロジェクトファイルです');
      return;
    }
    // Sanitize ranges (strict schema)
    const safe = data.ranges.filter((r) => (
      typeof r.start === 'number' && typeof r.end === 'number' &&
      r.end > r.start &&
      (r.type === 'cut' || r.type === 'speedup' || r.type === undefined)
    )).map((r) => ({
      start: r.start,
      end: r.end,
      type: r.type === 'speedup' ? 'speedup' : 'cut',
      speed: r.type === 'speedup' ? ([2, 4, 8].includes(r.speed) ? r.speed : 2) : undefined,
    }));
    addRanges(safe);
    setStatus(`${safe.length}件のカット範囲を復元しました`);
  } catch (err) {
    setStatus('プロジェクト読み込みエラー: ' + err.message);
  }
  e.target.value = '';
});

// --- Export ---
exportBtn.addEventListener('click', () => doExport({ xOptimize: false }));
xExportBtn.addEventListener('click', () => doExport({ xOptimize: true }));

async function doExport({ xOptimize }) {
  if (!currentFile || exporting) return;
  // Generic export needs at least one cut; the X export is also useful with zero
  // cuts (just re-containerizing a HEVC/PS5 clip into an X-uploadable MP4).
  if (!xOptimize && cutRanges.length === 0) return;

  exporting = true;
  exportBtn.disabled = true;
  xExportBtn.disabled = true;
  const activeBtn = xOptimize ? xExportBtn : exportBtn;
  const originalHTML = activeBtn.innerHTML;
  activeBtn.textContent = '処理中...';
  showProgress(true);
  showCancelBtn(true);
  try {
    const url = await exportVideo(currentFile, cutRanges, video.duration, {
      onStatus: (msg) => { setStatus(msg); },
      onProgress: (p) => setProgress(p),
      hasAudio: getHasAudio(),
      xOptimize,
      format: formatSelect.value,
      height: heightSelect.value,
      aspect: aspectSelect.value,
      normalizeAudio: normalizeAudioChk.checked,
    });
    setProgress(1);
    const a = document.createElement('a');
    a.href = url;
    const base = (currentFile.name || 'video').replace(/\.[^.]+$/, '');
    const ext = xOptimize
      ? '.mp4'
      : (formatSelect.value === 'webm' ? '.webm' : (formatSelect.value === 'gif' ? '.gif' : '.mp4'));
    a.download = xOptimize ? `${base}_for_X${ext}` : `${base}_trimmed${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus(xOptimize
      ? '完了。Xにそのままアップロードできます（ダウンロードフォルダを確認）。'
      : '完了。ダウンロードフォルダを確認してください。');
    setTimeout(() => { showProgress(false); showCancelBtn(false); }, 1500);
  } catch (err) {
    console.error('[export] error:', err);
    showProgress(false);
    showCancelBtn(false);
    setStatus('');
    if (err && err.message && err.message.includes('__CANCELLED__')) {
      setStatus('書き出しをキャンセルしました');
    } else {
      const pre = document.createElement('pre');
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.fontFamily = 'monospace';
      pre.style.fontSize = '12px';
      pre.style.color = '#A24D2E';
      pre.style.marginTop = '6px';
      pre.textContent = '書き出しに失敗:\n' + (err.message || String(err));
      statusEl.appendChild(pre);
    }
  } finally {
    exporting = false;
    exportBtn.disabled = cutRanges.length === 0;
    xExportBtn.disabled = !currentFile;
    activeBtn.innerHTML = originalHTML;
  }
}

cancelExportBtn.addEventListener('click', () => {
  if (!exporting) return;
  cancelExport();
  setStatus('キャンセル中...');
});

// --- Ranges list ---
function renderRangesList(ranges) {
  rangesList.innerHTML = '';
  if (ranges.length === 0) return;
  ranges.forEach((r, i) => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'range-info';
    const isSpeed = r.type === 'speedup';
    const action = isSpeed ? `${r.speed}x 倍速` : '削除';

    const time = document.createElement('span');
    time.textContent = `${formatTime(r.start)} 〜 ${formatTime(r.end)}  ${action} `;
    const pill = document.createElement('span');
    pill.className = 'duration-pill' + (isSpeed ? ' speedup' : '');
    pill.textContent = `${(r.end - r.start).toFixed(1)}秒`;
    info.appendChild(time);
    info.appendChild(pill);

    const actions = document.createElement('div');
    actions.className = 'range-actions';

    const typeSel = document.createElement('select');
    typeSel.innerHTML = `
      <option value="cut" ${r.type === 'cut' ? 'selected' : ''}>削除</option>
      <option value="speedup-2" ${isSpeed && r.speed === 2 ? 'selected' : ''}>2x 倍速</option>
      <option value="speedup-4" ${isSpeed && r.speed === 4 ? 'selected' : ''}>4x 倍速</option>
      <option value="speedup-8" ${isSpeed && r.speed === 8 ? 'selected' : ''}>8x 倍速</option>
    `;
    typeSel.onchange = () => {
      if (typeSel.value === 'cut') updateRangeType(i, 'cut');
      else updateRangeType(i, 'speedup', parseInt(typeSel.value.replace('speedup-', ''), 10));
    };
    actions.appendChild(typeSel);

    const btn = document.createElement('button');
    btn.textContent = '取り消し';
    btn.onclick = () => removeRangeAt(i);
    actions.appendChild(btn);

    li.appendChild(info);
    li.appendChild(actions);
    rangesList.appendChild(li);
  });

  if (ranges.length >= 2) {
    const clearLi = document.createElement('li');
    clearLi.style.background = 'transparent';
    clearLi.style.border = 'none';
    clearLi.style.justifyContent = 'flex-end';
    clearLi.style.padding = '0';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'すべて取り消し';
    clearBtn.onclick = () => clearRanges();
    clearLi.appendChild(clearBtn);
    rangesList.appendChild(clearLi);
  }
}

function formatTime(t) {
  if (!isFinite(t)) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

// --- Minimap ---
function updateMinimap() {
  if (!minimapRanges) return;
  const dur = video.duration || 1;
  minimapRanges.innerHTML = '';
  for (const r of getRanges()) {
    const el = document.createElement('div');
    el.className = 'minimap-range' + (r.type === 'speedup' ? ' speedup' : '');
    el.style.left = ((r.start / dur) * 100) + '%';
    el.style.width = (((r.end - r.start) / dur) * 100) + '%';
    minimapRanges.appendChild(el);
  }
  updateMinimapPlayhead();
}
function updateMinimapPlayhead() {
  if (!minimapPlayhead) return;
  const dur = video.duration || 1;
  if (!isFinite(dur) || dur === 0) return;
  minimapPlayhead.style.left = ((video.currentTime / dur) * 100) + '%';
}

// --- X upload-limit badge (F3) ---
// Output length = full duration minus cut spans minus the time speed-ups save.
// Size is a rough estimate (kept fraction of the source bytes) and labelled 約.
function updateXLimit() {
  if (!xLimitBadge) return;
  const dur = video.duration;
  if (!currentFile || !isFinite(dur) || dur <= 0) { xLimitBadge.hidden = true; return; }
  let cut = 0, saved = 0;
  for (const r of cutRanges) {
    const span = Math.max(0, r.end - r.start);
    if (r.type === 'speedup') saved += span - span / (r.speed || 2);
    else cut += span;
  }
  const outDur = Math.max(0, dur - cut - saved);
  const estBytes = currentFile.size * (outDur / dur);
  const overDur = outDur > X_MAX_SECONDS;
  const overSize = estBytes > X_MAX_BYTES;
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
  const mb = (b) => (b / 1024 / 1024).toFixed(0);
  let tail;
  if (overDur && overSize) tail = '⚠ 長さ・サイズ超過';
  else if (overDur) tail = '⚠ 2:20 超過（もっとカットを）';
  else if (overSize) tail = '⚠ 512MB 超過';
  else tail = '✓ そのままXに投稿OK';
  xLimitBadge.hidden = false;
  xLimitBadge.classList.toggle('over', overDur || overSize);
  xLimitBadge.textContent = `X(無料)目安 — 長さ ${mmss(outDur)} / 2:20 ・ サイズ 約${mb(estBytes)}MB / 512MB　${tail}`;
}

// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  const tgt = e.target;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable)) return;
  if (!currentFile) return;

  const ctrl = e.ctrlKey || e.metaKey;

  if (e.code === 'Space') {
    e.preventDefault();
    if (video.paused) video.play(); else video.pause();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    const step = e.shiftKey ? 5 : (ctrl ? 0.1 : 1);
    video.currentTime = Math.max(0, video.currentTime - step);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    const step = e.shiftKey ? 5 : (ctrl ? 0.1 : 1);
    video.currentTime = Math.min(video.duration, video.currentTime + step);
  } else if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo(); updateUndoRedo();
  } else if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault();
    redo(); updateUndoRedo();
  } else if (e.key.toLowerCase() === 'i' && !ctrl) {
    e.preventDefault();
    markInTime = video.currentTime;
    showMarkInAt(markInTime);
    setStatus(`開始マーク: ${formatTime(markInTime)} (Oキーで範囲を確定)`);
  } else if (e.key.toLowerCase() === 'o' && !ctrl) {
    e.preventDefault();
    if (markInTime === null) { setStatus('先に I キーで開始位置をマークしてください'); return; }
    const start = Math.min(markInTime, video.currentTime);
    const end = Math.max(markInTime, video.currentTime);
    if (end - start < 0.05) { setStatus('範囲が短すぎます'); markInTime = null; hideMarkIn(); return; }
    addRanges([{ start, end, type: 'cut' }]);
    setStatus(`カット範囲を追加: ${formatTime(start)} 〜 ${formatTime(end)}`);
    markInTime = null;
    hideMarkIn();
  } else if (e.key === 'Escape') {
    if (markInTime !== null) {
      markInTime = null; hideMarkIn();
      setStatus('マークをクリアしました');
    }
    if (!helpModal.hidden) helpModal.hidden = true;
    if (!settingsModal.hidden) settingsModal.hidden = true;
  } else if (e.key.toLowerCase() === 'p' && !ctrl) {
    e.preventDefault();
    togglePreview();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (tgt && tgt.tagName === 'BUTTON') return;
    e.preventDefault();
    const t = video.currentTime;
    const rs = getRanges();
    for (let i = 0; i < rs.length; i++) {
      if (t >= rs[i].start && t <= rs[i].end) {
        removeRangeAt(i);
        setStatus('再生位置の範囲を削除しました');
        return;
      }
    }
    setStatus('再生位置に範囲がありません');
  }
});

// --- Modals ---
helpBtn.addEventListener('click', () => { helpModal.hidden = false; });
helpModal.addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) helpModal.hidden = true; });
settingsBtn.addEventListener('click', () => { applySettingsToUI(); settingsModal.hidden = false; });
settingsModal.addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) settingsModal.hidden = true; });

// --- Settings live updates ---
silenceThreshold.addEventListener('input', () => {
  const v = Number(silenceThreshold.value);
  silenceThresholdVal.textContent = v.toFixed(3);
  settings = saveSettings({ silenceThreshold: v });
});
silenceMinDuration.addEventListener('input', () => {
  const v = Number(silenceMinDuration.value);
  silenceMinDurationVal.textContent = v.toFixed(1) + 's';
  settings = saveSettings({ silenceMinDuration: v });
});
silencePadding.addEventListener('input', () => {
  const v = Number(silencePadding.value);
  silencePaddingVal.textContent = v.toFixed(2) + 's';
  settings = saveSettings({ silencePadding: v });
});
defaultFormat.addEventListener('change', () => {
  settings = saveSettings({ defaultFormat: defaultFormat.value });
  formatSelect.value = defaultFormat.value;
});
defaultHeight.addEventListener('change', () => {
  settings = saveSettings({ defaultHeight: defaultHeight.value });
  heightSelect.value = defaultHeight.value;
});
defaultNormalize.addEventListener('change', () => {
  settings = saveSettings({ normalizeAudio: defaultNormalize.checked });
  normalizeAudioChk.checked = defaultNormalize.checked;
});
normalizeAudioChk.addEventListener('change', () => {
  settings = saveSettings({ normalizeAudio: normalizeAudioChk.checked });
});
formatSelect.addEventListener('change', () => {
  settings = saveSettings({ defaultFormat: formatSelect.value });
});
heightSelect.addEventListener('change', () => {
  settings = saveSettings({ defaultHeight: heightSelect.value });
});
resetSettingsBtn.addEventListener('click', () => {
  if (confirm('設定をデフォルトに戻しますか？')) {
    resetSettings();
    settings = getSettings();
    applySettingsToUI();
    setStatus('設定をリセットしました');
  }
});

// --- PWA install ---
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.hidden = true;
  if (choice.outcome === 'accepted') setStatus('インストールしました');
});

// --- Service worker registration (production only) ---
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('SW register failed', err);
    });
  });
}

// --- Initial UI state ---
updateUndoRedo();
