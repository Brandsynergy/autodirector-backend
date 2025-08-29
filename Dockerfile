# Prebuilt Playwright image (browsers preinstalled)
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# tiny cache-bust so Render doesn’t reuse stale layers
ARG CACHEBUST=2025-08-28
ENV CACHEBUST=${CACHEBUST}

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./server.js
COPY public ./public
RUN mkdir -p /app/runs

EXPOSE 10000
CMD ["node", "server.js"]
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                            
  
  
  
  
  
  
  
                                                            
  
  
  
                                        
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                
  
  
  
  
  
  
  
  




