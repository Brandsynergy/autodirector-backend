# Use Playwright image with browsers preinstalled
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# speed up rebuilds
COPY package.json package-lock.json* ./
RUN npm i --omit=dev

COPY server.js ./server.js
COPY public ./public

# the app writes screenshots here
RUN mkdir -p /app/runs

ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
                                                                                                                                            
  
  
  
  
  
  
  
                                                            
  
  
  
                                        
  
  
                                                                                
  
  
  
  
                                                            
  
  
  
                                                                                                                                                                
  
  
  
  
  
  
  
  




