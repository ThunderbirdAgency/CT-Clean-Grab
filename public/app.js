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
  })
  .catch(() => {
    const badge = $('engineBadge');
    badge.textContent = 'engine offline';
    badge.classList.add('bad');
  });

/* ------------------------------------------------------------ fetch info */

async function fetchInfo() {
  const url = urlInput.value.trim();
  if (!looksLikeUrl(url)) {
    showError('That doesn’t look like a link. Paste the full video URL (starting with https://).');
    return;
  }
  showError(null);
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

function renderPreview(info, url) {
  $('pvTitle').textContent = info.title;
  $('pvUploader').textContent = info.uploader ? `by ${info.uploader}` : '';

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
      ${job.thumbnail ? `<img src="${escapeAttr(job.thumbnail)}" alt="">` : '<div class="noimg">▶</div>'}
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

  const qualityLabel = { best: 'Best', 1080: '1080p', 720: '720p', audio: 'Audio' }[job.quality] || '';

  if (job.status === 'downloading' || job.status === 'queued') {
    barFill.style.width = `${job.progress || 0}%`;
    const bits = [qualityLabel, job.speed, job.eta ? `ETA ${job.eta}` : null].filter(Boolean);
    meta.textContent = bits.join(' · ') || 'Starting…';
    meta.classList.remove('err');
    state.textContent = `${Math.floor(job.progress || 0)}%`;
  } else if (job.status === 'processing') {
    barFill.style.width = '99%';
    meta.textContent = `${qualityLabel} · finishing up…`;
    state.textContent = '⚙';
  } else if (job.status === 'done') {
    bar.classList.add('done');
    barFill.style.width = '100%';
    meta.textContent = [qualityLabel, fmtSize(job.filesize), job.filename].filter(Boolean).join(' · ');
    state.remove?.();
    if (!el.querySelector('.qsave')) {
      const a = document.createElement('a');
      a.className = 'qsave';
      a.href = `/api/jobs/${job.id}/file`;
      a.textContent = 'Save';
      el.appendChild(a);
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
