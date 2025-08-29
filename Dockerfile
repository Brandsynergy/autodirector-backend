# Dockerfile
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY public ./public
COPY server.js ./server.js
RUN mkdir -p /app/runs

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
                                                            
  
  
  
                                                                                                                                            
  
  
  
  
  
  
  
                                                            
  
  
  
                                        
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                
  
  
  
  
  
  
  
  




