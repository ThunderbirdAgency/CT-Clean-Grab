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
- **Clean originals** — fetches the platform's original media stream. For TikTok that means the watermark-free stream whenever the platform exposes one (yt-dlp prefers it by default).
- **Zero npm dependencies** — plain Node built-ins, nothing to `npm install`.

## Quick start

```bash
# 1. Get the download engine (one time)
npm run setup            # downloads the yt-dlp binary into ./bin
# …or, if you prefer:    pip install yt-dlp

# 2. (Optional, recommended) install ffmpeg for mp3 + HD stream merging
#    macOS:  brew install ffmpeg
#    Ubuntu: sudo apt install ffmpeg

# 3. Run
npm start                # → http://localhost:3111
```

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

Without ffmpeg, CleanGrab falls back to the best *single-file* format the platform offers
(usually 720p–1080p mp4) and best-audio instead of mp3 — everything still works.

## Configuration

| Env var      | Default | Purpose                          |
|--------------|---------|----------------------------------|
| `PORT`       | `3111`  | Web UI port                      |
| `YTDLP_PATH` | auto    | Explicit path to a yt-dlp binary |

## A note on use

CleanGrab downloads the original media that platforms serve — it doesn't crack DRM and it
doesn't strip creator attribution baked into the video itself. Please only download content
you own, have permission to use, or that's licensed for reuse, and respect each platform's
terms of service and creators' rights.
