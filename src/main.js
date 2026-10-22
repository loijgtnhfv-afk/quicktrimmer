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
  setDragTool,
  keyOf,
  getSelectedKey,
  selectRangeAt,
  focusRange,
  setHotIndexExternal,
  onHot,
  onSelect,
} from './timeline.js';
import { exportVideo, exportConcat, cancelExport, preloadFFmpeg, rescueToPlayable } from './exporter.js';
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
const progressStatus = document.getElementById('progressStatus');
const cancelExportBtn = document.getElementById('cancelExportBtn');
const exportError = document.getElementById('exportError');
const exportNotice = document.getElementById('exportNotice');
const exportTopStrip = document.getElementById('exportTopStrip');
const rescueBanner = document.getElementById('rescueBanner');
const rescueBtn = document.getElementById('rescueBtn');
const rescueDismiss = document.getElementById('rescueDismiss');
const rescueDesc = document.getElementById('rescueDesc');
const rescueProgress = document.getElementById('rescueProgress');
const timelineContainer = document.getElementById('timelineContainer');
const exportDonePanel = document.getElementById('exportDonePanel');
const exportDoneMeta = document.getElementById('exportDoneMeta');
const exportDoneHint = document.getElementById('exportDoneHint');
const exportRedownloadBtn = document.getElementById('exportRedownloadBtn');
const exportShareBtn = document.getElementById('exportShareBtn');
const exportDoneClose = document.getElementById('exportDoneClose');
const playerCard = document.getElementById('playerCard');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const previewBtn = document.getElementById('previewBtn');
const silenceBtn = document.getElementById('silenceBtn');
const resetZoomBtn = document.getElementById('resetZoomBtn');
const captureFrameBtn = document.getElementById('captureFrameBtn');
const modeCutBtn = document.getElementById('modeCutBtn');
const modeSpeedBtn = document.getElementById('modeSpeedBtn');
const dragSpeedSelect = document.getElementById('dragSpeedSelect');
const legendDrag = document.getElementById('legendDrag');
const formatSelect = document.getElementById('formatSelect');
const heightSelect = document.getElementById('heightSelect');
const aspectSelect = document.getElementById('aspectSelect');
const normalizeAudioChk = document.getElementById('normalizeAudioChk');
const notifyOnDoneChk = document.getElementById('notifyOnDoneChk');
const saveJsonBtn = document.getElementById('saveJsonBtn');
const loadJsonInput = document.getElementById('loadJsonInput');
const helpBtn = document.getElementById('helpBtn');
const helpModal = document.getElementById('helpModal');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const legalBtn = document.getElementById('legalBtn');
const legalModal = document.getElementById('legalModal');
const installBtn = document.getElementById('installBtn');

// Editor cards hidden until a clip is loaded (keeps the first-load screen to the
// 3-step empty-state hero instead of an empty waveform + toolbar + options wall).
const timelineCard = document.getElementById('timelineCard');
const infoCard = document.getElementById('infoCard');

// Multi-clip ("highlights") refs
const clipTrayCard = document.getElementById('clipTrayCard');
const clipTrayList = document.getElementById('clipTrayList');
const addClipBtn = document.getElementById('addClipBtn');
const clearClipsBtn = document.getElementById('clearClipsBtn');
const combineBtn = document.getElementById('combineBtn');
const exportEachBtn = document.getElementById('exportEachBtn');
const combineHint = document.getElementById('combineHint');
const combineBadge = document.getElementById('combineBadge');

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

// On-screen player control bar refs
const videoMinimap = document.getElementById('videoMinimap');
const pcPlay = document.getElementById('pcPlay');
const pcBack5 = document.getElementById('pcBack5');
const pcBack1 = document.getElementById('pcBack1');
const pcFwd1 = document.getElementById('pcFwd1');
const pcFwd5 = document.getElementById('pcFwd5');
const pcMarkIn = document.getElementById('pcMarkIn');
const pcMarkOut = document.getElementById('pcMarkOut');
const pcPrevSeg = document.getElementById('pcPrevSeg');
const pcSegHead = document.getElementById('pcSegHead');
const pcFrameBack = document.getElementById('pcFrameBack');
const pcFrameFwd = document.getElementById('pcFrameFwd');
const pcCur = document.getElementById('pcCur');
const pcDur = document.getElementById('pcDur');

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
// clips[] holds every loaded clip; the ACTIVE clip is the one mirrored into
// currentFile / cutRanges and shown in the timeline. Single-clip use = a clips
// array of length 1, so the existing single-clip pipeline is untouched.
let clips = [];          // [{ id, file, name, duration, ranges, hasAudio, url }]
let activeClipId = null;
let clipSeq = 0;
let currentFile = null;  // mirror of the active clip's file
let cutRanges = [];      // mirror of the active clip's ranges
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
  aspectSelect.value = settings.defaultAspect;
  normalizeAudioChk.checked = settings.normalizeAudio;
  if (notifyOnDoneChk) notifyOnDoneChk.checked = settings.notifyOnDone;
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
// Honest progress + ETA (①). ffmpeg's real re-encode progress arrives with
// {determinate:true}; the fast stream-copy path reports coarse synthetic steps with
// no flag. We only show a "残り 約NN秒" estimate during the determinate (slow)
// phase, where the rate is time-proportional and an ETA is trustworthy — never on
// the jumpy copy steps, which would otherwise read as a frozen/garbage countdown.
let etaStart = 0;   // performance.now() when the current determinate run began
let etaStartP = 0;  // progress value at etaStart
function resetEta() { etaStart = 0; etaStartP = 0; }
function formatEta(sec) {
  sec = Math.max(1, Math.round(sec));
  if (sec < 60) return `約${sec}秒`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return `約${m}分${String(s).padStart(2, '0')}秒`;
}
function setProgress(value, info) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  progressFill.style.width = pct + '%';
  let label = pct + '%';
  if (info && info.determinate) {
    const now = performance.now();
    if (etaStart === 0 || value < etaStartP) { etaStart = now; etaStartP = value; }
    const elapsed = (now - etaStart) / 1000;
    const progressed = value - etaStartP;
    if (elapsed > 1.5 && progressed > 0.01 && value > 0.02 && value < 0.995) {
      label = `${pct}%　残り ${formatEta(elapsed * (1 - value) / progressed)}`;
    }
  } else {
    resetEta();
  }
  progressLabel.textContent = label;
}
let progressHideTimer = null; // the one pending "hide the bar 1.5 s after finishing" timer
function showProgress(show) {
  progressWrap.hidden = !show;
  if (show) {
    // A new run cancels the previous run's pending hide, so that timer can't hide
    // THIS run's bar / キャンセル button when it starts within 1.5 s.
    clearTimeout(progressHideTimer);
    progressHideTimer = null;
    // A new run supersedes any lingering error card / notice from the previous attempt —
    // the top strip should show one state at a time (progress → done | error | notice).
    clearExportError();
    clearExportNotice();
    resetEta();
    setProgress(0);
  }
  syncTopStrip();
}
// Hide the bar (and キャンセル) a moment after a run ends, so 100% is seen briefly.
// reveal: the run ended with a result the user must see (done panel / 1本ずつ result) —
// once the strip stops being pinned, bring it into view if it scrolled out of sight.
function hideProgressLater(ms, reveal = false) {
  clearTimeout(progressHideTimer);
  progressHideTimer = setTimeout(() => {
    progressHideTimer = null; showProgress(false); showCancelBtn(false);
    if (reveal) revealTopStrip();
  }, ms);
}
function showCancelBtn(show) { cancelExportBtn.hidden = !show; }
// The top strip is shown only when one of its parts is, and pinned (sticky) only while
// a run is in progress — error / done / notice cards then scroll away with the page
// instead of covering it on phones. Toggled here in JS (not CSS :has()) so it also
// works in browsers without :has().
function syncTopStrip() {
  if (!exportTopStrip) return;
  const busy = !progressWrap.hidden;
  const shown = busy || (exportError && !exportError.hidden) || (exportNotice && !exportNotice.hidden) || !exportDonePanel.hidden;
  exportTopStrip.hidden = !shown;
  exportTopStrip.classList.toggle('is-busy', busy);
}
// One rule for results the user must see when an export ends — done panel, error card,
// 1本ずつ result: if the (no longer pinned) strip is out of view, scroll it into view
// once. Not for a cancel the user pressed (no jump to the top after キャンセル).
function revealTopStrip() {
  if (!exportTopStrip || exportTopStrip.hidden) return;
  if (exportTopStrip.getBoundingClientRect().top < 0) exportTopStrip.scrollIntoView({ block: 'nearest' });
}
// Who produced the result now in the strip: 'single' (書き出し / X用に書き出し — about the
// clip that was open), 'multi' (つなげて / 1本ずつ — about every clip) or 'other' (共有).
let stripResultFrom = null;
// Opening / removing a clip drops only single-clip results. つなげて / 1本ずつ results stay
// until ✕ or the next export — e.g. 「失敗: b.mp4、c.mp4」 must survive opening b to fix it.
function clearSingleClipResult() {
  if (stripResultFrom !== 'single') return;
  clearExportError();
  clearExportNotice();
}

