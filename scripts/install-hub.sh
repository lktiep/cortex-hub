#!/bin/bash
# Cortex Hub — Universal Installation Script
# This script bootstraps the entire Cortex Hub infrastructure.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[m'

echo -e "${BLUE}>>> Starting Cortex Hub Installation...${NC}"

# 1. Dependency Check
echo -e "${BLUE}>>> Checking dependencies...${NC}"
command -v docker >/dev/null 2>&1 || { echo -e "${RED}Error: Docker is not installed.${NC}" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo -e "${RED}Error: pnpm is not installed.${NC}" >&2; exit 1; }

# 2. Project Directory
PROJECT_ROOT=$(pwd)
echo -e "${BLUE}>>> Project root: ${PROJECT_ROOT}${NC}"

# 3. Environment Setup
if [ ! -f .env ]; then
    echo -e "${BLUE}>>> Generating .env from template...${NC}"
    cp .env.example .env
    # Note: In a real interactive script, we would prompt for values here.
    # For now, we assume the user will edit the .env after installation.
fi

# 4. Infrastructure Deployment
echo -e "${BLUE}>>> Starting Docker containers...${NC}"
cd "${PROJECT_ROOT}/infra"
docker compose up -d

# 5. Build Shared Packages
echo -e "${BLUE}>>> Building shared packages...${NC}"
cd "${PROJECT_ROOT}"
pnpm install
pnpm build --filter='@cortex/shared-*'

# 6. Verification
echo -e "${BLUE}>>> Verifying deployment...${NC}"
HEALTH_CHECK=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8317/v1/models || echo "failed")

if [ "$HEALTH_CHECK" == "200" ]; then
    echo -e "${GREEN}>>> Installation Successful! Hub is accessible on port 8317.${NC}"
else
    echo -e "${RED}>>> Installation Warning: Hub MCP (8317) is not responding yet. Check docker logs.${NC}"
fi

echo -e "${GREEN}>>> Done! Access the dashboard at http://localhost:3000 or your remote setup.${NC}"
