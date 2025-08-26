# Dockerfile
# Keep the Playwright version pinned so browsers + Node package match.
ARG PW_VERSION=1.55.0
FROM mcr.microsoft.com/playwright:v${PW_VERSION}-jammy

# Optional cache-bust knob: change this value if you ever need to force a clean pull.
ARG CACHE_BUST=2025-08-26
RUN echo "cache-bust=$CACHE_BUST"

WORKDIR /app

# Install dependencies (uses your lockfile if present)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App code
COPY server.js ./server.js
COPY public ./public
RUN mkdir -p runs

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

# Render detects the port automatically, but we set it explicitly too.
CMD ["node", "server.js"]



