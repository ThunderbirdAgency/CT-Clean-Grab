/* CleanGrab front-end */

const $ = (id) => document.getElementById(id);

const urlInput = $('urlInput');
const fetchBtn = $('fetchBtn');
const inputError = $('inputError');
const dropzone = $('dropzone');
const preview = $('preview');
const queueSection = $('queueSection');
const queueEl = $('queue');

let currentMeta = null;   // metadata for the previewed video
let currentUrl = null;
let selectedQuality = 'best';
const pollTimers = new Map();

/* ------------------------------------------------------------ helpers */

function platformFor(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(h)) return 'YouTube';
    if (/(^|\.)instagram\.com$/.test(h)) return 'Instagram';
    if (/(^|\.)tiktok\.com$/.test(h)) return 'TikTok';
    return h;
  } catch { return null; }
}

function fmtDuration(sec) {
  if (!sec && sec !== 0) return null;
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function showError(msg) {
  inputError.textContent = msg;
  inputError.hidden = !msg;
}

function looksLikeUrl(text) {
  return /^https?:\/\/\S+$/i.test((text || '').trim());
}

function fmtCount(n) {
  if (n == null) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function renderStats(el, stats) {
  el.innerHTML = '';
  if (!stats) { el.hidden = true; return; }
  const items = [
    ['views', stats.views], ['likes', stats.likes],
    ['comments', stats.comments], ['shares', stats.reposts],
    ['followers', stats.followers],
  ].filter(([, v]) => v != null);
  if (stats.views && stats.likes) {
    items.push(['like rate', ((stats.likes / stats.views) * 100).toFixed(1) + '%']);
  }
  if (!items.length) { el.hidden = true; return; }
  for (const [label, value] of items) {
    const chip = document.createElement('div');
    chip.className = 'stat';
    const span = document.createElement('span');
    span.textContent = label;
    chip.appendChild(span);
    chip.append(typeof value === 'number' ? fmtCount(value) : value);
    el.appendChild(chip);
  }
  el.hidden = false;
}

/** A profile/channel link rather than a single video? Then list top clips. */
function looksLikeProfile(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '');
    const p = u.pathname.replace(/\/+$/, '');
    if (/tiktok\.com$/.test(h)) return /^\/@[^/]+$/.test(p);
    if (/instagram\.com$/.test(h)) return /^\/[^/]+$/.test(p) && !/^\/(reel|reels|p|tv|stories|explore)/.test(p);
    if (/youtube\.com$/.test(h)) return /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(\/(videos|shorts))?$/.test(p);
    return false;
  } catch { return false; }
}

