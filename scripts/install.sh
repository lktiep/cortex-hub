#!/bin/bash
# Cortex Hub — Unified Installer (v3)
# One script for everything: global skill + MCP config + project hooks + IDE setup.
# Idempotent. Version-aware. Auto-updating. Multi-IDE.
#
# Usage:
#   bash install.sh                         # Full setup (global + project)
#   bash install.sh --force                 # Force regenerate all files
#   bash install.sh --check                 # Check status only
#   bash install.sh --tools claude,gemini   # Specific IDEs only
#   bash install.sh --skip-global           # Skip global install (project only)
#   curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.sh | bash
#
# Supported IDEs: claude, gemini, cursor, windsurf, vscode, codex
# Called by: /install skill, or directly from terminal

set -euo pipefail

HOOKS_VERSION=3
MCP_URL_DEFAULT="https://cortex-mcp.jackle.dev/mcp"

# ── Colors ──
RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'
YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()  { echo -e "${BLUE}[cortex]${NC} $*"; }
ok()    { echo -e "${GREEN}[cortex]${NC} $*"; }
warn()  { echo -e "${YELLOW}[cortex]${NC} $*"; }
err()   { echo -e "${RED}[cortex]${NC} $*" >&2; }

# ── Parse Args ──
FORCE=false
CHECK_ONLY=false
SKIP_GLOBAL=false
TOOLS_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|-f) FORCE=true; shift ;;
    --check|-c) CHECK_ONLY=true; shift ;;
    --skip-global) SKIP_GLOBAL=true; shift ;;
    --tools|-t) TOOLS_ARG="$2"; shift 2 ;;
    --tools=*) TOOLS_ARG="${1#*=}"; shift ;;
    *) shift ;;
  esac
done

# ── Find project root ──
PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$PROJECT_DIR"
GIT_REPO=$(git remote get-url origin 2>/dev/null || echo "unknown")

info "Project: $PROJECT_DIR"

# ── JSON parser (jq → python3 fallback) ──
parse_json_field() {
  local input="$1" field="$2"
  echo "$input" | jq -r ".$field // empty" 2>/dev/null && return 0
  echo "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$field',''))" 2>/dev/null && return 0
  return 1
}

# ── IDE Detection ──
detect_ides() {
  local detected=()
  # Claude Code
  if command -v claude >/dev/null 2>&1 || [ -f "$HOME/.claude.json" ] || [ -d "$HOME/.claude" ]; then
    detected+=("claude")
  fi
  # Gemini CLI / Antigravity
  if command -v gemini >/dev/null 2>&1 || [ -d "$HOME/.gemini" ]; then
    detected+=("gemini")
  fi
  # Cursor
  if [ -d "$HOME/.cursor" ] || command -v cursor >/dev/null 2>&1; then
    detected+=("cursor")
  fi
  # Windsurf
  if [ -d "$HOME/.codeium" ] || command -v windsurf >/dev/null 2>&1; then
    detected+=("windsurf")
  fi
  # VS Code
  if command -v code >/dev/null 2>&1; then
    detected+=("vscode")
  fi
  # OpenAI Codex
  if command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]; then
    detected+=("codex")
  fi
  echo "${detected[*]}"
}

# Determine which IDEs to configure
if [ -n "$TOOLS_ARG" ]; then
  IFS=',' read -ra SELECTED_IDES <<< "$TOOLS_ARG"
  info "IDEs (specified): ${SELECTED_IDES[*]}"
