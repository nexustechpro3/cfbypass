FROM node:20-bookworm-slim

# Xenova/Transformers.js model cache — written at runtime, /tmp is fine
ENV TRANSFORMERS_CACHE=/tmp/whisper-cache

# Xvfb virtual display — Chrome runs headed against this, CF cannot detect headless
ENV DISPLAY=:99
ENV HEADED=true

# Install system deps + Chrome in one layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    ffmpeg \
    xvfb \
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
    && curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --production

ENV NODE_ENV=production

EXPOSE 3000

# Create nexus user and pre-create every /tmp path Chrome/crashpad/Xvfb will touch
RUN useradd -r -s /bin/false nexus && \
    chown -R nexus:nexus /app && \
    mkdir -p \
        /tmp/whisper-cache \
        /tmp/.X11-unix \
        /tmp/nexus-clearance-profile \
        /tmp/chrome-crashpad-database \
    && chmod 1777 /tmp/.X11-unix \
    && chown -R nexus:nexus \
        /tmp/whisper-cache \
        /tmp/.X11-unix \
        /tmp/nexus-clearance-profile \
        /tmp/chrome-crashpad-database

USER nexus

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
    CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

CMD ["sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset & sleep 2 && node dist/index.js"]