FROM mcr.microsoft.com/playwright:v1.46.0-jammy
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY server.js ./server.js
RUN mkdir -p runs
ENV PORT=8080
EXPOSE 8080
CMD ["node","server.js"]
