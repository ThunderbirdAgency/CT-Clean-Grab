# Magpie 🐦‍⬛

**Collect the clips that fly. Let Claude tell you why.**

Magpie is an internal virality-research tool: it collects clean, original videos from
**Instagram**, **TikTok**, and **YouTube** (plus 1,000+ other sites), captures their
engagement stats, and turns each clip into a **Claude-ready analysis bundle** — sampled
frames, a contact sheet, the audio track, transcript, and a per-second music-energy
timeline. With an Anthropic API key configured, one click asks Claude **why the clip
performs** and generates a **new script/outline in the same DNA**, so the success can
be repeated.

Built on the open-source [yt-dlp](https://github.com/yt-dlp/yt-dlp) engine (the same class
of engine Downie uses) + [ffmpeg](https://ffmpeg.org) + the
[Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript).

![Magpie](https://img.shields.io/badge/engine-yt--dlp-blue) ![Node](https://img.shields.io/badge/node-%E2%89%A518-green)

## The research loop

1. **Gather** — paste a single clip URL, or paste a **creator's profile/channel URL** and
   Magpie lists their clips ranked by views so outliers jump out. Grab the top ones in one click.
2. **See the evidence** — every download captures views, likes, comments, shares, follower
   count, hashtags, and like-rate automatically.
3. **Analyze** — hit 🔍 Analyze on any finished clip. Magpie builds the bundle (frames +
   contact sheet + hook frame + audio + transcript + energy timeline) and sends it to Claude
   with the engagement stats. Claude "watches" the clip and returns a report: why it works,
   the hook, structure & pacing, the music's role, platform signals, the replicable formula,
   and a complete new script in the same DNA.
4. **Repeat** — flip on **Auto-analyze** in ⚙ Settings and every finished download gets the
   full treatment automatically. Reports land in your save folder next to the videos.

No API key? Magpie still builds the bundle and gives you a one-click **copy-paste prompt**
to run in any Claude session (claude.ai, Claude Code, the API console).

## Features

- **Paste anywhere** — hit ⌘V / Ctrl+V on the page and Magpie grabs the link automatically (the Downie move). Drag & drop links works too.
- **Preview before downloading** — thumbnail, title, uploader, duration, and available resolutions.
- **Quality picker** — Best available, 1080p, 720p, or audio-only (mp3 when ffmpeg is installed). Tiers the source doesn't offer are greyed out.
- **Live download queue** — progress bars, speed, ETA, then a one-click **Save** button.
- **Screen recording** — hit ⏺ Record screen, pick a screen/window/tab, and the recording lands in the same queue, auto-converted to universally playable mp4 (when ffmpeg is present).
- **Audio recording** ([Audio Hijack](https://rogueamoeba.com/audiohijack/)-style) — hit 🎙 Record audio and capture your microphone, app/tab/system audio, or both mixed into one track, with a live level meter. Recordings convert to 192 kbps mp3 automatically. To capture audio from *any* Mac app (Spotify, Zoom…), install the free [BlackHole](https://existential.audio/blackhole/) virtual audio device, set it as the app's output, and pick it as the input device.
- **Cloud storage handoff** — set a save folder in ⚙ Settings and every finished download and recording is auto-copied there. Point it at a synced folder (`~/Dropbox/…`, iCloud Drive, `~/Google Drive/…`) and everything flows straight into your cloud storage.
- **Clean originals** — fetches the platform's original media stream. For TikTok that means the watermark-free stream whenever the platform exposes one (yt-dlp prefers it by default).
- **Profile raiding** — paste a creator's profile/channel URL to list their top clips by views and grab several at once.
- **Claude analysis** — per-clip virality reports and same-DNA scripts, powered by the contact sheet + stats + transcript + audio-energy bundle.

## Quick start

```bash
# 1. Get the engines (one time) — downloads yt-dlp, ffmpeg, and deno into ./bin
npm run setup

# 2. Install the Anthropic SDK (for Claude analysis)
npm install

# 3. Configure Claude (optional but the whole point)
export ANTHROPIC_API_KEY=sk-ant-...      # or `ant auth login`, or ANTHROPIC_AUTH_TOKEN

# 4. Run
npm start                # → http://localhost:3111
```

Analysis uses `claude-opus-4-8` by default; override with `ANTHROPIC_MODEL`.

`npm run setup` installs everything Magpie needs — no Homebrew, no pip, no system
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
  YouTube. Magpie passes your existing login along (this is how Downie handles it
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
- `POST /api/collection` — lists a profile/channel/playlist, ranked by views.
- `POST /api/jobs/:id/analyze` — builds the analysis bundle and (optionally) asks Claude.
- `GET /api/jobs/:id/analysis` — bundle + Claude report (+ copy-paste prompt fallback).
- `GET`/`POST /api/settings` — save folder, browser cookies, auto-analyze (persisted in `config.json`).

Screen recording uses the browser's native capture API (`getDisplayMedia` + `MediaRecorder`),
so you pick exactly what to record — a full screen, one window, or a single tab (tab/system
audio included where the browser supports it).

Without ffmpeg, Magpie falls back to the best *single-file* format the platform offers
(usually 720p–1080p mp4), best-audio instead of mp3, and keeps recordings as webm —
everything still works.

## Configuration

| Env var             | Default            | Purpose                           |
|---------------------|--------------------|-----------------------------------|
| `PORT`              | `3111`             | Web UI port                       |
| `HOST`              | `0.0.0.0`          | Bind address                      |
| `YTDLP_PATH`        | auto               | Explicit path to a yt-dlp binary  |
| `FFMPEG_PATH`       | auto               | Explicit path to an ffmpeg binary |
| `ANTHROPIC_API_KEY` | —                  | Enables Claude analysis           |
| `ANTHROPIC_MODEL`   | `claude-opus-4-8`  | Model used for analysis           |
| `MAGPIE_TOKEN`      | — (open)           | Shared access token for team deployments |

## Run it for the whole team

Put Magpie on an always-on Mac mini and share it over Tailscale — one library,
one Dropbox, everyone's browser can download, analyze, and record into it.
Full guide: [`deploy/MAC-MINI-SETUP.md`](deploy/MAC-MINI-SETUP.md) (launchd
service, HTTPS via Tailscale, access token). A `deploy/Dockerfile` is included
for Linux home servers.

## A note on use

Magpie downloads the original media that platforms serve — it doesn't crack DRM and it
doesn't strip creator attribution baked into the video itself. Please only download content
you own, have permission to use, or that's licensed for reuse, and respect each platform's
terms of service and creators' rights.