else
  IFS=' ' read -ra SELECTED_IDES <<< "$(detect_ides)"
  if [ ${#SELECTED_IDES[@]} -gt 0 ]; then
    info "IDEs (detected): ${SELECTED_IDES[*]}"
  else
    SELECTED_IDES=("claude")
    info "IDEs: defaulting to claude"
  fi
fi

# Helper: check if IDE is selected
ide_selected() {
  local target="$1"
  for ide in "${SELECTED_IDES[@]}"; do
    [ "$ide" = "$target" ] && return 0
  done
  return 1
}

# ══════════════════════════════════════════════
# Phase 0: Global Skill Install
# ══════════════════════════════════════════════
if [ "$SKIP_GLOBAL" = "false" ] && [ "$CHECK_ONLY" = "false" ] && ide_selected "claude"; then
  SKILL_DIR="$HOME/.claude/skills/install"
  SKILL_INSTALLED=false

  # Find SKILL.md source: local repo or download
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" 2>/dev/null || echo ".")" && pwd)"
  LOCAL_SKILL="$SCRIPT_DIR/../templates/skills/install/SKILL.md"

  if [ -f "$LOCAL_SKILL" ]; then
    mkdir -p "$SKILL_DIR"
    if ! diff -q "$LOCAL_SKILL" "$SKILL_DIR/SKILL.md" >/dev/null 2>&1; then
      cp "$LOCAL_SKILL" "$SKILL_DIR/SKILL.md"
      SKILL_INSTALLED=true
    fi
  elif [ ! -f "$SKILL_DIR/SKILL.md" ]; then
    mkdir -p "$SKILL_DIR"
    curl -fsSL "https://raw.githubusercontent.com/lktiep/cortex-hub/master/templates/skills/install/SKILL.md" \
      -o "$SKILL_DIR/SKILL.md" 2>/dev/null && SKILL_INSTALLED=true || true
  fi

  if [ "$SKILL_INSTALLED" = "true" ]; then
    ok "Global: /install skill installed → $SKILL_DIR/SKILL.md"
  elif [ -f "$SKILL_DIR/SKILL.md" ]; then
    ok "Global: /install skill up to date"
  fi
fi

# ══════════════════════════════════════════════
# Phase 1: Global MCP Config Check
# ══════════════════════════════════════════════
CLAUDE_JSON="$HOME/.claude.json"
MCP_CONFIGURED=false

check_mcp() {
  [ -f "$CLAUDE_JSON" ] || return 1
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import json, sys
with open('$CLAUDE_JSON') as f:
    config = json.load(f)
if 'cortex-hub' in config.get('mcpServers', {}):
    sys.exit(0)
sys.exit(1)
" 2>/dev/null
  elif command -v jq >/dev/null 2>&1; then
    jq -e '.mcpServers["cortex-hub"]' "$CLAUDE_JSON" >/dev/null 2>&1
  else
    grep -q "cortex-hub" "$CLAUDE_JSON" 2>/dev/null
  fi
}

if check_mcp; then
  MCP_CONFIGURED=true
  ok "MCP: configured in ~/.claude.json"
else
  # Try to find API key from env or .env file
  API_KEY="${HUB_API_KEY:-}"
  [ -z "$API_KEY" ] && [ -f ".env" ] && API_KEY=$(grep -E '^HUB_API_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'" || true)

  if [ -n "$API_KEY" ] && [ "$CHECK_ONLY" = "false" ]; then
    MCP_URL="${HUB_MCP_URL:-$MCP_URL_DEFAULT}"
    info "Configuring MCP in ~/.claude.json..."

    python3 << PYEOF
import json, os
path = os.path.expanduser('~/.claude.json')
config = {}
if os.path.exists(path):
    with open(path) as f:
        config = json.load(f)
if 'mcpServers' not in config:
    config['mcpServers'] = {}
config['mcpServers']['cortex-hub'] = {
    'command': 'npx',
    'args': ['-y', 'mcp-remote', '${MCP_URL}', '--header', 'Authorization:\${AUTH_HEADER}'],
    'env': {'AUTH_HEADER': 'Bearer ${API_KEY}'}
}
with open(path, 'w') as f:
    json.dump(config, f, indent=2)
PYEOF
    MCP_CONFIGURED=true
    ok "MCP: configured Claude Code with provided API key"

    # Configure other IDEs too
    MCP_URL="${HUB_MCP_URL:-$MCP_URL_DEFAULT}"
    if ide_selected "cursor"; then
      CURSOR_JSON="$HOME/.cursor/mcp.json"
      mkdir -p "$(dirname "$CURSOR_JSON")"
      python3 << CURSOREOF
import json, os
path = '$CURSOR_JSON'
config = {}
if os.path.exists(path):
    with open(path) as f:
        config = json.load(f)
if 'mcpServers' not in config:
    config['mcpServers'] = {}
config['mcpServers']['cortex-hub'] = {
    'command': 'npx',
    'args': ['-y', 'mcp-remote', '${MCP_URL}', '--header', 'Authorization:\${AUTH_HEADER}'],
    'env': {'AUTH_HEADER': 'Bearer ${API_KEY}'}
}
with open(path, 'w') as f:
    json.dump(config, f, indent=2)
CURSOREOF
      ok "MCP: configured Cursor"
    fi

    if ide_selected "windsurf"; then
      WINDSURF_JSON="$HOME/.codeium/windsurf/mcp_config.json"
      mkdir -p "$(dirname "$WINDSURF_JSON")"
      python3 << WINDSURFEOF
import json, os
path = '$WINDSURF_JSON'
config = {}
if os.path.exists(path):
    with open(path) as f:
        config = json.load(f)
if 'mcpServers' not in config:
    config['mcpServers'] = {}
config['mcpServers']['cortex-hub'] = {
    'command': 'npx',
    'args': ['-y', 'mcp-remote', '${MCP_URL}', '--header', 'Authorization:\${AUTH_HEADER}'],
    'env': {'AUTH_HEADER': 'Bearer ${API_KEY}'}
}
with open(path, 'w') as f:
    json.dump(config, f, indent=2)
WINDSURFEOF
      ok "MCP: configured Windsurf"
    fi

    if ide_selected "gemini"; then
      GEMINI_JSON="$HOME/.gemini/antigravity/mcp_config.json"
      mkdir -p "$(dirname "$GEMINI_JSON")"
      python3 << GEMINIEOF
import json, os
path = '$GEMINI_JSON'
config = {}
if os.path.exists(path):
    with open(path) as f:
        config = json.load(f)
if 'mcpServers' not in config:
    config['mcpServers'] = {}
config['mcpServers']['cortex-hub'] = {
    'command': 'npx',
    'args': ['-y', 'mcp-remote', '${MCP_URL}', '--header', 'Authorization:\${AUTH_HEADER}'],
    'env': {'AUTH_HEADER': 'Bearer ${API_KEY}'}
}
with open(path, 'w') as f:
    json.dump(config, f, indent=2)
GEMINIEOF
      ok "MCP: configured Gemini"
    fi

    if ide_selected "vscode"; then
      VSCODE_JSON=".vscode/mcp.json"
      mkdir -p ".vscode"
      python3 << VSCODEEOF
import json, os
path = '$VSCODE_JSON'
config = {}
if os.path.exists(path):
    with open(path) as f:
        config = json.load(f)
if 'servers' not in config:
    config['servers'] = {}
config['servers']['cortex-hub'] = {
    'type': 'stdio',
    'command': 'npx',
    'args': ['-y', 'mcp-remote', '${MCP_URL}', '--header', 'Authorization:\${AUTH_HEADER}'],
    'env': {'AUTH_HEADER': 'Bearer ${API_KEY}'}
}
with open(path, 'w') as f:
    json.dump(config, f, indent=2)
VSCODEEOF
      ok "MCP: configured VS Code (.vscode/mcp.json)"
    fi
  else
    warn "MCP: not configured. Set HUB_API_KEY in env or .env file, then re-run /onboard"
  fi
fi

# ══════════════════════════════════════════════
# Phase 2: Version Check
# ══════════════════════════════════════════════
mkdir -p .cortex
INSTALLED_VERSION=$(cat .cortex/.hooks-version 2>/dev/null || echo "0")

if [ "$CHECK_ONLY" = "true" ]; then
  echo ""
  echo -e "${CYAN}=== Cortex Hub Status ===${NC}"
  echo "  Project:        $PROJECT_DIR"
  echo "  MCP configured: $MCP_CONFIGURED"
  echo "  Hooks version:  $INSTALLED_VERSION (latest: $HOOKS_VERSION)"
  echo "  Profile:        $([ -f .cortex/project-profile.json ] && echo 'yes' || echo 'no')"
  echo "  Claude hooks:   $([ -f .claude/hooks/enforce-session.sh ] && echo 'yes' || echo 'no')"
  echo "  Gemini hooks:   $([ -f .gemini/hooks/enforce-session.sh ] && echo 'yes' || echo 'no')"
  echo "  Settings:       $([ -f .claude/settings.json ] && echo 'yes' || echo 'no')"
  echo "  Lefthook:       $([ -f lefthook.yml ] && echo 'yes' || echo 'no')"
  echo "  CLAUDE.md:      $([ -f CLAUDE.md ] && echo 'yes' || echo 'no')"
  [ "$INSTALLED_VERSION" -lt "$HOOKS_VERSION" ] 2>/dev/null && warn "Hooks outdated! Run /onboard to update."
  exit 0
fi

NEEDS_UPDATE=false
if [ "$FORCE" = "true" ]; then
  NEEDS_UPDATE=true
  info "Force mode: regenerating all files"
elif [ "$INSTALLED_VERSION" -lt "$HOOKS_VERSION" ] 2>/dev/null; then
  NEEDS_UPDATE=true
  info "Updating hooks v$INSTALLED_VERSION → v$HOOKS_VERSION"
elif [ ! -f ".claude/hooks/enforce-session.sh" ] || [ ! -f ".claude/settings.json" ]; then
  NEEDS_UPDATE=true
  info "Missing files detected, regenerating..."
else
  ok "Hooks: up to date (v$HOOKS_VERSION)"
fi

# ══════════════════════════════════════════════
# Phase 3: Detect Project Stack
# ══════════════════════════════════════════════
if [ ! -f ".cortex/project-profile.json" ] || [ "$FORCE" = "true" ]; then
  info "Detecting project stacks..."

  # Smart detection: scan ALL stacks present in the project
  # Each stack gets its own pipeline with glob filter (only runs when relevant files change)
  DETECTED_STACKS=()
  PKG_MANAGER="unknown"
  PRE_COMMIT_CMDS=""
  FULL_CMDS=""

  # ── Node.js ──
  if [ -f "package.json" ]; then
    if [ -f "pnpm-lock.yaml" ] || [ -f "pnpm-workspace.yaml" ]; then
      PKG_MANAGER="pnpm"
    elif [ -f "yarn.lock" ]; then
      PKG_MANAGER="yarn"
    else
      PKG_MANAGER="npm"
    fi
    DETECTED_STACKS+=("node:$PKG_MANAGER")

    SCRIPTS=""
    if command -v python3 >/dev/null 2>&1; then
      SCRIPTS=$(python3 -c "import json; s=json.load(open('package.json',encoding='utf-8-sig')).get('scripts',{}); print(' '.join(s.keys()))" 2>/dev/null || true)
    elif command -v jq >/dev/null 2>&1; then
      SCRIPTS=$(jq -r '.scripts // {} | keys[]' package.json 2>/dev/null | tr '\n' ' ' || true)
    fi

    PRE_COMMIT=()
    FULL=()
    for script in build typecheck lint; do
      if echo "$SCRIPTS" | grep -qw "$script"; then
        PRE_COMMIT+=("\"$PKG_MANAGER $script\"")
        FULL+=("\"$PKG_MANAGER $script\"")
      fi
    done
    echo "$SCRIPTS" | grep -qw "test" && FULL+=("\"$PKG_MANAGER test\"")
    PRE_COMMIT_CMDS=$(IFS=,; echo "${PRE_COMMIT[*]}")
    FULL_CMDS=$(IFS=,; echo "${FULL[*]}")
  fi

  # ── Go ──
  if [ -f "go.mod" ]; then
    PKG_MANAGER="go"
    DETECTED_STACKS+=("go")
  fi

  # ── Rust ──
  if [ -f "Cargo.toml" ]; then
    PKG_MANAGER="cargo"
    DETECTED_STACKS+=("rust")
  fi

  # ── Python (only if has manifest, not just .py files) ──
  if [ -f "requirements.txt" ] || [ -f "pyproject.toml" ] || [ -f "setup.py" ] || [ -f "Pipfile" ]; then
    DETECTED_STACKS+=("python")
    [ "$PKG_MANAGER" = "unknown" ] && PKG_MANAGER="pip"
  fi

  # ── .NET (root or subdirectory) ──
  if ls *.csproj >/dev/null 2>&1 || ls *.sln >/dev/null 2>&1; then
    DETECTED_STACKS+=("dotnet:root")
    [ "$PKG_MANAGER" = "unknown" ] && PKG_MANAGER="dotnet"
  elif find . -maxdepth 3 -name "*.sln" 2>/dev/null | grep -q .; then
    SLN_PATH=$(find . -maxdepth 3 -name "*.sln" 2>/dev/null | head -1)
    DETECTED_STACKS+=("dotnet:$SLN_PATH")
    [ "$PKG_MANAGER" = "unknown" ] && PKG_MANAGER="dotnet-mixed"
  fi

  # ── Godot ──
  if find . -maxdepth 4 -name "project.godot" 2>/dev/null | grep -q .; then
    GODOT_DIR=$(dirname "$(find . -maxdepth 4 -name "project.godot" 2>/dev/null | head -1)")
    DETECTED_STACKS+=("godot:$GODOT_DIR")
  fi

  # ── Scattered Python scripts (no manifest) ──
  if ! printf '%s\n' "${DETECTED_STACKS[@]}" 2>/dev/null | grep -q "python" && find . -maxdepth 3 -name "*.py" 2>/dev/null | grep -q .; then
    DETECTED_STACKS+=("python-scripts")
  fi

  if [ ${#DETECTED_STACKS[@]} -eq 0 ]; then
    warn "Stack: no recognized project types found"
  elif [ ${#DETECTED_STACKS[@]} -eq 1 ]; then
    ok "Stack: ${DETECTED_STACKS[0]}"
  else
    ok "Stack: mixed project — ${DETECTED_STACKS[*]}"
  fi

  # Generate profile
  STACKS_JSON=$(printf '"%s",' "${DETECTED_STACKS[@]}" | sed 's/,$//')
  if [ -z "$PRE_COMMIT_CMDS" ] && [ ${#DETECTED_STACKS[@]} -gt 0 ]; then
    # For non-node projects, leave verify empty — lefthook will use glob-based pipelines
    PRE_COMMIT_CMDS=""
    FULL_CMDS=""
  fi

  cat > .cortex/project-profile.json << EOF
{
  "schema_version": "2.0",
  "project_name": "$(basename "$PROJECT_DIR")",
  "fingerprint": {
    "package_manager": "$PKG_MANAGER",
    "stacks": [${STACKS_JSON}],
    "detected_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  },
  "verify": {
    "pre_commit": [${PRE_COMMIT_CMDS}],
    "full": [${FULL_CMDS}],
    "auto_fix": true,
    "max_retries": 2
  }
}
EOF
  ok "Profile: .cortex/project-profile.json created (${DETECTED_STACKS[*]:-unknown})"
else
  ok "Profile: already exists"
fi

# ══════════════════════════════════════════════
# Phase 4: Install Hooks (if needed)
# ══════════════════════════════════════════════
if [ "$NEEDS_UPDATE" = "true" ]; then
  mkdir -p .claude/hooks .cortex/.session-state

  # ── session-init.sh ──
  cat > .claude/hooks/session-init.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Session Init (v3) — Resets session markers + prints mandatory reminder
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR/session-started" "$STATE_DIR/quality-gates-passed" \
      "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" \
      "$STATE_DIR/session-ended" 2>/dev/null
cat <<'MSG'
⚠️ HARD REQUIREMENT — BLOCKING ⚠️
You MUST call cortex_session_start IMMEDIATELY as your very first action.
ALL file edits and modifications are BLOCKED until you do this.

Steps:
1. Call cortex_session_start(repo: "<git remote url>", mode: "development", agentId: "claude-code")
2. If recentChanges.count > 0 → warn user and git pull
3. Read STATE.md if it exists

FAILURE TO COMPLY: Your Edit/Write/Bash tools WILL return exit code 2 (blocked).
This is enforced by hooks — not optional.
MSG
HOOKEOF

  # ── enforce-session.sh ──
  cat > .claude/hooks/enforce-session.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Session Enforcement (v3) — HARD BLOCK without active session
# Improvements: robust path resolution, jq+python3 fallback, fail-closed

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

# If session already started, allow everything
[ -f "$STATE_DIR/session-started" ] && exit 0

# Parse hook input (jq → python3 fallback)
INPUT=$(cat)
TOOL_NAME=""
COMMAND=""

if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || true)
  COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi

# If we couldn't parse at all, fail closed (block)
if [ -z "$TOOL_NAME" ]; then
  echo "BLOCKED: Cannot parse hook input. Install jq or python3." >&2
  exit 2
fi

case "$TOOL_NAME" in
  Edit|Write|NotebookEdit)
    echo "BLOCKED: Call cortex_session_start before editing files." >&2
    exit 2
    ;;
  Bash)
    # Allow read-only commands
    if [[ "$COMMAND" =~ ^(ls|cat|head|tail|pwd|which|echo|git\ (status|log|diff|branch|remote|rev-parse)|pnpm\ (build|typecheck|lint|test)|npm\ (run|test)|yarn\ |cargo\ (build|test|clippy)|go\ (build|test|vet)|python3?\ -m|curl|dotnet\ (build|test)) ]]; then
      exit 0
    fi
    # Block file-modifying commands
    if [[ "$COMMAND" =~ (git\ (add|commit|push|reset)|rm\ |mv\ |cp\ |mkdir\ |touch\ |chmod\ |sed\ -i|>\ ) ]]; then
      echo "BLOCKED: Call cortex_session_start before modifying files." >&2
      exit 2
    fi
    # Default: allow (likely read-only inspection)
    exit 0
    ;;
esac

# All other tools — allow
exit 0
HOOKEOF

  # ── enforce-commit.sh ──
  cat > .claude/hooks/enforce-commit.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Commit Enforcement (v3) — Blocks commit without quality gates

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

INPUT=$(cat)
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi

[[ ! "$COMMAND" =~ ^git\ (commit|push) ]] && exit 0

if [[ "$COMMAND" =~ ^git\ commit ]]; then
  if [ ! -f "$STATE_DIR/quality-gates-passed" ]; then
    echo "BLOCKED: Quality gates not passed. Run build/typecheck/lint first, then call cortex_quality_report." >&2
    exit 2
  fi
fi

if [[ "$COMMAND" =~ ^git\ push ]]; then
  echo "REMINDER: After push, call cortex_code_reindex to update code intelligence." >&2
fi
exit 0
HOOKEOF

  # ── track-quality.sh ──
  cat > .claude/hooks/track-quality.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Quality Tracker (v3) — Marks gates as passed

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat)
COMMAND=""
TOOL_NAME=""

if command -v jq >/dev/null 2>&1; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
" 2>/dev/null || true)"
fi

# Track build gates
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ build ]]     && touch "$STATE_DIR/gate-build"
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ typecheck ]]  && touch "$STATE_DIR/gate-typecheck"
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ lint ]]       && touch "$STATE_DIR/gate-lint"
[[ "$COMMAND" =~ cargo\ build ]]                && touch "$STATE_DIR/gate-build"
[[ "$COMMAND" =~ cargo\ clippy ]]               && touch "$STATE_DIR/gate-lint"
[[ "$COMMAND" =~ go\ build ]]                   && touch "$STATE_DIR/gate-build"
[[ "$COMMAND" =~ go\ vet ]]                     && touch "$STATE_DIR/gate-lint"
[[ "$COMMAND" =~ dotnet\ build ]]               && touch "$STATE_DIR/gate-build"

