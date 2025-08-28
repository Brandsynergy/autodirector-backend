# Playwright image has Chrome/Firefox/WebKit preinstalled
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install --omit=dev

COPY public ./public
RUN mkdir -p /app/runs
COPY server.js ./server.js

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
                                                            
  
  
  
                                        
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                
  
  
  
  
  
  
  
  