/* tiny markdown renderer — headers, bold, lists, paragraphs; all text-escaped */
function renderMarkdown(target, md) {
  target.innerHTML = '';
  let list = null;
  const closeList = () => { list = null; };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const inline = (parent, text) => {
      // **bold** and `code`, everything else as plain text nodes
      const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
      for (const part of parts) {
        if (/^\*\*[^*]+\*\*$/.test(part)) {
          const b = document.createElement('strong');
          b.textContent = part.slice(2, -2);
          parent.appendChild(b);
        } else if (/^`[^`]+`$/.test(part)) {
          const c = document.createElement('code');
          c.textContent = part.slice(1, -1);
          parent.appendChild(c);
        } else if (part) {
          parent.appendChild(document.createTextNode(part));
        }
      }
    };
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) {
      closeList();
      const h = document.createElement('h' + m[1].length);
      inline(h, m[2]);
      target.appendChild(h);
    } else if ((m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/))) {
      const ordered = /^\s*\d+\./.test(line);
      if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) {
        list = document.createElement(ordered ? 'ol' : 'ul');
        target.appendChild(list);
      }
      const li = document.createElement('li');
      inline(li, m[1]);
      list.appendChild(li);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      const p = document.createElement('p');
      inline(p, line);
      target.appendChild(p);
    }
  }
}

/* ------------------------------------------------------------ engine badge */

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    const badge = $('engineBadge');
    badge.textContent = h.ffmpeg ? 'engine ready · mp3 + HD merge' : 'engine ready';
    badge.classList.add('ok');
    if (!h.ffmpeg) {
      // Without ffmpeg we can't extract mp3 or merge separate video+audio streams.
      document.querySelector('[data-q="audio"]').title =
        'Downloads best audio stream (install ffmpeg for mp3 conversion)';
    }
    if (h.saveDir) $('saveDirInput').value = h.saveDir;
    if (h.cookiesBrowser) $('cookiesSelect').value = h.cookiesBrowser;
    $('autoAnalyzeChk').checked = Boolean(h.autoAnalyze);
    if (h.deno === false) {
      badge.textContent += ' · no JS runtime (YouTube limited — run: npm run setup)';
    }
  })
  .catch(() => {
    const badge = $('engineBadge');
    badge.textContent = 'engine offline';
    badge.classList.add('bad');
  });

/* ------------------------------------------------------------ settings */

$('settingsBtn').addEventListener('click', () => {
  const panel = $('settingsPanel');
  panel.hidden = !panel.hidden;
});

$('saveDirBtn').addEventListener('click', saveSettings);
$('saveDirInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); });

async function saveSettings() {
  const status = $('saveDirStatus');
  status.className = 'settings-status';
  status.textContent = 'Saving…';
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        saveDir: $('saveDirInput').value,
        cookiesBrowser: $('cookiesSelect').value,
        autoAnalyze: $('autoAnalyzeChk').checked,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not save settings.');
    status.classList.add('ok');
    const bits = [
      data.saveDir ? `files copied to ${data.saveDir}` : 'files stay in the app only',
      data.cookiesBrowser ? `cookies from ${data.cookiesBrowser}` : 'no browser cookies',
    ];
    status.textContent = `✓ Saved — ${bits.join(' · ')}`;
  } catch (e) {
    status.classList.add('err');
    status.textContent = e.message;
  }
}

/* ------------------------------------------------------------ screen recording */

let recorder = null;
let recChunks = [];
let recTimer = null;
let recStartedAt = 0;
let recMode = 'screen';          // 'screen' | 'audio'
let recStreams = [];             // every raw stream we opened, to stop tracks later
let audioCtx = null;
let meterRAF = null;

$('recordBtn').addEventListener('click', startScreenRecording);
$('stopRecBtn').addEventListener('click', () => recorder?.stop());

function beginRecorder(stream, mode, mimeCandidates) {
  const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recMode = mode;
  recChunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = finishRecording;
  recorder.start(1000);
  recStartedAt = Date.now();
  $('recLabel').textContent = mode === 'audio' ? 'Recording audio…' : 'Recording your screen…';
  $('recbar').hidden = false;
  $('recordBtn').disabled = true;
  $('audioBtn').disabled = true;
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStartedAt) / 1000);
    $('recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

async function startScreenRecording() {
  if (recorder) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showError('Screen recording needs a browser with screen-capture support (Chrome, Edge, Safari 16+, Firefox).');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true, // tab/system audio where the browser supports it
    });
  } catch {
    return; // user cancelled the picker
  }
  recStreams = [stream];

  // Stopping via the browser's own "Stop sharing" button also ends the recording.
  stream.getVideoTracks()[0].addEventListener('ended', () => recorder?.stop());

  beginRecorder(stream, 'screen',
    ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
}

async function finishRecording() {
  clearInterval(recTimer);
  cancelAnimationFrame(meterRAF);
  $('recbar').hidden = true;
  $('meter').hidden = true;
  $('recordBtn').disabled = false;
  $('audioBtn').disabled = false;
  recStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  recStreams = [];
  audioCtx?.close().catch(() => {});
  audioCtx = null;

  const isAudio = recMode === 'audio';
  const blob = new Blob(recChunks, { type: isAudio ? 'audio/webm' : 'video/webm' });
  recorder = null;
  recChunks = [];
  if (!blob.size) return;

  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `${isAudio ? 'Audio' : 'Screen'} Recording ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} at ${pad(stamp.getHours())}.${pad(stamp.getMinutes())}.${pad(stamp.getSeconds())}`;

  try {
    const r = await fetch(`/api/recordings?name=${encodeURIComponent(name)}${isAudio ? '&audio=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    });
    const job = await r.json();
    if (!r.ok) throw new Error(job.error || 'Could not save recording.');
    addOrUpdateQueueItem(job);
    watchJob(job.id);
  } catch (e) {
    showError(`Recording upload failed: ${e.message}`);
  }
}

/* ------------------------------------------------------------ audio recording */

$('audioBtn').addEventListener('click', async () => {
  const panel = $('audioPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) populateMics();
});
$('cancelAudioBtn').addEventListener('click', () => { $('audioPanel').hidden = true; });
$('startAudioBtn').addEventListener('click', startAudioRecording);

async function populateMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const sel = $('micSelect');
    const current = sel.value;
    sel.innerHTML = '<option value="">Default microphone</option>';
    mics.forEach((m, i) => {
      const opt = document.createElement('option');
      opt.value = m.deviceId;
      // Labels are blank until mic permission is granted once — that's fine.
      opt.textContent = m.label || `Input device ${i + 1}`;
      sel.appendChild(opt);
    });
    sel.value = current;
  } catch { /* device list is a nicety, not a requirement */ }
}