# All gates passed?
if [ -f "$STATE_DIR/gate-build" ] && [ -f "$STATE_DIR/gate-typecheck" ] && [ -f "$STATE_DIR/gate-lint" ]; then
  touch "$STATE_DIR/quality-gates-passed"
fi
# For projects without typecheck (Go, Rust, etc.) — build + lint = passed
if [ -f "$STATE_DIR/gate-build" ] && [ -f "$STATE_DIR/gate-lint" ] && [ ! -f "$STATE_DIR/gate-typecheck" ]; then
  # Check if project has typecheck command
  if [ -f ".cortex/project-profile.json" ]; then
    HAS_TYPECHECK=$(grep -c "typecheck" .cortex/project-profile.json 2>/dev/null || echo "0")
    [ "$HAS_TYPECHECK" = "0" ] && touch "$STATE_DIR/quality-gates-passed"
  fi
fi

# Track MCP tool calls
[[ "$TOOL_NAME" =~ cortex_session_start ]]  && touch "$STATE_DIR/session-started"
[[ "$TOOL_NAME" =~ cortex_session_end ]]    && touch "$STATE_DIR/session-ended"
[[ "$TOOL_NAME" =~ cortex_quality_report ]] && touch "$STATE_DIR/quality-gates-passed"
exit 0
HOOKEOF

  # ── session-end-check.sh ──
  cat > .claude/hooks/session-end-check.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Session End Check (v3) — Warns if session not properly closed
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
if [ -f "$STATE_DIR/session-started" ] && [ ! -f "$STATE_DIR/session-ended" ]; then
  echo "WARNING: cortex_session_end has not been called. Call it with sessionId and summary before ending."
