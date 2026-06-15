#!/bin/bash
# Emergency Cleanup Script
# This script removes locally cached Cortex Hub images that may contain sensitive data
# Before running this, please ensure the docker stack is down.

echo "⚠️  WARNING: This will remove locally built cortex-hub images to prevent accidental re-push of leaked data."

# Prune local images
docker rmi ghcr.io/duyprx/cortex-api:latest -f 2>/dev/null || true
docker rmi ghcr.io/duyprx/cortex-gitnexus:latest -f 2>/dev/null || true
docker rmi ghcr.io/duyprx/cortex-mcp:latest -f 2>/dev/null || true

# Prune builder cache to ensure no data is baked into layers
docker builder prune -a -f

echo "✅ Local docker images and cache pruned successfully."
echo "========================================================="
echo "🚨 CRITICAL: YOU MUST DELETE THE LEAKED PACKAGES FROM GITHUB"
echo "========================================================="
echo "The GHCR packages have already been pushed publicly."
echo "I checked your 'gh' CLI and it lacks 'delete:packages' permission,"
echo "so you MUST delete them manually via the GitHub Web UI:"
echo ""
echo "1. Go to: https://github.com/users/DuyPrX/packages/container/package/cortex-api / Package Settings -> Delete Package"
echo "2. Go to: https://github.com/users/DuyPrX/packages/container/package/cortex-gitnexus / Package Settings -> Delete Package"
echo "3. Go to: https://github.com/users/DuyPrX/packages/container/package/cortex-mcp / Package Settings -> Delete Package"
echo ""
echo "Once deleted, you can rebuild and push the safe versions."
