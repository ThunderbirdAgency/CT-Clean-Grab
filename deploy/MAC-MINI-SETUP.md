# Magpie on a Mac mini — the team appliance

One always-on Magpie the whole agency shares: paste links, raid profiles,
record screens/mics from any team member's browser, and every clip +
Claude report lands in the shared Dropbox.

Total setup time: ~20 minutes.

## 1. Install the basics (on the mini)

```bash
# Homebrew if it isn't there yet: https://brew.sh
brew install node
# Optional but recommended for team access from anywhere:
brew install --cask tailscale
```

## 2. Install Magpie

```bash
git clone https://github.com/ThunderbirdAgency/CT-Clean-Grab.git ~/Magpie
cd ~/Magpie
npm run setup        # downloads yt-dlp, ffmpeg, deno into ./bin
npm install          # Anthropic SDK
```

Quick smoke test:

```bash
ANTHROPIC_API_KEY=sk-ant-... MAGPIE_TOKEN=test123 npm start
# open http://localhost:3111/?token=test123 — paste a TikTok link, watch it fly
# Ctrl+C when satisfied
```

In ⚙ Settings, point the **save folder** at the mini's synced Dropbox
folder (e.g. `~/Dropbox/Magpie`), and turn on **Auto-analyze** if you want
every clip analyzed without clicking.

## 3. Run it full time (launchd)

```bash
cp deploy/com.thunderbirdagency.magpie.plist ~/Library/LaunchAgents/
open -e ~/Library/LaunchAgents/com.thunderbirdagency.magpie.plist
```

Edit the three marked values:
- the `node` path (`which node` — Apple Silicon Homebrew is `/opt/homebrew/bin/node`)
- `WorkingDirectory` → your Magpie folder
- `ANTHROPIC_API_KEY` and `MAGPIE_TOKEN` (make the token a long random string)

Then:

```bash
launchctl load ~/Library/LaunchAgents/com.thunderbirdagency.magpie.plist
tail -f /tmp/magpie.log     # should show "Magpie is running"
```

It now starts on boot and restarts if it ever crashes. Also worth doing on
an appliance mini: System Settings → Energy → **never sleep**, and enable
auto-login so launchd agents start after a power cut.

## 4. Team access from anywhere (Tailscale)

On the mini:

```bash
tailscale up                      # sign in once
tailscale serve --bg 3111         # HTTPS in front of Magpie
tailscale status                  # note the machine name
```

That gives the team `https://<mini-name>.<tailnet>.ts.net` — a real HTTPS
URL, which matters because **browsers only allow screen/mic capture on
HTTPS**. Each teammate installs Tailscale, joins your tailnet, and opens:

```
https://<mini-name>.<tailnet>.ts.net/?token=<MAGPIE_TOKEN>
```

The token is remembered in their browser after the first visit.

Recording note: capture always happens in the *visitor's* browser — a
teammate recording their screen records **their** screen, and the file
uploads to the mini's library. The BlackHole trick for capturing desktop
app audio works on each teammate's own machine the same way.

## 5. Updating

```bash
cd ~/Magpie && git pull && npm install && npm run setup
launchctl kickstart -k gui/$(id -u)/com.thunderbirdagency.magpie
```

## Troubleshooting

- **"engine offline" badge** → check `/tmp/magpie.err.log`; usually a wrong
  `node` path in the plist.
- **YouTube 403 / bot check** → set **Browser cookies** in ⚙ Settings to a
  browser on the mini that's signed in to YouTube (open Safari on the mini
  once and log in).
- **Disk filling up** → `downloads/` keeps every clip + bundle. Safe to
  delete old job folders; the copies in Dropbox are the archive.