fi
exit 0
HOOKEOF

  chmod +x .claude/hooks/*.sh
  ok "Hooks: all 5 hooks installed (v$HOOKS_VERSION)"

  # ── settings.json ──
  # Detect OS for hook command prefix
  if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    # Windows Git Bash — still use bash but with explicit path
    HOOK_PREFIX="bash"
  else
    HOOK_PREFIX="bash"
  fi

  cat > .claude/settings.json << EOF
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "$HOOK_PREFIX \${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/session-init.sh"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$HOOK_PREFIX \${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/enforce-session.sh"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$HOOK_PREFIX \${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/enforce-commit.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "$HOOK_PREFIX \${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/track-quality.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "$HOOK_PREFIX \${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/session-end-check.sh"
          }
        ]
      }
    ]
  }
}
EOF
  ok "Settings: .claude/settings.json generated"

  # ── Gemini / Antigravity hooks ──
  if ide_selected "gemini"; then
    mkdir -p .gemini/hooks

    # Gemini hooks use JSON response format: {"decision":"allow"} or {"decision":"deny","reason":"..."}
    cat > .gemini/hooks/session-init.sh << 'GHOOKEOF'
#!/bin/bash
# Cortex Session Init (v3) — Gemini variant
PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR/session-started" "$STATE_DIR/quality-gates-passed" \
      "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" \
      "$STATE_DIR/session-ended" 2>/dev/null
echo '{"systemMessage":"MANDATORY: Call cortex_session_start before any work."}'
GHOOKEOF

    cat > .gemini/hooks/enforce-session.sh << 'GHOOKEOF'
#!/bin/bash
# Cortex Session Enforcement (v3) — Gemini variant (JSON response)
PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
[ -f "$STATE_DIR/session-started" ] && { echo '{"decision":"allow"}'; exit 0; }
INPUT=$(cat)
TOOL_NAME=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null || true)
fi
case "$TOOL_NAME" in
  write_file|edit_file|create_file|insert_text)
    echo '{"decision":"deny","reason":"BLOCKED: Call cortex_session_start before editing files."}'
    exit 0 ;;
  run_shell_command|shell)
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
    if [[ "$COMMAND" =~ (git\ (add|commit|push|reset)|rm\ |mv\ |cp\ |mkdir\ ) ]]; then
      echo '{"decision":"deny","reason":"BLOCKED: Call cortex_session_start before modifying files."}'
      exit 0
    fi ;;
esac
echo '{"decision":"allow"}'
GHOOKEOF

    cat > .gemini/hooks/enforce-commit.sh << 'GHOOKEOF'
#!/bin/bash
# Cortex Commit Enforcement (v3) — Gemini variant
PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
if [[ "$COMMAND" =~ ^git\ commit ]] && [ ! -f "$STATE_DIR/quality-gates-passed" ]; then
  echo '{"decision":"deny","reason":"Quality gates not passed. Run build/lint first."}'
  exit 0
fi
echo '{"decision":"allow"}'
GHOOKEOF

    cat > .gemini/hooks/track-quality.sh << 'GHOOKEOF'
#!/bin/bash
# Cortex Quality Tracker (v3) — Gemini variant
PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ build ]]    && touch "$STATE_DIR/gate-build"
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ typecheck ]] && touch "$STATE_DIR/gate-typecheck"
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ lint ]]      && touch "$STATE_DIR/gate-lint"
[ -f "$STATE_DIR/gate-build" ] && [ -f "$STATE_DIR/gate-typecheck" ] && [ -f "$STATE_DIR/gate-lint" ] && touch "$STATE_DIR/quality-gates-passed"
[[ "$TOOL_NAME" =~ cortex_session_start ]]  && touch "$STATE_DIR/session-started"
[[ "$TOOL_NAME" =~ cortex_session_end ]]    && touch "$STATE_DIR/session-ended"
[[ "$TOOL_NAME" =~ cortex_quality_report ]] && touch "$STATE_DIR/quality-gates-passed"
echo '{"decision":"allow"}'
GHOOKEOF

    cat > .gemini/hooks/session-end-check.sh << 'GHOOKEOF'
#!/bin/bash
# Cortex Session End Check (v3) — Gemini variant
PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
if [ -f "$STATE_DIR/session-started" ] && [ ! -f "$STATE_DIR/session-ended" ]; then
  echo '{"systemMessage":"WARNING: Call cortex_session_end before ending."}'
fi
GHOOKEOF

    chmod +x .gemini/hooks/*.sh

    # Gemini settings.json
    cat > .gemini/settings.json << 'GSETTINGS'
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {"type": "command", "command": ".gemini/hooks/session-init.sh", "name": "cortex_session_init"}
        ]
      }
    ],
    "BeforeTool": [
      {
        "matcher": "write_file|edit_file|create_file|insert_text|run_shell_command|shell",
        "hooks": [
          {"type": "command", "command": ".gemini/hooks/enforce-session.sh", "name": "cortex_enforce_session"}
        ]
      },
      {
        "matcher": "run_shell_command|shell",
        "hooks": [
          {"type": "command", "command": ".gemini/hooks/enforce-commit.sh", "name": "cortex_enforce_commit"}
        ]
      }
    ],
    "AfterTool": [
      {
        "matcher": ".*",
        "hooks": [
          {"type": "command", "command": ".gemini/hooks/track-quality.sh", "name": "cortex_track_quality"}
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {"type": "command", "command": ".gemini/hooks/session-end-check.sh", "name": "cortex_session_end_check"}
        ]
      }
    ]
  }
}
GSETTINGS
    ok "Gemini: hooks + settings.json installed (v$HOOKS_VERSION)"
  fi

  # ── Instruction files for IDEs without runtime hooks ──
  # These IDEs rely on instruction-based enforcement only (no hooks API)
  generate_instruction_content() {
    local agent_id="$1"
    cat << INSTREOF
<!-- cortex-hub:auto-mcp -->
## Cortex Hub — Auto MCP (MANDATORY)

At the START of every conversation:
1. Call \`cortex_session_start\` with repo: "$GIT_REPO", agentId: "$agent_id", mode: "development"
2. If \`recentChanges.count > 0\`, warn user and run \`git pull\`
3. Read \`STATE.md\` if it exists

### Error Protocol
1. \`cortex_knowledge_search\` first
2. Fix the error
3. Non-obvious fixes: \`cortex_knowledge_store\`

### Quality Gates
Run verify commands from \`.cortex/project-profile.json\`, then \`cortex_quality_report\`.
End session: \`cortex_session_end\` with sessionId and summary.
<!-- cortex-hub:auto-mcp -->
INSTREOF
  }

  inject_or_update_instructions() {
    local file="$1" agent_id="$2"
    local content
    content=$(generate_instruction_content "$agent_id")

    if [ ! -f "$file" ]; then
      echo "$content" > "$file"
      ok "Created $file ($agent_id)"
    elif grep -q "cortex-hub:auto-mcp" "$file" 2>/dev/null; then
      TMPFILE=$(mktemp)
      echo "$content" > "$TMPFILE"
      python3 << PYEOF2
import re, os
with open('$file', 'r', encoding='utf-8-sig') as f:
    orig = f.read()
with open('$TMPFILE', 'r') as f:
    replacement = f.read().strip()
marker = '<!-- cortex-hub:auto-mcp -->'
pattern = re.escape(marker) + r'.*?' + re.escape(marker)
new = re.sub(pattern, replacement, orig, flags=re.DOTALL)
with open('$file', 'w', encoding='utf-8') as f:
    f.write(new)
os.unlink('$TMPFILE')
PYEOF2
      ok "Updated $file ($agent_id)"
    else
      echo "" >> "$file"
      echo "$content" >> "$file"
      ok "Appended to $file ($agent_id)"
    fi
  }

  ide_selected "cursor"   && inject_or_update_instructions ".cursorrules" "cursor"
  ide_selected "windsurf"  && inject_or_update_instructions ".windsurfrules" "windsurf"
  ide_selected "vscode"    && { mkdir -p .vscode; inject_or_update_instructions ".vscode/copilot-instructions.md" "vscode-copilot"; }
  ide_selected "codex"     && { mkdir -p .codex; inject_or_update_instructions ".codex/instructions.md" "codex"; }

  # Write version marker
  echo "$HOOKS_VERSION" > .cortex/.hooks-version
  ok "Version: v$HOOKS_VERSION marked"
fi

# ══════════════════════════════════════════════
# Phase 5: Lefthook Setup (smart glob-based pipelines)
# ══════════════════════════════════════════════
if [ ! -f "lefthook.yml" ] || [ "$FORCE" = "true" ]; then
  # Read detected stacks from profile
  STACKS_FROM_PROFILE=""
  if [ -f ".cortex/project-profile.json" ] && command -v python3 >/dev/null 2>&1; then
    STACKS_FROM_PROFILE=$(python3 -c "
import json
p = json.load(open('.cortex/project-profile.json'))
stacks = p.get('fingerprint',{}).get('stacks',[])
print(' '.join(stacks))
" 2>/dev/null || true)
  fi

  # Generate lefthook.yml with per-stack glob-filtered commands
  # Each command only runs when files matching its glob are staged
  {
    echo "# Auto-generated by cortex install.sh — per-stack pipelines"
    echo "# Each command only runs when relevant files are changed (glob filter)"
    echo ""
    echo "pre-commit:"
    echo "  parallel: true"
    echo "  commands:"

    HOOK_COUNT=0

    for stack in $STACKS_FROM_PROFILE; do
      case "$stack" in
        node:pnpm|node:npm|node:yarn)
          PM="${stack#node:}"
          # Read available scripts from profile pre_commit
          if [ -f ".cortex/project-profile.json" ]; then
            PRE_CMDS=$(python3 -c "
import json
p = json.load(open('.cortex/project-profile.json'))
for c in p.get('verify',{}).get('pre_commit',[]):
    print(c)
" 2>/dev/null || true)
            if [ -n "$PRE_CMDS" ]; then
              while IFS= read -r cmd; do
                CMD_NAME=$(echo "$cmd" | tr ' ' '_')
                echo "    ${CMD_NAME}:"
                echo "      glob: \"**/*.{ts,tsx,js,jsx,json,css,scss}\""
                echo "      run: $cmd"
                HOOK_COUNT=$((HOOK_COUNT + 1))
              done <<< "$PRE_CMDS"
            fi
          fi
          ;;
        go)
          echo "    go_build:"
          echo "      glob: \"**/*.go\""
          echo "      run: go build ./..."
          echo "    go_vet:"
          echo "      glob: \"**/*.go\""
          echo "      run: go vet ./..."
          HOOK_COUNT=$((HOOK_COUNT + 2))
          ;;
        rust)
          echo "    cargo_build:"
          echo "      glob: \"**/*.rs\""
          echo "      run: cargo build"
          echo "    cargo_clippy:"
          echo "      glob: \"**/*.rs\""
          echo "      run: cargo clippy --all-targets"
          HOOK_COUNT=$((HOOK_COUNT + 2))
          ;;
        python)
          echo "    python_check:"
          echo "      glob: \"**/*.py\""
          echo "      run: python3 -m py_compile {staged_files}"
          HOOK_COUNT=$((HOOK_COUNT + 1))
          ;;
        python-scripts)
          echo "    python_syntax:"
          echo "      glob: \"**/*.py\""
          echo "      run: python3 -m py_compile {staged_files}"
          HOOK_COUNT=$((HOOK_COUNT + 1))
          ;;
        dotnet:root)
          echo "    dotnet_build:"
          echo "      glob: \"**/*.{cs,csproj,sln}\""
          echo "      run: dotnet build"
          HOOK_COUNT=$((HOOK_COUNT + 1))
          ;;
        dotnet:*)
          SLN="${stack#dotnet:}"
          SLN_DIR=$(dirname "$SLN")
          echo "    dotnet_build:"
          echo "      glob: \"${SLN_DIR}/**/*.{cs,csproj,sln}\""
          echo "      run: dotnet build $SLN"
          HOOK_COUNT=$((HOOK_COUNT + 1))
          ;;
        godot:*)
          GDIR="${stack#godot:}"
          echo "    godot_check:"
          echo "      glob: \"${GDIR}/**/*.{gd,tscn,tres}\""
          echo "      run: echo 'Godot files changed — verify in editor'"
          HOOK_COUNT=$((HOOK_COUNT + 1))
          ;;
      esac
    done

    if [ "$HOOK_COUNT" -eq 0 ]; then
      echo "    noop:"
      echo "      run: \"true\"  # No stacks detected — add commands manually"
    fi

    # pre-push: same + tests
    echo ""
    echo "pre-push:"
    echo "  parallel: true"
    echo "  commands:"

    for stack in $STACKS_FROM_PROFILE; do
      case "$stack" in
        node:*)
          PM="${stack#node:}"
          if [ -f ".cortex/project-profile.json" ]; then
            FULL_CMDS_LIST=$(python3 -c "
import json
p = json.load(open('.cortex/project-profile.json'))
for c in p.get('verify',{}).get('full',[]):
    print(c)
" 2>/dev/null || true)
            if [ -n "$FULL_CMDS_LIST" ]; then
              while IFS= read -r cmd; do
                CMD_NAME=$(echo "$cmd" | tr ' ' '_')
                echo "    ${CMD_NAME}:"
                echo "      glob: \"**/*.{ts,tsx,js,jsx,json,css,scss}\""
                echo "      run: $cmd"
              done <<< "$FULL_CMDS_LIST"
            fi
          fi
          ;;
        go)
          echo "    go_build:"
          echo "      glob: \"**/*.go\""
          echo "      run: go build ./..."
          echo "    go_test:"
          echo "      glob: \"**/*.go\""
          echo "      run: go test ./..."
          ;;
        rust)
          echo "    cargo_build:"
          echo "      glob: \"**/*.rs\""
          echo "      run: cargo build"
          echo "    cargo_test:"
          echo "      glob: \"**/*.rs\""
          echo "      run: cargo test"
          ;;
        python)
          echo "    python_test:"
          echo "      glob: \"**/*.py\""
          echo "      run: python3 -m pytest"
          ;;
        dotnet:root)
          echo "    dotnet_test:"
          echo "      glob: \"**/*.{cs,csproj,sln}\""
          echo "      run: dotnet test"
          ;;
        dotnet:*)
          SLN="${stack#dotnet:}"
          SLN_DIR=$(dirname "$SLN")
          echo "    dotnet_test:"
          echo "      glob: \"${SLN_DIR}/**/*.{cs,csproj,sln}\""
          echo "      run: dotnet test $SLN"
          ;;
      esac
    done

    # post-push: cortex notification
    echo ""
    cat << 'POSTPUSH'
