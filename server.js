/**
 * Magpie — collect clips, then understand why they fly.
 *
 * Downloads clean original videos (yt-dlp engine), records screen/audio,
 * and builds Claude-ready analysis bundles: frames, contact sheet, audio
 * track, transcript, music-energy timeline, and engagement stats — then
 * optionally asks Claude why the clip performs and for a new script in
 * the same DNA.
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

// yt-dlp children get ./bin prepended to PATH so the bundled ffmpeg and
// deno (the JS runtime yt-dlp needs for YouTube) are found automatically.
const SPAWN_ENV = {
  ...process.env,
  PATH: `${path.join(ROOT, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
};

function hasDeno() {
  return spawnSync('deno', ['--version'], { encoding: 'utf8', env: SPAWN_ENV }).status === 0;
}

const YTDLP = resolveYtDlp();
const FFMPEG_PATH = resolveFfmpeg();
const FFMPEG = Boolean(FFMPEG_PATH);
const DENO = hasDeno();

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
    stats: job.stats || null,
    analysis: job.analysis
      ? {
          status: job.analysis.status,   // running | done | error
          step: job.analysis.step || null,
          error: job.analysis.error || null,
          hasReport: Boolean(job.analysis.report),
        }
      : null,
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

const COOKIE_BROWSERS = ['chrome', 'safari', 'firefox', 'edge', 'brave', 'vivaldi', 'opera', 'chromium'];

/**
 * Borrow login cookies from the user's browser. This is how Downie handles
 * YouTube's "Sign in to confirm you're not a bot" checks, age-restricted
 * videos, and private videos the user can see when logged in.
 */
function cookieArgs() {
  return COOKIE_BROWSERS.includes(config.cookiesBrowser)
    ? ['--cookies-from-browser', config.cookiesBrowser]
    : [];
}

function fetchInfo(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      YTDLP,
      ['-J', '--no-playlist', '--no-warnings', ...cookieArgs(), '--', url],
      { env: SPAWN_ENV }
    );
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

/** Pull the engagement signals out of a yt-dlp info dump. */
function extractStats(info) {
  const hashtags = [...new Set(
    String(info.description || '').match(/#[\p{L}\p{N}_]+/gu) || []
  )].slice(0, 20);
  return {
    views: info.view_count ?? null,
    likes: info.like_count ?? null,
    comments: info.comment_count ?? null,
    reposts: info.repost_count ?? info.share_count ?? null,
    followers: info.channel_follower_count ?? null,
    uploadDate: info.upload_date || null,   // YYYYMMDD
    description: (info.description || '').slice(0, 2000) || null,
    hashtags,
    platform: info.extractor_key || null,
  };
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
    ...cookieArgs(),
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress',
    // Analysis inputs: full metadata + captions when the platform has them.
    '--write-info-json',
    '--write-subs', '--write-auto-subs',
    '--sub-langs', 'en.*,en,-live_chat',
    ...(FFMPEG ? ['--convert-subs', 'srt'] : []),
    '-o', path.join(dir, '%(title).180B.%(ext)s'),
    '--', url,
  ];

  const proc = spawn(YTDLP, args, { env: SPAWN_ENV });
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
    // Find the finished media file (skip metadata/caption sidecars).
    const SIDECARS = ['.part', '.ytdl', '.json', '.srt', '.vtt', '.description'];
    const files = fs
      .readdirSync(dir)
      .filter((f) => !SIDECARS.some((ext) => f.endsWith(ext)))
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

    // Surface engagement stats from the info json the download wrote.
    try {
      const infoFile = fs.readdirSync(dir).find((f) => f.endsWith('.info.json'));
      if (infoFile) {
        const info = JSON.parse(fs.readFileSync(path.join(dir, infoFile), 'utf8'));
        job.stats = extractStats(info);
        if (!job.title) job.title = info.title || null;
        if (!job.thumbnail) job.thumbnail = info.thumbnail || null;
      }
    } catch { /* stats are a bonus, not a requirement */ }

    job.status = 'done';
    copyToSaveDir(job);

    if (config.autoAnalyze && FFMPEG) {
      startAnalysis(job, { claude: true }).catch(() => {});
    }
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
 * Receives a browser recording (webm) as a raw upload, then converts it
 * when ffmpeg is available: screen recordings become mp4, audio-only
 * recordings become mp3.
 */
function receiveRecording(req, res, name, audioOnly) {
  const id = newJobId();
  const dir = path.join(DOWNLOADS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const title = sanitizeName(name, audioOnly ? 'Audio Recording' : 'Screen Recording');
  const webmFile = path.join(dir, `${title}.webm`);

  const job = {
    id,
    url: null,
    quality: audioOnly ? 'audiorec' : 'rec',
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

    // Convert for universal playback: mp4 for screen, mp3 for audio-only.
    job.status = 'processing';
    job.progress = 99;
    const outFile = path.join(dir, `${title}.${audioOnly ? 'mp3' : 'mp4'}`);
    const convArgs = audioOnly
      ? ['-y', '-i', webmFile, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', outFile]
      : ['-y', '-i', webmFile,
         '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
         '-pix_fmt', 'yuv420p',
         '-c:a', 'aac', '-b:a', '192k',
         '-movflags', '+faststart',
         outFile];
    const conv = spawn(FFMPEG_PATH, convArgs);
    conv.on('error', () => finish(webmFile));
    conv.on('close', (code) => {
      if (code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
        fs.unlinkSync(webmFile);
        finish(outFile);
      } else {
        finish(webmFile); // keep the original if conversion failed
      }
    });
  });
}

/* ------------------------------------------------------------ analysis engine */

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve({ out, err }) : reject(new Error(err.split('\n').slice(-4).join('\n')))
    );
  });
}