// --- Clip helpers ---
function isVideoFile(file) {
  return !!file && (file.type.startsWith('video/') || VIDEO_EXT_RE.test(file.name));
}
function activeClip() {
  return clips.find((c) => c.id === activeClipId) || null;
}

// Cheap metadata-only probe (no decode) so a clip's duration is known for the
// combined-length badge even if the user never opens it in the editor.
function probeClipMeta(clip) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { v.removeAttribute('src'); v.load(); } catch (_) {}
      resolve();
    };
    v.addEventListener('loadedmetadata', () => { if (isFinite(v.duration)) clip.duration = v.duration; finish(); }, { once: true });
    v.addEventListener('error', finish, { once: true });
    setTimeout(finish, 8000);
    v.src = clip.url;
  });
}

// Entry point for the file picker + drag-drop. Registers one or more clips and
// opens the first newly-added one for editing. Existing clips are kept (append),
// so dropping more files builds up a highlights set rather than replacing.
async function handleIncomingFiles(fileList) {
  const incoming = Array.from(fileList || []).filter(isVideoFile);
  if (incoming.length === 0) { setStatus('動画ファイルを選んでください。'); return; }
  // A fresh user-initiated load supersedes any standing rescue prompt. (Hidden here
  // — NOT in doOpenClip — so the automatic fallback-reopen of an existing clip after
  // a sibling fails doesn't wipe the new clip's rescue banner. If THIS load also
  // fails, doOpenClip's catch re-shows the banner for it.)
  hideRescueBanner();
  const wasEmpty = clips.length === 0;
  const newClips = [];
  for (const file of incoming) {
    const clip = {
      id: ++clipSeq, file, name: file.name,
      duration: 0, ranges: [], hasAudio: true, url: URL.createObjectURL(file),
    };
    clips.push(clip);
    newClips.push(clip);
  }
  renderClipTray();
  // Fill in durations in the background so the tray + combined badge are accurate
  // even for clips never opened in the editor (openClip sets the active one too).
  Promise.all(newClips.map(probeClipMeta)).then(() => { renderClipTray(); updateCombinedUI(); });
  // Restore-prompt only for the very first single clip (preserves the original
  // single-clip behavior); batch/appended clips just load empty.
  await openClip(newClips[0].id, { promptRestore: wasEmpty && incoming.length === 1 });
  if (incoming.length > 1) setStatus(`${incoming.length}本のクリップを追加しました。`);
}

// Serialize clip loads. initTimeline() is async and drives module-global timeline
// state + the single <video>; two overlapping loads (a fast switch while a prior
// clip's audio is still decoding) would corrupt the active clip's waveform/ranges.
// Chain every open so only one runs at a time.
let openChain = Promise.resolve();
function openClip(clipId, opts = {}) {
  const run = openChain.then(() => doOpenClip(clipId, opts));
  openChain = run.catch(() => {}); // a failed load must not poison the queue
  return run;
}

// Load a clip into the timeline/player. Persists the previously-active clip's
// ranges first, swaps the video source, re-inits the timeline, and restores this
// clip's own ranges. timeline.js stays single-clip; we swap its state in/out.
async function doOpenClip(clipId, { promptRestore = false } = {}) {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return;

  // Persist the outgoing clip's current edits before we switch away.
  const prev = activeClip();
  if (prev && prev.id !== clip.id) prev.ranges = getRanges();

  // Capture this clip's ranges BEFORE init (initTimeline's initial notify resets
  // the active clip's ranges to [] via the callback below — read them first).
  const savedRanges = (clip.ranges || []).slice();

  activeClipId = clip.id;
  currentFile = clip.file;
  autosaveWarned = false;
  // A previous clip's 書き出し / X用 error card or notice doesn't apply to this one
  // (つなげて / 1本ずつ results stay — they cover every clip).
  clearSingleClipResult();
  resetSubtitlePanel();
  video.src = clip.url;
  startFrameRateProbe(); // コマ送りの幅をこの動画のフレームレートで測り直す
  playerCard.classList.remove('empty');
  // Reveal the editor cards BEFORE initTimeline() so the waveform canvas measures a
  // real (non-zero) width. Hidden on the empty screen; restored here on every load.
  if (timelineCard) timelineCard.hidden = false;
  if (infoCard) infoCard.hidden = false;
  setStatus('波形を解析しています...');
  timelineContainer.classList.add('analyzing'); // spinner overlay until the waveform decode finishes (big clips take a few seconds)
  renderClipTray();

  const saved = promptRestore ? loadProject(clip.name) : null;

  try {
    await initTimeline(clip.file, video, (ranges, opts = {}) => {
      cutRanges = ranges;
      const ac = activeClip();
      if (ac) { ac.ranges = ranges; ac.duration = video.duration; ac.hasAudio = getHasAudio(); }
      exportBtn.disabled = ranges.length === 0;
      renderRangesList(ranges);
      setHotIndexExternal(-1);
      updateUndoRedo();
      updateMinimap();
      updateXLimit();
      updateCombinedUI();
      if (!opts.initial) {
        const ok = saveProject(clip.name, { ranges, duration: video.duration });
        if (!ok && !autosaveWarned) {
          autosaveWarned = true;
          setStatus('⚠ 自動保存に失敗しました（ストレージ容量不足またはブラウザ設定）。書き出しは引き続き可能です。');
        }
      }
    });
    clip.duration = video.duration;
    clip.hasAudio = getHasAudio();
    refreshSilenceBtn();
    genSubBtn.disabled = !getHasAudio();
    captureFrameBtn.disabled = false;
    xExportBtn.disabled = false;
    updateXLimit();
    setStatus('');
    // Warm up ffmpeg.wasm now (clip is loaded, user is about to mark cuts) so the
    // first export doesn't stall on the ~32MB core download.
    preloadFFmpeg();

    if (savedRanges.length > 0) {
      // Returning to an already-edited clip — restore its in-memory cuts.
      addRanges(savedRanges);
    } else if (saved && saved.ranges && saved.ranges.length > 0) {
      const ago = Math.round((Date.now() - (saved.savedAt || 0)) / 1000 / 60);
      if (confirm(`前回のカット範囲（${saved.ranges.length}件、${ago}分前）を復元しますか？`)) {
        addRanges(saved.ranges);
      } else {
        saveProject(clip.name, { ranges: [], duration: video.duration });
      }
    }
    renderClipTray();
    updateCombinedUI();
  } catch (err) {
    console.error(err);
    if (err && (err.message === 'UNSUPPORTED_MEDIA' || err.message === 'LOAD_TIMEOUT')) {
      // Don't dead-end (④): offer an in-place ffmpeg.wasm conversion to a playable
      // MP4 instead of telling the user to go convert it elsewhere.
      setStatus('');
      showRescueBanner(clip.file);
    } else {
      setStatus('読み込みエラー: ' + (err.message || err));
    }
    // Drop the un-loadable clip from the set and fall back to another clip (or empty).
    video.removeAttribute('src'); video.load();
    removeClip(clip.id, { silent: true });
  } finally {
    // Clear the waveform-loading overlay no matter how init ended (success, error,
    // or an unsupported-media reject), so it never sticks on screen.
    timelineContainer.classList.remove('analyzing');
  }
}

// Remove a clip; if it was active, fall back to a neighbour (or the empty state).
function removeClip(clipId, { silent = false } = {}) {
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return;
  const [removed] = clips.splice(idx, 1);
  try { if (removed.url) URL.revokeObjectURL(removed.url); } catch (_) {}
  // A 書き出し / X用 result may be about the clip that just left — drop it.
  clearSingleClipResult();
  if (activeClipId === clipId) {
    activeClipId = null;
    if (clips.length > 0) {
      openClip(clips[Math.min(idx, clips.length - 1)].id);
    } else {
      resetToEmpty();
    }
  } else {
    renderClipTray();
    updateCombinedUI();
  }
  if (!silent) setStatus('クリップを外しました。');
}

function moveClip(clipId, dir) {
  const idx = clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return;
  const j = idx + dir;
  if (j < 0 || j >= clips.length) return;
  [clips[idx], clips[j]] = [clips[j], clips[idx]];
  renderClipTray();
  updateCombinedUI();
}

function clearAllClips() {
  for (const c of clips) { try { if (c.url) URL.revokeObjectURL(c.url); } catch (_) {} }
  clips = [];
  activeClipId = null;
  resetToEmpty();
}

// Return the editor to the no-clip empty state.
function resetToEmpty() {
  if (video.src) { try { video.removeAttribute('src'); video.load(); } catch (_) {} }
  fpsProbeGen++; detectedFrameSec = null; // forget the old clip's frame rate
  currentFile = null;
  cutRanges = [];
  clearRanges();
  exportBtn.disabled = true;
  xExportBtn.disabled = true;
  genSubBtn.disabled = true;
  silenceBtn.disabled = true;
  captureFrameBtn.disabled = true;
  playerCard.classList.add('empty');
  // Back to the empty screen — hide the editor cards again.
  if (timelineCard) timelineCard.hidden = true;
  if (infoCard) infoCard.hidden = true;
  resetSubtitlePanel();
  hideExportDone();
  clearBatchUrls();
  updateXLimit();
  renderClipTray();
  updateCombinedUI();
  setStatus('');
}

