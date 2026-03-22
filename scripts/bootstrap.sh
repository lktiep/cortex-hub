#!/bin/bash
# Cortex Hub — Bootstrap Script
# Usage: curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/install-hub.sh | bash
#
# This script downloads and runs the appropriate installer:
#   1) Administrator — Full Docker stack + infrastructure
#   2) Member — Project onboarding (connect to existing Hub)

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[m'

REPO_RAW="https://raw.githubusercontent.com/lktiep/cortex-hub/master"
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

echo -e "${BLUE}>>> Bootstrapping Cortex Hub...${NC}"

# ── Role Selection ──
# When piped via curl, stdin is the download stream.
# Open /dev/tty explicitly for interactive prompts.
echo -e "${GREEN}>>> Welcome to Cortex Hub!${NC}"
echo "Choose your role:"
echo "  1) Administrator (Full installation: Docker stack, Hub API, and Onboarding)"
echo "  2) Member (Project Onboarding only: Connect local agent to existing Hub)"

read -rp "  Select option [1-2]: " ROLE < /dev/tty

case "$ROLE" in
  1)
    echo -e "${BLUE}>>> Downloading full installer...${NC}"
    curl -fsSL "$REPO_RAW/scripts/install-hub.sh" -o "$TMP_DIR/install-hub.sh"
    chmod +x "$TMP_DIR/install-hub.sh"
    exec bash "$TMP_DIR/install-hub.sh" < /dev/tty
    ;;
  2)
    echo -e "${BLUE}>>> Downloading onboarding script...${NC}"
    curl -fsSL "$REPO_RAW/scripts/onboard.sh" -o "$TMP_DIR/onboard.sh"
    chmod +x "$TMP_DIR/onboard.sh"
    exec bash "$TMP_DIR/onboard.sh" < /dev/tty
    ;;
  *)
    echo -e "${RED}>>> Invalid option. Exiting.${NC}"
    exit 1
    ;;
esac
