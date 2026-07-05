/**
 * Downloads the standalone yt-dlp binary into ./bin so CleanGrab works
 * without any system-wide installs. Safe to re-run (updates the binary).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const IS_WIN = process.platform === 'win32';
const ASSET =
  IS_WIN ? 'yt-dlp.exe'
  : process.platform === 'darwin' ? 'yt-dlp_macos'
  : 'yt-dlp';
const DEST = path.join(BIN_DIR, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
const URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`;

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  console.log(`Downloading yt-dlp (${ASSET})…`);

  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(DEST, buf);
  if (!IS_WIN) fs.chmodSync(DEST, 0o755);

  const version = execFileSync(DEST, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`✓ yt-dlp ${version} installed at ${DEST}`);
  console.log('\nOptional but recommended: install ffmpeg for mp3 extraction and');
  console.log('HD stream merging (macOS: brew install ffmpeg · Ubuntu: apt install ffmpeg).');
  console.log('\nStart the app with:  npm start');
}

main().catch((e) => {
  console.error(`Setup failed: ${e.message}`);
  console.error('Alternatively install yt-dlp yourself (pip install yt-dlp) — CleanGrab');
  console.error('will find it on your PATH.');
  process.exit(1);
});
