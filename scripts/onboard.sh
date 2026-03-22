#!/bin/bash
# Cortex Hub — Universal Onboarding Script
# This script handles the onboarding of a new member/agent to a project.
# It also detects the project stack, generates verify commands, and installs git hooks.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[m'

echo -e "${BLUE}>>> Starting Member Onboarding...${NC}"

# ── Step 1: Identity Detection ──
GIT_REPO=$(git remote get-url origin 2>/dev/null || echo "unknown")
echo -e "${BLUE}>>> Detecting project context for: ${GIT_REPO}${NC}"

# ── Step 2: MCP Gateway Connection & Secret Injection ──
echo -e "${BLUE}>>> Connecting to Cortex Hub...${NC}"

# Support for passing API Key as first argument
if [ -n "$1" ]; then
    HUB_API_KEY="$1"
fi

# Interactive prompt — try stdin first, then /dev/tty
prompt_user() {
    if [ -t 0 ]; then
        read "$@"
    elif [ -e /dev/tty ]; then
        read "$@" < /dev/tty
    else
        return 1
    fi
}

prompt_user_secret() {
    if [ -t 0 ]; then
        read -rsp "$@"
    elif [ -e /dev/tty ]; then
        read -rsp "$@" < /dev/tty
    else
        return 1
    fi
}

# 1. Prompt for MCP URL (with default — use exactly as provided, no suffixes)
if prompt_user -rp "Enter your Cortex Hub MCP URL [https://cortex-mcp.jackle.dev/mcp]: " INPUT_URL; then
    MCP_URL=${INPUT_URL:-"https://cortex-mcp.jackle.dev/mcp"}
else
    MCP_URL=${HUB_API_URL:-"https://cortex-mcp.jackle.dev/mcp"}
fi

# Strip trailing slash for consistency
MCP_URL="${MCP_URL%/}"

# 2. Prompt for API Key (masked)
if [ -z "$HUB_API_KEY" ]; then
    if prompt_user_secret "Enter your Cortex Hub API Key: " HUB_API_KEY; then
        echo "" # Newline after masked input
    else
        echo -e "${RED}>>> Error: HUB_API_KEY not provided and no interactive terminal available.${NC}"
        echo -e "${YELLOW}    Usage: HUB_API_KEY=your-key bash onboard.sh${NC}"
        echo -e "${YELLOW}    Or pass as argument: bash onboard.sh your-key${NC}"
        exit 1
    fi
fi

# 3. Test MCP connection before proceeding
echo -e "${BLUE}>>> Testing MCP connection...${NC}"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 10 \
    -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $HUB_API_KEY" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}>>> MCP connection successful! ✅${NC}"
elif [ "$HTTP_CODE" = "401" ]; then
    echo -e "${RED}>>> MCP connection failed: Invalid API Key (401).${NC}"
    echo -e "${YELLOW}    Check your key on the Hub dashboard and try again.${NC}"
    exit 1
elif [ "$HTTP_CODE" = "000" ]; then
    echo -e "${RED}>>> MCP connection failed: Cannot reach $MCP_URL${NC}"
    echo -e "${YELLOW}    Check the URL and your network connection.${NC}"
    exit 1
else
    echo -e "${YELLOW}>>> MCP responded with HTTP $HTTP_CODE — continuing anyway...${NC}"
fi

# 4. Inject into global mcp_config.json
CONFIG_PATH="$HOME/.gemini/antigravity/mcp_config.json"
if [ -f "$CONFIG_PATH" ]; then
    echo -e "${BLUE}>>> Injecting API Key into mcp_config.json...${NC}"
    python3 -c "
import json, os
path = '$CONFIG_PATH'
with open(path, 'r') as f: config = json.load(f)
if 'mcpServers' not in config: config['mcpServers'] = {}
config['mcpServers']['cortex-hub'] = {
    'command': 'npx',
    'args': ['-y', 'mcp-remote', '$MCP_URL', '--header', 'Authorization: Bearer $HUB_API_KEY']
}
with open(path, 'w') as f: json.dump(config, f, indent=2)
"
else
    echo -e "${YELLOW}>>> Warning: Global mcp_config.json not found at $CONFIG_PATH.${NC}"
fi

# ── Step 3: Scan & Detect Project Stack ──
echo -e "${BLUE}>>> Scanning project stack...${NC}"

CORTEX_DIR=".cortex"
PROFILE_PATH="$CORTEX_DIR/project-profile.json"
mkdir -p "$CORTEX_DIR"

# Detect package manager & stack
PKG_MANAGER="unknown"
BUILD_CMD=""
TYPECHECK_CMD=""
LINT_CMD=""
TEST_CMD=""
FORMAT_CMD=""

