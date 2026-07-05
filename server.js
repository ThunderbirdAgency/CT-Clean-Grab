/**
 * CleanGrab — a Downie-style video downloader server.
 *
 * Wraps the yt-dlp engine behind a small JSON API and serves the web UI.
 * No npm dependencies — plain Node built-ins only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PORT = process.env.PORT || 3111;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');

fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

/* ---------------------------------------------------------------- tooling */

function resolveYtDlp() {
  const candidates = [
    process.env.YTDLP_PATH,
    path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
    'yt-dlp',
  ].filter(Boolean);
  for (const cand of candidates) {
    const probe = spawnSync(cand, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return cand;
  }
  return null;
}

function resolveFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(ROOT, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    'ffmpeg',
  ].filter(Boolean);
  for (const cand of candidates) {
    if (spawnSync(cand, ['-version'], { encoding: 'utf8' }).status === 0) return cand;
  }
  return null;
}

const YTDLP = resolveYtDlp();
const FFMPEG_PATH = resolveFfmpeg();
const FFMPEG = Boolean(FFMPEG_PATH);

/* ---------------------------------------------------------------- settings */

const CONFIG_FILE = path.join(ROOT, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

let config = loadConfig();

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return process.env.HOME || p;
  if (p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(2));
  return p;
}

/** Copy a finished file into the user's save folder (Dropbox, iCloud, etc.). */
function copyToSaveDir(job) {
  const dir = expandHome(config.saveDir);
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, job.filename);
    const { name, ext } = path.parse(job.filename);
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${name} (${n})${ext}`);
    fs.copyFileSync(path.join(job.dir, job.filename), dest);
    job.savedTo = dest;
  } catch (e) {
    job.saveError = `Could not copy to save folder: ${e.message}`;
  }
}

if (!YTDLP) {
  console.error(
    '\n  yt-dlp was not found. Install it first:\n' +
    '    npm run setup          (downloads the standalone binary into ./bin)\n' +
    '  or pip install yt-dlp\n' +
    '  or set YTDLP_PATH to an existing binary.\n'
  );
  process.exit(1);
}

/* ------------------------------------------------------------------- jobs */

const jobs = new Map(); // id -> job

function newJobId() {
  return crypto.randomBytes(8).toString('hex');
}

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    quality: job.quality,
    status: job.status,       // queued | downloading | processing | done | error
    progress: job.progress,   // 0..100
    speed: job.speed,
    eta: job.eta,
    title: job.title,
    thumbnail: job.thumbnail,
    filename: job.filename,
    filesize: job.filesize,
    error: job.error,
    createdAt: job.createdAt,
    kind: job.kind || 'download',
    savedTo: job.savedTo || null,
    saveError: job.saveError || null,
  };
}

/* ----------------------------------------------------------- URL handling */

function validateUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.toString();
}

/**
 * Format selection. Every option asks yt-dlp for the platform's original
 * stream — never a re-encoded or watermarked variant. For TikTok this means
 * the clean "play" stream (no burned-in watermark) whenever the platform
 * exposes one, which yt-dlp prefers by default.
 */
function formatArgs(quality) {
  switch (quality) {
    case 'audio':
      return FFMPEG
        ? ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0']
        : ['-f', 'ba/b'];
    case '720':
      return FFMPEG
        ? ['-f', 'bv*[height<=720]+ba/b[height<=720]/b', '--merge-output-format', 'mp4']
        : ['-f', 'b[height<=720]/b'];
    case '1080':
      return FFMPEG
        ? ['-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4']
        : ['-f', 'b[height<=1080]/b'];
    case 'best':
    default:
      return FFMPEG
        ? ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4']
        : ['-f', 'b'];
  }
}

/* ---------------------------------------------------------------- yt-dlp */

function fetchInfo(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP, ['-J', '--no-playlist', '--no-warnings', '--', url]);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Timed out while fetching video info.'));
    }, 90_000);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(cleanYtdlpError(err)));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('Could not parse video info.'));
      }
    });
  });
}

function cleanYtdlpError(stderr) {
  const line = (stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ERROR:'))
    .pop();
  return line ? line.replace(/^ERROR:\s*(\[[^\]]*\]\s*)?/, '') : 'Download failed.';
}

function startDownload(url, quality, meta) {
  const id = newJobId();
  const dir = path.join(DOWNLOADS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const job = {
    id,
    url,
    quality,
    status: 'queued',
    progress: 0,
    speed: null,
    eta: null,
    title: meta?.title || null,
    thumbnail: meta?.thumbnail || null,
    filename: null,
    filesize: null,
    error: null,
    createdAt: Date.now(),
    dir,
  };
  jobs.set(id, job);

  const args = [
    ...formatArgs(quality),
    ...(FFMPEG && FFMPEG_PATH !== 'ffmpeg' ? ['--ffmpeg-location', FFMPEG_PATH] : []),
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress',
    '-o', path.join(dir, '%(title).180B.%(ext)s'),
    '--', url,
  ];

  const proc = spawn(YTDLP, args);
  job.status = 'downloading';
  let stderr = '';

  proc.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      const m = line.match(/\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\w+))?(?:\s+at\s+([\d.]+\w+\/s))?(?:\s+ETA\s+([\d:]+))?/);
      if (m) {
        job.progress = Math.min(99, parseFloat(m[1]));
        if (m[3]) job.speed = m[3];
        if (m[4]) job.eta = m[4];
      }
      if (/\[(Merger|ExtractAudio|VideoRemuxer)\]/.test(line)) {
        job.status = 'processing';
        job.progress = 99;
      }
    }
  });
  proc.stderr.on('data', (d) => (stderr += d));

  proc.on('error', (e) => {
    job.status = 'error';
    job.error = e.message;
  });

  proc.on('close', (code) => {
    if (code !== 0) {
      job.status = 'error';
      job.error = cleanYtdlpError(stderr);
      return;
    }
    // Find the finished file (ignore leftovers from intermediate steps).
    const files = fs
      .readdirSync(dir)
      .filter((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'))
      .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }))
      .sort((a, b) => b.size - a.size);
    if (!files.length) {
      job.status = 'error';
      job.error = 'Download finished but no file was produced.';
      return;
    }
    job.filename = files[0].name;
    job.filesize = files[0].size;
    job.progress = 100;
    job.status = 'done';
    copyToSaveDir(job);
  });

  return job;
}

/* -------------------------------------------------------- screen recordings */

function sanitizeName(name, fallback) {
  const clean = String(name || '')
    .replace(/[/\\:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return clean || fallback;
}

/**
 * Receives a browser screen recording (webm) as a raw upload, then converts
 * it to mp4 when ffmpeg is available so it plays everywhere.
 */
function receiveRecording(req, res, name) {
  const id = newJobId();
  const dir = path.join(DOWNLOADS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const title = sanitizeName(name, 'Screen Recording');
  const webmFile = path.join(dir, `${title}.webm`);

  const job = {
    id,
    url: null,
    quality: 'rec',
    kind: 'recording',
    status: 'downloading',
    progress: 0,
    speed: null,
    eta: null,
    title,
    thumbnail: null,
    filename: null,
    filesize: null,
    error: null,
    createdAt: Date.now(),
    dir,
  };
  jobs.set(id, job);

  const out = fs.createWriteStream(webmFile);
  req.pipe(out);

  req.on('error', () => {
    job.status = 'error';
    job.error = 'Upload interrupted.';
    try { sendJson(res, 500, publicJob(job)); } catch {}
  });

  out.on('finish', () => {
    // Upload is complete — hand the job to the UI, then convert in the background.
    sendJson(res, 200, publicJob(job));
    const finish = (file) => {
      job.filename = path.basename(file);
      job.filesize = fs.statSync(file).size;
      job.progress = 100;
      job.status = 'done';
      copyToSaveDir(job);
    };

    if (!FFMPEG) return finish(webmFile);

    // Convert to mp4 for universal playback (QuickTime, iOS, editors…).
    job.status = 'processing';
    job.progress = 99;
    const mp4File = path.join(dir, `${title}.mp4`);
    const conv = spawn(FFMPEG_PATH, [
      '-y', '-i', webmFile,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      mp4File,
    ]);
    conv.on('error', () => finish(webmFile));
    conv.on('close', (code) => {
      if (code === 0 && fs.existsSync(mp4File) && fs.statSync(mp4File).size > 0) {
        fs.unlinkSync(webmFile);
        finish(mp4File);
      } else {
        finish(webmFile); // keep the original if conversion failed
      }
    });
  });
}

/* -------------------------------------------------------------- HTTP layer */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  try {
    // ---- API -------------------------------------------------------------
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        ytdlp: YTDLP,
        ffmpeg: FFMPEG,
        saveDir: config.saveDir || null,
      });
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      return sendJson(res, 200, { saveDir: config.saveDir || null });
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      const raw = String(body.saveDir || '').trim();
      if (!raw) {
        delete config.saveDir;
        saveConfig();
        return sendJson(res, 200, { saveDir: null });
      }
      const dir = expandHome(raw);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
      } catch (e) {
        return sendJson(res, 422, { error: `Can't use that folder: ${e.message}` });
      }
      config.saveDir = raw;
      saveConfig();
      return sendJson(res, 200, { saveDir: raw });
    }

    if (pathname === '/api/recordings' && req.method === 'POST') {
      const name = new URL(req.url, `http://${req.headers.host}`).searchParams.get('name');
      return receiveRecording(req, res, name);
    }

    if (pathname === '/api/info' && req.method === 'POST') {
      const body = await readBody(req);
      const url = validateUrl(body.url);
      if (!url) return sendJson(res, 400, { error: 'Please paste a valid video link.' });

      try {
        const info = await fetchInfo(url);
        const heights = [...new Set(
          (info.formats || [])
            .map((f) => f.height)
            .filter((h) => typeof h === 'number' && h > 0)
        )].sort((a, b) => b - a);
        return sendJson(res, 200, {
          title: info.title || 'Untitled video',
          uploader: info.uploader || info.channel || info.uploader_id || null,
          thumbnail: info.thumbnail || null,
          duration: info.duration || null,
          extractor: info.extractor_key || null,
          webpage_url: info.webpage_url || url,
          maxHeight: heights[0] || null,
          heights: heights.slice(0, 6),
        });
      } catch (e) {
        return sendJson(res, 422, { error: e.message });
      }
    }

    if (pathname === '/api/download' && req.method === 'POST') {
      const body = await readBody(req);
      const url = validateUrl(body.url);
      if (!url) return sendJson(res, 400, { error: 'Please paste a valid video link.' });
      const quality = ['best', '1080', '720', 'audio'].includes(body.quality) ? body.quality : 'best';
      const job = startDownload(url, quality, body.meta || null);
      return sendJson(res, 200, publicJob(job));
    }

    if (pathname === '/api/jobs' && req.method === 'GET') {
      const list = [...jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(publicJob);
      return sendJson(res, 200, list);
    }

    let m = pathname.match(/^\/api\/jobs\/([a-f0-9]{16})$/);
    if (m && req.method === 'GET') {
      const job = jobs.get(m[1]);
      if (!job) return sendJson(res, 404, { error: 'Job not found' });
      return sendJson(res, 200, publicJob(job));
    }

    m = pathname.match(/^\/api\/jobs\/([a-f0-9]{16})\/file$/);
    if (m && req.method === 'GET') {
      const job = jobs.get(m[1]);
      if (!job || job.status !== 'done' || !job.filename) {
        res.writeHead(404);
        return res.end('File not ready');
      }
      const file = path.join(job.dir, job.filename);
      const stat = fs.statSync(file);
      const asciiName = job.filename.replace(/[^\x20-\x7E]+/g, '_').replace(/"/g, "'");
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition':
          `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
      });
      return fs.createReadStream(file).pipe(res);
    }

    m = pathname.match(/^\/api\/jobs\/([a-f0-9]{16})$/);
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Not found' });
    }

    // ---- static UI ---------------------------------------------------------
    if (req.method === 'GET') return serveStatic(req, res, pathname);

    res.writeHead(405);
    res.end('Method not allowed');
  } catch (e) {
    sendJson(res, 500, { error: e.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  CleanGrab is running');
  console.log(`  →  http://localhost:${PORT}`);
  console.log(`  engine: ${YTDLP}   ffmpeg: ${FFMPEG ? 'yes (merging + mp3 enabled)' : 'no (single-file formats only)'}`);
  console.log('');
});
