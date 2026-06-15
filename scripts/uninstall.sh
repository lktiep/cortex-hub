#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────
# Cortex Hub — Clean Uninstall
# Removes all local Cortex-related config for a fresh start.
# Supports all AI tools: Claude Code, Cursor, Windsurf, VS Code, Antigravity.
# Usage: bash scripts/uninstall.sh
# ────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${RED}══════════════════════════════════════════════${NC}"
echo -e "${RED}  Cortex Hub — Clean Uninstall${NC}"
echo -e "${RED}══════════════════════════════════════════════${NC}"
echo ""
echo -e "This will remove all local Cortex-related configuration:"
echo -e "  - cortex-hub entry from all AI tool MCP configs"
echo -e "  - .cortex/ directory (project profile, conventions)"
echo -e "  - lefthook.yml and git hooks"
echo -e "  - HUB_API_KEY from .env"
echo ""

# ── Confirm ──
if [ -t 0 ]; then
    read -rp "Continue? [y/N] " confirm
else
    read -rp "Continue? [y/N] " confirm < /dev/tty 2>/dev/null || confirm="n"
fi

if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}>>> Cancelled.${NC}"
    exit 0
fi

echo ""

# ── 1. Remove cortex-hub from all MCP configs ──
# List of all known config paths
MCP_CONFIGS=(
    "$HOME/.claude.json|mcpServers|Claude Code"
    "$HOME/.cursor/mcp.json|mcpServers|Cursor"
    "$HOME/.codeium/windsurf/mcp_config.json|mcpServers|Windsurf"
    "$HOME/.gemini/antigravity/mcp_config.json|mcpServers|Antigravity"
)

# Also check project-level VS Code config
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
VSCODE_CONFIG="$PROJECT_ROOT/.vscode/mcp.json"
if [ -f "$VSCODE_CONFIG" ]; then
    MCP_CONFIGS+=("$VSCODE_CONFIG|servers|VS Code (project)")
fi

for entry in "${MCP_CONFIGS[@]}"; do
    IFS='|' read -r config_path config_key display_name <<< "$entry"

    if [ -f "$config_path" ]; then
        echo -e "${BLUE}>>> Removing cortex-hub from $display_name...${NC}"
        python3 -c "
import json
path = '$config_path'
with open(path, 'r') as f: config = json.load(f)
key = '$config_key'
if key in config and 'cortex-hub' in config[key]:
    del config[key]['cortex-hub']
    with open(path, 'w') as f: json.dump(config, f, indent=2)
    print('  Removed cortex-hub entry')
else:
    print('  No cortex-hub entry found (already clean)')
" 2>/dev/null || echo -e "${YELLOW}  Could not parse $config_path${NC}"
    fi
done

# ── 2. Remove .cortex/ directory ──
CORTEX_DIR="$PROJECT_ROOT/.cortex"
if [ -d "$CORTEX_DIR" ]; then
    echo -e "${BLUE}>>> Removing .cortex/ directory...${NC}"
    rm -rf "$CORTEX_DIR"
    echo "  Removed $CORTEX_DIR"
else
    echo -e "${YELLOW}  .cortex/ not found — skipping${NC}"
fi

# ── 3. Remove lefthook.yml and git hooks ──
LEFTHOOK="$PROJECT_ROOT/lefthook.yml"
if [ -f "$LEFTHOOK" ]; then
    echo -e "${BLUE}>>> Removing lefthook.yml...${NC}"
    rm -f "$LEFTHOOK"
    echo "  Removed lefthook.yml"

    # Uninstall lefthook git hooks
    if command -v lefthook &>/dev/null; then
        echo -e "${BLUE}>>> Uninstalling lefthook git hooks...${NC}"
        cd "$PROJECT_ROOT" && lefthook uninstall 2>/dev/null || true
        echo "  Git hooks removed"
    fi
else
    echo -e "${YELLOW}  lefthook.yml not found — skipping${NC}"
fi

# ── 4. Clean HUB_API_KEY from .env ──
ENV_FILE="$PROJECT_ROOT/.env"
if [ -f "$ENV_FILE" ] && grep -q "HUB_API_KEY" "$ENV_FILE"; then
    echo -e "${BLUE}>>> Cleaning HUB_API_KEY from .env...${NC}"
    sed -i.bak '/HUB_API_KEY/d' "$ENV_FILE" 2>/dev/null || \
    sed -i '' '/HUB_API_KEY/d' "$ENV_FILE" 2>/dev/null || true
    rm -f "$ENV_FILE.bak"
    echo "  Removed HUB_API_KEY entries"
else
    echo -e "${YELLOW}  No HUB_API_KEY in .env — skipping${NC}"
fi

# ── 5. Preserve AGENTS.md ──
AGENTS_MD="$PROJECT_ROOT/AGENTS.md"
if [ -f "$AGENTS_MD" ]; then
    echo -e "${BLUE}>>> Found AGENTS.md — keeping (may contain custom rules)${NC}"
    echo -e "${YELLOW}  Delete manually if needed: rm $AGENTS_MD${NC}"
fi

echo ""
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Uninstall Complete!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo ""
echo -e "  Removed:"
echo -e "    - cortex-hub from all MCP configs (Claude, Cursor, Windsurf, VS Code, Antigravity)"
echo -e "    - .cortex/ directory"
echo -e "    - lefthook.yml + git hooks"
echo -e "    - HUB_API_KEY from .env"
echo ""
echo -e "  To re-onboard:"
echo -e "    ${BLUE}curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/bootstrap.sh | bash${NC}"
echo ""