if [ -f "package.json" ]; then
    # Node.js project
    if [ -f "pnpm-lock.yaml" ] || [ -f "pnpm-workspace.yaml" ]; then
        PKG_MANAGER="pnpm"
    elif [ -f "yarn.lock" ]; then
        PKG_MANAGER="yarn"
    else
        PKG_MANAGER="npm"
    fi

    # Detect scripts from package.json
    if python3 -c "import json; s=json.load(open('package.json')).get('scripts',{}); exit(0 if 'build' in s else 1)" 2>/dev/null; then
        BUILD_CMD="$PKG_MANAGER build"
    fi
    if python3 -c "import json; s=json.load(open('package.json')).get('scripts',{}); exit(0 if 'typecheck' in s else 1)" 2>/dev/null; then
        TYPECHECK_CMD="$PKG_MANAGER typecheck"
    fi
    if python3 -c "import json; s=json.load(open('package.json')).get('scripts',{}); exit(0 if 'lint' in s else 1)" 2>/dev/null; then
        LINT_CMD="$PKG_MANAGER lint"
    fi
    if python3 -c "import json; s=json.load(open('package.json')).get('scripts',{}); exit(0 if 'test' in s else 1)" 2>/dev/null; then
        TEST_CMD="$PKG_MANAGER test"
    fi
    if python3 -c "import json; s=json.load(open('package.json')).get('scripts',{}); exit(0 if 'format' in s else 1)" 2>/dev/null; then
        FORMAT_CMD="$PKG_MANAGER format"
    fi
elif [ -f "go.mod" ]; then
    PKG_MANAGER="go"
    BUILD_CMD="go build ./..."
    LINT_CMD="golangci-lint run"
    TEST_CMD="go test ./..."
