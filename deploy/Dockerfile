# Magpie — containerized (for a Linux home server / NAS).
# Note: YouTube distrusts datacenter IPs — run this on a box with a
# residential connection for best results. IG/TikTok work anywhere.

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN node scripts/setup.js   # yt-dlp + ffmpeg + deno into ./bin

ENV PORT=3111
EXPOSE 3111
VOLUME ["/app/downloads", "/app/config.json"]

CMD ["node", "server.js"]
