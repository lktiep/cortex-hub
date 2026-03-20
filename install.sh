#!/bin/bash
# Cortex Hub — One-Command Entry Point
# This script handles the initial clone and delegates to internal scripts.

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}>>> Bootstrapping Cortex Hub...${NC}"

# 1. Clone if not in repo
if [ ! -d ".git" ]; then
    echo -e "${BLUE}>>> Cloning Cortex Hub repository...${NC}"
    git clone https://github.com/lktiep/cortex-hub.git
    cd cortex-hub
fi

echo -e "${GREEN}>>> Welcome to Cortex Hub!${NC}"
echo "Choose your role:"
echo "1) Administrator (Full installation: Docker stack, Hub API, and Onboarding)"
echo "2) Member (Project Onboarding only: Connect local agent to existing Hub)"
read -rp "Select option [1-2]: " role

if [ "$role" == "1" ]; then
    # 2. Execute Admin Installation
    if [ -f "scripts/install-hub.sh" ]; then
        bash scripts/install-hub.sh
    else
        echo "Error: scripts/install-hub.sh not found."
        exit 1
    fi
else
    # 3. Execute Member Onboarding Only
    if [ -f "scripts/onboard.sh" ]; then
        bash scripts/onboard.sh
    else
        echo "Error: scripts/onboard.sh not found."
        exit 1
    fi
fi

echo -e "${BLUE}>>> Operation complete. Happy Coding!${NC}"