function mediaDuration(file) {
  // Parse "Duration: 00:00:09.73" from ffmpeg's stderr banner.
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_PATH, ['-hide_banner', '-i', file]);
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null);
    });
    proc.on('error', () => resolve(null));
  });
}

function parseSrt(text) {
  // srt/vtt → [{t: seconds, text}] — enough structure for pacing analysis.
  const segments = [];
  const blocks = text.replace(/\r/g, '').split('\n\n');
  for (const block of blocks) {
    const m = block.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->/);
    if (!m) continue;
    const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    const text = block
      .split('\n')
      .filter((l) => !/^\d+$/.test(l) && !l.includes('-->') && !/^WEBVTT/.test(l))
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text && (!segments.length || segments[segments.length - 1].text !== text)) {
      segments.push({ t: Math.round(t * 10) / 10, text });
    }
  }
  return segments;
}

/**
 * Per-second RMS loudness — the "music energy" timeline. Shows drops,
 * builds, and beat-synced cuts without needing to hear the audio.
 */
async function loudnessTimeline(file) {
  try {
    const { out, err } = await ffmpeg([
      '-i', file, '-vn',
      '-af', 'asetnsamples=48000,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-',
      '-f', 'null', '-',
    ]);
    const values = [...(out + err).matchAll(/RMS_level=(-?[\d.]+|-inf)/g)]
      .map((m) => (m[1] === '-inf' ? -90 : Math.round(parseFloat(m[1]) * 10) / 10));
    return values.length ? values : null;
  } catch {
    return null; // no audio track
  }
}

/**
 * Builds the analysis bundle in <job.dir>/analysis/:
 * frames, contact sheet, hook frame, audio.mp3, transcript, energy
 * timeline, metadata — everything Claude needs to "watch" the clip.
 */
async function buildBundle(job) {
  const video = path.join(job.dir, job.filename);
  const outDir = path.join(job.dir, 'analysis');
  fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });

  const duration = (await mediaDuration(video)) || 10;
  const frameCount = duration <= 65 ? 12 : 16;
  const cols = frameCount === 12 ? 3 : 4;
  const rows = frameCount / cols;
  const fps = frameCount / duration;

  job.analysis.step = 'sampling frames';
  await ffmpeg(['-y', '-i', video,
    '-vf', `fps=${fps.toFixed(5)},scale=420:-2,tile=${cols}x${rows}:padding=4:color=black`,
    '-frames:v', '1', '-q:v', '3', path.join(outDir, 'contact-sheet.jpg')]);
  await ffmpeg(['-y', '-i', video,
    '-vf', `fps=${fps.toFixed(5)},scale=640:-2`,
    '-q:v', '3', path.join(outDir, 'frames', 'frame_%02d.jpg')]);
  await ffmpeg(['-y', '-ss', Math.min(0.5, duration / 4).toString(), '-i', video,
    '-frames:v', '1', '-q:v', '2', path.join(outDir, 'hook.jpg')]);

  job.analysis.step = 'extracting audio';
  let hasAudio = true;
  try {
    await ffmpeg(['-y', '-i', video, '-vn', '-c:a', 'libmp3lame', '-b:a', '160k',
      path.join(outDir, 'audio.mp3')]);
  } catch {
    hasAudio = false;
  }

  job.analysis.step = 'reading audio energy';
  const energy = hasAudio ? await loudnessTimeline(video) : null;

  // Transcript from captions the download saved (if the platform had them).
  let transcript = null;
  const subFile = fs.readdirSync(job.dir).find((f) => f.endsWith('.srt') || f.endsWith('.vtt'));
  if (subFile) {
    transcript = parseSrt(fs.readFileSync(path.join(job.dir, subFile), 'utf8'));
    if (!transcript.length) transcript = null;
  }

  const bundle = {
    title: job.title,
    url: job.url,
    duration: Math.round(duration * 10) / 10,
    stats: job.stats || null,
    frameCount,
    grid: `${cols}x${rows}, left-to-right then top-to-bottom, evenly spaced across ${Math.round(duration)}s`,
    energy,           // per-second RMS dB, higher = louder
    transcript,       // [{t, text}] or null
    hasAudio,
    generatedAt: Date.now(),
  };
  fs.writeFileSync(path.join(outDir, 'bundle.json'), JSON.stringify(bundle, null, 2));
  return bundle;
}

