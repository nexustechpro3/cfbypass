FROM node:20-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers
ENV TRANSFORMERS_CACHE=/tmp/whisper-cache

# Remove NODE_ENV=production from here — it causes npm ci to skip devDependencies

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    ffmpeg \
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
    xvfb \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci

RUN npx patchright install chromium

COPY . .

RUN npm run build

RUN npm prune --production

# Set NODE_ENV=production AFTER build
ENV NODE_ENV=production

HEALTHCHECK --interval=10s --timeout=5s --start-period=45s --retries=6 \
    CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

EXPOSE 3000

RUN useradd -r -s /bin/false nexus && \
    chown -R nexus:nexus /app && \
    mkdir -p /tmp/pw-browsers /tmp/whisper-cache && \
    chown -R nexus:nexus /tmp/pw-browsers /tmp/whisper-cache

USER nexus

CMD ["node", "dist/index.js"]