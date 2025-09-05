# Uses a Playwright image that already contains Chromium
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# Install deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# App files
COPY server.js ./server.js
COPY public ./public

# Where screenshots are written
RUN mkdir -p /app/runs

# Render expects your app to listen on $PORT
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
                                                                                                                                            
  
  
  
  
  
  
  
                                        
  
  
                                                            
  
  
  
                                        
  
  
                                        
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                            
  
  
  
  
  
  
  
                                                            
  
  
  
                                        
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                
  
  
  
  
  
  
  
  