function showAudioError(msg) {
  const el = $('audioError');
  el.textContent = msg;
  el.hidden = !msg;
}

async function startAudioRecording() {
  if (recorder) return;
  showAudioError(null);
  const wantMic = $('srcMic').checked;
  const wantApp = $('srcApp').checked;
  if (!wantMic && !wantApp) {
    showAudioError('Pick at least one audio source.');
    return;
  }

  recStreams = [];
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const mixDest = audioCtx.createMediaStreamDestination();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;

  try {
    if (wantMic) {
      const deviceId = $('micSelect').value;
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      recStreams.push(mic);
      const src = audioCtx.createMediaStreamSource(mic);
      src.connect(mixDest);
      src.connect(analyser);
    }

    if (wantApp) {
      // The share picker needs a video surface; we drop the video track and
      // keep only the audio. Chrome: pick a tab (with "share tab audio") or,
      // on Windows, a screen with system audio.
      const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      recStreams.push(disp);
      if (!disp.getAudioTracks().length) {
        recStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
        recStreams = [];
        await audioCtx.close(); audioCtx = null;
        showAudioError('No audio was shared — tick "Also share tab audio" (or system audio) in the picker and try again.');
        return;
      }
      disp.getVideoTracks().forEach((t) => t.stop());
      const src = audioCtx.createMediaStreamSource(new MediaStream(disp.getAudioTracks()));
      src.connect(mixDest);
      src.connect(analyser);
      disp.getAudioTracks()[0].addEventListener('ended', () => recorder?.stop());
    }
  } catch (e) {
    recStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    recStreams = [];
    await audioCtx?.close().catch(() => {}); audioCtx = null;
    if (e.name === 'NotAllowedError') return; // user cancelled a permission prompt
    showAudioError(`Could not open audio source: ${e.message}`);
    return;
  }

  $('audioPanel').hidden = true;
  beginRecorder(mixDest.stream, 'audio',
    ['audio/webm;codecs=opus', 'audio/webm']);

  // Live level meter, Audio Hijack style.
  $('meter').hidden = false;
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    $('meterFill').style.width = `${Math.min(100, (peak / 128) * 130)}%`;
    meterRAF = requestAnimationFrame(tick);
  };
  tick();
}

/* ------------------------------------------------------------ fetch info */

async function fetchInfo() {
  const url = urlInput.value.trim();
  if (!looksLikeUrl(url)) {
    showError('That doesn’t look like a link. Paste the full video URL (starting with https://).');
    return;
  }
  showError(null);
  if (looksLikeProfile(url)) return fetchCollection(url);
  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Fetching…';
  preview.hidden = true;

  try {
    const r = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not read that link.');

    currentMeta = data;
    currentUrl = url;
    renderPreview(data, url);
  } catch (e) {
    showError(e.message);
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Fetch';
  }
}

/* ---------------------------------------------------- profile top clips */

async function fetchCollection(url) {
  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Listing…';
  try {
    const r = await fetch('/api/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not list that profile.');
    renderCollection(data);
  } catch (e) {
    showError(e.message);
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Fetch';
  }
}