function setStatus(text) {
  statusEl.textContent = '';
  if (typeof text === 'string') statusEl.textContent = text;
  // Mirror to the top strip's per-step status line so users watching the top
  // progress bar don't have to scroll down to see "セグメント 2/3 を抽出中..." etc.
  // Only meaningful while progress is visible; when hidden the empty line collapses.
  if (progressStatus) {
    progressStatus.textContent = (typeof text === 'string') ? text : '';
  }
}

// --- Friendly export error ---
// Translate ffmpeg / wasm exceptions into plain words a first-time user can act on.
// The raw log stays available in a <details> so it can still be sent for support.
// exporter.js appends the ffmpeg log tail ("\n\n--- FFmpeg log …") to every error,
// and ffmpeg.wasm logs "Aborted()" at the end of EVERY run (its normal exit) —
// so judge by the error itself (the head), not the log, or every failure reads as
// "too big".
function errorHead(raw) { return raw.split('\n\n--- FFmpeg log')[0]; }
function isOutOfMemory(err) {
  const raw = (err && err.message) ? err.message : String(err);
  // WASM heap exhaustion — the classic ffmpeg.wasm failure on big game clips —
  // or ffmpeg's own ENOMEM line anywhere in the log.
  return /memory access out of bounds|out of memory|std::bad_alloc|Aborted\(\)|RangeError/i.test(errorHead(raw)) ||
    /Cannot allocate memory/i.test(raw);
}

// button: which button failed — 'x' (X用に書き出し), 'normal' (書き出し), 'combine' (つなげて書き出し).
// The advice must work for THAT button (X用 ignores 「解像度」, so don't suggest it there).
// canUseNormalExport: the 書き出し button is only pressable with at least one range
// marked, so only point X用 users at it when it can actually be pressed.
function friendlyExportError(err, prefix, button = 'normal', canUseNormalExport = true) {
  const raw = (err && err.message) ? err.message : String(err);
  const p = prefix || '書き出し';
  const head = errorHead(raw);

  const oom = isOutOfMemory(err);
  const emptyCut = head.includes('全部削除されています');
  const ffExit = /exit\s+-?\d+/i.test(head); // ffmpeg-core's return code starts at -1
  const loadFail = head.includes('FFmpeg の読み込みに失敗');

  let title, body;
  if (oom) {
    title = '動画が長すぎる・大きすぎるため、ブラウザの中で書き出しきれませんでした';
    const tips = button === 'x' ? [
      'いらない所をもっとカットして、書き出す部分を短くする',
      '2回に分けて書き出す（前半だけ・後半だけを、それぞれ書き出す）',
      ...(canUseNormalExport ? ['上の「書き出し」ボタン（Xマークのない方）で、「解像度」を 720p にして書き出す（形式が MP4 なら、そのままXに投稿できます）'] : []),
    ] : button === 'combine' ? [
      'つなげるクリップを減らすか、それぞれをもっとカットして短くする',
      '「1本ずつ書き出し（X用）」で、クリップを別々に書き出す',
    ] : [
      '「解像度」を 720p か 480p にして書き出す',
      'いらない所をもっとカットして、書き出す部分を短くする',
      '2回に分けて書き出す（前半だけ・後半だけを、それぞれ書き出す）',
    ];
    tips.push('ほかのタブや重いアプリを閉じてから、もう一度書き出す');
    tips.push('それでもだめなときは、ページを読み込み直してから、もう一度書き出す');
    body =
      '書き出しはこのパソコンの中だけで行うため、長い動画やファイルの大きい動画だと、途中で止まってしまうことがあります。\n\n' +
      '次のどれかをお試しください：\n' + tips.map((t) => '・' + t).join('\n');
  } else if (emptyCut) {
    title = 'ぜんぶカット範囲になっています';
    body = '書き出す部分が残っていません。カット範囲を減らしてから、もう一度お試しください。';
  } else if (loadFail) {
    title = `${p}の準備に失敗しました`;
    body = '通信が不安定だった可能性があります。ページを読み込み直してから、もう一度お試しください。';
  } else if (ffExit) {
    title = `${p}に失敗しました`;
    body = 'この動画の形式に、うまく対応できなかったようです。別の動画で試してみてください。直らないときは、下の「詳しいログを見る」の中身を、画面下の「お問い合わせ（X）」から送ってください。';
  } else {
    title = `${p}に失敗しました`;
    // exporter.js's own Japanese reasons (e.g. 「すべてのクリップが空です（カットで全部
    // 消えています）。」) are already plain — show them as the card text.
    body = /[ぁ-んァ-ヶ一-龠]/.test(head)
      ? head
      : 'もう一度お試しください。何度も失敗するときは、ページを読み込み直してください。';
  }
  return { title, body, raw, oom };
}

// Small ✕ (閉じる) button shared by the error card and the notice line.
function makeStripCloseButton(onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-ghost icon-only strip-close';
  b.title = '閉じる';
  b.setAttribute('aria-label', '閉じる');
  b.textContent = '✕';
  b.addEventListener('click', onClick);
  return b;
}

function showExportError(err, opts = {}) {
  const info = friendlyExportError(err, opts.prefix, opts.button, opts.canUseNormalExport !== false);
  if (!exportError) return info;
  const { title, body, raw } = info;
  clearExportNotice();
  stripResultFrom = opts.from || 'single';
  exportError.innerHTML = '';
  // Show the (empty) card first, then fill it, so screen readers announce the text.
  // Mutually exclusive with the done panel.
  if (exportDonePanel) exportDonePanel.hidden = true;
  exportError.hidden = false;
  syncTopStrip();

  const h = document.createElement('div');
  h.className = 'export-error-title';
  h.textContent = `⚠ ${title}`;
  exportError.appendChild(h);
  exportError.appendChild(makeStripCloseButton(clearExportError));

  if (body) {
    const p = document.createElement('p');
    p.className = 'export-error-body';
    p.textContent = body;
    exportError.appendChild(p);
  }

  if (raw && raw !== title) {
    const det = document.createElement('details');
    det.className = 'export-error-details';
    const sum = document.createElement('summary');
    sum.textContent = '詳しいログを見る';
    det.appendChild(sum);
    const pre = document.createElement('pre');
    pre.textContent = raw;
    det.appendChild(pre);
    exportError.appendChild(det);
  }

  revealTopStrip();
  return info;
}

function clearExportError() {
  if (!exportError) return;
  exportError.hidden = true;
  exportError.innerHTML = '';
  syncTopStrip();
}

// One-line result in the top strip (cancelled / 1本ずつ書き出し summary), so it shows
// where the user was watching the progress bar — not only in the bottom #status.
// kind: 'info' | 'success' | 'warn'; from: who produced it (see stripResultFrom).
// No scrolling here: a cancel must not jump the page; the 1本ずつ result is revealed
// when its run ends (hideProgressLater(…, true)).
function showExportNotice(text, kind = 'info', from = 'single') {
  if (!exportNotice) return;
  clearExportError();
  stripResultFrom = from;
  exportNotice.className = 'export-notice' + (kind === 'success' ? ' is-success' : kind === 'warn' ? ' is-warn' : '');
  exportNotice.innerHTML = '';
  // Show first, then fill, so screen readers announce the text.
  exportNotice.hidden = false;
  syncTopStrip();
  const span = document.createElement('span');
  span.className = 'export-notice-text';
  span.textContent = text;
  exportNotice.appendChild(span);
  exportNotice.appendChild(makeStripCloseButton(clearExportNotice));
}

function clearExportNotice() {
  if (!exportNotice) return;
  exportNotice.hidden = true;
  exportNotice.innerHTML = '';
  syncTopStrip();
}

// --- File input + drag-drop ---
fileInput.addEventListener('change', async (e) => {
  if (e.target.files && e.target.files.length) await handleIncomingFiles(e.target.files);
  e.target.value = ''; // allow re-selecting the same file(s)
});

// Empty-state "サンプルで試す": fetch the bundled rights-free clip, wrap it as a
// File and push it through the SAME load pipeline as drop/picker. The button is
// ALWAYS restored in finally: on success #emptyState is hidden (doOpenClip removes
// .empty from #playerCard), but the user can later 全部クリア / remove the last clip
// → resetToEmpty() shows the empty state again — without the restore the button
// would reappear stuck disabled with the 読み込み中… label.
const trySampleBtn = document.getElementById('trySampleBtn');
if (trySampleBtn) {
  trySampleBtn.addEventListener('click', async () => {
    if (trySampleBtn.disabled) return;
    const labelEl = trySampleBtn.querySelector('.es-cta-sample-label');
    const prev = labelEl ? labelEl.textContent : '';
    trySampleBtn.disabled = true;
    if (labelEl) labelEl.textContent = '読み込み中…';
    try {
      const res = await fetch('/sample/sample-clip.mp4');
      if (!res.ok) throw new Error('sample fetch failed: ' + res.status);
      const blob = await res.blob();
      const file = new File([blob], 'sample-clip.mp4', { type: 'video/mp4' });
      await handleIncomingFiles([file]); // same path as drop / picker — one load pipeline
    } catch (err) {
      console.error(err);
      setStatus('サンプルの読み込みに失敗しました。少し待ってからもう一度お試しください。');
    } finally {
      trySampleBtn.disabled = false;
      if (labelEl) labelEl.textContent = prev;
    }
  });
}

