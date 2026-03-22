#!/bin/bash
# Cortex Hub — Universal Onboarding Script
# Supports multiple AI IDE tools: Claude Code, Cursor, Windsurf, VS Code Copilot,
# Antigravity (Gemini), and headless bots (OpenClaw, custom agents).
#
# Usage:
#   bash onboard.sh                         # Interactive (auto-detect tools)
#   bash onboard.sh --tool claude           # Specific tool
#   bash onboard.sh --tool bot              # Headless bot (outputs connection info)
#   HUB_API_KEY=xxx bash onboard.sh         # Non-interactive

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[m'

echo -e "${BLUE}>>> Starting Member Onboarding...${NC}"

# ── Parse Arguments ──
TOOL_ARG=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --tool|-t)
            TOOL_ARG="$2"
            shift 2
            ;;
        --tool=*)
            TOOL_ARG="${1#*=}"
            shift
            ;;
        *)
            # Legacy: first positional arg = API key
            if [ -z "$HUB_API_KEY" ]; then
                HUB_API_KEY="$1"
            fi
            shift
            ;;
    esac
done

# ── Tool Registry ──
# Each tool has: display name, config path, config format, inject function
# Format: "key|display_name|config_path|config_key"
TOOL_REGISTRY=(
    "claude|Claude Code|__claude_json__|mcpServers"
    "cursor|Cursor|__cursor_mcp__|mcpServers"
    "windsurf|Windsurf|$HOME/.codeium/windsurf/mcp_config.json|mcpServers"
    "vscode|VS Code (Copilot)|__vscode_mcp__|servers"
    "antigravity|Antigravity (Gemini)|$HOME/.gemini/antigravity/mcp_config.json|mcpServers"
    "bot|Headless Bot (OpenClaw, API)|__bot__|__none__"
)

# Resolve dynamic config paths
resolve_config_path() {
    local key="$1"
    case "$key" in
        __claude_json__)
            echo "$HOME/.claude.json"
            ;;
        __cursor_mcp__)
            echo "$HOME/.cursor/mcp.json"
            ;;
        __vscode_mcp__)
            # Per-project config
            echo ".vscode/mcp.json"
            ;;
        __bot__)
            echo "__bot__"
            ;;
        *)
            echo "$key"
            ;;
    esac
}

# ── Step 1: Identity Detection ──
GIT_REPO=$(git remote get-url origin 2>/dev/null || echo "unknown")
echo -e "${BLUE}>>> Detecting project context for: ${GIT_REPO}${NC}"

# ── Step 2: MCP Gateway Connection ──
echo -e "${BLUE}>>> Connecting to Cortex Hub...${NC}"

# Interactive prompt helpers
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

# 1. Get MCP URL
if prompt_user -rp "Enter your Cortex Hub MCP URL [https://cortex-mcp.jackle.dev/mcp]: " INPUT_URL; then
    MCP_URL=${INPUT_URL:-"https://cortex-mcp.jackle.dev/mcp"}
else
    MCP_URL=${HUB_API_URL:-"https://cortex-mcp.jackle.dev/mcp"}
fi
MCP_URL="${MCP_URL%/}"

# 2. Get API Key
if [ -z "$HUB_API_KEY" ]; then
    if prompt_user_secret "Enter your Cortex Hub API Key: " HUB_API_KEY; then
        echo "" # Newline after masked input
    else
        echo -e "${RED}>>> Error: HUB_API_KEY not provided and no interactive terminal available.${NC}"
        echo -e "${YELLOW}    Usage: HUB_API_KEY=your-key bash onboard.sh${NC}"
        exit 1
    fi
fi

# 3. Test MCP connection
echo -e "${BLUE}>>> Testing MCP connection...${NC}"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 10 \
    -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $HUB_API_KEY" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}>>> MCP connection successful!${NC}"
elif [ "$HTTP_CODE" = "401" ]; then
    echo -e "${RED}>>> MCP connection failed: Invalid API Key (401).${NC}"
    exit 1
elif [ "$HTTP_CODE" = "000" ]; then
    echo -e "${RED}>>> MCP connection failed: Cannot reach $MCP_URL${NC}"
    exit 1
