# Use the Playwright base so Chromium is present
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# cache-bust knob (change value to force rebuild)
ARG CACHE_BUST=2025-08-31
RUN echo "cache-bust=${CACHE_BUST}"

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY public ./public
COPY server.js ./server.js

RUN mkdir -p runs

ENV NODE_ENV=production
EXPOSE 10000
CMD ["node","server.js"]
                                        
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                            
  
  
  
  
  
  
  
                                                            
  
  
  
                                        
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                
  
  
  
  
  
  
  
  