elif ls ./*.csproj >/dev/null 2>&1 || ls ./*.sln >/dev/null 2>&1; then
    PKG_MANAGER="dotnet"
    BUILD_CMD="dotnet build"
    LINT_CMD="dotnet format --check"
    TEST_CMD="dotnet test"
elif [ -f "Cargo.toml" ]; then
    PKG_MANAGER="cargo"
    BUILD_CMD="cargo build"
    LINT_CMD="cargo clippy"
    TEST_CMD="cargo test"
elif [ -f "requirements.txt" ] || [ -f "pyproject.toml" ]; then
    PKG_MANAGER="pip"
    LINT_CMD="ruff check ."
    TEST_CMD="pytest"
fi

echo -e "${GREEN}>>> Detected: $PKG_MANAGER${NC}"
[ -n "$BUILD_CMD" ] && echo -e "    Build: $BUILD_CMD"
[ -n "$TYPECHECK_CMD" ] && echo -e "    Typecheck: $TYPECHECK_CMD"
[ -n "$LINT_CMD" ] && echo -e "    Lint: $LINT_CMD"
[ -n "$TEST_CMD" ] && echo -e "    Test: $TEST_CMD"

# Generate project-profile.json if it doesn't exist
if [ ! -f "$PROFILE_PATH" ]; then
    echo -e "${BLUE}>>> Generating $PROFILE_PATH...${NC}"

    # Build verify arrays
    PRE_COMMIT_CMDS=""
    FULL_CMDS=""
    [ -n "$BUILD_CMD" ] && PRE_COMMIT_CMDS="$PRE_COMMIT_CMDS\"$BUILD_CMD\","
    [ -n "$TYPECHECK_CMD" ] && PRE_COMMIT_CMDS="$PRE_COMMIT_CMDS\"$TYPECHECK_CMD\","
    [ -n "$LINT_CMD" ] && PRE_COMMIT_CMDS="$PRE_COMMIT_CMDS\"$LINT_CMD\","
    # Remove trailing comma
    PRE_COMMIT_CMDS="${PRE_COMMIT_CMDS%,}"

    FULL_CMDS="$PRE_COMMIT_CMDS"
    [ -n "$TEST_CMD" ] && FULL_CMDS="$FULL_CMDS,\"$TEST_CMD\""

    cat > "$PROFILE_PATH" <<EOF
{
  "schema_version": "1.0",
  "project_name": "$(basename "$(pwd)")",
  "fingerprint": {
    "package_manager": "$PKG_MANAGER",
    "detected_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  },
  "verify": {
    "pre_commit": [$PRE_COMMIT_CMDS],
    "full": [$FULL_CMDS],
    "auto_fix": true,
    "max_retries": 2
  }
}
EOF
    echo -e "${GREEN}>>> Generated $PROFILE_PATH${NC}"
else
    echo -e "${GREEN}>>> Found existing $PROFILE_PATH — skipping generation${NC}"
fi

# ── Step 4: Install Lefthook & Generate Git Hooks ──
echo -e "${BLUE}>>> Setting up git hooks (Lefthook)...${NC}"

# Install Lefthook if not available
if ! command -v lefthook >/dev/null 2>&1; then
    echo -e "${YELLOW}>>> Lefthook not found. Installing...${NC}"
    if command -v brew >/dev/null 2>&1; then
        brew install lefthook
    elif command -v npm >/dev/null 2>&1; then
        npm install -g @evilmartians/lefthook
    else
        # Direct binary download (Linux/macOS)
        ARCH=$(uname -m)
        OS=$(uname -s | tr '[:upper:]' '[:lower:]')
        [ "$ARCH" = "x86_64" ] && ARCH="amd64"
        [ "$ARCH" = "aarch64" ] && ARCH="arm64"
        LEFTHOOK_URL="https://github.com/evilmartians/lefthook/releases/latest/download/lefthook_${OS}_${ARCH}"
        echo -e "${BLUE}>>> Downloading lefthook from $LEFTHOOK_URL${NC}"
        curl -fsSL "$LEFTHOOK_URL" -o /usr/local/bin/lefthook && chmod +x /usr/local/bin/lefthook
    fi
fi

# Generate lefthook.yml from project-profile.json
if [ -f "$PROFILE_PATH" ]; then
    echo -e "${BLUE}>>> Generating lefthook.yml from $PROFILE_PATH...${NC}"

    python3 -c "
import json

with open('$PROFILE_PATH') as f:
    profile = json.load(f)

verify = profile.get('verify', {})
pre_commit = verify.get('pre_commit', [])
full_cmds = verify.get('full', [])

def cmd_to_key(cmd_str, index):
    \"\"\"Convert a command string to a unique YAML key name.\"\"\"
    # Replace spaces/slashes with underscores, strip unsafe chars
    key = cmd_str.replace(' ', '_').replace('/', '_').replace('-', '_').lower()
    # Remove leading/trailing underscores
    key = key.strip('_')
    return key or f'step_{index}'

lines = []

# Pre-commit hooks
if pre_commit:
    lines.append('pre-commit:')
    lines.append('  parallel: true')
    lines.append('  commands:')
    for i, cmd in enumerate(pre_commit):
        # Handle both string and object formats
        if isinstance(cmd, dict):
            name = cmd.get('name', f'step_{i}').lower().replace(' ', '_')
            run_cmd = cmd.get('cmd', '')
        else:
            name = cmd_to_key(cmd, i)
            run_cmd = cmd
        lines.append(f'    {name}:')
        lines.append(f'      run: {run_cmd}')

# Pre-push hooks (use full commands if different from pre_commit)
push_cmds = full_cmds if full_cmds != pre_commit else pre_commit
if push_cmds:
    lines.append('')
    lines.append('pre-push:')
    lines.append('  parallel: true')
    lines.append('  commands:')
    for i, cmd in enumerate(push_cmds):
        if isinstance(cmd, dict):
            name = cmd.get('name', f'step_{i}').lower().replace(' ', '_')
            run_cmd = cmd.get('cmd', '')
        else:
            name = cmd_to_key(cmd, i)
            run_cmd = cmd
        lines.append(f'    {name}:')
        lines.append(f'      run: {run_cmd}')

with open('lefthook.yml', 'w') as f:
    f.write('\\n'.join(lines) + '\\n')
print('Generated lefthook.yml')
"

    # Remove legacy .husky directory if it exists
    if [ -d ".husky" ]; then
        echo -e "${YELLOW}>>> Removing legacy .husky/ (replaced by Lefthook)${NC}"
        rm -rf .husky
    fi

    # Install hooks
    if command -v lefthook >/dev/null 2>&1; then
        lefthook install
        echo -e "${GREEN}>>> Git hooks installed via Lefthook ✅${NC}"
    else
        echo -e "${RED}>>> Warning: Lefthook install failed. Git hooks not active.${NC}"
    fi
else
    echo -e "${YELLOW}>>> No project-profile.json found. Skipping hook setup.${NC}"
fi

# ── Step 5: Sync AGENTS.md ──
if [ -f AGENTS.md ]; then
    echo -e "${GREEN}>>> Found AGENTS.md — agent rules are active${NC}"
fi

# ── Step 6: Local Context Audit & Session Start ──
echo -e "${BLUE}>>> Announcing agent availability and running audit...${NC}"
if command -v gitnexus >/dev/null 2>&1; then
    gitnexus audit --local || true
fi

# Announce session start (optional — endpoint may not exist yet)
curl -s -o /dev/null -X POST "$MCP_URL/session/start" \
     -H "Authorization: Bearer $HUB_API_KEY" \
     -H "Content-Type: application/json" \
     -d "{\"repo\": \"$GIT_REPO\", \"mode\": \"onboarding\"}" 2>/dev/null || true

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}>>> Onboarding Complete! ✅${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "    Stack:     ${BLUE}$PKG_MANAGER${NC}"
echo -e "    Profile:   ${BLUE}$PROFILE_PATH${NC}"
echo -e "    Hooks:     ${BLUE}lefthook (pre-commit + pre-push)${NC}"
echo -e "    Rules:     ${BLUE}AGENTS.md${NC}"
echo -e ""
echo -e "    ${YELLOW}Enforcement: git commit/push will FAIL if verify doesn't pass.${NC}"
echo -e "${BLUE}>>> Happy Coding!${NC}"