else
    echo -e "${YELLOW}>>> MCP responded with HTTP $HTTP_CODE — continuing anyway...${NC}"
fi

# ── Step 3: Tool Detection & Selection ──
echo ""
echo -e "${BLUE}>>> Detecting installed AI tools...${NC}"

DETECTED_TOOLS=()

# Detect installed tools by checking config paths or binaries
detect_tools() {
    # Claude Code
    if command -v claude >/dev/null 2>&1 || [ -f "$HOME/.claude.json" ] || [ -d "$HOME/.claude" ]; then
        DETECTED_TOOLS+=("claude")
        echo -e "    ${GREEN}Found: Claude Code${NC}"
    fi

    # Cursor
    if [ -d "$HOME/.cursor" ] || command -v cursor >/dev/null 2>&1; then
        DETECTED_TOOLS+=("cursor")
        echo -e "    ${GREEN}Found: Cursor${NC}"
    fi

    # Windsurf
    if [ -d "$HOME/.codeium" ] || command -v windsurf >/dev/null 2>&1; then
        DETECTED_TOOLS+=("windsurf")
        echo -e "    ${GREEN}Found: Windsurf${NC}"
    fi

    # VS Code
    if command -v code >/dev/null 2>&1; then
        DETECTED_TOOLS+=("vscode")
        echo -e "    ${GREEN}Found: VS Code${NC}"
    fi

    # Antigravity (Gemini)
    if [ -d "$HOME/.gemini/antigravity" ]; then
        DETECTED_TOOLS+=("antigravity")
        echo -e "    ${GREEN}Found: Antigravity (Gemini)${NC}"
    fi
}

detect_tools

if [ ${#DETECTED_TOOLS[@]} -eq 0 ]; then
    echo -e "    ${YELLOW}No AI tools auto-detected.${NC}"
fi

# If --tool was specified, use that
SELECTED_TOOLS=()
if [ -n "$TOOL_ARG" ]; then
    # Support comma-separated: --tool claude,cursor
    IFS=',' read -ra TOOL_PARTS <<< "$TOOL_ARG"
    for t in "${TOOL_PARTS[@]}"; do
        SELECTED_TOOLS+=("$(echo "$t" | xargs)")  # trim whitespace
    done
    echo -e "${BLUE}>>> Using specified tool(s): ${TOOL_ARG}${NC}"
else
    # Interactive selection
    echo ""
    echo -e "${CYAN}Select which tools to configure:${NC}"
    echo "  1) All detected tools (${DETECTED_TOOLS[*]:-none})"
    echo "  2) Claude Code"
    echo "  3) Cursor"
    echo "  4) Windsurf"
    echo "  5) VS Code (Copilot)"
    echo "  6) Antigravity (Gemini)"
    echo "  7) Headless Bot (OpenClaw, Telegram, API)"
    echo "  8) All tools"
    echo ""

    if prompt_user -rp "  Select option(s) [1-8, comma-separated]: " TOOL_CHOICE; then
        IFS=',' read -ra CHOICES <<< "$TOOL_CHOICE"
        for choice in "${CHOICES[@]}"; do
            choice="$(echo "$choice" | xargs)"
            case "$choice" in
                1) SELECTED_TOOLS=("${DETECTED_TOOLS[@]}") ;;
                2) SELECTED_TOOLS+=("claude") ;;
                3) SELECTED_TOOLS+=("cursor") ;;
                4) SELECTED_TOOLS+=("windsurf") ;;
                5) SELECTED_TOOLS+=("vscode") ;;
                6) SELECTED_TOOLS+=("antigravity") ;;
                7) SELECTED_TOOLS+=("bot") ;;
                8) SELECTED_TOOLS=("claude" "cursor" "windsurf" "vscode" "antigravity") ;;
                *) echo -e "${YELLOW}  Skipping unknown option: $choice${NC}" ;;
            esac
        done
    else
        # Non-interactive: use all detected tools
        SELECTED_TOOLS=("${DETECTED_TOOLS[@]}")
    fi
fi