/* ------------------------------------------------------------ Claude analysis */

const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

const ANALYST_SYSTEM = `You are a short-form video strategist for a creative agency. You reverse-engineer why clips perform on Instagram Reels, TikTok, and YouTube Shorts, then turn those mechanics into new, original scripts.

You are given everything needed to "watch" a clip: a contact sheet of evenly spaced frames (read it left-to-right, top-to-bottom as the video's timeline), the hook frame, engagement stats, the transcript with timestamps, and a per-second audio-energy timeline (RMS dB — spikes are drops/hits, valleys are quiet beats; align it with the frames to see how sound and cuts work together).

Ground every claim in the evidence provided — cite the frame, timestamp, stat, or energy value that supports it. Where evidence is missing (e.g. no transcript), say so rather than inventing detail. Be direct and specific; no filler.`;

function analysisPrompt(bundle) {
  const lines = [];
  lines.push(`## Clip metadata\n${JSON.stringify({
    title: bundle.title,
    url: bundle.url,
    duration_seconds: bundle.duration,
    stats: bundle.stats,
  }, null, 2)}`);
  lines.push(`## Contact sheet\nThe first image is a ${bundle.grid} grid of frames. The second image is the hook frame (~0.5s in).`);
  if (bundle.transcript) {
    lines.push(`## Transcript (seconds → speech/captions)\n` +
      bundle.transcript.map((s) => `[${s.t}s] ${s.text}`).join('\n'));
  } else {
    lines.push(`## Transcript\nNone available — rely on visual text in the frames.`);
  }
  if (bundle.energy) {
    lines.push(`## Audio energy timeline (per-second RMS dB; higher = louder)\n` +
      bundle.energy.map((v, i) => `${i}s: ${v}`).join(', '));
  }
  lines.push(`## Your task
Write a markdown report with exactly these sections:

# Why this clip works
2-4 sentences, the TL;DR verdict tied to the numbers.

# The hook (0-3s)
What stops the scroll — visual, text, and audio, with evidence.

# Structure & pacing
Beat-by-beat breakdown using the frames + energy timeline. Note cut rhythm, payoff placement, loops.

# Audio & music
What the sound is doing and how it's synced to the visuals. Use the energy timeline.

# Platform signals
Read the stats: engagement ratios, what they suggest about shares/saves/completion.

# The replicable formula
The abstract recipe — 5-8 numbered mechanics that transfer to other topics.

# New script in the same DNA
A complete, original script for a new video in the same niche using the formula: shot-by-shot outline with timings, spoken/caption lines, on-screen text, and audio/music direction per beat. Then one alternate hook variant.`);
  return lines.join('\n\n');
}

async function askClaude(job, bundle) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();  // API key / auth token / ant profile from env

  const outDir = path.join(job.dir, 'analysis');
  const img = (name) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: fs.readFileSync(path.join(outDir, name)).toString('base64'),
    },
  });

  const stream = client.messages.stream({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: ANALYST_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        img('contact-sheet.jpg'),
        img('hook.jpg'),
        { type: 'text', text: analysisPrompt(bundle) },
      ],
    }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new Error('Claude declined to analyze this clip.');
  }
  const report = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (!report.trim()) throw new Error('Claude returned an empty report.');
  return report;
}

