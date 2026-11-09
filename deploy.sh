#!/usr/bin/env bash
set -e

echo "=========================================="
echo "🚀 Starting VPS Deployment via Git & Docker"
echo "=========================================="

# 1. Verify .env file exists
if [ ! -f ".env" ]; then
    echo "❌ Error: .env file not found!"
    echo "👉 Please copy .env.example to .env and configure your variables:"
    echo "   cp .env.example .env"
    exit 1
fi

# 2. Pull latest changes from Git
echo "📥 Pulling latest changes from Git..."
git pull

# 3. Build and restart containers
echo "🔨 Building and restarting containers..."
docker compose up -d --build

# 4. Clean up dangling images to save VPS disk space
echo "🧹 Cleaning up old unused Docker images..."
docker image prune -f

# 5. Show container status
echo ""
echo "✅ Deployment successful! Service status:"
docker compose ps

echo "=========================================="
echo "🎉 Services are running! Check logs with: docker compose logs -f"
echo "=========================================="

