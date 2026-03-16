FROM node:20-slim

# Create non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser

WORKDIR /app

# Copy package manifests from repo root
COPY package.json package-lock.json* ./

# Install production dependencies (clean cache first to avoid EINTEGRITY errors)
RUN npm cache clean --force && npm install --omit=dev --no-audit --no-fund

# Copy application source and setup scripts
COPY src/ ./src/
COPY scripts/ ./scripts/

# FIX BUG-01: Run setup script at build time so chart.min.js is bundled into the
# image and the Service Worker can pre-cache it for true offline support.
# The script is non-fatal — build succeeds even if the CDN is unreachable.
RUN node scripts/setup.js

# Create data dir and set permissions
RUN mkdir -p /app/data && chown -R appuser:appuser /app

USER appuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=15s --start-period=60s --retries=5 \
  CMD node -e "const p=process.env.PORT||3000; require('http').get('http://localhost:'+p+'/api/health', r => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]