async function startAnalysis(job, opts = {}) {
  if (!FFMPEG) throw new Error('Analysis needs ffmpeg — run: npm run setup');
  if (job.status !== 'done' || !job.filename) throw new Error('Job has no finished file yet.');
  if (job.analysis?.status === 'running') return;

  job.analysis = { status: 'running', step: 'preparing', error: null, bundle: null, report: null };
  try {
    const bundlePath = path.join(job.dir, 'analysis', 'bundle.json');
    job.analysis.bundle = fs.existsSync(bundlePath)
      ? JSON.parse(fs.readFileSync(bundlePath, 'utf8'))
      : await buildBundle(job);

    if (opts.claude !== false) {
      job.analysis.step = 'asking Claude';
      job.analysis.report = await askClaude(job, job.analysis.bundle);
      fs.writeFileSync(path.join(job.dir, 'analysis', 'report.md'), job.analysis.report);
      if (config.saveDir) {
        try {
          const dir = expandHome(config.saveDir);
          fs.copyFileSync(
            path.join(job.dir, 'analysis', 'report.md'),
            path.join(dir, `${path.parse(job.filename).name} — analysis.md`)
          );
        } catch { /* report still available in the app */ }
      }
    }
    job.analysis.status = 'done';
    job.analysis.step = null;
  } catch (e) {
    job.analysis.status = 'error';
    job.analysis.step = null;
    job.analysis.error = e?.error?.error?.message || e.message || 'Analysis failed.';
  }
}

