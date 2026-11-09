FROM node:20-alpine

WORKDIR /app

# Install dependencies based on lockfile
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Set default environment variables
ENV NODE_ENV=production
ENV PORT=3002

# Expose backend port
EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/health || exit 1

# Run as non-root user for security
USER node

CMD ["node", "index.js"]

