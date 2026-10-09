FROM node:20-bookworm-slim

ENV TRANSFORMERS_CACHE=/tmp/whisper-cache
ENV DISPLAY=:99
ENV HEADED=true
ENV BREAKPAD_DUMP_LOCATION=/tmp/chrome-crashpad-database

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    ffmpeg \
    xvfb \
    x11-utils \
    xdotool \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxtst6 \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci
RUN npx patchright install chromium
RUN npx patchright install-deps chromium

COPY . .
RUN npm run build
RUN npm prune --production

ENV NODE_ENV=production

EXPOSE 3000

RUN useradd -r -s /bin/false nexus && \
    mkdir -p /home/nexus/.cache && \
    cp -r /root/.cache/ms-playwright /home/nexus/.cache/ms-playwright && \
    chown -R nexus:nexus /app /home/nexus/.cache

USER nexus

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
    CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

CMD ["sh", "-c", "\
  mkdir -p /tmp/.X11-unix /tmp/chrome-crashpad-database /tmp/whisper-cache /tmp/nexus-clearance-profile && \
  chmod 1777 /tmp/.X11-unix && \
  Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset & \
  until xdpyinfo -display :99 >/dev/null 2>&1; do sleep 0.1; done && \
  node dist/index.js"]