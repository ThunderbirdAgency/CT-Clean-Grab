# CleanGrab ⬇

A [Downie](https://software.charliemonroe.net/downie/)-style video downloader with a clean web interface.
Paste an **Instagram**, **TikTok**, or **YouTube** link (plus 1,000+ other sites) and get the
platform's **original video file** — no watermarks, no branding, no re-encoding.

Built on the open-source [yt-dlp](https://github.com/yt-dlp/yt-dlp) engine — the same class of
engine Downie uses under the hood.

![CleanGrab](https://img.shields.io/badge/engine-yt--dlp-blue) ![Node](https://img.shields.io/badge/node-%E2%89%A518-green)

## Features

- **Paste anywhere** — hit ⌘V / Ctrl+V on the page and CleanGrab grabs the link automatically (the Downie move). Drag & drop links works too.
- **Preview before downloading** — thumbnail, title, uploader, duration, and available resolutions.
- **Quality picker** — Best available, 1080p, 720p, or audio-only (mp3 when ffmpeg is installed). Tiers the source doesn't offer are greyed out.
- **Live download queue** — progress bars, speed, ETA, then a one-click **Save** button.
- **Screen recording** — hit ⏺ Record screen, pick a screen/window/tab, and the recording lands in the same queue, auto-converted to universally playable mp4 (when ffmpeg is present).
- **Audio recording** ([Audio Hijack](https://rogueamoeba.com/audiohijack/)-style) — hit 🎙 Record audio and capture your microphone, app/tab/system audio, or both mixed into one track, with a live level meter. Recordings convert to 192 kbps mp3 automatically. To capture audio from *any* Mac app (Spotify, Zoom…), install the free [BlackHole](https://existential.audio/blackhole/) virtual audio device, set it as the app's output, and pick it as the input device.
- **Cloud storage handoff** — set a save folder in ⚙ Settings and every finished download and recording is auto-copied there. Point it at a synced folder (`~/Dropbox/…`, iCloud Drive, `~/Google Drive/…`) and everything flows straight into your cloud storage.
- **Clean originals** — fetches the platform's original media stream. For TikTok that means the watermark-free stream whenever the platform exposes one (yt-dlp prefers it by default).
- **Zero npm dependencies** — plain Node built-ins, nothing to `npm install`.

## Quick start

```bash
# 1. Get the engines (one time) — downloads yt-dlp, ffmpeg, and deno into ./bin
npm run setup

# 2. Run
npm start                # → http://localhost:3111
```

`npm run setup` installs everything CleanGrab needs — no Homebrew, no pip, no system
packages. It skips anything already on your PATH. You can also bring your own binaries
via the `YTDLP_PATH` / `FFMPEG_PATH` env vars.

> **Why deno?** YouTube protects its streams with JavaScript signature challenges;
> yt-dlp needs a JS runtime to solve them. Without one, YouTube downloads fail with
> 403 errors while every other site works fine.

## YouTube troubleshooting

- **HTTP 403 / missing formats** → you're missing the JS runtime. Run `npm run setup`
  and restart; the engine badge and server log both warn when no runtime is found.
- **"Sign in to confirm you're not a bot" / age-restricted / private videos** → open
  ⚙ Settings and set **Browser cookies** to the browser where you're logged in to
  YouTube. CleanGrab passes your existing login along (this is how Downie handles it
  too). Note: Chrome on macOS may prompt for keychain access the first time.

Then open **http://localhost:3111**, paste a video link, and click **Download**.

## How it works

```
Browser UI  ──►  Node server (server.js)  ──►  yt-dlp  ──►  original media stream
   ▲                    │
   └── progress polling ┴── files land in ./downloads/<job-id>/
```

- `POST /api/info` — reads a link's metadata (title, thumbnail, resolutions) without downloading.
- `POST /api/download` — starts a download job; progress is parsed live from yt-dlp.
- `GET /api/jobs/:id` — job status for the progress bar.
- `GET /api/jobs/:id/file` — streams the finished file to your browser as a download.
- `POST /api/recordings` — receives a browser recording (webm); screen recordings convert to mp4, audio recordings (`?audio=1`) to mp3.
- `GET`/`POST /api/settings` — the save-folder setting (persisted in `config.json`).

Screen recording uses the browser's native capture API (`getDisplayMedia` + `MediaRecorder`),
so you pick exactly what to record — a full screen, one window, or a single tab (tab/system
audio included where the browser supports it).

Without ffmpeg, CleanGrab falls back to the best *single-file* format the platform offers
(usually 720p–1080p mp4), best-audio instead of mp3, and keeps recordings as webm —
everything still works.

## Configuration

| Env var       | Default | Purpose                           |
|---------------|---------|-----------------------------------|
| `PORT`        | `3111`  | Web UI port                       |
| `YTDLP_PATH`  | auto    | Explicit path to a yt-dlp binary  |
| `FFMPEG_PATH` | auto    | Explicit path to an ffmpeg binary |

## A note on use

CleanGrab downloads the original media that platforms serve — it doesn't crack DRM and it
doesn't strip creator attribution baked into the video itself. Please only download content
you own, have permission to use, or that's licensed for reuse, and respect each platform's
terms of service and creators' rights.
