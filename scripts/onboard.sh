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
    -H "Accept: application/json, text/event-stream" \
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
        echo -e "    -H 'Accept: application/json, text/event-stream' \\"
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

# ── Step 4b: Generate IDE instruction files with correct agentId ──
# Maps tool key → agentId used in cortex_session_start
# Each IDE has its own instruction file format
GIT_REPO_URL=$(git remote get-url origin 2>/dev/null || echo "unknown")
CORTEX_MARKER="<!-- cortex-hub:auto-mcp -->"

generate_cortex_instructions() {
    local agent_id="$1"
    cat <<INSTREOF
$CORTEX_MARKER
## Cortex Hub — Auto MCP (MANDATORY — every conversation)

At the START of every conversation, before doing anything else:

1. Call \`cortex_session_start\` with:
   \`\`\`
   repo: "$GIT_REPO_URL"
   mode: "development"
   agentId: "$agent_id"
   \`\`\`
   This returns project context AND unseen code changes from other agents.

2. If \`recentChanges.count > 0\` in the response, warn the user and run \`git pull\` before editing any affected files.

3. Read \`STATE.md\` for current task progress (if it exists).

### Before editing shared files

Call \`cortex_changes\` to check if another agent modified the same files:
\`\`\`
agentId: "$agent_id"
projectId: "<from session_start response>"
\`\`\`

### When encountering an error or bug (MANDATORY)

1. First search \`cortex_knowledge_search\` or \`cortex_memory_search\` for the error message.
2. Fix the error.
3. If the fix was non-obvious, **YOU MUST** use \`cortex_knowledge_store\` to record the problem and solution so you (and others) don't have to debug it again.

### After pushing code

Call \`cortex_code_reindex\` to update code intelligence:
\`\`\`
repo: "$GIT_REPO_URL"
branch: "<current branch>"
\`\`\`

### Quality gates

Every session must end with verification commands from \`.cortex/project-profile.json\`.
Call \`cortex_quality_report\` with results.
Call \`cortex_session_end\` to close the session.
$CORTEX_MARKER
INSTREOF
}

inject_instructions_to_file() {
    local file="$1"
    local agent_id="$2"
    local label="$3"

    if [ -f "$file" ] && grep -q "$CORTEX_MARKER" "$file" 2>/dev/null; then
        # Already injected — update agentId in case tool changed
        sed -i.bak "s/agentId: \"[^\"]*\"/agentId: \"$agent_id\"/g" "$file" && rm -f "${file}.bak"
        echo -e "${GREEN}>>> $label already has Cortex instructions — updated agentId to '$agent_id'${NC}"
    else
        if [ -f "$file" ]; then
            echo -e "${BLUE}>>> Appending Cortex Hub instructions to $label...${NC}"
        else
            echo -e "${BLUE}>>> Creating $label with Cortex Hub instructions...${NC}"
        fi
        echo "" >> "$file"
        generate_cortex_instructions "$agent_id" >> "$file"
        echo -e "${GREEN}>>> $label updated (agentId: $agent_id)${NC}"
    fi
}

# Antigravity-specific: enriched GEMINI.md with full tool enforcement
generate_antigravity_instructions() {
    cat <<'ANTIGRAVITYEOF'

<!-- cortex-hub:auto-mcp -->
## Cortex Hub — Auto MCP (MANDATORY — every conversation)

At the START of every conversation, before doing anything else:

1. Call `cortex_session_start` with:
   ```
   repo: "https://github.com/lktiep/cortex-hub.git"
   mode: "development"
   agentId: "antigravity"
   ```
   This returns project context AND unseen code changes from other agents.

2. If `recentChanges.count > 0` in the response, warn the user and run `git pull` before editing any affected files.

3. Read `STATE.md` for current task progress (if it exists).

### Before editing shared files

Call `cortex_changes` to check if another agent modified the same files:
```
agentId: "antigravity"
projectId: "<from session_start response>"
```

### When encountering an error or bug (MANDATORY)

1. First search `cortex_knowledge_search` or `cortex_memory_search` for the error message.
2. Fix the error.
3. If the fix was non-obvious, **YOU MUST** use `cortex_knowledge_store` to record the problem and solution so you (and others) don't have to debug it again.

### After pushing code

Call `cortex_code_reindex` to update code intelligence:
```
repo: "https://github.com/lktiep/cortex-hub.git"
branch: "<current branch>"
```

### Quality gates

Every session must end with verification commands from `.cortex/project-profile.json`.
Call `cortex_quality_report` with results.
Call `cortex_session_end` to close the session.

---

## ⚠️ Tool Usage Enforcement (MANDATORY)

> **You MUST use Cortex tools throughout the session. Skipping them defeats the purpose of Cortex Hub.**
> If any tool is missing or fails with `fetch failed`, immediately inform the user to refresh the MCP server connection.

### Complete Tool Reference (14 tools)

| # | Tool | When to Use | Required Args |
|---|------|-------------|---------------|
| 1 | `cortex_session_start` | Start of EVERY conversation | `repo`, `agentId`, `mode` |
| 2 | `cortex_session_end` | End of EVERY session | `sessionId` |
| 3 | `cortex_changes` | Before editing shared files | `agentId`, `projectId` |
| 4 | `cortex_code_search` | **BEFORE** grep/find — use FIRST | `query`, optional `projectId` |
| 5 | `cortex_code_impact` | Before editing core code | `target` (function/class/file) |
| 6 | `cortex_detect_changes` | Before committing — pre-commit risk analysis | optional `scope`, `projectId` |
| 7 | `cortex_cypher` | Advanced graph queries (find callers, trace deps) | `query` (Cypher syntax) |
| 8 | `cortex_code_reindex` | After EVERY push | `repo`, `branch` |
| 9 | `cortex_memory_search` | Recall past decisions/findings | `query` |
| 10 | `cortex_memory_store` | Store session findings | `content` |
| 11 | `cortex_knowledge_search` | Search **FIRST** when encountering errors | `query` |
| 12 | `cortex_knowledge_store` | **MANDATORY**: Contribute bug fixes & patterns | `title`, `content` |
| 13 | `cortex_quality_report` | After running verify commands | `gate_name`, `passed`, `details`, `agent_id` |
| 14 | `cortex_health` | Check service health | (none) |

### Tool Priority Order (MANDATORY — before grep/find)

1. `cortex_memory_search` → check if you already know this
2. `cortex_knowledge_search` → search shared knowledge base
3. `cortex_code_search` → search indexed codebase (GitNexus AST)
4. `cortex_code_impact` → check blast radius before editing
5. `cortex_detect_changes` → pre-commit risk analysis
6. `cortex_cypher` → advanced graph queries (Cypher syntax)
7. `grep_search` / `find_by_name` → fallback ONLY if Cortex tools unavailable

### Post-Push Checklist (NEVER skip)

```
1. pnpm build && pnpm typecheck && pnpm lint                    ← verify
2. cortex_quality_report(gate, passed, details, agent_id)       ← report (agent_id: "antigravity")
3. cortex_code_reindex(repo, branch)                            ← update code intelligence
4. cortex_memory_store(content, projectId)                      ← store findings
5. cortex_session_end(sessionId)                                ← close session
```

### Tool Verification

If you see fewer than 14 tools from `cortex-hub` MCP server, the connection may be stale.
**Action:** Immediately inform the user: "MCP tools are incomplete. Please refresh the cortex-hub MCP server connection."
<!-- cortex-hub:auto-mcp -->
ANTIGRAVITYEOF
}

for tool_key in "${SELECTED_TOOLS[@]}"; do
    case "$tool_key" in
        claude)
            inject_instructions_to_file "CLAUDE.md" "claude-code" "CLAUDE.md"
            ;;
        cursor)
            inject_instructions_to_file ".cursorrules" "cursor" ".cursorrules"
            ;;
        windsurf)
            inject_instructions_to_file ".windsurfrules" "windsurf" ".windsurfrules"
            ;;
        vscode)
            mkdir -p .vscode
            inject_instructions_to_file ".vscode/copilot-instructions.md" "vscode-copilot" ".vscode/copilot-instructions.md"
            ;;
        antigravity)
            # Antigravity gets enriched GEMINI.md with full tool enforcement
            # Uses marker-based injection: replaces content between cortex markers,
            # preserving any user content outside the markers.
            echo -e "${BLUE}>>> Generating enriched GEMINI.md for Antigravity...${NC}"
            GEMINI_FILE="GEMINI.md"
            ANTIGRAVITY_CONTENT=$(generate_antigravity_instructions)

            if [ -f "$GEMINI_FILE" ] && grep -q "$CORTEX_MARKER" "$GEMINI_FILE" 2>/dev/null; then
                # File exists with markers — replace content between markers
                python3 -c "
import re
with open('$GEMINI_FILE', 'r') as f:
    content = f.read()
marker = '$CORTEX_MARKER'
pattern = re.escape(marker) + r'.*?' + re.escape(marker)
replacement = '''$ANTIGRAVITY_CONTENT'''
new_content = re.sub(pattern, replacement.strip(), content, flags=re.DOTALL)
with open('$GEMINI_FILE', 'w') as f:
    f.write(new_content)
print('    Updated cortex section (preserved other content)')
"
            else
                # File doesn't exist or no markers — write fresh
                echo "$ANTIGRAVITY_CONTENT" > "$GEMINI_FILE"
                echo -e "    Created $GEMINI_FILE"
            fi
            echo -e "${GREEN}>>> GEMINI.md updated with full tool reference${NC}"
            ;;
        bot)
            echo -e "${YELLOW}>>> Bot mode: agentId should be passed via API call${NC}"
            ;;
    esac
done

# ── Step 4c: Verify Tool Count ──
echo ""
echo -e "${BLUE}>>> Verifying MCP tool count...${NC}"
TOOL_COUNT_RESPONSE=$(curl -s -m 10 \
    -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $HUB_API_KEY" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null || echo "{}")

EXPECTED_TOOLS=14
ACTUAL_TOOLS=$(echo "$TOOL_COUNT_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('result',{}).get('tools',[]))" 2>/dev/null || echo "0")

if [ "$ACTUAL_TOOLS" -ge "$EXPECTED_TOOLS" ] 2>/dev/null; then
    echo -e "${GREEN}    ✓ MCP tools: $ACTUAL_TOOLS/$EXPECTED_TOOLS available${NC}"
elif [ "$ACTUAL_TOOLS" -gt 0 ] 2>/dev/null; then
    echo -e "${YELLOW}    ⚠ MCP tools: $ACTUAL_TOOLS/$EXPECTED_TOOLS — some tools may be missing!${NC}"
    echo -e "${YELLOW}    → Refresh MCP server connection in your IDE if tools seem incomplete.${NC}"
else
    echo -e "${YELLOW}    ⚠ Could not verify tool count (MCP may use SSE). Tools will be available after IDE restart.${NC}"
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
lines.append('          FILES=\$(git diff --name-only HEAD~1 HEAD 2>/dev/null | jq -R -s \'split(\"\\\\n\") | map(select(. != \"\"))\' 2>/dev/null || echo \"[]\")')
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

# ── Step 6b: Install Claude Code Enforcement Hooks ──
# Claude Code is the ONLY IDE that supports runtime hooks (PreToolUse, PostToolUse, etc.)
# For other IDEs, enforcement is instruction-based only + server-side validation.

CLAUDE_DIR=".claude"
CLAUDE_HOOKS_DIR="$CLAUDE_DIR/hooks"
CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"

# Check if Claude Code is one of the configured tools
INSTALL_CLAUDE_HOOKS=false
for tool in "${SELECTED_TOOLS[@]}"; do
    if [ "$tool" = "claude" ]; then
        INSTALL_CLAUDE_HOOKS=true
        break
    fi
done

if [ "$INSTALL_CLAUDE_HOOKS" = true ]; then
    echo -e "${BLUE}>>> Installing Claude Code enforcement hooks...${NC}"
    mkdir -p "$CLAUDE_HOOKS_DIR"

    # ── Hook 1: session-init.sh — Inject mandatory session_start reminder ──
    cat > "$CLAUDE_HOOKS_DIR/session-init.sh" <<'HOOKEOF'
#!/bin/bash
# Cortex Session Init — Injects mandatory reminder + resets session markers.
CORTEX_STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.cortex/.session-state"
mkdir -p "$CORTEX_STATE_DIR"
rm -f "$CORTEX_STATE_DIR/session-started" "$CORTEX_STATE_DIR/quality-gates-passed" \
      "$CORTEX_STATE_DIR/gate-build" "$CORTEX_STATE_DIR/gate-typecheck" "$CORTEX_STATE_DIR/gate-lint" \
      "$CORTEX_STATE_DIR/session-ended" 2>/dev/null
cat <<'MSG'
MANDATORY SESSION PROTOCOL — You MUST complete these steps NOW before any other work:
1. Call cortex_session_start with repo, mode: "development", agentId: "claude-code"
2. If recentChanges.count > 0, warn user and run git pull
3. Read STATE.md for current task progress
DO NOT proceed with any code changes until step 1 is complete.
MSG
HOOKEOF

    # ── Hook 2: enforce-commit.sh — Block git commit without quality gates ──
    cat > "$CLAUDE_HOOKS_DIR/enforce-commit.sh" <<'HOOKEOF'
#!/bin/bash
# Cortex Commit Enforcement — Blocks git commit if quality gates haven't passed.
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [[ ! "$COMMAND" =~ ^git\ (commit|push) ]]; then exit 0; fi
CORTEX_STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.cortex/.session-state"
if [[ "$COMMAND" =~ ^git\ commit ]]; then
  if [ ! -f "$CORTEX_STATE_DIR/quality-gates-passed" ]; then
    echo "Quality gates not passed. Run: pnpm build && pnpm typecheck && pnpm lint first, then call cortex_quality_report." >&2
    exit 2
  fi
fi
if [[ "$COMMAND" =~ ^git\ push ]]; then
  echo "REMINDER: After push, call cortex_code_reindex to update code intelligence." >&2
fi
exit 0
HOOKEOF

    # ── Hook 3: track-quality.sh — Track quality gate passes + MCP calls ──
    cat > "$CLAUDE_HOOKS_DIR/track-quality.sh" <<'HOOKEOF'
#!/bin/bash
# Cortex Quality Tracker — Marks gates as passed when build/typecheck/lint succeed.
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
CORTEX_STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.cortex/.session-state"
mkdir -p "$CORTEX_STATE_DIR"
[[ "$COMMAND" =~ pnpm\ build ]] && touch "$CORTEX_STATE_DIR/gate-build"
[[ "$COMMAND" =~ pnpm\ typecheck ]] && touch "$CORTEX_STATE_DIR/gate-typecheck"
[[ "$COMMAND" =~ pnpm\ lint ]] && touch "$CORTEX_STATE_DIR/gate-lint"
if [ -f "$CORTEX_STATE_DIR/gate-build" ] && [ -f "$CORTEX_STATE_DIR/gate-typecheck" ] && [ -f "$CORTEX_STATE_DIR/gate-lint" ]; then
  touch "$CORTEX_STATE_DIR/quality-gates-passed"
fi
[[ "$TOOL_NAME" =~ cortex_session_start ]] && touch "$CORTEX_STATE_DIR/session-started"
[[ "$TOOL_NAME" =~ cortex_session_end ]] && touch "$CORTEX_STATE_DIR/session-ended"
exit 0
HOOKEOF

    # ── Hook 4: session-end-check.sh — Warn if session_end not called ──
    cat > "$CLAUDE_HOOKS_DIR/session-end-check.sh" <<'HOOKEOF'
#!/bin/bash
# Cortex Session End Check — Warns if cortex_session_end not called.
CORTEX_STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.cortex/.session-state"
if [ -f "$CORTEX_STATE_DIR/session-started" ] && [ ! -f "$CORTEX_STATE_DIR/session-ended" ]; then
  echo "WARNING: cortex_session_end has not been called. Call it with sessionId and summary before ending."
fi
exit 0
HOOKEOF

    # ── Hook 5: enforce-session.sh — HARD BLOCK Edit/Write/Bash without session ──
    cat > "$CLAUDE_HOOKS_DIR/enforce-session.sh" <<'HOOKEOF'
#!/bin/bash
# Cortex Session Enforcement — HARD BLOCK.
# Blocks Edit, Write, Bash (file-modifying) if cortex_session_start hasn't been called.
CORTEX_STATE_DIR="${CLAUDE_PROJECT_DIR:-.}/.cortex/.session-state"
if [ -f "$CORTEX_STATE_DIR/session-started" ]; then exit 0; fi
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit)
    echo "BLOCKED: Call cortex_session_start before editing files. Session not started." >&2
    exit 2
    ;;
  Bash)
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
    if [[ "$COMMAND" =~ ^(ls|cat|head|tail|pwd|which|echo|git\ (status|log|diff|branch|remote)|pnpm\ (build|typecheck|lint|test)|curl|python3\ -m\ json) ]]; then
      exit 0
    fi
    if [[ "$COMMAND" =~ (git\ (add|commit|push|reset)|rm\ |mv\ |cp\ |mkdir\ |touch\ |chmod\ |sed\ -i|">" ) ]]; then
      echo "BLOCKED: Call cortex_session_start before modifying files. Session not started." >&2
      exit 2
    fi
    exit 0
    ;;
esac
exit 0
HOOKEOF

    chmod +x "$CLAUDE_HOOKS_DIR"/*.sh

    # ── Generate .claude/settings.json with hooks (merge with existing if present) ──
    python3 -c "
import json, os

settings_path = '$CLAUDE_SETTINGS'
hooks_config = {
    'hooks': {
        'SessionStart': [{
            'matcher': '',
            'hooks': [{'type': 'command', 'command': '.claude/hooks/session-init.sh'}]
        }],
        'PreToolUse': [
            {
                'matcher': 'Edit|Write|NotebookEdit|Bash',
                'hooks': [{'type': 'command', 'command': '.claude/hooks/enforce-session.sh'}]
            },
            {
                'matcher': 'Bash',
                'hooks': [{'type': 'command', 'command': '.claude/hooks/enforce-commit.sh'}]
            }
        ],
        'PostToolUse': [{
            'matcher': '',
            'hooks': [{'type': 'command', 'command': '.claude/hooks/track-quality.sh'}]
        }],
        'Stop': [{
            'matcher': '',
            'hooks': [{'type': 'command', 'command': '.claude/hooks/session-end-check.sh'}]
        }]
    }
}

existing = {}
if os.path.exists(settings_path):
    try:
        with open(settings_path) as f:
            existing = json.load(f)
    except (json.JSONDecodeError, IOError):
        existing = {}

existing['hooks'] = hooks_config['hooks']

with open(settings_path, 'w') as f:
    json.dump(existing, f, indent=2)
    f.write('\n')
"

    echo -e "${GREEN}    ✓ Claude Code hooks installed (5 enforcement hooks)${NC}"
    echo -e "${GREEN}      SessionStart  → session-init.sh (inject reminder)${NC}"
    echo -e "${GREEN}      PreToolUse    → enforce-session.sh (BLOCK edit/write without session)${NC}"
    echo -e "${GREEN}      PreToolUse    → enforce-commit.sh (BLOCK commit without gates)${NC}"
    echo -e "${GREEN}      PostToolUse   → track-quality.sh (track gate passes + MCP calls)${NC}"
    echo -e "${GREEN}      Stop          → session-end-check.sh (session_end reminder)${NC}"
else
    echo -e "${YELLOW}>>> Claude Code not selected — skipping Claude hooks${NC}"
fi

# ── Step 6c: Install Gemini CLI Enforcement Hooks ──
# Gemini CLI (v0.26+) supports hooks similar to Claude Code:
#   BeforeTool (can block), AfterTool, SessionStart, SessionEnd, BeforeModel, etc.
# Config: .gemini/settings.json (project-level)

GEMINI_DIR=".gemini"
GEMINI_HOOKS_DIR="$GEMINI_DIR/hooks"
GEMINI_SETTINGS="$GEMINI_DIR/settings.json"

INSTALL_GEMINI_HOOKS=false
for tool in "${SELECTED_TOOLS[@]}"; do
    if [ "$tool" = "antigravity" ]; then
        INSTALL_GEMINI_HOOKS=true
        break
    fi
done

if [ "$INSTALL_GEMINI_HOOKS" = true ]; then
    echo -e "${BLUE}>>> Installing Gemini CLI enforcement hooks...${NC}"
    mkdir -p "$GEMINI_HOOKS_DIR"

    # ── Hook 1: session-init.sh — Inject mandatory session_start reminder ──
    cat > "$GEMINI_HOOKS_DIR/session-init.sh" <<'HOOKEOF'
#!/bin/bash
# Cortex Session Init (Gemini) — Resets session markers + injects reminder.
CORTEX_STATE_DIR=".cortex/.session-state"
mkdir -p "$CORTEX_STATE_DIR"
rm -f "$CORTEX_STATE_DIR/session-started" "$CORTEX_STATE_DIR/quality-gates-passed" \
      "$CORTEX_STATE_DIR/gate-build" "$CORTEX_STATE_DIR/gate-typecheck" "$CORTEX_STATE_DIR/gate-lint" \
      "$CORTEX_STATE_DIR/session-ended" 2>/dev/null
cat <<'MSG'
{"systemMessage": "MANDATORY: Call cortex_session_start(repo, mode: 'development', agentId: 'antigravity') NOW before any work."}
MSG
HOOKEOF

    # ── Hook 2: enforce-commit.sh — Block shell commands (git commit) without quality gates ──
    cat > "$GEMINI_HOOKS_DIR/enforce-commit.sh" <<'HOOKEOF'
#!/bin/bash
# Cortex Commit Enforcement (Gemini) — Blocks git commit without quality gates.
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Only intercept shell commands
if [[ "$TOOL_NAME" != "run_shell_command" ]] && [[ "$TOOL_NAME" != "shell" ]]; then
  echo '{"decision":"allow"}'
  exit 0
fi

CORTEX_STATE_DIR=".cortex/.session-state"

if [[ "$COMMAND" =~ ^git\ commit ]]; then
  if [ ! -f "$CORTEX_STATE_DIR/quality-gates-passed" ]; then
    echo '{"decision":"deny","reason":"Quality gates not passed. Run: pnpm build && pnpm typecheck && pnpm lint first."}'
    exit 0
  fi
fi

echo '{"decision":"allow"}'
exit 0
HOOKEOF

    # ── Hook 3: track-quality.sh — Track quality gate passes + MCP calls ──
    cat > "$GEMINI_HOOKS_DIR/track-quality.sh" <<'HOOKEOF'
#!/bin/bash
# Cortex Quality Tracker (Gemini) — Marks gates as passed after successful commands.
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
CORTEX_STATE_DIR=".cortex/.session-state"
mkdir -p "$CORTEX_STATE_DIR"

# Track shell command results
[[ "$COMMAND" =~ pnpm\ build ]] && touch "$CORTEX_STATE_DIR/gate-build"
[[ "$COMMAND" =~ pnpm\ typecheck ]] && touch "$CORTEX_STATE_DIR/gate-typecheck"
[[ "$COMMAND" =~ pnpm\ lint ]] && touch "$CORTEX_STATE_DIR/gate-lint"
if [ -f "$CORTEX_STATE_DIR/gate-build" ] && [ -f "$CORTEX_STATE_DIR/gate-typecheck" ] && [ -f "$CORTEX_STATE_DIR/gate-lint" ]; then
  touch "$CORTEX_STATE_DIR/quality-gates-passed"
fi

# Track MCP tool calls
[[ "$TOOL_NAME" =~ cortex_session_start ]] && touch "$CORTEX_STATE_DIR/session-started"
[[ "$TOOL_NAME" =~ cortex_session_end ]] && touch "$CORTEX_STATE_DIR/session-ended"

echo '{}'
exit 0
HOOKEOF

    # ── Hook 4: session-end-check.sh — Warn if session_end not called ──
    cat > "$GEMINI_HOOKS_DIR/session-end-check.sh" <<'HOOKEOF'
#!/bin/bash
# Cortex Session End Check (Gemini) — Warns if session_end not called.
CORTEX_STATE_DIR=".cortex/.session-state"
if [ -f "$CORTEX_STATE_DIR/session-started" ] && [ ! -f "$CORTEX_STATE_DIR/session-ended" ]; then
  echo '{"systemMessage":"WARNING: cortex_session_end not called. Call it with sessionId and summary."}'
else
  echo '{}'
fi
exit 0
HOOKEOF

    # ── Hook 5: enforce-session.sh — HARD BLOCK write_file/edit_file without session ──
    cat > "$GEMINI_HOOKS_DIR/enforce-session.sh" <<'HOOKEOF'
#!/bin/bash
# Cortex Session Enforcement (Gemini) — HARD BLOCK.
# Blocks write_file, edit_file, run_shell_command (modifying) without session.
CORTEX_STATE_DIR=".cortex/.session-state"
if [ -f "$CORTEX_STATE_DIR/session-started" ]; then
  echo '{"decision":"allow"}'
  exit 0
fi
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
case "$TOOL_NAME" in
  write_file|edit_file|create_file|insert_text)
    echo '{"decision":"deny","reason":"BLOCKED: Call cortex_session_start before editing files. Session not started."}'
    exit 0
    ;;
  run_shell_command|shell)
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
    if [[ "$COMMAND" =~ (git\ (add|commit|push)|rm\ |mv\ |cp\ |mkdir\ ) ]]; then
      echo '{"decision":"deny","reason":"BLOCKED: Call cortex_session_start before modifying files. Session not started."}'
      exit 0
    fi
    ;;
esac
echo '{"decision":"allow"}'
exit 0
HOOKEOF

    chmod +x "$GEMINI_HOOKS_DIR"/*.sh

    # ── Generate .gemini/settings.json with hooks ──
    python3 -c "
import json, os

settings_path = '$GEMINI_SETTINGS'
hooks_config = {
    'hooks': {
        'SessionStart': [{
            'hooks': [{
                'type': 'command',
                'command': '.gemini/hooks/session-init.sh',
                'name': 'cortex_session_init'
            }]
        }],
        'BeforeTool': [
            {
                'matcher': 'write_file|edit_file|create_file|insert_text|run_shell_command|shell',
                'hooks': [{
                    'type': 'command',
                    'command': '.gemini/hooks/enforce-session.sh',
                    'name': 'cortex_enforce_session'
                }]
            },
            {
                'matcher': 'run_shell_command|shell',
                'hooks': [{
                    'type': 'command',
                    'command': '.gemini/hooks/enforce-commit.sh',
                    'name': 'cortex_enforce_commit'
                }]
            }
        ],
        'AfterTool': [{
            'matcher': '.*',
            'hooks': [{
                'type': 'command',
                'command': '.gemini/hooks/track-quality.sh',
                'name': 'cortex_track_quality'
            }]
        }],
        'SessionEnd': [{
            'hooks': [{
                'type': 'command',
                'command': '.gemini/hooks/session-end-check.sh',
                'name': 'cortex_session_end_check'
            }]
        }]
    }
}

existing = {}
if os.path.exists(settings_path):
    try:
        with open(settings_path) as f:
            existing = json.load(f)
    except (json.JSONDecodeError, IOError):
        existing = {}

existing['hooks'] = hooks_config['hooks']

with open(settings_path, 'w') as f:
    json.dump(existing, f, indent=2)
    f.write('\n')
"

    echo -e "${GREEN}    ✓ Gemini CLI hooks installed (4 enforcement hooks)${NC}"
    echo -e "${GREEN}      SessionStart  → session-init.sh (inject reminder)${NC}"
    echo -e "${GREEN}      BeforeTool    → enforce-commit.sh (block commit without gates)${NC}"
    echo -e "${GREEN}      AfterTool     → track-quality.sh (track gate passes)${NC}"
    echo -e "${GREEN}      SessionEnd    → session-end-check.sh (session_end reminder)${NC}"
else
    echo -e "${YELLOW}>>> Gemini CLI not selected — skipping Gemini hooks${NC}"
fi

# ── Step 7: Generate .cortex/agent-rules.md (Cortex-managed) ──
# This file is FULLY managed by the onboard script. It can be regenerated anytime.
# AGENTS.md is the PROJECT TEAM's file — we only append a reference line, never modify content.

CORTEX_RULES_PATH="$CORTEX_DIR/agent-rules.md"
CORTEX_RULES_VERSION="2"  # Bump when updating rules content
CORTEX_RULES_REF='> 📋 **Cortex Hub rules:** See [.cortex/agent-rules.md](.cortex/agent-rules.md) for MCP tool usage guidelines.'
CORTEX_REF_MARKER="<!-- cortex-hub:agent-rules -->"

echo -e "${BLUE}>>> Generating $CORTEX_RULES_PATH (v${CORTEX_RULES_VERSION})...${NC}"

cat > "$CORTEX_RULES_PATH" <<'RULESEOF'
# Cortex Hub — Agent Rules
<!-- cortex-rules-version: CORTEX_VERSION_PLACEHOLDER -->

> These rules are auto-generated by `scripts/onboard.sh`.
> Do NOT edit manually — changes will be overwritten on next onboard.

---

## During Session — Cortex Tool Integration (MANDATORY)

> ⚠️ **Agents MUST use Cortex tools throughout the session, not just at start/end.**
> These tools are the core value of Cortex Hub — skipping them defeats the purpose.

| When | Tool | What to Do |
|------|------|------------|
| **Searching code** | `cortex_code_search` | Use FIRST before grep/find. Queries GitNexus AST graph. Fall back to grep only if unavailable. |
| **Before editing core code** | `cortex_code_impact` | Run blast radius analysis on the symbol/file you plan to change. |
| **Searching shared knowledge** | `cortex_knowledge_search` | Search team knowledge base for patterns, solutions, documented decisions. Supports tag/project filtering. |
| **Recalling past context** | `cortex_memory_search` | Search agent memories for past decisions, debugging findings. |
| **Contributing knowledge** | `cortex_knowledge_store` | Store reusable patterns, resolved issues into shared knowledge base. Include tags. |
| **Storing personal memory** | `cortex_memory_store` | Store session-specific findings and workarounds for future recall. |
| **After pushing code** | `cortex_quality_report` | Report build/typecheck/lint results and a summary of changes. |

### Tool Priority Order (before grep/find)

1. `cortex_memory_search` → check if you or another agent already knows this
2. `cortex_knowledge_search` → search shared knowledge base
3. `cortex_code_search` → search indexed codebase (GitNexus AST graph)
4. `cortex_code_impact` → check blast radius before editing
5. `grep_search` / `find_by_name` → fallback only

---

## Session Protocol

### At Session Start
1. Call `cortex_session_start` with repo URL, mode, AND your agentId (e.g., "claude-code", "cursor", "antigravity")
2. Read `STATE.md` → current task & progress
3. Read `.cortex/project-profile.json` → verify commands

### At Session End
1. Run verify commands from `project-profile.json`
2. Call `cortex_quality_report` with gate results
3. Call `cortex_memory_store` for any new knowledge learned
4. Update `STATE.md` with progress
5. Commit with conventional prefix: `feat:`, `fix:`, `docs:`, `chore:`
RULESEOF

# Replace version placeholder
sed -i.bak "s/CORTEX_VERSION_PLACEHOLDER/${CORTEX_RULES_VERSION}/" "$CORTEX_RULES_PATH" && rm -f "${CORTEX_RULES_PATH}.bak"

echo -e "${GREEN}    ✓ Generated $CORTEX_RULES_PATH (v${CORTEX_RULES_VERSION})${NC}"

# Only append a reference line to AGENTS.md if not already there
if [ -f AGENTS.md ]; then
    if grep -q "$CORTEX_REF_MARKER" AGENTS.md 2>/dev/null; then
        echo -e "${GREEN}    ✓ AGENTS.md already references agent-rules.md${NC}"
    else
        echo -e "${BLUE}>>> Appending Cortex Hub reference to AGENTS.md...${NC}"
        echo "" >> AGENTS.md
        echo "$CORTEX_REF_MARKER" >> AGENTS.md
        echo "$CORTEX_RULES_REF" >> AGENTS.md
        echo -e "${GREEN}    ✓ Added reference line to AGENTS.md${NC}"
    fi
else
    echo -e "${YELLOW}>>> No AGENTS.md found — $CORTEX_RULES_PATH will be the sole rules source${NC}"
fi

# ── Step 7b: Deploy Workflow Templates ──
# Installs Cortex workflow templates into .agents/workflows/ for any project.
# Templates define how agents use Cortex tools (code, continue, phase, onboard).

WORKFLOWS_DIR=".agents/workflows"
WORKFLOW_VERSION="2"  # Bump when updating templates
WORKFLOW_MARKER="<!-- cortex-workflows-version: -->"

echo -e "${BLUE}>>> Deploying Cortex workflow templates to ${WORKFLOWS_DIR}...${NC}"
mkdir -p "$WORKFLOWS_DIR"

# Check if workflows need update
NEEDS_UPDATE=false
if [ -f "$WORKFLOWS_DIR/code.md" ]; then
    if grep -q "cortex-workflows-version: ${WORKFLOW_VERSION}" "$WORKFLOWS_DIR/code.md" 2>/dev/null; then
        echo -e "${GREEN}    ✓ Workflows already at v${WORKFLOW_VERSION} — skipping${NC}"
    else
        echo -e "${YELLOW}    ⟳ Workflows outdated — updating to v${WORKFLOW_VERSION}${NC}"
        NEEDS_UPDATE=true
    fi
else
    NEEDS_UPDATE=true
fi

if [ "$NEEDS_UPDATE" = true ]; then
    # Source 1: Local templates from cortex-hub repo (if running from inside cortex-hub)
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    TEMPLATES_SRC="$SCRIPT_DIR/../templates/workflows"

    if [ -d "$TEMPLATES_SRC" ] && [ -f "$TEMPLATES_SRC/code.md" ]; then
        echo -e "${BLUE}    Using local templates from $TEMPLATES_SRC${NC}"
        for tmpl in "$TEMPLATES_SRC"/*.md; do
            filename=$(basename "$tmpl")
            cp "$tmpl" "$WORKFLOWS_DIR/$filename"
            echo -e "${GREEN}    ✓ Deployed $filename${NC}"
        done
    else
        # Source 2: Download from GitHub
        TEMPLATES_BASE="https://raw.githubusercontent.com/lktiep/cortex-hub/main/templates/workflows"
        WORKFLOW_FILES=("code.md" "continue.md" "phase.md")

        echo -e "${BLUE}    Downloading templates from GitHub...${NC}"
        for wf in "${WORKFLOW_FILES[@]}"; do
            if curl -sf "$TEMPLATES_BASE/$wf" -o "$WORKFLOWS_DIR/$wf" 2>/dev/null; then
                echo -e "${GREEN}    ✓ Downloaded $wf${NC}"
            else
                echo -e "${YELLOW}    ⚠ Could not download $wf — skipping${NC}"
            fi
        done
    fi

    echo -e "${GREEN}    ✓ Workflows deployed to $WORKFLOWS_DIR (v${WORKFLOW_VERSION})${NC}"
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
echo -e "    Workflows: ${BLUE}.agents/workflows/ (code, continue, phase)${NC}"
if [ ${#CONFIGURED_TOOLS[@]} -gt 0 ]; then
    echo -e "    Tools:     ${BLUE}${CONFIGURED_TOOLS[*]}${NC}"
fi
echo ""
echo -e "    ${YELLOW}Enforcement:${NC}"
echo -e "      ${YELLOW}├─ Lefthook: git commit/push BLOCKED if verify doesn't pass${NC}"
echo -e "      ${YELLOW}├─ Server-side: session validation on quality reports${NC}"
if [ "$INSTALL_CLAUDE_HOOKS" = true ]; then
echo -e "      ${YELLOW}├─ Claude hooks: commit BLOCKED, session reminders (4 hooks)${NC}"
fi
if [ "$INSTALL_GEMINI_HOOKS" = true ]; then
echo -e "      ${YELLOW}├─ Gemini hooks: commit BLOCKED, session reminders (4 hooks)${NC}"
fi
echo -e "      ${YELLOW}└─ Instructions: CLAUDE.md / GEMINI.md / .cursorrules${NC}"
echo -e "${BLUE}>>> Happy Coding!${NC}"