// --- Rescue: convert a browser-unplayable file to a playable MP4 in place (④) ---
// Shown by doOpenClip's catch when the <video> can't load a clip (OBS MKV, AVI,
// HEVC, …). Instead of dead-ending, we convert locally with ffmpeg.wasm (lossless
// remux when only the container is the problem, transcode when the codec is) and
// feed the result back through the normal load pipeline.
let lastFailedFile = null;
const rescueEta = { start: 0, startP: 0 };
function showRescueBanner(file) {
  lastFailedFile = file;
  if (rescueDesc) rescueDesc.textContent = `「${file.name}」はブラウザでそのまま再生できない形式です（OBSのMKVなど）。このPCの中だけでMP4に変換すれば、続けて編集できます（アップロードはしません）。`;
  if (rescueProgress) { rescueProgress.hidden = true; rescueProgress.textContent = ''; }
  if (rescueBtn) { rescueBtn.disabled = false; rescueBtn.textContent = 'MP4に変換して読み込む'; }
  if (rescueBanner) rescueBanner.hidden = false;
}
function hideRescueBanner() {
  if (rescueBanner) rescueBanner.hidden = true;
  lastFailedFile = null;
}
// Show a non-percentage status line in the banner (used for the probe + the remux
// branch, which has NO progress events — a bare "0%" there would look frozen).
function setRescueStatus(msg) {
  if (!rescueProgress || !msg) return;
  rescueProgress.hidden = false;
  rescueProgress.textContent = msg;
}
// Percentage + ETA — only fed real (determinate) ffmpeg progress from the transcode.
function setRescueProgress(p, info) {
  if (!rescueProgress || !(info && info.determinate)) return;
  rescueProgress.hidden = false;
  const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
  const now = performance.now();
  if (rescueEta.start === 0 || p < rescueEta.startP) { rescueEta.start = now; rescueEta.startP = p; }
  const elapsed = (now - rescueEta.start) / 1000, prog = p - rescueEta.startP;
  let txt = `変換中… ${pct}%`;
  if (elapsed > 1.5 && prog > 0.01 && p > 0.02 && p < 0.995) txt += `　残り ${formatEta(elapsed * (1 - p) / prog)}`;
  rescueProgress.textContent = txt;
}
if (rescueDismiss) rescueDismiss.addEventListener('click', hideRescueBanner);
if (rescueBtn) {
  rescueBtn.addEventListener('click', async () => {
    if (!lastFailedFile || exporting) return;
    const file = lastFailedFile;
    exporting = true;
    rescueBtn.disabled = true;
    rescueBtn.textContent = '変換中...';
    rescueEta.start = 0; rescueEta.startP = 0;
    showCancelBtn(true);
    try {
      const { blob, method } = await rescueToPlayable(file, {
        // Route status into the banner too: the remux branch emits no progress
        // events, so this descriptive line (not a frozen "0%") is what the user sees.
        onStatus: (m) => { setStatus(m); setRescueStatus(m); },
        onProgress: (p, info) => setRescueProgress(p, info),
      });
      notifyExportDone('動画の変換が完了しました', '✅ 変換完了！'); // consistent with ②: a long transcode may have been backgrounded
      const base = (file.name || 'video').replace(/\.[^.]+$/, '');
      const mp4 = new File([blob], `${base}.mp4`, { type: 'video/mp4' });
      hideRescueBanner();
      showCancelBtn(false);
      exporting = false; // release before the normal load pipeline takes over
      setStatus(method === 'remux' ? 'MP4に変換しました（画質そのまま）。読み込みます…' : 'MP4に変換しました。読み込みます…');
      await handleIncomingFiles([mp4]);
    } catch (err) {
      console.error('[rescue] error:', err);
      exporting = false;
      showCancelBtn(false);
      if (err && err.message && err.message.includes('__CANCELLED__')) {
        setStatus('変換をキャンセルしました');
        if (rescueProgress) rescueProgress.hidden = true;
      } else {
        setStatus('変換に失敗しました: ' + (err.message || err));
        if (rescueProgress) { rescueProgress.hidden = false; rescueProgress.textContent = '変換に失敗しました。別の形式でお試しください。'; }
      }
      rescueBtn.disabled = false;
      rescueBtn.textContent = 'MP4に変換して読み込む';
    }
  });
}

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
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) await handleIncomingFiles(files);
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
  updateTimeDisplay();
});

