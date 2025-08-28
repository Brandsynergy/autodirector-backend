# syntax=docker/dockerfile:1

# Playwright image that already contains Chromium/Firefox/WebKit
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

# 🔁 Bump this value anytime you want to force a clean rebuild on Render
ARG CACHEBUST=2025-08-27-01
ENV CACHEBUST=${CACHEBUST}

# App directory
WORKDIR /app

# Copy only dependency manifests first to maximize build caching
COPY package.json package-lock.json* ./

# Install deps: prefer npm ci (if a lockfile exists), otherwise fallback to npm install
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# Copy the rest of the app
COPY server.js ./server.js
COPY public ./public

# Directory for screenshots/exports if your app writes files
RUN mkdir -p /app/runs

# Render looks for a listening port; we also log this in server.js
ENV PORT=10000
EXPOSE 10000

# Start the server
CMD ["node", "server.js"]
                                        
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                
  
  
  
  
  
  
  
  