function renderCollection(data) {
  $('colTitle').textContent = `Top clips — ${data.uploader || data.title} (by views)`;
  const list = $('collectionList');
  list.innerHTML = '';
  data.entries.forEach((entry, i) => {
    const row = document.createElement('label');
    row.className = 'colitem';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = i < 5; // top 5 pre-selected
    chk.dataset.url = entry.url;
    row.appendChild(chk);
    if (entry.thumbnail) {
      const img = document.createElement('img');
      img.src = entry.thumbnail;
      row.appendChild(img);
    }
    const title = document.createElement('span');
    title.className = 'coltitle';
    title.textContent = entry.title || entry.url;
    row.appendChild(title);
    const views = document.createElement('span');
    views.className = 'colviews';
    views.textContent = entry.views != null ? `${fmtCount(entry.views)} views` : '';
    row.appendChild(views);
    list.appendChild(row);
  });
  $('collectionSection').hidden = false;
  $('collectionSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('closeColBtn').addEventListener('click', () => { $('collectionSection').hidden = true; });
$('grabTopBtn').addEventListener('click', async () => {
  const selected = [...$('collectionList').querySelectorAll('input:checked')];
  if (!selected.length) return;
  $('grabTopBtn').disabled = true;
  for (const chk of selected) {
    try {
      const r = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: chk.dataset.url, quality: 'best' }),
      });
      const job = await r.json();
      if (r.ok) { addOrUpdateQueueItem(job); watchJob(job.id); }
    } catch { /* keep grabbing the rest */ }
  }
  $('grabTopBtn').disabled = false;
  $('collectionSection').hidden = true;
});

function renderPreview(info, url) {
  $('pvTitle').textContent = info.title;
  $('pvUploader').textContent = info.uploader ? `by ${info.uploader}` : '';
  renderStats($('pvStats'), info.stats);

  const thumb = $('pvThumb');
  thumb.src = info.thumbnail || '';
  thumb.style.display = info.thumbnail ? '' : 'none';

  const dur = $('pvDuration');
  const d = fmtDuration(info.duration);
  dur.textContent = d || '';
  dur.hidden = !d;

  const plat = $('pvPlatform');
  const p = platformFor(info.webpage_url || url);
  plat.textContent = p || '';
  plat.hidden = !p;

  // Disable quality tiers the source doesn't have.
  const max = info.maxHeight || 99999;
  document.querySelector('[data-q="1080"]').disabled = max < 1080;
  document.querySelector('[data-q="720"]').disabled = max < 720;
  $('qBestNote').textContent = info.maxHeight ? ` · ${info.maxHeight}p` : '';

  // Reset selection to Best.
  selectQuality('best');

  preview.hidden = false;
  preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function selectQuality(q) {
  selectedQuality = q;
  document.querySelectorAll('.qbtn').forEach((b) => {
    b.classList.toggle('active', b.dataset.q === q);
  });
}

/* ------------------------------------------------------------ download */

async function startDownload() {
  if (!currentUrl) return;
  const btn = $('downloadBtn');
  btn.disabled = true;

  try {
    const r = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: currentUrl,
        quality: selectedQuality,
        meta: currentMeta ? { title: currentMeta.title, thumbnail: currentMeta.thumbnail } : null,
      }),
    });
    const job = await r.json();
    if (!r.ok) throw new Error(job.error || 'Could not start download.');

    addOrUpdateQueueItem(job);
    watchJob(job.id);
    preview.hidden = true;
    urlInput.value = '';
    urlInput.focus();
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
  }
}

function watchJob(id) {
  if (pollTimers.has(id)) return;
  const timer = setInterval(async () => {
    try {
      const r = await fetch(`/api/jobs/${id}`);
      if (!r.ok) throw new Error();
      const job = await r.json();
      addOrUpdateQueueItem(job);
      if (job.status === 'done' || job.status === 'error') {
        clearInterval(timer);
        pollTimers.delete(id);
      }
    } catch {
      clearInterval(timer);
      pollTimers.delete(id);
    }
  }, 600);
  pollTimers.set(id, timer);
}

/* ------------------------------------------------------------ queue UI */

