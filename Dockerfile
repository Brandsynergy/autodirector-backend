# Playwright runtime with matching version to our dependency
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# Install production deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# App files
COPY server.js ./server.js

# Screenshot output dir
RUN mkdir -p /app/runs

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
                                        
  
  
                                        
  
  
                                                            
  
  
  
                                                            
  
  
  
                                                                                                                                            
  
  
  
  
  
  
  
                                                            
  
  
  
                                        
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                
  
  
  
  
  
  
  
  




