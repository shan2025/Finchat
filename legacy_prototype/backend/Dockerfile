# ── Build stage ──
FROM node:20-alpine AS builder

# better-sqlite3 needs build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --production

# ── Runtime stage ──
FROM node:20-alpine

WORKDIR /app

# Copy built node_modules and source
COPY --from=builder /app/node_modules ./node_modules
COPY backend/ .
COPY frontend/ /frontend

# Create directories
RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "server.js"]