function addOrUpdateQueueItem(job) {
  queueSection.hidden = false;
  let el = document.getElementById(`job-${job.id}`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'qitem';
    el.id = `job-${job.id}`;
    el.innerHTML = `
      ${job.thumbnail ? `<img src="${escapeAttr(job.thumbnail)}" alt="">` : `<div class="noimg">${job.quality === 'audiorec' ? '🎙' : job.kind === 'recording' ? '⏺' : '▶'}</div>`}
      <div class="qmain">
        <div class="qtitle"></div>
        <div class="qmeta"></div>
        <div class="qbar"><div></div></div>
      </div>
      <span class="qstate"></span>
    `;
    queueEl.prepend(el);
  }

  el.querySelector('.qtitle').textContent = job.title || job.url;
  const meta = el.querySelector('.qmeta');
  const bar = el.querySelector('.qbar');
  const barFill = bar.firstElementChild;
  const state = el.querySelector('.qstate');

  const qualityLabel = { best: 'Best', 1080: '1080p', 720: '720p', audio: 'Audio', rec: 'Recording', audiorec: 'Audio recording' }[job.quality] || '';

  if (job.status === 'downloading' || job.status === 'queued') {
    barFill.style.width = `${job.progress || 0}%`;
    const bits = [qualityLabel, job.speed, job.eta ? `ETA ${job.eta}` : null].filter(Boolean);
    meta.textContent = bits.join(' · ') || 'Starting…';
    meta.classList.remove('err');
    state.textContent = `${Math.floor(job.progress || 0)}%`;
  } else if (job.status === 'processing') {
    barFill.style.width = '99%';
    meta.textContent = job.kind === 'recording'
      ? `Converting to ${job.quality === 'audiorec' ? 'mp3' : 'mp4'}…`
      : `${qualityLabel} · finishing up…`;
    state.textContent = '⚙';
  } else if (job.status === 'done') {
    bar.classList.add('done');
    barFill.style.width = '100%';
    const savedNote = job.savedTo ? `✓ copied to ${job.savedTo}` : (job.saveError || null);
    meta.innerHTML = '';
    meta.append([qualityLabel, fmtSize(job.filesize), job.filename].filter(Boolean).join(' · '));
    if (savedNote) {
      const span = document.createElement('span');
      span.className = job.savedTo ? 'qsaved' : '';
      span.textContent = ` · ${savedNote}`;
      meta.append(span);
    }
    state.remove?.();
    if (!el.querySelector('.qsave')) {
      const a = document.createElement('a');
      a.className = 'qsave';
      a.href = `/api/jobs/${job.id}/file`;
      a.textContent = 'Save';
      el.appendChild(a);
    }
    // Analyze button for anything with video content
    if (job.quality !== 'audio' && job.quality !== 'audiorec') {
      let btn = el.querySelector('.qanalyze');
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'qanalyze';
        btn.addEventListener('click', () => onAnalyzeClick(job.id, btn));
        el.insertBefore(btn, el.querySelector('.qsave'));
      }
      const a = job.analysis;
      if (!a) {
        btn.textContent = '🔍 Analyze';
        btn.disabled = false;
        btn.classList.remove('ready');
      } else if (a.status === 'running') {
        btn.textContent = `⏳ ${a.step || 'Analyzing'}…`;
        btn.disabled = true;
        btn.classList.remove('ready');
        pollAnalysis(job.id);
      } else if (a.status === 'done') {
        btn.textContent = a.hasReport ? '📊 View report' : '📦 View bundle';
        btn.disabled = false;
        btn.classList.add('ready');
      } else {
        btn.textContent = '🔍 Retry analysis';
        btn.disabled = false;
        btn.classList.remove('ready');
        if (a.error && !btn.title) btn.title = a.error;
      }
    }
  } else if (job.status === 'error') {
    barFill.style.width = '100%';
    barFill.style.background = 'var(--err)';
    meta.textContent = job.error || 'Download failed.';
    meta.classList.add('err');
    state.textContent = '✕';
  }
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------ analysis */

const analysisPolls = new Map();

