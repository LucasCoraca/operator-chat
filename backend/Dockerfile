# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# The builder doesn't need a runnable Chrome — it only compiles TypeScript —
# so skip Puppeteer's postinstall download here. The production image fetches
# its own browser binary below.
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage — Debian-based so Puppeteer's bundled Chromium build
# (which ships SwiftShader for software-rendered WebGL) works out of the box.
# Alpine's `chromium` package is stripped of SwiftShader, so WebGL fails to
# initialize there even with the right flags.
FROM node:20-bookworm-slim

WORKDIR /app

# Runtime libraries Chromium links against. We deliberately do NOT install
# the distro `chromium` package — Puppeteer downloads its own matching build
# into PUPPETEER_CACHE_DIR during `npm ci` below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    openssh-client \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp powers the youtube_transcript tool. Use the standalone Linux build
# (a self-contained PyInstaller binary) so we don't have to install Python.
RUN wget -q -O /usr/local/bin/yt-dlp \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    && chmod a+rx /usr/local/bin/yt-dlp

# Create non-root user. Use `useradd -m` so /home/nodejs exists for any
# tooling that defaults to $HOME.
RUN groupadd -g 1001 nodejs && useradd -m -u 1001 -g nodejs -s /bin/bash nodejs

# Pin Puppeteer's browser cache to a known path the runtime user can read.
# Setting this BEFORE `npm ci` makes the postinstall download land here
# instead of /root/.cache/puppeteer.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

# Copy package files
COPY package*.json ./

# Install production dependencies only. Puppeteer's postinstall fetches the
# bundled Chromium into PUPPETEER_CACHE_DIR.
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy personalities.json file for built-in personalities
COPY --from=builder /app/personalities.json ./personalities.json

# Create directories for data persistence and hand the whole tree (including
# the puppeteer browser cache populated by `npm ci`) to the runtime user.
RUN mkdir -p /app/data /app/sandboxes && chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
