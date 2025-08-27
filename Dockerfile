# Dockerfile
# Keep Playwright version pinned so browsers match the Node package.
ARG PW_VERSION=1.55.0
FROM mcr.microsoft.com/playwright:v${PW_VERSION}-jammy

# Cache-bust knob: bump this value any time you want to force a clean pull.
ARG CACHE_BUST=2025-08-27
RUN echo "cache-bust=$CACHE_BUST"

WORKDIR /app

# Install dependencies (uses lockfile if present)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App code
COPY server.js ./server.js
COPY public ./public
RUN mkdir -p runs

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]




