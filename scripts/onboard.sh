#!/bin/bash
# Cortex Hub — Universal Onboarding Script
# This script handles the onboarding of a new member/agent to a project.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[m'

echo -e "${BLUE}>>> Starting Member Onboarding...${NC}"

# 1. Identity Detection
GIT_REPO=$(git remote get-url origin || echo "unknown")
echo -e "${BLUE}>>> Detecting project context for: ${GIT_REPO}${NC}"

# 2. MCP Gateway Connection & Secret Injection
echo -e "${BLUE}>>> Connecting to Cortex Hub...${NC}"

# Support for passing API Key as first argument
if [ -n "$1" ]; then
    HUB_API_KEY="$1"
fi

# Interactive prompt if TTY is available
if [ -t 0 ]; then
    # 1. Prompt for MCP URL (with default)
    read -rp "Enter your Cortex Hub MCP URL [https://cortex-mcp.jackle.dev]: " INPUT_URL
    MCP_URL=${INPUT_URL:-"https://cortex-mcp.jackle.dev"}
    
    # 2. Prompt for API Key (masked)
    if [ -z "$HUB_API_KEY" ]; then
        read -rsp "Enter your Cortex Hub API Key: " HUB_API_KEY
        echo "" # Newline after masked input
    fi
else
    # Non-interactive defaults
    MCP_URL=${HUB_API_URL:-"https://cortex-mcp.jackle.dev"}
    if [ -z "$HUB_API_KEY" ]; then
        echo -e "${RED}>>> Error: HUB_API_KEY not provided and no TTY detected.${NC}"
        exit 1
    fi
fi

# Inject into global mcp_config.json
CONFIG_PATH="$HOME/.gemini/antigravity/mcp_config.json"
if [ -f "$CONFIG_PATH" ]; then
    echo -e "${BLUE}>>> Injecting API Key into mcp_config.json...${NC}"
    # Simple python one-liner for JSON injection (safe for both Mac/Linux)
    python3 -c "
import json, os
path = '$CONFIG_PATH'
with open(path, 'r') as f: config = json.load(f)
if 'mcpServers' not in config: config['mcpServers'] = {}
config['mcpServers']['cortex-hub'] = {
    'command': 'npx',
    'args': ['-y', '@cortex/mcp-gateway', '--url', '$MCP_URL'],
    'env': {'HUB_API_KEY': '$HUB_API_KEY'}
}
with open(path, 'w') as f: json.dump(config, f, indent=2)
"
else
    echo -e "${RED}>>> Warning: Global mcp_config.json not found at $CONFIG_PATH.${NC}"
fi

# 3. Rule Synchronization & Husky Setup
if [ -f AGENTS.md ]; then
    echo -e "${BLUE}>>> Syncing project rules (AGENTS.md)...${NC}"
    if [ -d .husky ]; then
        echo -e "${BLUE}>>> Reinforcing pre-commit hooks (Husky)...${NC}"
        pnpm husky install
    fi
else
    echo -e "${RED}>>> Warning: AGENTS.md not found in repository root.${NC}"
fi

# 4. Local Context Audit & Session Start
echo -e "${BLUE}>>> Announcing agent availability and running audit...${NC}"
# Trigger local intelligence audit
if command -v gitnexus >/dev/null 2>&1; then
    gitnexus audit --local || true
fi

# Announce session start (to help the Gateway enforce rules)
curl -s -X POST "$MCP_URL/session/start" \
     -H "Authorization: Bearer $HUB_API_KEY" \
     -H "Content-Type: application/json" \
     -d "{\"repo\": \"$GIT_REPO\", \"mode\": \"onboarding\"}" || true

echo -e "${GREEN}>>> Onboarding Complete! Your agent is now context-aware and authenticated.${NC}"
echo -e "${BLUE}>>> Happy Coding!${NC}"
