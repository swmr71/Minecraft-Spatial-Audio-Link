# msal-node（Node.js）。@livekit/rtc-node がネイティブ依存なので glibc の Debian を使う（Alpine は不可）
FROM node:22-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/swmr71/Minecraft-Spatial-Audio-Link" \
      org.opencontainers.image.description="msal-node: Minecraft Spatial Audio Link backend"

# ffmpeg は音源 API の「URL 方式」でだけ使う。不要なら --build-arg INSTALL_FFMPEG=0
ARG INSTALL_FFMPEG=1
RUN if [ "$INSTALL_FFMPEG" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends ffmpeg \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# SQLite（ログインコード）の置き場。名前付きボリュームをマウントする
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8010 DB_PATH=/data/db.sqlite3
VOLUME /data

USER node
EXPOSE 8010

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8010)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