post-push:
  commands:
    notify_cortex:
      run: |
        if [ -n "$CORTEX_API_URL" ]; then
          BRANCH=$(git rev-parse --abbrev-ref HEAD)
          REPO=$(git remote get-url origin 2>/dev/null || echo "")
          COMMIT_SHA=$(git rev-parse HEAD)
          COMMIT_MSG=$(git log -1 --pretty=%s)
          curl -s -X POST "$CORTEX_API_URL/api/webhooks/local-push" \
            -H "Content-Type: application/json" \
            -d "{\"repo\":\"$REPO\",\"branch\":\"$BRANCH\",\"commitSha\":\"$COMMIT_SHA\",\"commitMessage\":\"$COMMIT_MSG\"}" \
            > /dev/null 2>&1 || true
        fi
POSTPUSH
  } > lefthook.yml

  ok "Lefthook: smart pipelines generated ($HOOK_COUNT checks, glob-filtered)"

  # Install lefthook if available
  if command -v lefthook >/dev/null 2>&1; then
    lefthook install 2>/dev/null && ok "Lefthook: git hooks installed" || warn "Lefthook: install failed (non-fatal)"
  elif command -v npx >/dev/null 2>&1; then
    npx lefthook install 2>/dev/null && ok "Lefthook: git hooks installed (via npx)" || warn "Lefthook: install skipped"
  else
    warn "Lefthook: not found. Install with: npm i -g lefthook"
  fi
