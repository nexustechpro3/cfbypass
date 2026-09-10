# Amendment 12: node:20-bookworm-slim — NOT Alpine (Chromium has glibc deps that break on Alpine)
FROM node:20-bookworm-slim

# Amendment 13: Keep Patchright Chromium binary in a known, writable path inside the container
ENV PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers

# Amendment 6: Xenova/Transformers.js model cache to /tmp (RAM-backed tmpfs on Railway)
ENV TRANSFORMERS_CACHE=/tmp/whisper-cache

# Node environment
ENV NODE_ENV=production

# Install all Chromium system dependencies + FFmpeg via apt-get
# Amendment 8: system FFmpeg — NOT the wasm version from unpkg CDN
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Core build tools
    ca-certificates \
    curl \
    gnupg \
    # FFmpeg — amendment 8
    ffmpeg \
    # Chromium system deps (glibc-based, required by Patchright Chromium)
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

# Copy package files first for Docker layer caching
COPY package*.json ./

# Install all npm dependencies
RUN npm ci

# Install Patchright Chromium at build time
# --with-deps skipped here since we installed deps via apt-get above
RUN npx patchright install chromium

# Copy application source and built output
COPY . .

# Build TypeScript
RUN npm run build

# Clean up dev artifacts
RUN npm prune --production

# Railway / container healthcheck
HEALTHCHECK --interval=10s --timeout=5s --start-period=45s --retries=6 \
    CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

EXPOSE 3000

# Run as non-root user for security
RUN useradd -r -s /bin/false nexus && \
    chown -R nexus:nexus /app && \
    mkdir -p /tmp/pw-browsers /tmp/whisper-cache && \
    chown -R nexus:nexus /tmp/pw-browsers /tmp/whisper-cache

USER nexus

CMD ["node", "dist/index.js"]
