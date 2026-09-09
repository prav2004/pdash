# Google Cloud Run container for the Pickr Affiliate Portal
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the application source
COPY . .

# Cloud Run provides the PORT env var; the server already honours it.
EXPOSE 8080
CMD ["node", "server.js"]