else
  ok "Lefthook: already configured"
fi

# ══════════════════════════════════════════════
# Phase 6: CLAUDE.md Injection
# ══════════════════════════════════════════════
CORTEX_MARKER="<!-- cortex-hub:auto-mcp -->"

inject_claude_md() {
  local CONTENT
  CONTENT=$(cat << 'CLAUDEEOF'
<!-- cortex-hub:auto-mcp -->
## Cortex Hub — MANDATORY (enforced by hooks — violations are BLOCKED)

**YOUR FIRST ACTION in every conversation MUST be calling `cortex_session_start`.
If you skip this, all Edit/Write/file-modifying Bash commands will return exit code 2 (BLOCKED).
This is not optional — it is enforced by pre-tool hooks.**

```
cortex_session_start(repo: "__GIT_REPO__", mode: "development", agentId: "claude-code")
```

Then:
- If `recentChanges.count > 0` in the response, warn the user and run `git pull`
- Read `STATE.md` for current task progress (if it exists)

### Before editing shared files

Call `cortex_changes` to check if another agent modified the same files:
```
agentId: "claude-code"
projectId: "<from session_start response>"
```

### When encountering an error or bug

1. First search `cortex_knowledge_search` or `cortex_memory_search` for the error message
2. Fix the error
3. Non-obvious fixes: **YOU MUST** call `cortex_knowledge_store` to record the solution

### After pushing code

Call `cortex_code_reindex` to update code intelligence:
```
repo: "__GIT_REPO__"
branch: "<current branch>"
```

### Quality gates (enforced — commit blocked without these)

Every session must end with verification commands from `.cortex/project-profile.json`.
Call `cortex_quality_report` with results. Call `cortex_session_end` to close the session.
**Commits are BLOCKED by hooks until quality gates pass.**

### Compliance Enforcement (Automated)

Your tool usage is **automatically tracked and scored**:

1. **Session Compliance Score** — `cortex_session_end` returns a grade (A/B/C/D) based on 5-category tool coverage.
2. **MCP Response Hints** — Every tool response includes adaptive hints about what to use next.
<!-- cortex-hub:auto-mcp -->
CLAUDEEOF
  )
  # Replace placeholder with actual repo URL
  CONTENT="${CONTENT//__GIT_REPO__/$GIT_REPO}"
  echo "$CONTENT"
}

