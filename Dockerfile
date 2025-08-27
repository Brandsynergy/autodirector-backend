FROM mcr.microsoft.com/playwright:v1.55.0-jammy

# Do not download browsers again; the base image already has them.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
COPY package.json package-lock.json* ./
# If you don't have a lockfile, this falls back to npm install.
RUN npm ci --omit=dev || npm install --omit=dev

COPY server.js ./server.js
COPY public ./public
RUN mkdir -p runs

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
                                                            
  
  
  
                                                                                                                                                                
  
  
  
  
  
  
  
  




