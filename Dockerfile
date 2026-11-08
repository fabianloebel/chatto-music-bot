FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/yt && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /opt/yt/yt-dlp \
 && chmod +x /opt/yt/yt-dlp && chown -R node:node /opt/yt
ENV PATH=/opt/yt:$PATH
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bot.mjs lib.mjs ./
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
# Healthy while the bot keeps its Chatto connection (it touches this file every 15 s).
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD test -n "$(find /tmp/healthy -mmin -2 2>/dev/null)" || exit 1
# yt-dlp breaks regularly: self-update on every start, then run the bot.
CMD ["sh", "-c", "yt-dlp -U || true; exec node bot.mjs"]