/** The copy-paste prompt for users without an API key configured. */
function manualPrompt(bundle) {
  return `${ANALYST_SYSTEM}\n\n(Attach contact-sheet.jpg and hook.jpg from the analysis bundle.)\n\n${analysisPrompt(bundle)}`;
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

// Optional shared-access token for team deployments (set MAGPIE_TOKEN).
// First visit with ?token=XYZ sets a long-lived cookie; after that every
// browser request carries it automatically.
const ACCESS_TOKEN = process.env.MAGPIE_TOKEN || null;

function authorized(req, res, requestUrl) {
  if (!ACCESS_TOKEN) return true;
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => {
      const i = c.indexOf('=');
      return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
    })
  );
  if (cookies.magpie_token === ACCESS_TOKEN) return true;
  const queryToken = requestUrl.searchParams.get('token');
  if (queryToken === ACCESS_TOKEN) {
    res.setHeader('Set-Cookie',
      `magpie_token=${ACCESS_TOKEN}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
    return true;
  }
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (bearer === ACCESS_TOKEN) return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = requestUrl;
  let m;

  if (!authorized(req, res, requestUrl)) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(
      '<body style="font-family:sans-serif;background:#0e0f13;color:#eef0f6;display:grid;place-items:center;height:100vh;margin:0">' +
      '<div style="text-align:center"><h2>🐦‍⬛ Magpie</h2><p>This Magpie needs an access token.<br>' +
      'Open the link your admin gave you (it ends in <code>?token=…</code>).</p></div></body>'
    );
  }

  try {
    // ---- API -------------------------------------------------------------
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        ytdlp: YTDLP,
        ffmpeg: FFMPEG,
        deno: DENO,
        saveDir: config.saveDir || null,
        cookiesBrowser: config.cookiesBrowser || null,
        autoAnalyze: Boolean(config.autoAnalyze),
        claudeModel: CLAUDE_MODEL,
      });
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      return sendJson(res, 200, {
        saveDir: config.saveDir || null,
        cookiesBrowser: config.cookiesBrowser || null,
      });
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);

      if ('autoAnalyze' in body) {
        if (body.autoAnalyze) config.autoAnalyze = true;
        else delete config.autoAnalyze;
      }

      if ('cookiesBrowser' in body) {
        const browser = String(body.cookiesBrowser || '').trim().toLowerCase();
        if (browser && !COOKIE_BROWSERS.includes(browser)) {
          return sendJson(res, 422, { error: `Unknown browser "${browser}".` });
        }
        if (browser) config.cookiesBrowser = browser;
        else delete config.cookiesBrowser;
      }

      if ('saveDir' in body) {
        const raw = String(body.saveDir || '').trim();
        if (!raw) {
          delete config.saveDir;
        } else {
          const dir = expandHome(raw);
          try {
            fs.mkdirSync(dir, { recursive: true });
            fs.accessSync(dir, fs.constants.W_OK);
          } catch (e) {
            return sendJson(res, 422, { error: `Can't use that folder: ${e.message}` });
          }
          config.saveDir = raw;
        }
      }

      saveConfig();
      return sendJson(res, 200, {
        saveDir: config.saveDir || null,
        cookiesBrowser: config.cookiesBrowser || null,
        autoAnalyze: Boolean(config.autoAnalyze),
      });
    }

    if (pathname === '/api/recordings' && req.method === 'POST') {
      const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
      return receiveRecording(req, res, params.get('name'), params.get('audio') === '1');
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
          stats: extractStats(info),
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

    // List a profile/channel/playlist and rank its clips by views.
    if (pathname === '/api/collection' && req.method === 'POST') {
      const body = await readBody(req);
      const url = validateUrl(body.url);
      if (!url) return sendJson(res, 400, { error: 'Please paste a valid link.' });
      try {
        const listing = await new Promise((resolve, reject) => {
          const proc = spawn(YTDLP,
            ['-J', '--flat-playlist', '--playlist-items', '1-40', '--no-warnings',
             ...cookieArgs(), '--', url],
            { env: SPAWN_ENV });
          let out = '', err = '';
          const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Timed out listing the profile.')); }, 120_000);
          proc.stdout.on('data', (d) => (out += d));
          proc.stderr.on('data', (d) => (err += d));
          proc.on('error', (e) => { clearTimeout(timer); reject(e); });
          proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error(cleanYtdlpError(err)));
            try { resolve(JSON.parse(out)); } catch { reject(new Error('Could not parse the listing.')); }
          });
        });
        const entries = (listing.entries || [])
          .filter(Boolean)
          .map((e) => ({
            url: e.url || e.webpage_url,
            title: e.title || null,
            views: e.view_count ?? null,
            duration: e.duration ?? null,
            thumbnail: Array.isArray(e.thumbnails) ? e.thumbnails[0]?.url : (e.thumbnail || null),
          }))
          .filter((e) => e.url);
        entries.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
        return sendJson(res, 200, {
          title: listing.title || listing.uploader || url,
          uploader: listing.uploader || listing.channel || null,
          total: entries.length,
          entries: entries.slice(0, 20),
        });
      } catch (e) {
        return sendJson(res, 422, { error: e.message });
      }
    }

    m = pathname.match(/^\/api\/jobs\/([a-f0-9]{16})\/analyze$/);
    if (m && req.method === 'POST') {
      const job = jobs.get(m[1]);
      if (!job) return sendJson(res, 404, { error: 'Job not found' });
      const body = await readBody(req).catch(() => ({}));
      try {
        // Fire and poll — analysis (esp. the Claude call) takes a while.
        startAnalysis(job, { claude: body.claude !== false });
      } catch (e) {
        return sendJson(res, 422, { error: e.message });
      }
      return sendJson(res, 200, publicJob(job));
    }

    m = pathname.match(/^\/api\/jobs\/([a-f0-9]{16})\/analysis$/);
    if (m && req.method === 'GET') {
      const job = jobs.get(m[1]);
      if (!job || !job.analysis) return sendJson(res, 404, { error: 'No analysis for this job' });
      return sendJson(res, 200, {
        status: job.analysis.status,
        step: job.analysis.step,
        error: job.analysis.error,
        bundle: job.analysis.bundle,
        report: job.analysis.report,
        prompt: job.analysis.bundle && !job.analysis.report ? manualPrompt(job.analysis.bundle) : null,
      });
    }

    m = pathname.match(/^\/api\/jobs\/([a-f0-9]{16})\/analysis\/(sheet|hook|audio)$/);
    if (m && req.method === 'GET') {
      const job = jobs.get(m[1]);
      const fileMap = { sheet: 'contact-sheet.jpg', hook: 'hook.jpg', audio: 'audio.mp3' };
      const file = job && path.join(job.dir, 'analysis', fileMap[m[2]]);
      if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': m[2] === 'audio' ? 'audio/mpeg' : 'image/jpeg' });
      return fs.createReadStream(file).pipe(res);
    }

    if (pathname === '/api/jobs' && req.method === 'GET') {
      const list = [...jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(publicJob);
      return sendJson(res, 200, list);
    }

    m = pathname.match(/^\/api\/jobs\/([a-f0-9]{16})$/);
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

const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Magpie is running — collect clips, learn why they fly');
  console.log(`  →  http://localhost:${PORT}`);
  console.log(`  engine: ${YTDLP}   ffmpeg: ${FFMPEG ? 'yes (merging + mp3 enabled)' : 'no (single-file formats only)'}   deno: ${DENO ? 'yes' : 'NO — YouTube downloads will likely fail; run: npm run setup'}`);
  if (ACCESS_TOKEN) console.log(`  access: token required — share http://<host>:${PORT}/?token=${ACCESS_TOKEN}`);
  console.log('');
});
