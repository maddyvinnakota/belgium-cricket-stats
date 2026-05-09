# Use the official Playwright image — Chromium is pre-installed
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Railway injects $PORT; default to 3000
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
