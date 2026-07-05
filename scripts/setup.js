/**
 * Downloads the standalone yt-dlp binary AND a static ffmpeg build into
 * ./bin so CleanGrab works at full power without any system-wide installs.
 * Safe to re-run (updates both).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

async function fetchTo(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/* ------------------------------------------------------------------ yt-dlp */

async function installYtDlp() {
  const asset = IS_WIN ? 'yt-dlp.exe' : IS_MAC ? 'yt-dlp_macos' : 'yt-dlp';
  const dest = path.join(BIN_DIR, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
  console.log(`Downloading yt-dlp (${asset})…`);
  await fetchTo(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, dest);
  if (!IS_WIN) fs.chmodSync(dest, 0o755);
  const version = execFileSync(dest, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`✓ yt-dlp ${version} → ${dest}`);
}

/* ------------------------------------------------------------------ ffmpeg */

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

async function installFfmpeg() {
  const dest = path.join(BIN_DIR, IS_WIN ? 'ffmpeg.exe' : 'ffmpeg');

  // Already have a working system ffmpeg? Then skip the download.
  if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0) {
    console.log('✓ ffmpeg already on PATH — skipping download');
    return;
  }

  const url = IS_MAC
    ? 'https://evermeet.cx/ffmpeg/getrelease/zip'
    : IS_WIN
      ? 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
      : `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${os.arch() === 'arm64' ? 'arm64' : 'amd64'}-static.tar.xz`;

  const archive = path.join(BIN_DIR, path.basename(new URL(url).pathname) || 'ffmpeg-archive');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleangrab-ffmpeg-'));

  console.log('Downloading static ffmpeg build (this one is ~30–80 MB)…');
  await fetchTo(url, archive);

  // bsdtar (macOS/Windows 10+) and GNU tar (Linux) both handle these archives.
  const extract = spawnSync('tar', ['-xf', archive, '-C', tmp], { encoding: 'utf8' });
  if (extract.status !== 0) throw new Error(`could not extract archive: ${extract.stderr}`);

  const binName = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
  const found = findFile(tmp, binName);
  if (!found) throw new Error('ffmpeg binary not found inside the archive');

  fs.copyFileSync(found, dest);
  if (!IS_WIN) fs.chmodSync(dest, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });

  const version = execFileSync(dest, ['-version'], { encoding: 'utf8' }).split('\n')[0];
  console.log(`✓ ${version} → ${dest}`);
}

/* -------------------------------------------------------------------- main */

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  await installYtDlp();

  try {
    await installFfmpeg();
  } catch (e) {
    console.warn(`\n⚠ ffmpeg auto-install failed: ${e.message}`);
    console.warn('CleanGrab still works without it, but full-HD merging, mp3');
    console.warn('extraction, and recording conversion need it. Install manually:');
    console.warn('  macOS:  brew install ffmpeg');
    console.warn('  Ubuntu: sudo apt install ffmpeg');
    console.warn('  Windows: winget install ffmpeg');
  }

  console.log('\nAll set. Start the app with:  npm start');
}

main().catch((e) => {
  console.error(`Setup failed: ${e.message}`);
  console.error('Alternatively install yt-dlp yourself (pip install yt-dlp) — CleanGrab');
  console.error('will find it on your PATH.');
  process.exit(1);
});