// --- Player transport (shared by keyboard shortcuts + the on-screen control bar) ---
function playPause() {
  if (video.paused) video.play().catch(() => {}); else video.pause();
}
function skip(delta) {
  const dur = isFinite(video.duration) ? video.duration : Infinity;
  video.currentTime = Math.max(0, Math.min(dur, video.currentTime + delta));
}
// 「区切り（セグメント境界）」= 0 / 動画の終わり / すべての範囲(カット・倍速)の start と end。
// これらでタイムラインが分断されるので、その頭に飛べば区切りごとの頭出しになる。
function getSegmentBoundaries() {
  const dur = isFinite(video.duration) ? video.duration : 0;
  const set = new Set([0]);
  if (dur > 0) set.add(dur);
  for (const r of getRanges()) {
    if (isFinite(r.start)) set.add(Math.max(0, Math.min(dur, r.start)));
    if (isFinite(r.end)) set.add(Math.max(0, Math.min(dur, r.end)));
  }
  const all = Array.from(set).sort((a, b) => a - b);
  // プレビュー(P)中はカット部分が飛ばされる＝カットの頭へ飛んでも即カットの終わりへ戻される。
  // カットの内側にある境界を外さないと、[ でカットより前へ戻れなくなる。
  if (!previewMode) return all;
  const cuts = getRanges().filter((r) => r.type === 'cut');
  return all.filter((b) => !cuts.some((r) => b >= r.start && b < r.end));
}
// 「今の区切り」の頭 = 現在時刻より前の最寄りの境界
function currentSegmentStart() {
  const t = video.currentTime;
  const dur = isFinite(video.duration) ? video.duration : 0;
  const bs = getSegmentBoundaries();
  let cur = 0;
  for (const b of bs) {
    // 動画の終わりは区切りの「頭」にはならない（最後まで再生し終えた時の「今の区切り」は最後の区切り）。
    // これを除かないと、終わりで ] を押すと終わりへ飛ぶだけで何も再生されない。
    if (dur > 0 && b >= dur - 1e-4) break;
    if (b <= t + 1e-4) cur = b; else break;
  }
  return cur;
}
function playCurrentSegmentFromStart() {
  const s = currentSegmentStart();
  video.currentTime = s;
  video.play().catch(() => {});
}
function jumpToPrevSegment() {
  const t = video.currentTime;
  const bs = getSegmentBoundaries();
  // 「今の区切りの頭」を出し、それより 0.05 秒以上手前にいれば「今の頭」に戻す。
  // 既にほぼ頭にいれば、そのひとつ手前の境界へ。
  let curStart = 0;
  for (const b of bs) {
    if (b <= t + 1e-4) curStart = b; else break;
  }
  // 再生中は、次に押すまでに再生位置が進んでしまうので「ほぼ頭」の幅を 1 秒に広げる
  // （0.05 秒のままだと、再生中は何度押しても同じ頭に戻るだけで前の区切りへ行けない）。
  const atHead = video.paused ? 0.05 : 1.0;
  if (t - curStart > atHead) {
    video.currentTime = curStart;
    return;
  }
  let prev = 0;
  for (const b of bs) {
    if (b < curStart - 1e-4) prev = b; else break;
  }
  video.currentTime = prev;
}
// コマ送り: 1 コマ = その動画の本当のフレームレート（再生中に測れたら）。測れるまでは
// 30fps 相当（1/30 秒）。再生中は止めてから動かす。
const FRAME_STEP_SEC = 1 / 30;
let detectedFrameSec = null; // seconds per frame of the current clip, once measured
let fpsProbeGen = 0;         // bumped on every clip change so stale callbacks stop
let seekSerial = 0;          // any seek restarts the measuring window
video.addEventListener('seeking', () => { seekSerial++; });
const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 119.88, 120, 144, 240];
// Measure the frame rate while the clip plays at normal speed: count every frame that
// went by — shown (rVFC presentedFrames) + skipped by the player (droppedVideoFrames) —
// over ~1 s of media time (after 0.5 s of warm-up), so a 120fps clip on a 60Hz screen
// still reads 120. (totalVideoFrames, the decoder count, also includes frames decoded
// ahead and was ±1 frame off per second in tests.) Only at playbackRate 1, no pause /
// seek inside the window. Snap to a common rate within 2%; an uncommon value is only
// taken once two windows agree. No support / never played → stays on 1/30 s.
function startFrameRateProbe() {
  detectedFrameSec = null;
  const gen = ++fpsProbeGen;
  if (typeof video.requestVideoFrameCallback !== 'function' || typeof video.getVideoPlaybackQuality !== 'function') return;
  let warm = null;     // first steady sample after (re)starting
  let start = null;    // window start
  let lastRaw = null;  // previous uncommon estimate, waiting for confirmation
  const onFrame = (_now, meta) => {
    if (gen !== fpsProbeGen) return;
    const steady = !video.paused && !video.seeking && video.playbackRate === 1;
    if (!steady || (warm && warm.seek !== seekSerial)) { warm = null; start = null; }
    if (steady) {
      const s = { t: meta.mediaTime, n: meta.presentedFrames + video.getVideoPlaybackQuality().droppedVideoFrames, seek: seekSerial };
      if (!warm) warm = s;
      else if (!start) { if (s.t - warm.t >= 0.5) start = s; }
      else if (s.t - start.t >= 1.0) {
        const fps = (s.n - start.n) / (s.t - start.t);
        start = s;
        if (Number.isFinite(fps) && fps >= 10 && fps <= 300) {
          const best = COMMON_FPS.reduce((a, c) => (Math.abs(c - fps) < Math.abs(a - fps) ? c : a));
          if (Math.abs(best - fps) / best <= 0.02) { detectedFrameSec = 1 / best; return; } // measured — stop
          if (lastRaw && Math.abs(lastRaw - fps) / fps <= 0.02) { detectedFrameSec = 2 / (lastRaw + fps); return; }
          lastRaw = fps;
        }
      }
    }
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}
function frameStep(dir) {
  if (!video.paused) video.pause();
  const dur = isFinite(video.duration) ? video.duration : Infinity;
  const step = detectedFrameSec || FRAME_STEP_SEC;
  video.currentTime = Math.max(0, Math.min(dur, video.currentTime + dir * step));
}
function markIn() {
  markInTime = video.currentTime;
  showMarkInAt(markInTime);
  setStatus(`カット開始: ${formatTime(markInTime)} — 終わりまで進めて「カット終了」(O) を押してください`);
}
function markOut() {
  if (markInTime === null) { setStatus('先に「カット開始」(I) で始まりの位置を決めてください'); return; }
  const start = Math.min(markInTime, video.currentTime);
  const end = Math.max(markInTime, video.currentTime);
  if (end - start < 0.05) { setStatus('範囲が短すぎます'); markInTime = null; hideMarkIn(); return; }
  addRanges([{ start, end, type: 'cut' }]);
  setStatus(`カット範囲を追加: ${formatTime(start)} 〜 ${formatTime(end)}`);
  markInTime = null;
  hideMarkIn();
}
function fmtClock(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function updateTimeDisplay() {
  if (!pcCur || !pcDur) return;
  pcCur.textContent = fmtClock(video.currentTime);
  pcDur.textContent = fmtClock(video.duration);
}
function updatePlayBtn() {
  if (!pcPlay) return;
  const label = pcPlay.querySelector('.pc-label') || pcPlay;
  label.textContent = (!video.paused && !video.ended) ? '⏸ 一時停止' : '▶ 再生';
}
video.addEventListener('play', updatePlayBtn);
video.addEventListener('pause', updatePlayBtn);
video.addEventListener('ended', updatePlayBtn);
video.addEventListener('loadedmetadata', updateTimeDisplay);

// On-screen control bar wiring
pcPlay.addEventListener('click', playPause);
pcBack5.addEventListener('click', () => skip(-5));
pcBack1.addEventListener('click', () => skip(-1));
pcFwd1.addEventListener('click', () => skip(1));
pcFwd5.addEventListener('click', () => skip(5));
pcMarkIn.addEventListener('click', markIn);
pcMarkOut.addEventListener('click', markOut);
pcPrevSeg.addEventListener('click', jumpToPrevSegment);
pcSegHead.addEventListener('click', playCurrentSegmentFromStart);
pcFrameBack.addEventListener('click', () => frameStep(-1));
pcFrameFwd.addEventListener('click', () => frameStep(1));
videoMinimap.addEventListener('click', (e) => {
  const dur = video.duration;
  if (!isFinite(dur) || dur <= 0) return;
  const rect = videoMinimap.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  video.currentTime = frac * dur;
});

// --- Reset zoom ---
resetZoomBtn.addEventListener('click', () => resetZoom());

// --- Drag mode: left-drag creates a cut range or a speedup range ---
let speedDragMode = false;
function applyDragTool() {
  const speed = parseInt(dragSpeedSelect.value, 10) || 2;
  if (speedDragMode) setDragTool('speedup', speed);
  else setDragTool('cut');
  modeCutBtn.classList.toggle('active', !speedDragMode);
  modeSpeedBtn.classList.toggle('active', speedDragMode);
  dragSpeedSelect.hidden = !speedDragMode;
  if (legendDrag) {
    legendDrag.innerHTML = speedDragMode
      ? '<span class="dot dot-speed"></span>左ドラッグ=倍速'
      : '<span class="dot dot-add"></span>左ドラッグ=カット';
  }
}
modeCutBtn.addEventListener('click', () => { speedDragMode = false; applyDragTool(); settings = saveSettings({ defaultDragMode: 'cut' }); });
modeSpeedBtn.addEventListener('click', () => { speedDragMode = true; applyDragTool(); settings = saveSettings({ defaultDragMode: 'speedup' }); });
dragSpeedSelect.addEventListener('change', () => { settings = saveSettings({ defaultDragSpeed: parseInt(dragSpeedSelect.value, 10) || 2 }); if (speedDragMode) applyDragTool(); });

// Restore the saved left-drag tool + speed (③). Placed AFTER the declarations
// above (speedDragMode / applyDragTool / dragSpeedSelect) to avoid the TDZ that
// would hit if applySettingsToUI() touched speedDragMode at module-init time.
if (settings.defaultDragSpeed) dragSpeedSelect.value = String(settings.defaultDragSpeed);
speedDragMode = settings.defaultDragMode === 'speedup';
applyDragTool();

// --- Timeline ↔ list correspondence: light/scroll the list row when the
//     matching waveform bar is hovered (onHot) or pinned (onSelect). Registered
//     ONCE; the data-index selectors naturally skip the extra "すべて取り消し" li. ---
function rowByIndex(i) {
  return i >= 0 ? rangesList.querySelector(`li[data-index="${i}"]`) : null;
}
onHot((i) => {
  rangesList.querySelectorAll('li.hot').forEach((e) => e.classList.remove('hot'));
  const li = rowByIndex(i);
  // Highlight only — never scroll on passive hover. #rangesList is not its own
  // scroll container, so scrollIntoView here would yank the whole PAGE as the
  // cursor sweeps the waveform. Scrolling is reserved for the deliberate pin.
  if (li) li.classList.add('hot');
});
onSelect((key, index) => {
  rangesList.querySelectorAll('li.selected').forEach((e) => e.classList.remove('selected'));
  const li = rowByIndex(index);
  if (li) { li.classList.add('selected'); li.scrollIntoView({ block: 'nearest' }); }
});

// --- Silence detect (uses settings) ---
// 無音検出 shares the progress bar with exports, so it is off while an export runs
// (its own end would otherwise hide the export's bar and キャンセル button).
let detectingSilence = false;
function refreshSilenceBtn() { silenceBtn.disabled = exporting || detectingSilence || !currentFile || !getHasAudio(); }
// ...and the other way round: no export starts while 無音検出 runs (the cuts it is about to add would be
// missing from the export, and both would fight over the progress bar).
function silenceBusy() {
  if (!detectingSilence) return false;
  setStatus('無音検出が終わってから、もう一度書き出してください');
  return true;
}
silenceBtn.addEventListener('click', async () => {
  if (exporting || detectingSilence) return;
  const buf = getAudioBuffer();
  if (!buf) {
    setStatus('音声トラックがないので無音検出できません。');
    return;
  }
  detectingSilence = true;
  refreshSilenceBtn();
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
    detectingSilence = false;
    refreshSilenceBtn();
    if (!exporting) hideProgressLater(800); // an export started meanwhile owns the bar now
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

// --- Export completion panel ---
// After a successful export we keep the result's object-URL alive (instead of the
// old "revoke after 2s") and surface a panel with "download again" + "share", so a
// missed/failed browser download no longer means re-running a multi-minute export.
let lastExport = null; // { url, blob, filename }

function clearLastExport() {
  if (lastExport && lastExport.url) {
    try { URL.revokeObjectURL(lastExport.url); } catch (_) {}
  }
  lastExport = null;
}

function hideExportDone() {
  exportDonePanel.hidden = true;
  clearLastExport();
  clearExportError();
  clearExportNotice();
  syncTopStrip();
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// Local HHMMSS stamp appended to export filenames so a re-export of the same clip a
// moment later doesn't collide into "..._for_X (1).mp4", keeping the right file to
// attach to X identifiable in a crowded Downloads folder. (Batch export additionally
// appends a per-clip index so same-named clips finishing in the same second differ.)
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function showExportDone({ blob, url, filename, hint }) {
  // Drop any previous result (revokes its URL); the new one stays alive until the
  // panel is closed, the next export starts, or the project is reset.
  clearLastExport();
  // Mutually exclusive with the friendly-error card / notice in the same top slot.
  clearExportError();
  clearExportNotice();
  lastExport = { url, blob, filename };
  // Show the panel first, then fill in the file name / hint, so screen readers announce it.
  exportDonePanel.hidden = false;
  syncTopStrip();
  const size = humanSize(blob.size);
  exportDoneMeta.textContent = size ? `${filename}（${size}）` : filename;
  exportDoneHint.textContent = hint || '';
  // Web Share with files is mostly mobile/Safari; show the button only when the
  // browser can actually share this file, otherwise it would always reject.
  let canShare = false;
  try {
    const probe = new File([blob], filename, { type: blob.type || 'video/mp4' });
    canShare = !!(navigator.canShare && navigator.canShare({ files: [probe] }));
  } catch (_) { canShare = false; }
  exportShareBtn.hidden = !canShare;
}

exportRedownloadBtn.addEventListener('click', () => {
  if (!lastExport) return;
  triggerDownload(lastExport.url, lastExport.filename);
});

exportShareBtn.addEventListener('click', async () => {
  if (!lastExport) return;
  try {
    const file = new File([lastExport.blob], lastExport.filename, { type: lastExport.blob.type || 'video/mp4' });
    if (navigator.canShare && !navigator.canShare({ files: [file] })) {
      const msg = 'このブラウザはファイル共有に対応していません。「もう一度ダウンロード」をお使いください。';
      setStatus(msg);
      showExportNotice(msg, 'warn', 'other'); // next to the done panel, where 共有… was pressed
      return;
    }
    await navigator.share({ files: [file], title: 'QuickTrimmer' });
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user dismissed the share sheet
    console.error('[share] error:', err);
    const msg = '共有できませんでした。「もう一度ダウンロード」をお使いください。';
    setStatus(msg);
    showExportNotice(msg, 'warn', 'other');
  }
});

exportDoneClose.addEventListener('click', hideExportDone);

// --- Export-done notification (②) ---
// Gamers alt-tab into their game while a clip transcodes, so the on-screen panel
// alone is easy to miss. When the tab is hidden at completion we (a) flash the tab
// title (always, no permission needed — visible in the taskbar/tab strip) and
// (b) fire a desktop Notification if the user opted in AND granted permission.
let _titleSaved = null;
function flashTitle(text) {
  if (_titleSaved === null) _titleSaved = document.title;
  document.title = text;
}
function restoreTitle() {
  if (_titleSaved !== null) { document.title = _titleSaved; _titleSaved = null; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) restoreTitle(); });
window.addEventListener('focus', restoreTitle);

function notifyExportDone(message, flashText = '✅ 書き出し完了！') {
  if (!document.hidden) return; // looking at the tab — the on-screen panel is enough
  flashTitle(flashText);
  if (settings.notifyOnDone && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification('QuickTrimmer', { body: message, icon: '/icons/icon.svg' });
      n.onclick = () => { try { window.focus(); } catch (_) {} n.close(); };
    } catch (_) {}
  }
}

// --- Export ---
exportBtn.addEventListener('click', () => doExport({ xOptimize: false }));
xExportBtn.addEventListener('click', () => doExport({ xOptimize: true }));

async function doExport({ xOptimize }) {
  if (!currentFile || exporting || silenceBusy()) return;
  // Generic export needs at least one cut; the X export is also useful with zero
  // cuts (just re-containerizing a HEVC/PS5 clip into an X-uploadable MP4).
  if (!xOptimize && cutRanges.length === 0) return;

  exporting = true;
  exportBtn.disabled = true;
  xExportBtn.disabled = true;
  refreshSilenceBtn(); // 無音検出 shares the progress bar — off during an export
  hideExportDone(); // clear any previous result panel (and revoke its URL)
  const activeBtn = xOptimize ? xExportBtn : exportBtn;
  const originalHTML = activeBtn.innerHTML;
  activeBtn.textContent = '処理中...';
  showProgress(true);
  showCancelBtn(true);
  try {
    const blob = await exportVideo(currentFile, cutRanges, video.duration, {
      onStatus: (msg) => { setStatus(msg); },
      onProgress: (p, info) => setProgress(p, info),
      hasAudio: getHasAudio(),
      xOptimize,
      format: formatSelect.value,
      height: heightSelect.value,
      aspect: aspectSelect.value,
      normalizeAudio: normalizeAudioChk.checked,
      // lets a converted export keep enough bitrate for a >1080p source (exporter.js plainMaxrateMbps)
      sourceWidth: video.videoWidth,
      sourceHeight: video.videoHeight,
    });
    setProgress(1);
    const url = URL.createObjectURL(blob);
    const base = (currentFile.name || 'video').replace(/\.[^.]+$/, '');
    const ext = xOptimize
      ? '.mp4'
      : (formatSelect.value === 'webm' ? '.webm' : (formatSelect.value === 'gif' ? '.gif' : '.mp4'));
    const filename = xOptimize ? `${base}_for_X_${stamp()}${ext}` : `${base}_trimmed_${stamp()}${ext}`;
    triggerDownload(url, filename);
    showExportDone({ blob, url, filename, hint: xOptimize
      ? 'Xにそのままアップロードできます。ダウンロードフォルダを確認してください。見当たらないときは下のボタンでやり直せます。'
      : 'ダウンロードフォルダを確認してください。見当たらないときは下のボタンでやり直せます。' });
    setStatus('書き出し完了！');
    notifyExportDone(xOptimize ? 'X用の書き出しが完了しました' : '書き出しが完了しました');
    hideProgressLater(1500, true); // keep the done panel in view once it stops being pinned
  } catch (err) {
    console.error('[export] error:', err);
    showProgress(false);
    showCancelBtn(false);
    setStatus('');
    if (err && err.message && err.message.includes('__CANCELLED__')) {
      setStatus('書き出しをキャンセルしました');
      showExportNotice('書き出しをキャンセルしました');
    } else {
      // Friendly error into the top strip (in place of the old raw <pre> stapled
      // to the bottom #status). The raw log is still available inside the card.
      const info = showExportError(err, { prefix: '書き出し', button: xOptimize ? 'x' : 'normal', canUseNormalExport: cutRanges.length > 0 });
      // After a real out-of-memory crash the ffmpeg.wasm engine can be left broken.
      // Drop it (cancelExport() just terminates the worker) so the next try loads a
      // fresh one instead of failing again in the same tab.
      if (info && info.oom) cancelExport();
      setStatus('');
    }
  } finally {
    exporting = false;
    refreshSilenceBtn();
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
    li.dataset.index = i;
    li.dataset.key = keyOf(r);
    if (getSelectedKey() === keyOf(r)) li.classList.add('selected');
    const info = document.createElement('div');
    info.className = 'range-info';
    const isSpeed = r.type === 'speedup';
    const action = isSpeed ? `${r.speed}x 倍速` : '削除';

    // Number badge — same digit as the matching waveform bar (#i+1).
    const num = document.createElement('span');
    num.className = 'range-row-num' + (isSpeed ? ' speedup' : '');
    num.textContent = i + 1;
    info.appendChild(num);

    const time = document.createElement('span');
    time.textContent = `${formatTime(r.start)} 〜 ${formatTime(r.end)}  ${action} `;
    const pill = document.createElement('span');
    pill.className = 'duration-pill' + (isSpeed ? ' speedup' : '');
    pill.textContent = `${(r.end - r.start).toFixed(1)}秒`;
    info.appendChild(time);
    info.appendChild(pill);

    // Click the row → seek there, pin it, and reveal its bar on the waveform
    // (recentering the zoom viewport if the bar is currently off-screen).
    info.style.cursor = 'pointer';
    info.title = 'クリックでこの位置へ移動 / 波形上の対応バーを表示';
    info.addEventListener('click', () => {
      video.currentTime = r.start;
      selectRangeAt(i);
      focusRange(keyOf(r));
    });
    // Hover the row → light its bar (and vice-versa via onHot below).
    li.addEventListener('mouseenter', () => setHotIndexExternal(i));
    li.addEventListener('mouseleave', () => setHotIndexExternal(-1));

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
// Size is a rough estimate (labelled 約): the kept fraction of the source bytes for a
// lossless copy; for an export that will be converted — a cut in the middle (two or more
// kept parts), a trimmed start or a speed-up — at most the converter's rate ceiling (exporter.js:
// 20 Mbit/s video + 128 kbit/s audio), so a high-bitrate source isn't flagged as too big.
const X_CONVERT_BYTES_PER_SEC = (20e6 + 128e3) / 8;
// Kept parts of a cut-only edit, and where the first one starts (> 0 = the start is trimmed,
// which is converted unless it lands exactly on a keyframe — counted as converted here).
function keptParts(ranges, dur) {
  const cuts = ranges.filter((r) => r.type !== 'speedup').sort((a, b) => a.start - b.start);
  let n = 0, cursor = 0, firstStart = null;
  for (const r of cuts) {
    if (r.start - cursor > 0.05) { n++; if (firstStart === null) firstStart = cursor; }
    cursor = Math.max(cursor, r.end);
  }
  if (dur - cursor > 0.05) { n++; if (firstStart === null) firstStart = cursor; }
  return { n, firstStart: firstStart === null ? 0 : firstStart };
}
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
  const kp = keptParts(cutRanges, dur);
  const converted = saved > 0 || kp.n >= 2 || kp.firstStart > 0.05;
  const estBytes = converted
    ? Math.min(currentFile.size / dur, X_CONVERT_BYTES_PER_SEC) * outDur
    : currentFile.size * (outDur / dur);
  const overDur = outDur > X_MAX_SECONDS;
  const overSize = estBytes > X_MAX_BYTES;
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
  const mb = (b) => (b / 1024 / 1024).toFixed(0);
  let tail;
  if (overDur && overSize) tail = '⚠ 長さ・サイズ超過';
  else if (overDur) tail = '⚠ 2:20 超過（もっとカットを）';
  else if (overSize) tail = '⚠ 512MB 超過';
  else tail = '✓ Xに投稿OK';
  xLimitBadge.hidden = false;
  xLimitBadge.classList.toggle('over', overDur || overSize);
  xLimitBadge.textContent = `X(無料)目安 — 長さ ${mmss(outDur)} / 2:20 ・ サイズ 約${mb(estBytes)}MB / 512MB　${tail}`;
}

// --- Clip tray + combine ("highlights") ---
// Post-edit output length of one clip (full minus cuts minus what speed-ups save).
function clipOutputDuration(clip) {
  const dur = clip.duration || 0;
  let cut = 0, saved = 0;
  for (const r of (clip.ranges || [])) {
    const span = Math.max(0, r.end - r.start);
    if (r.type === 'speedup') saved += span - span / (r.speed || 2);
    else cut += span;
  }
  return Math.max(0, dur - cut - saved);
}

function renderClipTray() {
  if (!clipTrayCard || !clipTrayList) return;
  if (clips.length === 0) { clipTrayCard.hidden = true; clipTrayList.innerHTML = ''; return; }
  clipTrayCard.hidden = false;
  clipTrayList.innerHTML = '';
  clips.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'clip-chip' + (c.id === activeClipId ? ' active' : '');
    li.dataset.id = c.id;

    const num = document.createElement('span');
    num.className = 'clip-num';
    num.textContent = i + 1;
    li.appendChild(num);

    const meta = document.createElement('div');
    meta.className = 'clip-meta';
    const name = document.createElement('span');
    name.className = 'clip-name';
    name.textContent = c.name;
    name.title = c.name;
    const sub = document.createElement('span');
    sub.className = 'clip-sub';
    sub.textContent = (c.id === activeClipId ? '編集中 · ' : '') + (c.duration ? fmtClock(clipOutputDuration(c)) : '…');
    meta.appendChild(name);
    meta.appendChild(sub);
    li.appendChild(meta);

    const ops = document.createElement('div');
    ops.className = 'clip-ops';
    const up = document.createElement('button');
    up.className = 'clip-op'; up.textContent = '↑'; up.title = '前へ移動'; up.disabled = i === 0;
    up.onclick = (e) => { e.stopPropagation(); moveClip(c.id, -1); };
    const down = document.createElement('button');
    down.className = 'clip-op'; down.textContent = '↓'; down.title = '後ろへ移動'; down.disabled = i === clips.length - 1;
    down.onclick = (e) => { e.stopPropagation(); moveClip(c.id, 1); };
    const del = document.createElement('button');
    del.className = 'clip-op clip-del'; del.textContent = '✕'; del.title = 'このクリップを外す';
    del.onclick = (e) => { e.stopPropagation(); removeClip(c.id); };
    ops.appendChild(up); ops.appendChild(down); ops.appendChild(del);
    li.appendChild(ops);

    li.onclick = () => { if (c.id !== activeClipId && !exporting) openClip(c.id); };
    clipTrayList.appendChild(li);
  });
}

function updateCombinedUI() {
  if (!combineBtn) return;
  const multi = clips.length >= 2;
  combineBtn.hidden = !multi;
  if (exportEachBtn) { exportEachBtn.hidden = !multi; exportEachBtn.disabled = exporting || !multi; }
  if (combineHint) combineHint.hidden = !multi;
  if (combineBadge) combineBadge.hidden = !multi;
  combineBtn.disabled = exporting || !multi;
  if (multi) updateCombinedBadge();
}

function updateCombinedBadge() {
  if (!combineBadge) return;
  let outDur = 0, estBytes = 0;
  for (const c of clips) {
    const od = clipOutputDuration(c);
    outDur += od;
    if (c.duration > 0) estBytes += (c.file.size || 0) * (od / c.duration);
  }
  const overDur = outDur > X_MAX_SECONDS;
  const overSize = estBytes > X_MAX_BYTES;
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
  const mb = (b) => (b / 1024 / 1024).toFixed(0);
  let tail;
  if (overDur && overSize) tail = '⚠ 長さ・サイズ超過';
  else if (overDur) tail = '⚠ 2:20 超過（もっとカットを）';
  else if (overSize) tail = '⚠ 512MB 超過';
  else tail = '✓ Xに投稿OK';
  combineBadge.classList.toggle('over', overDur || overSize);
  combineBadge.textContent = `つなげた長さ ${mmss(outDur)} / 2:20 ・ サイズ 約${mb(estBytes)}MB / 512MB　${tail}`;
}

async function doCombinedExport() {
  if (clips.length < 2 || exporting || silenceBusy()) return;
  exporting = true; // claim immediately so the metadata-probe await below can't be re-entered
  const ac = activeClip();
  if (ac) ac.ranges = getRanges(); // commit the active clip's in-progress edits

  // Guard the race where combine is clicked before a just-added clip's metadata
  // probe resolved: a clip with duration 0 would plan to zero segments and get
  // silently dropped. Make sure every clip has a real duration first.
  const needMeta = clips.filter((c) => !(c.duration > 0));
  if (needMeta.length) {
    setStatus('クリップ情報を確認中...');
    await Promise.all(needMeta.map(probeClipMeta));
  }
  // If any clip's length still can't be read, it would plan to zero segments and be
  // silently dropped from the combine — fail loudly with the offending names instead.
  const unmeasurable = clips.filter((c) => !(c.duration > 0));
  if (unmeasurable.length) {
    const reason = '次のクリップの長さを取得できませんでした（壊れている可能性）: ' + unmeasurable.map((c) => c.name).join('、');
    setStatus(reason);
    hideExportDone(); // drop the previous result (and its file in memory) first, like the other failure paths
    showExportError(new Error(reason), { prefix: '結合', button: 'combine', from: 'multi' }); // same card as other 結合 failures
    exporting = false; updateCombinedUI(); // release the claim taken above
    return;
  }

  exportBtn.disabled = true;
  xExportBtn.disabled = true;
  combineBtn.disabled = true;
  refreshSilenceBtn(); // 無音検出 shares the progress bar — off during an export
  hideExportDone(); // clear any previous result panel (and revoke its URL)
  const originalHTML = combineBtn.innerHTML;
  combineBtn.textContent = '処理中...';
  showProgress(true);
  showCancelBtn(true);
  try {
    const blob = await exportConcat(
      clips.map((c) => ({ file: c.file, ranges: c.ranges, duration: c.duration, hasAudio: c.hasAudio })),
      { onStatus: (m) => setStatus(m), onProgress: (p, info) => setProgress(p, info), aspect: aspectSelect.value }
    );
    setProgress(1);
    const url = URL.createObjectURL(blob);
    const filename = `ハイライト_${clips.length}本_for_X_${stamp()}.mp4`;
    triggerDownload(url, filename);
    showExportDone({ blob, url, filename,
      hint: 'つなげたハイライトをXにアップロードできます。ダウンロードフォルダを確認してください。見当たらないときは下のボタンでやり直せます。' });
    setStatus('結合して書き出し完了！');
    notifyExportDone('ハイライトの結合・書き出しが完了しました');
    hideProgressLater(1500, true);
  } catch (err) {
    console.error('[combine] error:', err);
    showProgress(false);
    showCancelBtn(false);
    setStatus('');
    if (err && err.message && err.message.includes('__CANCELLED__')) {
      setStatus('書き出しをキャンセルしました');
      showExportNotice('書き出しをキャンセルしました', 'info', 'multi');
    } else {
      const info = showExportError(err, { prefix: '結合', button: 'combine', from: 'multi' });
      if (info && info.oom) cancelExport(); // drop a possibly-broken engine (see doExport)
      setStatus('');
    }
  } finally {
    exporting = false;
    refreshSilenceBtn();
    exportBtn.disabled = cutRanges.length === 0;
    xExportBtn.disabled = !currentFile;
    combineBtn.innerHTML = originalHTML;
    updateCombinedUI();
  }
}

// --- "1本ずつ書き出し（X用）" — batch each clip to its OWN X-ready MP4 (⑥) ---
// Unlike combine (all clips → one video), this exports N separate files. Sequential
// (one ffmpeg at a time); the shared bar + status show the current clip's real
// per-clip progress/ETA, the count ("N/M本目") shows overall position. Each result
// downloads as it finishes. A per-clip failure is recorded and the batch continues;
// a cancel stops the run. URLs are kept alive (revoked on the next batch / reset) so
// a missed download isn't lost to a premature revoke.
let batchUrls = [];
function clearBatchUrls() { for (const u of batchUrls) { try { URL.revokeObjectURL(u); } catch (_) {} } batchUrls = []; }

async function doExportEach() {
  if (clips.length < 2 || exporting || silenceBusy()) return;
  exporting = true; // claim BEFORE the metadata-probe await so it can't be re-entered
  exportBtn.disabled = true; xExportBtn.disabled = true; combineBtn.disabled = true;
  refreshSilenceBtn(); // 無音検出 shares the progress bar — off during an export
  if (exportEachBtn) exportEachBtn.disabled = true;
  const originalHTML = exportEachBtn ? exportEachBtn.innerHTML : '';
  try {
    const ac = activeClip();
    if (ac) ac.ranges = getRanges(); // commit the active clip's in-progress edits
    const needMeta = clips.filter((c) => !(c.duration > 0));
    if (needMeta.length) { setStatus('クリップ情報を確認中...'); await Promise.all(needMeta.map(probeClipMeta)); }

    hideExportDone();
    clearBatchUrls();
    if (exportEachBtn) exportEachBtn.textContent = '処理中...';
    showProgress(true); showCancelBtn(true);
    const M = clips.length;
    let okCount = 0; const failed = []; let cancelled = false; let anyOom = false;
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      setStatus(`${i + 1}/${M}本目を書き出し中…`);
      try {
        const blob = await exportVideo(clip.file, clip.ranges || [], clip.duration, {
          xOptimize: true,
          hasAudio: clip.hasAudio !== false,
          aspect: aspectSelect.value,
          onStatus: (m) => setStatus(`${i + 1}/${M}本目: ${m}`),
          onProgress: (p, info) => setProgress(p, info),
        });
        const url = URL.createObjectURL(blob); batchUrls.push(url);
        const base = (clip.name || `clip${i + 1}`).replace(/\.[^.]+$/, '');
        triggerDownload(url, `${base}_for_X_${stamp()}_${i + 1}.mp4`);
        okCount++;
      } catch (err) {
        if (err && err.message && err.message.includes('__CANCELLED__')) { cancelled = true; break; }
        console.error(`[exportEach] clip ${i + 1} failed:`, err);
        failed.push(clip.name || `${i + 1}本目`);
        // A too-big clip can leave the ffmpeg.wasm engine broken — drop it so the
        // remaining clips get a fresh one (see doExport).
        if (isOutOfMemory(err)) { anyOom = true; cancelExport(); }
      }
    }
    setProgress(1);
    // Show the result in the top strip too (where the progress bar was), not only
    // in the bottom status line.
    let summary, kind;
    if (cancelled) {
      summary = `書き出しをキャンセルしました（${okCount}/${M}本まで完了）`; kind = 'info';
    } else if (failed.length) {
      summary = `${okCount}/${M}本を書き出しました。失敗: ${failed.join('、')}` +
        (anyOom ? '（長すぎる・大きすぎる動画は、カットして短くしてからもう一度お試しください）' : '');
      kind = 'warn';
    } else {
      summary = `${M}本すべてX用に書き出しました！ダウンロードを確認してください。`; kind = 'success';
      notifyExportDone(`${M}本の書き出しが完了しました`);
    }
    setStatus(summary);
    showExportNotice(summary, kind, 'multi');
    hideProgressLater(1500, !cancelled); // show the result once the bar hides — but no jump after a キャンセル
  } finally {
    exporting = false;
    refreshSilenceBtn();
    exportBtn.disabled = cutRanges.length === 0;
    xExportBtn.disabled = !currentFile;
    if (exportEachBtn) exportEachBtn.innerHTML = originalHTML;
    updateCombinedUI();
  }
}

if (addClipBtn) addClipBtn.addEventListener('click', () => fileInput.click());
if (clearClipsBtn) clearClipsBtn.addEventListener('click', () => {
  if (clips.length === 0 || exporting) return;
  if (confirm('読み込んだクリップを全部外しますか？（カット内容は消えます）')) clearAllClips();
});
if (combineBtn) combineBtn.addEventListener('click', doCombinedExport);
if (exportEachBtn) exportEachBtn.addEventListener('click', doExportEach);

// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  const tgt = e.target;

  // Esc closes any open modal FIRST — before the input-focus guard and the
  // !currentFile guard below. Otherwise a first-timer who opened 設定/ヘルプ on the
  // empty screen, or who just toggled a checkbox inside 設定 (focus on the input),
  // couldn't close it with Esc and had to find ✕/背景.
  if (e.key === 'Escape') {
    let closed = false;
    if (!helpModal.hidden) { helpModal.hidden = true; closed = true; }
    if (!settingsModal.hidden) { settingsModal.hidden = true; closed = true; }
    if (!legalModal.hidden) { legalModal.hidden = true; closed = true; }
    if (closed) { if (tgt && typeof tgt.blur === 'function') tgt.blur(); return; }
  }

  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable)) return;
  if (!currentFile) return;

  const ctrl = e.ctrlKey || e.metaKey;

  if (e.code === 'Space') {
    e.preventDefault();
    playPause();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    skip(e.shiftKey ? -5 : (ctrl ? -0.1 : -1));
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    skip(e.shiftKey ? 5 : (ctrl ? 0.1 : 1));
  } else if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo(); updateUndoRedo();
  } else if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault();
    redo(); updateUndoRedo();
  } else if (ctrl && e.key === 'Enter') {
    e.preventDefault();
    if (!exporting) doExport({ xOptimize: true }); // Ctrl+Enter = X用に書き出し（主役のアクション）
  } else if (e.key.toLowerCase() === 'i' && !ctrl) {
    e.preventDefault();
    markIn();
  } else if (e.key.toLowerCase() === 'o' && !ctrl) {
    e.preventDefault();
    markOut();
  } else if (e.key === 'Escape') {
    if (markInTime !== null) {
      markInTime = null; hideMarkIn();
      setStatus('マークをクリアしました');
    }
    if (!helpModal.hidden) helpModal.hidden = true;
    if (!settingsModal.hidden) settingsModal.hidden = true;
    if (!legalModal.hidden) legalModal.hidden = true;
  } else if (e.key.toLowerCase() === 'p' && !ctrl) {
    e.preventDefault();
    togglePreview();
  } else if (e.key === ',' && !ctrl) {
    e.preventDefault();
    frameStep(-1);
  } else if (e.key === '.' && !ctrl) {
    e.preventDefault();
    frameStep(1);
  } else if (e.key === '[' && !ctrl) {
    e.preventDefault();
    jumpToPrevSegment();
  } else if (e.key === ']' && !ctrl) {
    e.preventDefault();
    playCurrentSegmentFromStart();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (tgt && tgt.tagName === 'BUTTON') return;
    e.preventDefault();
    const t = video.currentTime;
    const rs = getRanges();
    for (let i = 0; i < rs.length; i++) {
      if (t >= rs[i].start && t <= rs[i].end) {
        removeRangeAt(i);
        setStatus('再生位置の範囲を取り消しました');
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
legalBtn.addEventListener('click', () => { legalModal.hidden = false; });
legalModal.addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) legalModal.hidden = true; });

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
if (notifyOnDoneChk) notifyOnDoneChk.addEventListener('change', async () => {
  if (notifyOnDoneChk.checked) {
    if (!('Notification' in window)) {
      setStatus('このブラウザはデスクトップ通知に対応していません（タブのタイトルでのお知らせは引き続き有効です）。');
      notifyOnDoneChk.checked = false;
      settings = saveSettings({ notifyOnDone: false });
      return;
    }
    let perm = Notification.permission;
    if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch (_) {} }
    if (perm !== 'granted') {
      notifyOnDoneChk.checked = false;
      settings = saveSettings({ notifyOnDone: false });
      setStatus('デスクトップ通知がブラウザで許可されませんでした（タブのタイトルでのお知らせは引き続き有効です）。');
      return;
    }
  }
  settings = saveSettings({ notifyOnDone: notifyOnDoneChk.checked });
});
formatSelect.addEventListener('change', () => {
  settings = saveSettings({ defaultFormat: formatSelect.value });
});
heightSelect.addEventListener('change', () => {
  settings = saveSettings({ defaultHeight: heightSelect.value });
});
aspectSelect.addEventListener('change', () => {
  settings = saveSettings({ defaultAspect: aspectSelect.value });
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
renderClipTray();
updateCombinedUI();