async function onAnalyzeClick(id, btn) {
  const job = await fetch(`/api/jobs/${id}`).then((r) => r.json()).catch(() => null);
  if (job?.analysis?.status === 'done') return openReport(id);

  btn.disabled = true;
  btn.textContent = '⏳ Starting…';
  try {
    const r = await fetch(`/api/jobs/${id}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claude: true }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not start analysis.');
    addOrUpdateQueueItem(data);
    pollAnalysis(id);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '🔍 Analyze';
    showError(e.message);
  }
}

function pollAnalysis(id) {
  if (analysisPolls.has(id)) return;
  const timer = setInterval(async () => {
    try {
      const r = await fetch(`/api/jobs/${id}`);
      if (!r.ok) throw new Error();
      const job = await r.json();
      addOrUpdateQueueItem(job);
      if (!job.analysis || job.analysis.status !== 'running') {
        clearInterval(timer);
        analysisPolls.delete(id);
        if (job.analysis?.status === 'done') openReport(id);
        if (job.analysis?.status === 'error') showError(`Analysis failed: ${job.analysis.error}`);
      }
    } catch {
      clearInterval(timer);
      analysisPolls.delete(id);
    }
  }, 1500);
  analysisPolls.set(id, timer);
}

async function openReport(id) {
  const r = await fetch(`/api/jobs/${id}/analysis`);
  if (!r.ok) return;
  const a = await r.json();
  const section = $('reportSection');

  $('reportTitle').textContent = a.bundle?.title ? `Analysis — ${a.bundle.title}` : 'Analysis';
  const sheet = $('reportSheet');
  sheet.src = `/api/jobs/${id}/analysis/sheet?t=${Date.now()}`;
  const audio = $('reportAudio');
  audio.src = a.bundle?.hasAudio ? `/api/jobs/${id}/analysis/audio` : '';
  audio.style.display = a.bundle?.hasAudio ? '' : 'none';
  renderStats($('reportStats'), a.bundle?.stats);

  const body = $('reportBody');
  if (a.report) {
    renderMarkdown(body, a.report);
  } else {
    body.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'rpt-pending';
    p.textContent = a.error
      ? `Claude analysis unavailable (${a.error}). The bundle below is ready — copy this prompt into any Claude session along with the contact sheet:`
      : 'Bundle ready. Copy this prompt into any Claude session along with the contact sheet:';
    body.appendChild(p);
    if (a.prompt) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '📋 Copy analysis prompt';
      btn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(a.prompt);
        btn.textContent = '✓ Copied';
        setTimeout(() => (btn.textContent = '📋 Copy analysis prompt'), 1500);
      });
      body.appendChild(btn);
    }
  }

  section.hidden = false;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('closeReportBtn').addEventListener('click', () => { $('reportSection').hidden = true; });

/* ------------------------------------------------------------ events */

fetchBtn.addEventListener('click', fetchInfo);
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchInfo(); });

$('downloadBtn').addEventListener('click', startDownload);
$('cancelPreview').addEventListener('click', () => { preview.hidden = true; });

document.querySelectorAll('.qbtn').forEach((b) => {
  b.addEventListener('click', () => selectQuality(b.dataset.q));
});

// Paste anywhere on the page → auto-fill and fetch (the Downie move).
document.addEventListener('paste', (e) => {
  if (e.target === urlInput) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (looksLikeUrl(text)) {
    urlInput.value = text.trim();
    fetchInfo();
  }
});

// Drag & drop a link onto the window.
['dragenter', 'dragover'].forEach((ev) =>
  document.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragging'); })
);
['dragleave', 'drop'].forEach((ev) =>
  document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) dropzone.classList.remove('dragging'); })
);
document.addEventListener('drop', (e) => {
  const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text') || '';
  if (looksLikeUrl(text)) {
    urlInput.value = text.trim();
    fetchInfo();
  }
});

// Restore any jobs from this server session (e.g. after a page refresh).
fetch('/api/jobs')
  .then((r) => r.json())
  .then((list) => {
    list.reverse().forEach((job) => {
      addOrUpdateQueueItem(job);
      if (job.status === 'downloading' || job.status === 'queued' || job.status === 'processing') {
        watchJob(job.id);
      }
    });
  })
  .catch(() => {});