if [ ${#SELECTED_TOOLS[@]} -eq 0 ]; then
    echo -e "${YELLOW}>>> No tools selected. Skipping MCP config injection.${NC}"
fi

# ── Step 4: Inject MCP Config ──
inject_mcp_config() {
    local tool_key="$1"
    local config_path="$2"
    local config_key="$3"
    local display_name="$4"

    # Handle bot — just output connection info, no file injection
    if [ "$tool_key" = "bot" ]; then
        echo ""
        echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${CYAN}  Bot / API Connection Details${NC}"
        echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo -e "  MCP Endpoint:  ${GREEN}$MCP_URL${NC}"
        echo -e "  API Key:       ${GREEN}$HUB_API_KEY${NC}"
        echo -e "  Auth Header:   ${GREEN}Authorization: Bearer $HUB_API_KEY${NC}"
        echo ""
        echo -e "  ${CYAN}Example (curl):${NC}"
        echo -e "  curl -X POST '$MCP_URL' \\"
        echo -e "    -H 'Content-Type: application/json' \\"
        echo -e "    -H 'Authorization: Bearer $HUB_API_KEY' \\"
        echo -e "    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'"
        echo ""
        echo -e "  ${CYAN}Dashboard API (REST):${NC}"
        DASHBOARD_URL="${MCP_URL%/mcp}"
        DASHBOARD_URL="${DASHBOARD_URL/cortex-mcp/cortex-api}"
        echo -e "  Base URL:      ${GREEN}${DASHBOARD_URL:-http://localhost:4000}${NC}"
        echo -e "  Push Events:   POST /api/webhooks/push"
        echo -e "  Changes:       GET  /api/webhooks/changes?agentId=BOT_ID&projectId=PROJ_ID"
        echo ""
        echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        return
    fi

    echo -e "${BLUE}>>> Configuring $display_name...${NC}"

    # Resolve path
    config_path=$(resolve_config_path "$config_path")

    # Ensure parent directory exists
    local config_dir
    config_dir=$(dirname "$config_path")
    mkdir -p "$config_dir"

    # Create empty config if it doesn't exist
    if [ ! -f "$config_path" ]; then
        echo "{}" > "$config_path"
        echo -e "    Created $config_path"
    fi

    # Build MCP server entry based on tool
    # Claude Code uses a different format than other tools
    if [ "$tool_key" = "claude" ]; then
        # Claude Code: ~/.claude.json uses mcpServers with command/args
        python3 -c "
import json
path = '$config_path'
with open(path, 'r') as f: config = json.load(f)
if '$config_key' not in config: config['$config_key'] = {}
config['$config_key']['cortex-hub'] = {
    'command': 'npx',
    'args': ['-y', 'mcp-remote', '$MCP_URL', '--header', 'Authorization: Bearer \${HUB_API_KEY}'],
    'env': {
        'HUB_API_KEY': '$HUB_API_KEY'
    }
}
with open(path, 'w') as f: json.dump(config, f, indent=2)
print('    Injected cortex-hub into $config_key')
"
    elif [ "$tool_key" = "vscode" ]; then
        # VS Code: uses "servers" key with "type": "stdio"
        python3 -c "
import json
path = '$config_path'
with open(path, 'r') as f: config = json.load(f)
if '$config_key' not in config: config['$config_key'] = {}
config['$config_key']['cortex-hub'] = {
    'type': 'stdio',
    'command': 'npx',
    'args': ['-y', 'mcp-remote', '$MCP_URL', '--header', 'Authorization: Bearer \${HUB_API_KEY}'],
    'env': {
        'HUB_API_KEY': '$HUB_API_KEY'
    }
}
with open(path, 'w') as f: json.dump(config, f, indent=2)
print('    Injected cortex-hub into $config_key')
"
    else
        # Cursor, Windsurf, Antigravity: standard mcpServers format
        python3 -c "
import json
path = '$config_path'
with open(path, 'r') as f: config = json.load(f)
if '$config_key' not in config: config['$config_key'] = {}
config['$config_key']['cortex-hub'] = {
    'command': 'npx',
    'args': ['-y', 'mcp-remote', '$MCP_URL', '--header', 'Authorization: Bearer \${HUB_API_KEY}'],
    'env': {
        'HUB_API_KEY': '$HUB_API_KEY'
    }
}
with open(path, 'w') as f: json.dump(config, f, indent=2)
print('    Injected cortex-hub into $config_key')
"
    fi

    echo -e "    ${GREEN}$display_name configured at $config_path${NC}"
}

# Process selected tools
CONFIGURED_TOOLS=()
for tool_key in "${SELECTED_TOOLS[@]}"; do
    # Look up tool in registry
    for entry in "${TOOL_REGISTRY[@]}"; do
        IFS='|' read -r key display_name config_path config_key <<< "$entry"
        if [ "$key" = "$tool_key" ]; then
            inject_mcp_config "$key" "$config_path" "$config_key" "$display_name"
            CONFIGURED_TOOLS+=("$display_name")
            break
        fi
    done
done

# ── Step 4b: Generate CLAUDE.md for Claude Code ──
HAS_CLAUDE=false
for t in "${SELECTED_TOOLS[@]}"; do [ "$t" = "claude" ] && HAS_CLAUDE=true; done

if $HAS_CLAUDE; then
    GIT_REPO_URL=$(git remote get-url origin 2>/dev/null || echo "unknown")
    CORTEX_MARKER="<!-- cortex-hub:auto-mcp -->"

    # Check if cortex instructions already injected
    if [ -f "CLAUDE.md" ] && grep -q "$CORTEX_MARKER" CLAUDE.md 2>/dev/null; then
        echo -e "${GREEN}>>> CLAUDE.md already has Cortex Hub instructions — skipping${NC}"
    else
        if [ -f "CLAUDE.md" ]; then
            echo -e "${BLUE}>>> Appending Cortex Hub instructions to existing CLAUDE.md...${NC}"
        else
            echo -e "${BLUE}>>> Creating CLAUDE.md with Cortex Hub instructions...${NC}"
        fi

        cat >> CLAUDE.md <<CLAUDEEOF

$CORTEX_MARKER
## Cortex Hub — Auto MCP (MANDATORY — every conversation)

At the START of every conversation, before doing anything else:

1. Call \`cortex_session_start\` with:
   \`\`\`
   repo: "$GIT_REPO_URL"
   mode: "development"
   agentId: "claude-code"
   \`\`\`
   This returns project context AND unseen code changes from other agents.

2. If \`recentChanges.count > 0\` in the response, warn the user and run \`git pull\` before editing any affected files.

3. Read \`STATE.md\` for current task progress (if it exists).

### Before editing shared files

Call \`cortex_changes\` to check if another agent modified the same files:
\`\`\`
agentId: "claude-code"
projectId: "<from session_start response>"
\`\`\`

### After pushing code

Call \`cortex_code_reindex\` to update code intelligence:
\`\`\`
repo: "$GIT_REPO_URL"
branch: "<current branch>"
\`\`\`

### Quality gates

Every session must end with verification commands from \`.cortex/project-profile.json\`.
Call \`cortex_quality_report\` with results.
$CORTEX_MARKER
CLAUDEEOF
        echo -e "${GREEN}>>> CLAUDE.md updated${NC}"
    fi
fi

# ── Step 5: Scan & Detect Project Stack ──
echo ""
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

# ── Step 6: Install Lefthook & Generate Git Hooks ──
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
    key = cmd_str.replace(' ', '_').replace('/', '_').replace('-', '_').lower()
    key = key.strip('_')
    return key or f'step_{index}'

lines = []

if pre_commit:
    lines.append('pre-commit:')
    lines.append('  parallel: true')
    lines.append('  commands:')
    for i, cmd in enumerate(pre_commit):
        if isinstance(cmd, dict):
            name = cmd.get('name', f'step_{i}').lower().replace(' ', '_')
            run_cmd = cmd.get('cmd', '')
        else:
            name = cmd_to_key(cmd, i)
            run_cmd = cmd
        lines.append(f'    {name}:')
        lines.append(f'      run: {run_cmd}')

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

# Post-push: notify Cortex API about code changes
lines.append('')
lines.append('post-push:')
lines.append('  commands:')
lines.append('    notify_cortex:')
lines.append('      run: |')
lines.append('        if [ -n \"\$CORTEX_API_URL\" ]; then')
lines.append('          BRANCH=\$(git rev-parse --abbrev-ref HEAD)')
lines.append('          REPO=\$(git remote get-url origin 2>/dev/null || echo \"\")')
lines.append('          COMMIT_SHA=\$(git rev-parse HEAD)')
lines.append('          COMMIT_MSG=\$(git log -1 --pretty=%s)')
lines.append('          FILES=\$(git diff --name-only HEAD~1 HEAD 2>/dev/null | jq -R -s \'split(\"\\n\") | map(select(. != \"\"))\' 2>/dev/null || echo \"[]\")')
lines.append('          curl -s -X POST \"\$CORTEX_API_URL/api/webhooks/local-push\" \\\\')
lines.append('            -H \"Content-Type: application/json\" \\\\')
lines.append('            -d \"{\\\"repo\\\":\\\"\$REPO\\\",\\\"branch\\\":\\\"\$BRANCH\\\",\\\"commitSha\\\":\\\"\$COMMIT_SHA\\\",\\\"commitMessage\\\":\\\"\$COMMIT_MSG\\\",\\\"filesChanged\\\":\$FILES}\" \\\\')
lines.append('            > /dev/null 2>&1 || true')
lines.append('        fi')

with open('lefthook.yml', 'w') as f:
    f.write('\n'.join(lines) + '\n')
print('Generated lefthook.yml')
"

    # Remove legacy .husky directory and unset core.hooksPath if it points there
    if [ -d ".husky" ]; then
        echo -e "${YELLOW}>>> Removing legacy .husky/ (replaced by Lefthook)${NC}"
        rm -rf .husky
    fi
    HOOKS_PATH=$(git config --local core.hooksPath 2>/dev/null || echo "")
    if [ -n "$HOOKS_PATH" ]; then
        echo -e "${YELLOW}>>> Unsetting core.hooksPath ($HOOKS_PATH) for Lefthook compatibility${NC}"
        git config --unset core.hooksPath 2>/dev/null || true
    fi

    # Install hooks
    if command -v lefthook >/dev/null 2>&1; then
        lefthook install
        echo -e "${GREEN}>>> Git hooks installed via Lefthook${NC}"
    else
        echo -e "${RED}>>> Warning: Lefthook install failed. Git hooks not active.${NC}"
    fi
else
    echo -e "${YELLOW}>>> No project-profile.json found. Skipping hook setup.${NC}"
fi

# ── Step 7: Sync AGENTS.md ──
if [ -f AGENTS.md ]; then
    echo -e "${GREEN}>>> Found AGENTS.md — agent rules are active${NC}"
fi

# ── Step 8: Session Start ──
echo -e "${BLUE}>>> Announcing agent availability...${NC}"
if command -v gitnexus >/dev/null 2>&1; then
    gitnexus audit --local || true
fi

curl -s -o /dev/null -X POST "$MCP_URL/session/start" \
     -H "Authorization: Bearer $HUB_API_KEY" \
     -H "Content-Type: application/json" \
     -d "{\"repo\": \"$GIT_REPO\", \"mode\": \"onboarding\"}" 2>/dev/null || true

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}>>> Onboarding Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "    Stack:     ${BLUE}$PKG_MANAGER${NC}"
echo -e "    Profile:   ${BLUE}$PROFILE_PATH${NC}"
echo -e "    Hooks:     ${BLUE}lefthook (pre-commit + pre-push + post-push)${NC}"
echo -e "    Rules:     ${BLUE}AGENTS.md${NC}"
if [ ${#CONFIGURED_TOOLS[@]} -gt 0 ]; then
    echo -e "    Tools:     ${BLUE}${CONFIGURED_TOOLS[*]}${NC}"
fi
echo ""
echo -e "    ${YELLOW}Enforcement: git commit/push will FAIL if verify doesn't pass.${NC}"
echo -e "${BLUE}>>> Happy Coding!${NC}"
