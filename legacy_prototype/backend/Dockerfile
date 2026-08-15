# ── Build stage ──
FROM node:20-alpine AS builder

# better-sqlite3 needs build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Full install, including devDependencies: Tailwind and its two plugins live
# there, and the stylesheet is built here rather than committed so it can never
# go stale against the markup. Dev deps are pruned again below, so the runtime
# image still ships production dependencies only.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --legacy-peer-deps

# Build the CSS the pages link. Without this the image serves HTML that
# references finchat_tw.css and gets a 404 — the Tailwind CDN that used to
# compile in the browser is gone, and the CSP no longer allows it back.
# NODE_PATH lets the configs in /frontend resolve plugins from /app.
COPY frontend/ /frontend
ENV NODE_PATH=/app/node_modules
RUN node_modules/.bin/tailwindcss -c /frontend/tailwind.config.js \
      -i /frontend/tailwind.input.css -o /frontend/finchat_tw.css --minify \
 && node_modules/.bin/tailwindcss -c /frontend/tailwind.audit.config.js \
      -i /frontend/tailwind.input.css -o /frontend/finchat_tw_audit.css --minify \
 && test -s /frontend/finchat_tw.css \
 && test -s /frontend/finchat_tw_audit.css

RUN npm prune --omit=dev --legacy-peer-deps

# ── Runtime stage ──
FROM node:20-alpine

# Signals production to Express (view caching, terser error output) and to
# server.js, which only relaxes the CORS allowlist for localhost outside it.
ENV NODE_ENV=production

WORKDIR /app

# Copy built node_modules and source. `node` is a non-root user that already
# exists in the base image; owning the tree lets the app write to uploads/
# without running the container as root.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node backend/ .
# From the builder, so the compiled stylesheets come with it.
COPY --from=builder --chown=node:node /frontend /frontend

# Create directories
RUN mkdir -p uploads && chown node:node uploads

# Drop privileges. A tool escaping the agent sandbox lands as an unprivileged
# user rather than as root inside the container.
USER node

EXPOSE 3000

CMD ["node", "server.js"]