if [ ! -f "CLAUDE.md" ]; then
  # Create new CLAUDE.md
  cat > CLAUDE.md << HEADEREOF
# $(basename "$PROJECT_DIR") — Claude Code Instructions

## Tech stack

$([ -f ".cortex/project-profile.json" ] && python3 -c "import json; p=json.load(open('.cortex/project-profile.json')); print(f'Package manager: {p[\"fingerprint\"][\"package_manager\"]}')" 2>/dev/null || echo "See project files for details")

## Code conventions

See \`.cortex/code-conventions.md\` for detailed style guide.

HEADEREOF
  inject_claude_md >> CLAUDE.md
  ok "CLAUDE.md: created with cortex integration"

elif grep -q "$CORTEX_MARKER" CLAUDE.md 2>/dev/null; then
  # Replace existing cortex section using temp file approach (avoids quoting issues)
  INJECTION=$(inject_claude_md)
  TMPFILE=$(mktemp)
  echo "$INJECTION" > "$TMPFILE"
  python3 << PYEOF
import re, os
with open('CLAUDE.md', 'r', encoding='utf-8-sig') as f:
    content = f.read()
with open('$TMPFILE', 'r') as f:
    replacement = f.read().strip()
marker = '$CORTEX_MARKER'
pattern = re.escape(marker) + r'.*?' + re.escape(marker)
new_content = re.sub(pattern, replacement, content, flags=re.DOTALL)
with open('CLAUDE.md', 'w', encoding='utf-8') as f:
    f.write(new_content)
os.unlink('$TMPFILE')
PYEOF
  [ $? -eq 0 ] && ok "CLAUDE.md: cortex section updated" || { warn "CLAUDE.md: could not update (check manually)"; rm -f "$TMPFILE"; }
else
  # Append cortex section
  echo "" >> CLAUDE.md
  inject_claude_md >> CLAUDE.md
  ok "CLAUDE.md: cortex section appended"
fi

# ══════════════════════════════════════════════
# Phase 7: Summary
# ══════════════════════════════════════════════
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Cortex Hub setup complete (v$HOOKS_VERSION)${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Project:   $(basename "$PROJECT_DIR")"
STACK_NAME=$(python3 -c "import json; print(json.load(open('.cortex/project-profile.json'))['fingerprint']['package_manager'])" 2>/dev/null || echo "detected")
echo "  Stack:     $STACK_NAME"
echo "  MCP:       $([ "$MCP_CONFIGURED" = "true" ] && echo "✓ configured" || echo "⚠ needs API key")"
echo "  /install:  $([ -f "$HOME/.claude/skills/install/SKILL.md" ] && echo "✓ global skill active" || echo "- not installed")"
echo "  IDEs:      ${SELECTED_IDES[*]}"
echo "  Hooks:     v$HOOKS_VERSION (enforcement: $(ide_selected claude && echo 'claude ')$(ide_selected gemini && echo 'gemini '))"
echo "  Lefthook:  $([ -f lefthook.yml ] && echo "✓ configured" || echo "⚠ not configured")"
echo ""
[ "$MCP_CONFIGURED" != "true" ] && echo -e "  ${YELLOW}→ Set HUB_API_KEY and re-run /install to configure MCP${NC}"
echo -e "  ${CYAN}→ Restart IDE to pick up changes${NC}"
echo ""
