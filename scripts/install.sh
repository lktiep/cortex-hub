#!/bin/bash
# Cortex Hub — Unified Installer (v0.8.0)
# One script for everything: global skill + MCP config + project hooks + IDE setup.
# Idempotent. Version-aware. Auto-updating. Multi-IDE.
#
# Version history:
#   v4.0 — Agent identity, Conductor support, discovery enforcement, stronger hooks
#   v3.x — Multi-IDE, glob pipelines, PS1 parity, fail-closed hooks
#   v2.x — Legacy onboard.sh hooks
#   v1.x — Initial hooks
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

HOOKS_VERSION=7
HOOKS_MINOR=6
MCP_URL_DEFAULT="http://localhost:8318/mcp"

# ── Colors ──
RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'
YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()  { echo -e "${BLUE}[cortex]${NC} $*"; }
ok()    { echo -e "${GREEN}[cortex]${NC} $*"; }
warn()  { echo -e "${YELLOW}[cortex]${NC} $*"; }

# BSD sed (macOS) wants an argument after -i, GNU sed must not get one.
sed_inplace() {
  if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi
}
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
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-"."}")" 2>/dev/null && pwd || echo ".")"
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
  # Check all known IDE config files for cortex-hub MCP entry
  local config_files="$CLAUDE_JSON"
  config_files="$config_files $HOME/.cursor/mcp.json"
  config_files="$config_files $HOME/.codeium/windsurf/mcp_config.json"
  config_files="$config_files $HOME/.gemini/antigravity/mcp_config.json"
  config_files="$config_files .vscode/mcp.json"

  for cf in $config_files; do
    [ -f "$cf" ] || continue
    if command -v python3 >/dev/null 2>&1; then
      python3 -c "
import json, sys
with open('$cf') as f:
    config = json.load(f)
servers = config.get('mcpServers', config.get('servers', {}))
if 'cortex-hub' in servers:
    sys.exit(0)
sys.exit(1)
" 2>/dev/null && return 0
    elif grep -q "cortex-hub" "$cf" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

# Also extract API key from existing IDE config if HUB_API_KEY not set
detect_api_key_from_ide() {
  [ -n "${HUB_API_KEY:-}" ] && return 0
  local config_files="$CLAUDE_JSON $HOME/.cursor/mcp.json $HOME/.codeium/windsurf/mcp_config.json $HOME/.gemini/antigravity/mcp_config.json"
  for cf in $config_files; do
    [ -f "$cf" ] || continue
    local key
    key=$(python3 -c "
import json, sys
with open('$cf') as f:
    config = json.load(f)
servers = config.get('mcpServers', config.get('servers', {}))
srv = servers.get('cortex-hub', {})
env = srv.get('env', {})
key = env.get('HUB_API_KEY', env.get('AUTH_HEADER', ''))
if key.startswith('Bearer '): key = key[7:]
if key: print(key)
" 2>/dev/null || echo "")
    if [ -n "$key" ]; then
      HUB_API_KEY="$key"
      export HUB_API_KEY
      return 0
    fi
  done
  return 1
}

if check_mcp; then
  MCP_CONFIGURED=true
  ok "MCP: configured (found cortex-hub in IDE config)"
else
  # Try to find API key from IDE configs, env, or .env file
  detect_api_key_from_ide 2>/dev/null || true
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
LATEST_VERSION="${HOOKS_VERSION}.${HOOKS_MINOR}"
# Compare: extract major for numeric comparison
INSTALLED_MAJOR=$(echo "$INSTALLED_VERSION" | cut -d. -f1)

if [ "$CHECK_ONLY" = "true" ]; then
  echo ""
  echo -e "${CYAN}=== Cortex Hub Status ===${NC}"
  echo "  Project:        $PROJECT_DIR"
  echo "  MCP configured: $MCP_CONFIGURED"
  echo "  Hooks version:  $INSTALLED_VERSION (latest: $LATEST_VERSION)"
  echo "  Profile:        $([ -f .cortex/project-profile.json ] && echo 'yes' || echo 'no')"
  echo "  Claude hooks:   $([ -f .claude/hooks/enforce-session.sh ] && echo 'yes' || echo 'no')"
  echo "  Gemini hooks:   $([ -f .gemini/hooks/enforce-session.sh ] && echo 'yes' || echo 'no')"
  echo "  Settings:       $([ -f .claude/settings.json ] && echo 'yes' || echo 'no')"
  echo "  Identity:       $([ -f .cortex/agent-identity.json ] && echo 'yes' || echo 'no')"
  HP="$(git -C "$PROJECT_DIR" config --get core.hooksPath 2>/dev/null || true)"
  if [ ! -f lefthook.yml ]; then LH="no"
  elif [ -n "$HP" ]; then LH="yml only — core.hooksPath='$HP' overrides it, gate does NOT run"
  elif grep -q lefthook "$PROJECT_DIR/.git/hooks/pre-commit" 2>/dev/null; then LH="yes (pre-commit gate live)"
  else LH="yml only — no git hook installed"; fi
  echo "  Lefthook:       $LH"
  echo "  CLAUDE.md:      $([ -f CLAUDE.md ] && echo 'yes' || echo 'no')"
  [ "$INSTALLED_VERSION" != "$LATEST_VERSION" ] && warn "Update available: $INSTALLED_VERSION → $LATEST_VERSION. Run /install --force"
  exit 0
fi

NEEDS_UPDATE=false
if [ "$FORCE" = "true" ]; then
  NEEDS_UPDATE=true
  info "Force mode: regenerating all files"
elif [ "$INSTALLED_VERSION" != "$LATEST_VERSION" ]; then
  NEEDS_UPDATE=true
  info "Updating hooks v$INSTALLED_VERSION → v$LATEST_VERSION"
elif [ ! -f ".claude/hooks/enforce-session.sh" ] || [ ! -f ".claude/settings.json" ]; then
  NEEDS_UPDATE=true
  info "Missing files detected, regenerating..."
else
  ok "Hooks: up to date (v$LATEST_VERSION)"
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
    PRE_COMMIT_CMDS=$(IFS=,; echo "${PRE_COMMIT[*]+"${PRE_COMMIT[*]}"}")
    FULL_CMDS=$(IFS=,; echo "${FULL[*]+"${FULL[*]}"}")
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
  if ! printf '%s\n' ${DETECTED_STACKS[@]+"${DETECTED_STACKS[@]}"} 2>/dev/null | grep -q "python" && find . -maxdepth 3 -name "*.py" 2>/dev/null | grep -q .; then
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
  STACKS_JSON=$(printf '"%s",' ${DETECTED_STACKS[@]+"${DETECTED_STACKS[@]}"} | sed 's/,$//')
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
# Phase 3b: Agent Identity (auto-detect environment)
# ══════════════════════════════════════════════
IDENTITY_FILE=".cortex/agent-identity.json"
if [ ! -f "$IDENTITY_FILE" ]; then
  info "Generating agent identity..."

  # Auto-detect environment
  DETECT_OS="unknown"
  case "$OSTYPE" in
    darwin*) DETECT_OS="macOS" ;;
    linux*)  DETECT_OS="linux" ;;
    msys*|cygwin*|mingw*) DETECT_OS="windows" ;;
  esac
  DETECT_HOSTNAME=$(hostname 2>/dev/null || echo "unknown")
  DETECT_ARCH=$(uname -m 2>/dev/null || echo "unknown")

  # Detect available tools
  DETECT_TOOLS=""
  for tool in godot blender python3 python dotnet cargo go node pnpm npm docker ffmpeg git; do
    command -v "$tool" >/dev/null 2>&1 && DETECT_TOOLS="${DETECT_TOOLS}\"$tool\","
  done
  DETECT_TOOLS="[${DETECT_TOOLS%,}]"

  # Generate identity file (user should edit role/capabilities/description)
  cat > "$IDENTITY_FILE" << IDEOF
{
  "schema_version": "1.0",
  "agent_name": "$(whoami)-$(echo "$DETECT_HOSTNAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')",
  "environment": {
    "os": "$DETECT_OS",
    "hostname": "$DETECT_HOSTNAME",
    "arch": "$DETECT_ARCH",
    "tools": $DETECT_TOOLS
  },
  "role": "",
  "capabilities": [],
  "description": "",
  "resources": [],
  "tags": ["$DETECT_OS"]
}
IDEOF
  ok "Identity: $IDENTITY_FILE created (edit to add role/capabilities)"
  warn "  Run: \$EDITOR $IDENTITY_FILE to set role, capabilities, description"
else
  ok "Identity: already exists"
fi

# ══════════════════════════════════════════════
# Phase 4: Install Hooks (if needed)
# ══════════════════════════════════════════════
if [ "$NEEDS_UPDATE" = "true" ]; then
  mkdir -p .claude/hooks .cortex/.session-state

  # ── session-init.sh ──
  cat > .claude/hooks/session-init.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Session Init (v7.1) — arms the gates; keeps discovery state across compaction.
#
# SessionStart fires on four different things: startup, resume, clear and compact.
# Wiping the discovery markers on all four is why a long task suddenly finds Grep and
# Edit blocked again halfway through itself — the context was compacted, the work was
# not restarted. Only a genuinely new session clears the gates.
#
# v7.0 also touched `session-started` here, which made the whole session gate vacuous: the
# marker existed before cortex_session_start had ever been called, so the "no session yet"
# branch of enforce-session.sh was dead code and enforce-commit.sh's session check always
# passed. Only the tracker writes that marker now, from a real cortex_session_start call.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat 2>/dev/null || true)
SOURCE=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("source",""))' 2>/dev/null || true)
  fi
fi

case "$SOURCE" in
  compact|resume)
    echo "Cortex: same session (${SOURCE}) — discovery state kept, gates stay as they were."
    exit 0 ;;
esac

# A new session: everything from the last one is stale, including the markers that
# were never reset before and so stayed satisfied for months.
rm -f "$STATE_DIR/session-started" \
      "$STATE_DIR/quality-gates-passed" \
      "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" \
      "$STATE_DIR/quality-reported" \
      "$STATE_DIR/session-ended" "$STATE_DIR/discovery-used" \
      "$STATE_DIR/knowledge-recalled" "$STATE_DIR/memory-recalled" \
      "$STATE_DIR/changes-checked" "$STATE_DIR/tasks-checked" \
      "$STATE_DIR/gate-off" "$STATE_DIR/session-id" 2>/dev/null
echo "Run /cs first: cortex_session_start, then knowledge+memory recall. Until then edits are BLOCKED, and Grep/Glob stay blocked until a cortex discovery tool has run."
HOOKEOF

  # ── enforce-session.sh ──
  cat > .claude/hooks/enforce-session.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Session Enforcement (v6.1) — hold tools back until the cortex workflow is followed.
#
# What this can and cannot do: the hook shares a filesystem with the agent it gates, so
# it cannot stop an agent that decides to forge a marker. What it can do is make the
# correct path the easy one, and make the wrong path visible. That is why markers must
# now carry evidence of a real tool call instead of merely existing, and why the way out
# is an explicit, named file rather than a silent trick.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

INPUT=$(cat)
TOOL_NAME=""
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  # Without this fallback the whole gate silently became a no-op on any machine without jq.
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
" 2>/dev/null || true)"
fi

[ -z "$TOOL_NAME" ] && { echo "BLOCKED: Cannot parse hook input (install jq or python3)." >&2; exit 2; }

# An escape hatch that has to be asked for out loud. When the hub is unreachable the
# tools this gate points at cannot run, and a gate with no path through it just stops
# the work — so there is a way out, it is one line, and it leaves a trace.
if [ -s "$STATE_DIR/gate-off" ]; then
  exit 0
fi

# A marker counts only if a tool wrote evidence into it. An empty file is a touch.
marker_ok() {
  [ -s "$STATE_DIR/$1" ] && grep -q '^tool=' "$STATE_DIR/$1" 2>/dev/null
}

# A search command counts as codebase search when it *starts* a command: `cd apps && grep -r x`
# is the search this gate is about. `pnpm build | grep error` filters output of something
# else and has nothing to do with finding code, so it stays allowed.
is_codebase_search() {
  # Everything after a heredoc marker is data being written, not commands being run —
  # a file whose text happens to contain the word grep is not a search.
  local cmd="${1%%<<*}"
  printf '%s' "$cmd" | grep -Eq '(^|[;&]{1,2}[[:space:]]*|\([[:space:]]*)[[:space:]]*(sudo[[:space:]]+)?(grep|egrep|fgrep|rg|ag|ack|find|fd)[[:space:]]' && return 0
  printf '%s' "$cmd" | grep -Eq '(^|[;&]{1,2}[[:space:]]*)[[:space:]]*git[[:space:]]+grep[[:space:]]' && return 0
  return 1
}

# Writing the escape hatch itself can never be blocked by the gate it opens, or the only
# way out of a gate armed against an unreachable hub is a trick.
is_gate_off_write() {
  printf '%s' "$1" | grep -Eq '>[[:space:]]*"?[^"[:space:]]*\.cortex/\.session-state/gate-off"?[[:space:]]*$'
}

# Editing through Bash is still editing. Gating Edit/Write while leaving `cat > file`,
# `sed -i` and `tee` open meant the recall gate only ever applied to agents that used
# the dedicated tools.
is_file_write() {
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(sed[[:space:]]+-i|tee[[:space:]]|dd[[:space:]]|truncate[[:space:]]|install[[:space:]]+-)' && return 0
  # Drop the redirects that write nowhere — `2>/dev/null` and `>&2` are not file edits —
  # then anything left pointing at a name is one.
  local cmd
  cmd=$(printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*&[0-9-]//g; s/[0-9]*>>?[[:space:]]*"?\/dev\/[a-zA-Z0-9]+"?//g')
  printf '%s' "$cmd" | grep -Eq '>>?[[:space:]]*"?[^&|"[:space:]]' && return 0
  return 1
}

HOW_OUT="If the Cortex hub is unreachable (MCP reports CONNECTION_CLOSED), say so and write the reason: echo 'hub unreachable' > .cortex/.session-state/gate-off"

# ── Session started: enforce discovery-first + knowledge/memory recall ──
if [ -f "$STATE_DIR/session-started" ]; then
  if ! marker_ok discovery-used; then
    if [ "$TOOL_NAME" = "Grep" ] || [ "$TOOL_NAME" = "Glob" ]; then
      echo "BLOCKED: use cortex_code_search first — it is AST-aware and returns the target file inside the top 10 far more reliably than a pattern guess. $HOW_OUT" >&2
      exit 2
    fi
    if [ "$TOOL_NAME" = "Bash" ] && is_codebase_search "$COMMAND"; then
      echo "BLOCKED: use cortex_code_search first. find/grep/rg unlock once a cortex discovery tool has run — and stay the right choice for an exact literal (env var, config key, error string), not for a question about behaviour. $HOW_OUT" >&2
      exit 2
    fi
  fi

  # Recall is a precondition for writing, not a consolation prize for not having
  # searched. This block used to live inside the `! marker_ok discovery-used`
  # branch above, so a single cortex_code_search call retired the requirement for
  # the rest of the session — while CLAUDE.md said editing without both recalls is
  # refused, full stop.
  WRITES_A_FILE=0
  case "$TOOL_NAME" in
    Edit|Write|NotebookEdit) WRITES_A_FILE=1 ;;
    Bash) is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND" && WRITES_A_FILE=1 ;;
  esac
  if [ "$WRITES_A_FILE" = "1" ]; then
    if ! marker_ok knowledge-recalled || ! marker_ok memory-recalled; then
      echo "BLOCKED: run cortex_knowledge_search and cortex_memory_search before editing — they restore what previous sessions already decided and already fixed. Run /cs to do every step at once. $HOW_OUT" >&2
      exit 2
    fi
  fi
  exit 0
fi

# ── Session NOT started: block writes and codebase search, allow plain reads ──
# Until v7.1 of session-init this branch never ran: the init hook created the session-started
# marker itself, so every session looked started before cortex_session_start was ever called.
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit)
    echo "BLOCKED: call cortex_session_start first (or run /cs). No edits without a session." >&2
    exit 2 ;;
  Grep|Glob)
    echo "BLOCKED: run /cs first (cortex_session_start + knowledge/memory recall), then search with cortex_code_search. $HOW_OUT" >&2
    exit 2 ;;
  Bash)
    if is_codebase_search "$COMMAND"; then
      echo "BLOCKED: run /cs first, then search with cortex_code_search. find/grep/rg unlock once a cortex discovery tool has run. $HOW_OUT" >&2
      exit 2
    fi
    # The write check goes before the read allowlist, or `cat > file` passes as a read.
    if is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND"; then
      echo "BLOCKED: call cortex_session_start first (or run /cs). No file modifications without a session." >&2
      exit 2
    fi
    [[ "$COMMAND" =~ ^(ls|cat|head|tail|pwd|which|echo|git\ (status|log|diff|branch|remote|show)|pnpm\ |npm\ |yarn\ |cargo\ |go\ |python|curl|dotnet\ |node\ ) ]] && exit 0
    [[ "$COMMAND" =~ (git\ (add|commit|push|reset)|rm\ |mv\ |cp\ |mkdir\ |touch\ |chmod\ ) ]] && {
      echo "BLOCKED: call cortex_session_start first (or run /cs). No file modifications without a session." >&2
      exit 2
    }
    exit 0 ;;
esac
exit 0
HOOKEOF

  # ── enforce-commit.sh ──
  cat > .claude/hooks/enforce-commit.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Commit Enforcement (v5.0) — a commit needs the workflow behind it.
#
# v4 accepted `quality-gates-passed`, which the tracker used to write the moment
# cortex_quality_report was called — so reporting a failure unlocked the commit just as
# well as passing. The marker now comes only from build/typecheck/lint actually running
# green, and the report is a separate, softer expectation.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi
[[ ! "$COMMAND" =~ ^git\ (commit|push) ]] && exit 0

if [[ "$COMMAND" =~ ^git\ commit ]]; then
  MISSING=""
  [ ! -f "$STATE_DIR/session-started" ] && MISSING="${MISSING}\n  - cortex_session_start (not called)"
  [ ! -s "$STATE_DIR/discovery-used" ] && MISSING="${MISSING}\n  - cortex_code_search / code_context / knowledge_search (no discovery recorded — search before you edit)"
  [ ! -s "$STATE_DIR/quality-gates-passed" ] && MISSING="${MISSING}\n  - Quality gates: run build, typecheck and lint and let them pass (calling cortex_quality_report no longer counts)"
  if [ -n "$MISSING" ]; then
    echo "BLOCKED: cannot commit — missing Cortex workflow steps:${MISSING}" >&2
    echo "" >&2
    echo "See the 'Finding code fast' and 'Quality Gates' sections of CLAUDE.md." >&2
    exit 2
  fi
  [ ! -s "$STATE_DIR/quality-reported" ] && echo "REMINDER: call cortex_quality_report with the gate results so the dashboard sees this session." >&2
fi

if [[ "$COMMAND" =~ ^git\ push ]]; then
  echo "REMINDER: after push, call cortex_code_reindex so code intelligence matches what you pushed." >&2
fi
exit 0
HOOKEOF

  # ── track-quality.sh ──
  cat > .claude/hooks/track-quality.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Quality Tracker (v4.0) — records what actually happened, as evidence.
#
# Two things changed from v3, both of them bugs found by reading a real hook payload:
#   1. The field is `tool_response`, not `tool_output`. v3 read `tool_output`, so the
#      session id was never captured and the auto-close on exit never had anything to
#      close — on this repo `.cortex/.session-state/session-id` had never once been written.
#   2. Markers were empty files, so a `touch` was indistinguishable from a tool call and
#      the gates could be satisfied without doing any of the work. They now carry the tool
#      name and a timestamp, and the enforcement hook requires that content.
#
# Note on exit codes: PostToolUse does not fire at all when a Bash command exits non-zero,
# so a failing `pnpm build` cannot mark its gate. What it can still do is hide the failure
# behind `|| true` or a pipe, which is why the output is scanned for failure signatures.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat)
COMMAND=""
TOOL_NAME=""
OUTPUT=""

if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  OUTPUT=$(printf '%s' "$INPUT" | jq -r '[(.tool_response // .tool_output // empty)] | tostring' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('tool_response', d.get('tool_output',''))
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'OUTPUT={repr(json.dumps(r) if not isinstance(r,str) else r)}')
" 2>/dev/null || true)"
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Evidence, not existence: the enforcement hook only accepts a marker that says who wrote it.
record() {
  printf 'tool=%s at=%s\n' "${2:-$TOOL_NAME}" "$NOW" > "$STATE_DIR/$1"
}

# A command that reports success while the build failed — `pnpm build || true`, or a pipe
# that swallows the status. If the output says it failed, the gate does not open.
looks_failed() {
  printf '%s' "$OUTPUT" | grep -Eq 'ERR_PNPM|ELIFECYCLE|error TS[0-9]|Command failed|✖|FAIL |Exit status [1-9]'
}

# 1 = this command is not one of the quality gates. mark_gate flips it, and the
# invalidation block at the bottom reads it, so `pnpm build | tee build.log` does not
# revoke the very marker it just armed.
GATE_COMMAND=1
mark_gate() {
  GATE_COMMAND=0
  looks_failed && return 0
  record "$1" "$COMMAND"
}

[[ "$COMMAND" =~ (pnpm|npm|yarn)\ build ]]    && mark_gate gate-build
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ typecheck ]] && mark_gate gate-typecheck
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ lint ]]      && mark_gate gate-lint
[[ "$COMMAND" =~ cargo\ build ]]               && mark_gate gate-build
[[ "$COMMAND" =~ cargo\ clippy ]]              && mark_gate gate-lint
[[ "$COMMAND" =~ go\ build ]]                  && mark_gate gate-build
[[ "$COMMAND" =~ go\ vet ]]                    && mark_gate gate-lint
[[ "$COMMAND" =~ dotnet\ build ]]              && mark_gate gate-build

# Quality gates pass when the commands passed — not when a tool was called to say so.
if [ -s "$STATE_DIR/gate-build" ] && [ -s "$STATE_DIR/gate-typecheck" ] && [ -s "$STATE_DIR/gate-lint" ]; then
  record quality-gates-passed "build+typecheck+lint"
elif [ -s "$STATE_DIR/gate-build" ] && [ -s "$STATE_DIR/gate-lint" ] && [ ! -s "$STATE_DIR/gate-typecheck" ]; then
  # Languages without a separate typecheck step (Go, Rust): build + lint is the full set.
  if [ -f "$PROJECT_DIR/.cortex/project-profile.json" ] \
     && ! grep -q '"typecheck"' "$PROJECT_DIR/.cortex/project-profile.json" 2>/dev/null; then
    record quality-gates-passed "build+lint (no typecheck in project-profile)"
  fi
fi

# ── Cortex tool calls ──
case "$TOOL_NAME" in
  *cortex_session_start*)
    record session-started
    # The id arrives inside an MCP text block, so the JSON is escaped one level deep —
    # dropping the backslashes first is what makes one pattern work for both shapes.
    SESSION_ID=$(printf '%s' "$INPUT" | tr -d '\\' \
      | grep -Eo '"session_?[iI]d"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
    [ -n "$SESSION_ID" ] && printf '%s\n' "$SESSION_ID" > "$STATE_DIR/session-id"
    ;;
  *cortex_session_end*)    record session-ended ;;
  *cortex_quality_report*) record quality-reported ;;
  *cortex_code_search*|*cortex_code_context*|*cortex_code_impact*|*cortex_cypher*)
    record discovery-used ;;
  # Recall is not discovery: knowledge and memory answer "why" and "has this broken before",
  # not "where is the code". Arming discovery-used here would let /cs alone open Grep and Glob.
  *cortex_knowledge_search*) record knowledge-recalled ;;
  *cortex_memory_search*)    record memory-recalled ;;
  *cortex_task_pickup*)    record tasks-checked ;;
  *cortex_detect_changes*|*cortex_changes*) record changes-checked ;;
esac

# ── A passing build certifies a tree, not a session ──
#
# The gate markers used to survive any edit made after them, so
# "pnpm build && typecheck && lint" → edit one file → `git commit` passed the commit
# gate with code that had never been checked. Reproduced in a sandbox: arming the
# three gates, then feeding an Edit, left quality-gates-passed armed and the commit
# gate returned 0. A write invalidates the certificate — the gates have to run again
# on the tree that is actually being committed.
writes_a_file() {
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(sed[[:space:]]+-i|tee[[:space:]]|dd[[:space:]]|truncate[[:space:]]|install[[:space:]]+-)' && return 0
  local cmd
  cmd=$(printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*&[0-9-]//g; s/[0-9]*>>?[[:space:]]*"?\/dev\/[a-zA-Z0-9]+"?//g')
  printf '%s' "$cmd" | grep -Eq '>>?[[:space:]]*"?[^&|"[:space:]]' && return 0
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(cp|mv|rm|mkdir|touch|patch|git[[:space:]]+apply)[[:space:]]' && return 0
  return 1
}
INVALIDATES=0
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) INVALIDATES=1 ;;
  Bash)
    # Editing through a shell is still editing. But a gate command that pipes its own
    # output to a file must not revoke the marker it just armed one screen above.
    if [ "$GATE_COMMAND" = "1" ] && writes_a_file "$COMMAND"; then
      INVALIDATES=1
    fi
    ;;
esac
if [ "$INVALIDATES" = "1" ]; then
  rm -f "$STATE_DIR/quality-gates-passed" "$STATE_DIR/gate-build" \
        "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint"
fi
exit 0
HOOKEOF

  # ── session-end-check.sh ──
  cat > .claude/hooks/session-end-check.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Session End Check (v6) — closes the cortex session when the session really ends.
#
# v5 was wired to the Stop event, which fires every time the agent finishes a turn. Had the
# session id ever been captured (it was not — v3 of the tracker read the wrong JSON field),
# this would have closed the session after the first answer and left the rest of the
# conversation running outside it. It belongs on SessionEnd.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ -f "$STATE_DIR/session-started" ] || exit 0
[ -f "$STATE_DIR/session-ended" ] && exit 0

SESSION_ID=""
[ -s "$STATE_DIR/session-id" ] && SESSION_ID=$(cat "$STATE_DIR/session-id" 2>/dev/null || true)

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  echo "WARNING: cortex session not closed — no session id was recorded. Run /ce next time."
  exit 0
fi

API_URL="${CORTEX_HUB_API_URL:-http://localhost:4000}"
ACTIONS=""
[ -s "$STATE_DIR/knowledge-recalled" ]   && ACTIONS="${ACTIONS} knowledge-searched"
[ -s "$STATE_DIR/memory-recalled" ]      && ACTIONS="${ACTIONS} memory-searched"
[ -s "$STATE_DIR/discovery-used" ]       && ACTIONS="${ACTIONS} code-searched"
[ -s "$STATE_DIR/changes-checked" ]      && ACTIONS="${ACTIONS} changes-checked"
[ -s "$STATE_DIR/quality-gates-passed" ] && ACTIONS="${ACTIONS} quality-passed"
[ -s "$STATE_DIR/quality-reported" ]     && ACTIONS="${ACTIONS} quality-reported"
[ -s "$STATE_DIR/tasks-checked" ]        && ACTIONS="${ACTIONS} tasks-checked"
[ -s "$STATE_DIR/gate-off" ]             && ACTIONS="${ACTIONS} gate-off($(head -c 80 "$STATE_DIR/gate-off" | tr -d '"\n'))"

SUMMARY="Session auto-closed (no /ce)."
[ -n "$ACTIONS" ] && SUMMARY="Session auto-closed. Activity:${ACTIONS}."

curl -X POST "${API_URL}/api/sessions/${SESSION_ID}/end" \
  -H 'Content-Type: application/json' \
  -d "{\"summary\":\"${SUMMARY}\"}" \
  --connect-timeout 5 -s -o /dev/null || true

touch "$STATE_DIR/session-ended"
echo "INFO: cortex session $SESSION_ID auto-closed.${ACTIONS:+ Activity:${ACTIONS}}"
exit 0
HOOKEOF

  chmod +x .claude/hooks/*.sh
  ok "Hooks: all 5 hooks installed (v${HOOKS_VERSION}.${HOOKS_MINOR})"

  # ── settings.json ──
  # Call bash directly — works on macOS (native) and Windows (Git Bash).
  # The path is anchored to CLAUDE_PROJECT_DIR because Claude Code runs a hook in the
  # shell cwd, which follows every cd: a relative path failed with No such file in a
  # subdirectory, and Claude Code treats that as non-blocking, so every gate opened.
  cat > .claude/settings.json << 'EOF'
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/session-init.sh\""
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
            "command": "bash \"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/enforce-session.sh\""
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/enforce-commit.sh\""
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
            "command": "bash \"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/track-quality.sh\""
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/session-end-check.sh\""
          }
        ]
      }
    ]
  }
}
EOF
  ok "Settings: .claude/settings.json generated"

  # ── Clean user-level hooks (prevent duplicate/stale hooks) ──
  USER_SETTINGS="$HOME/.claude/settings.json"
  if [ -f "$USER_SETTINGS" ] && command -v python3 >/dev/null 2>&1; then
    if python3 -c "import json; d=json.load(open('$USER_SETTINGS')); exit(0 if 'hooks' in d else 1)" 2>/dev/null; then
      python3 -c "
import json
with open('$USER_SETTINGS') as f: d=json.load(f)
d.pop('hooks', None)
with open('$USER_SETTINGS','w') as f: json.dump(d, f, indent=2)
" 2>/dev/null && ok "Removed stale hooks from user-level settings (~/.claude/settings.json)" || true
    fi
  fi

  # ── Slash commands (/cs, /ce) ──
  mkdir -p .claude/commands
  cat > .claude/commands/cs.md << 'CMDEOF'
# /cs — Cortex Start v0.8.0

> Version: 0.8.0 | Updated: 2026-09-28
> Changelog: v0.8.0 — search-once/read-all-ten ordering from measured retrieval; recall no longer counts as discovery
> Changelog: v0.7.0 — unified versioning, removed STATE.md, streamlined tool guidance, auto-memory safety net
> Changelog: v2.1 — added plan quality gate before implementation
> Changelog: v2.0 — added task pickup, detect changes, recipe health, workflow recipes, versioning

Run ALL steps IN ORDER. Do NOT proceed to user work until Step 7 completes.

## Step 1: Session Start
Call `cortex_session_start`:
```
repo: "__GIT_REPO__"
mode: "development"
agentId: "claude-code"
ide: "<your IDE>"
branch: "<current git branch>"
```
Save `session_id`, `projectId` and `project.orgId` from the response. `orgId` is the boundary of a cross-repo search.
If `recentChanges.count > 0` → warn user and `git pull` before any edits.

## Step 2: Recall Context (parallel)
Call BOTH in parallel:
- `cortex_knowledge_search(query: "session summary progress next session")`
- `cortex_memory_search(query: "session context decisions lessons", agentId: "claude-code")`

These return what was done last session, key decisions, and next steps.

## Step 3: Conflict Check
`cortex_changes(agentId: "claude-code", projectId: "<from step 1>")`

## Step 4: Task Pickup (Optional)
If `cortex_task_pickup` tool is available:
`cortex_task_pickup()` — check for Conductor tasks assigned to you.
If tasks exist → list them. Ask user which to work on, or continue with their request.
If the tool is not available (e.g. in solo dev mode), skip this step.

## Step 5: Working State Check
Run `git status`. If uncommitted changes:
- `cortex_detect_changes(diff: "<output of git diff HEAD>")` — analyze risk level. The hub cannot see your working tree, so pass the diff
- Report affected symbols and blast radius

## Step 6: Situational Summary
Print a concise report:

```
## Session Init Complete
- **Last session**: <what was done, from memory/knowledge recall>
- **Pending tasks**: <N tasks> or none
- **Unseen changes**: <from other agents> or clean
- **Working state**: clean / <N uncommitted files, risk level>
- **Key context**: <relevant decisions or lessons>
- Ready to start work.
```

## Step 7: Activate Workflow Intelligence
For the REST of this session, use cortex tools naturally:

### Before implementing a plan:
1. Draft plan with steps + files to change
2. `cortex_plan_quality(plan: "<your plan>")` → score 0-100
3. If score < 60 → refine. If 60-80 → proceed with caution. If > 80 → execute.

### Finding the code to change:
**Start from what you know, not from a fixed ladder:**

| You already know | Start with |
|---|---|
| A symbol name | `cortex_code_context(name)` — exact graph lookup, plus callers/callees/imports in one call |
| Only the behaviour | `cortex_code_search(query, limit: 10)` — ranked hybrid search, one call |
| An exact literal (env var, config key, error string) | `rg` / `grep` — this is not a ranking problem |
| A relationship across files | `cortex_cypher` |

**Search once, read all ten.** Measured on cortex-hub's own index (`benchmarks/retrieval_bench.ts`,
n=15): the target file is in the top 10 for 15/15 queries but at rank 1 for only 8/15. So scan
the whole result set, and never re-run a reworded version of the same query — recall@10 is
already 1.000, so it returns the same set. Ask a different question or switch tool instead.

**Knowledge and memory are for errors and decisions, not for locating code.** Recall them once
at session start, then when something breaks — not before every lookup.

`cortex_code_impact` before editing something exported or shared; `cortex_changes` before
touching a file another agent may hold.

### Cross-project lookup:
Projects are isolated per organization; related repos (client, server, tools) share one.
```
cortex_code_search(query: "...")                      # every repo in this organization
cortex_code_search(query: "...", repo: "my-backend")  # one repo
cortex_code_context(name: "...", repo: "my-backend")
cortex_list_repos()                                   # the repos "every repo" covers
```
Running sessions in two organizations with one API key at once? Pass `org: "<orgId>"`.

### When hitting an error:
1. `cortex_knowledge_search` → check if known
2. `cortex_memory_search` → check if seen before
3. Fix the error
4. If non-obvious → `cortex_knowledge_store` to save for others

### Before committing:
1. `cortex_detect_changes(diff: "<output of git diff --staged>")` — verify blast radius. `risk_level: "unknown"` means a lookup failed: it is not a pass
2. Commit
3. After push → `cortex_code_reindex(repo: "...", branch: "<branch>")`

### Working on a Conductor task:
1. `cortex_task_accept(taskId)` at start
2. `cortex_task_update(taskId, status: "in_progress")` during work
3. `cortex_task_update(taskId, status: "completed", result: {...})` when done

---
All cortex gates satisfied. Proceed with user tasks.
CMDEOF
  sed_inplace "s|__GIT_REPO__|${GIT_REPO}|g" .claude/commands/cs.md

  cat > .claude/commands/ce.md << 'CMDEOF'
# /ce — Cortex End v0.8.0

> Version: 0.8.0 | Updated: 2026-09-28
> Changelog: v0.8.0 — search-once/read-all-ten ordering from measured retrieval; recall no longer counts as discovery
> Changelog: v0.7.0 — unified versioning, session_end auto-saves memory, removed STATE.md, streamlined steps
> Changelog: v2.0 — added detect_changes, tool stats, task completion, recipe capture check

Run ALL steps IN ORDER before ending the session.

## Step 1: Pre-commit Check
If uncommitted changes exist:
- `cortex_detect_changes(diff: "<output of git diff HEAD>")` — verify blast radius
- If HIGH risk → warn user before proceeding

## Step 2: Quality Gates
```bash
pnpm build && pnpm typecheck && pnpm lint
```
Record pass/fail for each.

## Step 3: Quality Report
```
cortex_quality_report(
  gate_name: "Session Quality",
  passed: <true if all gates pass>,
  score: <0-100>,
  details: "<build/typecheck/lint results>"
)
```

## Step 4: Complete Conductor Tasks (Optional)
If `cortex_task_list` and `cortex_task_update` tools are available:
`cortex_task_list(status: "in_progress")` — find tasks worked on this session.
For each: `cortex_task_update(taskId, status: "completed", result: { summary: "..." })`
If the tools are not available, skip this step.

## Step 5: Store Knowledge (if applicable)
If this session involved any of these, call `cortex_knowledge_store`:
- Bug fix with non-obvious root cause
- Architecture decision or tradeoff
- Workflow pattern that worked well
- Error + solution that others might encounter

## Step 6: Store Memory
`cortex_memory_store` with:
- What was done this session
- Key decisions made
- Context for resuming next session
- Any user preferences discovered

## Step 7: End Session
```
cortex_session_end(
  sessionId: "<from session_start>",
  summary: "<concise: what was done, what's next>"
)
```
> The backend automatically saves this summary as searchable memory — a safety net even if Step 6 was skipped.

## Step 8: Final Report
```
## Session Complete
- **Work done**: <brief summary>
- **Quality gates**: build pass/fail | typecheck pass/fail | lint pass/fail
- **Knowledge stored**: <N docs> or none
- **Tasks completed**: <list> or none
- **Next steps**: <what should be done next session>
```
CMDEOF
  sed_inplace "s|__GIT_REPO__|${GIT_REPO}|g" .claude/commands/ce.md
  ok "Commands: /cs and /ce slash commands installed"

  # ── Gemini / Antigravity hooks ──
  if ide_selected "gemini"; then
    mkdir -p .gemini/hooks

    # Gemini hooks use JSON response format: {"decision":"allow"} or {"decision":"deny","reason":"..."}
    cat > .gemini/hooks/session-init.sh << 'GHOOKEOF'
#!/bin/bash
# Cortex Session Init (v7.1) — Gemini variant.
#
# v3 wiped the gate markers on every SessionStart. Where the host distinguishes a resumed or
# compacted session from a fresh one, re-arming the discovery gate mid-task is a bug: the agent
# already did the recall, and it cannot prove it any more. v3 also never cleared changes-checked
# or tasks-checked, so those markers survived for months and the checks silently stopped running.
#
# And it cleared session-started on every start, which is right — but the claude variant used to
# create it here instead, making its whole session gate vacuous. Only the tracker writes it, from
# a real cortex_session_start call.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat 2>/dev/null || true)
SOURCE=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("source",""))' 2>/dev/null || true)
  fi
fi

case "$SOURCE" in
  compact|resume)
    echo '{"systemMessage":"Cortex: same session ('"$SOURCE"') — discovery state kept."}'
    exit 0 ;;
esac

rm -f "$STATE_DIR/session-started" "$STATE_DIR/quality-gates-passed" \
      "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" \
      "$STATE_DIR/quality-reported" "$STATE_DIR/session-ended" \
      "$STATE_DIR/discovery-used" "$STATE_DIR/knowledge-recalled" \
      "$STATE_DIR/memory-recalled" "$STATE_DIR/changes-checked" \
      "$STATE_DIR/tasks-checked" "$STATE_DIR/gate-off" "$STATE_DIR/session-id" 2>/dev/null
echo '{"systemMessage":"MANDATORY: call cortex_session_start, then cortex_knowledge_search + cortex_memory_search, before any edit. search_file_content and glob stay blocked until a cortex discovery tool has run."}'
GHOOKEOF

    cat > .gemini/hooks/enforce-session.sh << 'GHOOKEOF'
#!/bin/bash
# Cortex Session Enforcement (v6.1) — Gemini variant.
#
# v3 only checked that a session existed: once cortex_session_start had run, every tool was
# allowed. So the discovery-first rule was documentation, not enforcement. This mirrors the
# Claude hook — gate grep/glob until a cortex discovery tool has run, and gate writes until
# knowledge and memory have been recalled — in Gemini's JSON decision protocol.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

allow() { echo '{"decision":"allow"}'; exit 0; }
deny()  { printf '{"decision":"deny","reason":%s}\n' "$(printf '%s' "$1" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"BLOCKED: cortex workflow step missing."')"; exit 0; }

INPUT=$(cat)
TOOL_NAME=""
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  # v3 read the command with jq only, so on a machine without jq the commit and write gates
  # quietly passed everything.
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
" 2>/dev/null || true)"
fi
[ -z "$TOOL_NAME" ] && allow

# Declared escape hatch: when the hub is unreachable the tools this gate points at cannot run.
[ -s "$STATE_DIR/gate-off" ] && allow

marker_ok() { [ -s "$STATE_DIR/$1" ] && grep -q '^tool=' "$STATE_DIR/$1" 2>/dev/null; }

is_codebase_search() {
  local cmd="${1%%<<*}"   # heredoc bodies are data being written, not commands being run
  printf '%s' "$cmd" | grep -Eq '(^|[;&]{1,2}[[:space:]]*|\([[:space:]]*)[[:space:]]*(sudo[[:space:]]+)?(grep|egrep|fgrep|rg|ag|ack|find|fd)[[:space:]]' && return 0
  printf '%s' "$cmd" | grep -Eq '(^|[;&]{1,2}[[:space:]]*)[[:space:]]*git[[:space:]]+grep[[:space:]]' && return 0
  return 1
}
is_gate_off_write() {
  printf '%s' "$1" | grep -Eq '>[[:space:]]*"?[^"[:space:]]*\.cortex/\.session-state/gate-off"?[[:space:]]*$'
}
is_file_write() {
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(sed[[:space:]]+-i|tee[[:space:]]|dd[[:space:]]|truncate[[:space:]]|install[[:space:]]+-)' && return 0
  local cmd
  cmd=$(printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*&[0-9-]//g; s/[0-9]*>>?[[:space:]]*"?\/dev\/[a-zA-Z0-9]+"?//g')
  printf '%s' "$cmd" | grep -Eq '>>?[[:space:]]*"?[^&|"[:space:]]' && return 0
  return 1
}

HOW_OUT="If the Cortex hub is unreachable, say so and write the reason: echo 'hub unreachable' > .cortex/.session-state/gate-off"

if [ -f "$STATE_DIR/session-started" ]; then
  if ! marker_ok discovery-used; then
    case "$TOOL_NAME" in
      search_file_content|glob)
        deny "BLOCKED: use cortex_code_search first — it is AST-aware and returns the target file inside the top 10 far more reliably than a pattern guess. $HOW_OUT" ;;
      run_shell_command|shell)
        is_codebase_search "$COMMAND" && deny "BLOCKED: use cortex_code_search first. find/grep/rg unlock once a cortex discovery tool has run — and stay the right choice for an exact literal (env var, config key, error string), not for a question about behaviour. $HOW_OUT" ;;
    esac
  fi

  # Recall is a precondition for writing, not a consolation prize for not having
  # searched — see the same fix in .claude/hooks/enforce-session.sh.
  WRITES_A_FILE=0
  case "$TOOL_NAME" in
    write_file|replace|edit_file|create_file|insert_text) WRITES_A_FILE=1 ;;
    run_shell_command|shell) is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND" && WRITES_A_FILE=1 ;;
  esac
  if [ "$WRITES_A_FILE" = "1" ]; then
    if ! marker_ok knowledge-recalled || ! marker_ok memory-recalled; then
      deny "BLOCKED: run cortex_knowledge_search and cortex_memory_search before editing — they restore what previous sessions already decided and already fixed. $HOW_OUT"
    fi
  fi
  allow
fi

# Session not started: block writes and codebase search, allow plain reads.
case "$TOOL_NAME" in
  write_file|replace|edit_file|create_file|insert_text)
    deny "BLOCKED: call cortex_session_start first. No edits without a session." ;;
  glob|search_file_content)
    deny "BLOCKED: call cortex_session_start first, then search with cortex_code_search. $HOW_OUT" ;;
  run_shell_command|shell)
    is_codebase_search "$COMMAND" && deny "BLOCKED: call cortex_session_start first, then search with cortex_code_search. $HOW_OUT"
    is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND" \
      && deny "BLOCKED: call cortex_session_start first. No file modifications without a session."
    printf '%s' "$COMMAND" | grep -Eq '(git[[:space:]]+(add|commit|push|reset)|^rm[[:space:]]|^mv[[:space:]]|^cp[[:space:]]|^mkdir[[:space:]])' \
      && deny "BLOCKED: call cortex_session_start first. No file modifications without a session." ;;
esac
allow
GHOOKEOF

    cat > .gemini/hooks/enforce-commit.sh << 'GHOOKEOF'
#!/bin/bash
# Cortex Commit Enforcement (v5.0) — Gemini variant.
#
# v3 accepted quality-gates-passed, which the tracker wrote the moment cortex_quality_report was
# called — so reporting a failure unlocked the commit just as well as passing. The marker now
# comes only from build/typecheck/lint actually running green.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi
[[ ! "$COMMAND" =~ ^git\ commit ]] && { echo '{"decision":"allow"}'; exit 0; }

MISSING=""
[ ! -f "$STATE_DIR/session-started" ]      && MISSING="${MISSING} cortex_session_start;"
[ ! -s "$STATE_DIR/discovery-used" ]       && MISSING="${MISSING} discovery (cortex_code_search / code_context / knowledge_search);"
[ ! -s "$STATE_DIR/quality-gates-passed" ] && MISSING="${MISSING} quality gates green (build, typecheck, lint — calling cortex_quality_report does not count);"
if [ -n "$MISSING" ]; then
  printf '{"decision":"deny","reason":"BLOCKED: cannot commit — missing Cortex workflow steps:%s"}\n' "$MISSING"
  exit 0
fi
echo '{"decision":"allow"}'
GHOOKEOF

    cat > .gemini/hooks/track-quality.sh << 'GHOOKEOF'
#!/bin/bash
# Cortex Quality Tracker (v4.0) — Gemini variant.
#
# Two bugs from v3: cortex_quality_report touched quality-gates-passed, so reporting a failure
# counted as passing; and every marker was an empty `touch`, which the enforcement hook could not
# tell apart from a forged one. Markers now carry the tool and time that produced them, a gate is
# only marked when the command output does not look like a failure, and the cortex session id is
# captured so the session can actually be closed.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
INPUT=$(cat)

TOOL_NAME=""; COMMAND=""; OUTPUT=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  OUTPUT=$(printf '%s' "$INPUT" | jq -r '[(.tool_response // .tool_output // empty)] | tostring' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'OUTPUT={repr(json.dumps(d.get(\"tool_response\", d.get(\"tool_output\",\"\"))))}')
" 2>/dev/null || true)"
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
record() { printf 'tool=%s at=%s\n' "${2:-$TOOL_NAME}" "$NOW" > "$STATE_DIR/$1"; }
looks_failed() {
  printf '%s' "$OUTPUT" | grep -Eq 'ERR_PNPM|ELIFECYCLE|error TS[0-9]|Command failed|✖|FAIL |Exit status [1-9]'
}
# 1 = this command is not one of the quality gates. mark_gate flips it, and the
# invalidation block at the bottom reads it, so `pnpm build | tee build.log` does not
# revoke the very marker it just armed.
GATE_COMMAND=1
mark_gate() { GATE_COMMAND=0; looks_failed && return 0; record "$1" "$COMMAND"; }

[[ "$COMMAND" =~ (pnpm|npm|yarn)\ .*build ]]     && mark_gate gate-build
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ .*typecheck ]] && mark_gate gate-typecheck
[[ "$COMMAND" =~ (pnpm|npm|yarn)\ .*lint ]]      && mark_gate gate-lint
if [ -s "$STATE_DIR/gate-build" ] && [ -s "$STATE_DIR/gate-typecheck" ] && [ -s "$STATE_DIR/gate-lint" ]; then
  record quality-gates-passed "build+typecheck+lint"
fi

case "$TOOL_NAME" in
  *cortex_session_start*)
    record session-started
    SESSION_ID=$(printf '%s' "$INPUT" | tr -d '\\' \
      | grep -Eo '"session_?[iI]d"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
    [ -n "$SESSION_ID" ] && printf '%s\n' "$SESSION_ID" > "$STATE_DIR/session-id"
    ;;
  *cortex_session_end*)    record session-ended ;;
  *cortex_quality_report*) record quality-reported ;;
  *cortex_code_search*|*cortex_code_context*|*cortex_code_impact*|*cortex_cypher*)
    record discovery-used ;;
  # Recall is not discovery: it answers "why" and "has this broken before", not "where is the
  # code". Arming discovery-used here would let /cs alone open glob and search_file_content.
  *cortex_knowledge_search*) record knowledge-recalled ;;
  *cortex_memory_search*)    record memory-recalled ;;
  *cortex_task_pickup*)      record tasks-checked ;;
  *cortex_detect_changes*|*cortex_changes*) record changes-checked ;;
esac

# ── A passing build certifies a tree, not a session ──
#
# The gate markers used to survive any edit made after them, so
# "pnpm build && typecheck && lint" → edit one file → `git commit` passed the commit
# gate with code that had never been checked. Reproduced in a sandbox: arming the
# three gates, then feeding an a write_file, left quality-gates-passed armed and the commit
# gate returned 0. A write invalidates the certificate — the gates have to run again
# on the tree that is actually being committed.
writes_a_file() {
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(sed[[:space:]]+-i|tee[[:space:]]|dd[[:space:]]|truncate[[:space:]]|install[[:space:]]+-)' && return 0
  local cmd
  cmd=$(printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*&[0-9-]//g; s/[0-9]*>>?[[:space:]]*"?\/dev\/[a-zA-Z0-9]+"?//g')
  printf '%s' "$cmd" | grep -Eq '>>?[[:space:]]*"?[^&|"[:space:]]' && return 0
  printf '%s' "$1" | grep -Eq '(^|[;&|]{1,2}[[:space:]]*)[[:space:]]*(cp|mv|rm|mkdir|touch|patch|git[[:space:]]+apply)[[:space:]]' && return 0
  return 1
}
INVALIDATES=0
case "$TOOL_NAME" in
  write_file|replace|edit_file|create_file|insert_text) INVALIDATES=1 ;;
  run_shell_command|shell)
    # Editing through a shell is still editing. But a gate command that pipes its own
    # output to a file must not revoke the marker it just armed one screen above.
    if [ "$GATE_COMMAND" = "1" ] && writes_a_file "$COMMAND"; then
      INVALIDATES=1
    fi
    ;;
esac
if [ "$INVALIDATES" = "1" ]; then
  rm -f "$STATE_DIR/quality-gates-passed" "$STATE_DIR/gate-build" \
        "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint"
fi
echo '{"decision":"allow"}'
GHOOKEOF

    cat > .gemini/hooks/session-end-check.sh << 'GHOOKEOF'
#!/bin/bash
# Cortex Session End Check (v6) — Gemini variant.
#
# v3 only printed a warning, which nothing reads once the session is over, so every gemini
# session stayed open forever on the hub. This closes it.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ -f "$STATE_DIR/session-started" ] || exit 0
[ -f "$STATE_DIR/session-ended" ] && exit 0

SESSION_ID=""
[ -s "$STATE_DIR/session-id" ] && SESSION_ID=$(cat "$STATE_DIR/session-id" 2>/dev/null || true)
if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  echo '{"systemMessage":"WARNING: cortex session not closed — no session id was recorded. Call cortex_session_end."}'
  exit 0
fi

API_URL="${CORTEX_HUB_API_URL:-http://localhost:4000}"
ACTIONS=""
[ -s "$STATE_DIR/knowledge-recalled" ]   && ACTIONS="${ACTIONS} knowledge-searched"
[ -s "$STATE_DIR/memory-recalled" ]      && ACTIONS="${ACTIONS} memory-searched"
[ -s "$STATE_DIR/discovery-used" ]       && ACTIONS="${ACTIONS} code-searched"
[ -s "$STATE_DIR/changes-checked" ]      && ACTIONS="${ACTIONS} changes-checked"
[ -s "$STATE_DIR/quality-gates-passed" ] && ACTIONS="${ACTIONS} quality-passed"
[ -s "$STATE_DIR/quality-reported" ]     && ACTIONS="${ACTIONS} quality-reported"
[ -s "$STATE_DIR/tasks-checked" ]        && ACTIONS="${ACTIONS} tasks-checked"

SUMMARY="Session auto-closed (gemini, no cortex_session_end)."
[ -n "$ACTIONS" ] && SUMMARY="Session auto-closed (gemini). Activity:${ACTIONS}."
curl -X POST "${API_URL}/api/sessions/${SESSION_ID}/end" \
  -H 'Content-Type: application/json' -d "{\"summary\":\"${SUMMARY}\"}" \
  --connect-timeout 5 -s -o /dev/null || true
touch "$STATE_DIR/session-ended"
echo '{"systemMessage":"INFO: cortex session closed."}'
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
        "matcher": "write_file|replace|edit_file|create_file|insert_text|glob|search_file_content|run_shell_command|shell",
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
    ok "Gemini: hooks + settings.json installed (v${HOOKS_VERSION}.${HOOKS_MINOR})"
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
3. \`cortex_knowledge_search\` + \`cortex_memory_search\` once — recall what the last session decided

### Finding code — start from what you know, not from a fixed ladder
| You already know | Start with |
|---|---|
| A symbol name | \`cortex_code_context(name)\` — exact graph lookup, plus callers/callees/imports in one call |
| Only the behaviour | \`cortex_code_search(query, limit: 10)\` — ranked hybrid search, one call |
| An exact literal (env var, config key, error string) | \`rg\` / \`grep\` — this is not a ranking problem |
| A relationship across files | \`cortex_cypher\` |

**Search once, read all ten.** On the cortex-hub index the target file is in the top 10 for
15/15 queries but at rank 1 for only 8/15 — so scan the whole result set, and never re-run a
reworded version of the same query. Ask a different question or switch tool instead.

\`cortex_code_impact\` before editing something exported or shared. Knowledge and memory are
for errors and decisions, not for locating code.

**Across repos:** omit \`repo:\` to search every repo in the organization of this project
(the client + server + tools of one product). Projects are isolated per organization, so it never reaches
another one. Running sessions in two organizations with one API key? Pass \`org:\`.

### Error Protocol
1. \`cortex_knowledge_search\` first — someone may have solved this
2. \`cortex_memory_search\` — you may have seen it before
3. Fix the error
4. Non-obvious fixes: \`cortex_knowledge_store\`

### Quality Gates
Run verify commands from \`.cortex/project-profile.json\`, then \`cortex_quality_report\`.
After a push: \`cortex_code_reindex\`. End session: \`cortex_session_end\` with sessionId and summary.
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
  echo "${HOOKS_VERSION}.${HOOKS_MINOR}" > .cortex/.hooks-version
  ok "Version: v${HOOKS_VERSION}.${HOOKS_MINOR} marked"
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

  # ── Install the git hooks ──
  #
  # `lefthook install` refuses outright when core.hooksPath points elsewhere, and
  # husky sets it to `.husky/_` from a `prepare` script — so every `pnpm install`
  # re-arms the conflict. Up to v7.1 this branch swallowed the failure as
  # "non-fatal": lefthook.yml existed, the summary said "configured", and no git
  # hook ran at all. Verified on cortex-hub itself — `git hook run pre-commit`
  # produced no output while lefthook's real hook sat unused in `.git/hooks/`.
  # The commit gate this phase exists to create was simply absent.
  #
  # So name the conflict. Reset the path only when the directory it points at has
  # no hooks of its own; otherwise say what to run and do not claim success.
  HOOKS_PATH="$(git -C "$PROJECT_DIR" config --get core.hooksPath 2>/dev/null || true)"
  if [ -n "$HOOKS_PATH" ]; then
    # husky keeps its stubs in `<dir>/_` and the project's own hooks one level up,
    # so that parent is where a real hook would live.
    OWNER_DIR="$HOOKS_PATH"
    [ "$(basename "$HOOKS_PATH")" = "_" ] && OWNER_DIR="$(dirname "$HOOKS_PATH")"
    OWN_HOOKS=""
    for h in pre-commit pre-push commit-msg prepare-commit-msg post-commit post-merge; do
      [ -s "$PROJECT_DIR/$OWNER_DIR/$h" ] && OWN_HOOKS="${OWN_HOOKS:+$OWN_HOOKS }$h"
    done
    if [ -z "$OWN_HOOKS" ]; then
      info "Lefthook: core.hooksPath='$HOOKS_PATH' has no hooks of its own — unsetting it"
      git -C "$PROJECT_DIR" config --unset-all core.hooksPath 2>/dev/null || true
    else
      warn "Lefthook: core.hooksPath='$HOOKS_PATH' owns hooks ($OWN_HOOKS) — NOT installing over them."
      warn "          The pre-commit quality gate will not run. To hand git hooks to lefthook:"
      warn "            git config --unset-all core.hooksPath && lefthook install"
    fi
  fi

  if [ -n "$(git -C "$PROJECT_DIR" config --get core.hooksPath 2>/dev/null || true)" ]; then
    : # left in place on purpose above; nothing to install
  elif command -v lefthook >/dev/null 2>&1; then
    lefthook install >/dev/null 2>&1 && ok "Lefthook: git hooks installed" || warn "Lefthook: install failed"
  elif command -v npx >/dev/null 2>&1; then
    npx --yes lefthook install >/dev/null 2>&1 && ok "Lefthook: git hooks installed (via npx)" || warn "Lefthook: install skipped"
  else
    warn "Lefthook: not found. Install with: npm i -g lefthook"
  fi
else
  # lefthook.yml existing is not the same as the gate running: this is exactly the
  # branch a repeat `install.sh` (no --force) took while core.hooksPath kept the
  # hook dead. Check the hook, not the file.
  if [ -n "$(git -C "$PROJECT_DIR" config --get core.hooksPath 2>/dev/null || true)" ]; then
    warn "Lefthook: lefthook.yml present but core.hooksPath overrides git hooks — the pre-commit gate does NOT run."
    warn "          Fix with: git config --unset-all core.hooksPath && lefthook install"
  elif grep -q lefthook "$PROJECT_DIR/.git/hooks/pre-commit" 2>/dev/null; then
    ok "Lefthook: already configured (pre-commit gate live)"
  else
    warn "Lefthook: lefthook.yml present but no git hook installed. Run: lefthook install"
  fi
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

### Agent Identity (send with session_start if available)

Read `.cortex/agent-identity.json` and pass identity fields:
```
cortex_session_start(
  repo: "__GIT_REPO__",
  mode: "development",
  agentId: "claude-code",
  hostname: "<from agent-identity.json>",
  os: "<from agent-identity.json>",
  ide: "claude-code-cli",
  branch: "<current git branch>",
  role: "<from agent-identity.json>",
  capabilities: ["<from agent-identity.json>"]
)
```
This helps Dashboard identify which agent you are across multiple IDEs/machines.

### Finding code fast (MANDATORY — and a fixed ladder is the slow way)

Start from what you already know. Grep and Glob are blocked by a hook until a cortex
discovery tool has run in this session.

| You already know | Start with | Why |
|---|---|---|
| A symbol name | `cortex_code_context(name)` | Exact graph lookup — no ranking to get wrong — and it answers callers, callees and imports in one call |
| Only the behaviour | `cortex_code_search(query, limit: 10)` | Ranked hybrid search over the index. One call, then read the list |
| An exact literal (env var, config key, error string) | `rg` / `grep` | Not a ranking problem. Lexical search alone ranks *worse* than vector on questions, but it is right for a string that either appears or does not |
| A relationship across files | `cortex_cypher` | One graph query instead of N searches |

**Search once, then read the whole set.** Measured on the cortex-hub index (n=15): the target
file is in the top 10 for 15/15 queries, top 3 for 11/15, rank 1 for only 8/15. So scan all ten
hits before choosing, and do not re-run a reworded version of the same query — recall@10 is
already 1.000, so it returns the same set. Ask a different question or switch tool instead.

`cortex_code_impact` before editing something exported or shared — not as a ritual on every file.

**Across repos:** omit `repo:` to search every repo in the organization of this project —
related repos (the client, server and tools of one product) belong to one, and a cross-repo
search never leaves it. `cortex_list_repos()` shows exactly which repos that covers. Running sessions in two
organizations with one API key at once? Pass `org:` — the `project.orgId` returned by `cortex_session_start`.

**Knowledge and memory are for errors and decisions, not for locating code.** Recall them once
at session start, then whenever something breaks.

### Before editing shared files

Call `cortex_changes` to check if another agent modified the same files.

### When encountering an error or bug

1. **FIRST** search `cortex_knowledge_search` — someone may have solved this already
2. **THEN** `cortex_memory_search` — you may have seen this before
3. Fix the error
4. Non-obvious fixes: **YOU MUST** call `cortex_knowledge_store` to record the solution

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
elif grep -q "cortex_session_start" CLAUDE.md 2>/dev/null; then
  # A hand-written cortex section with no marker. Appending would leave the file with two
  # MANDATORY sections giving different orders — worse than not touching it at all.
  warn "CLAUDE.md: already has cortex instructions but no ${CORTEX_MARKER} marker — left untouched."
  warn "          To let /install manage that section, wrap it in the marker on both sides."
else
  # Append cortex section
  echo "" >> CLAUDE.md
  inject_claude_md >> CLAUDE.md
  ok "CLAUDE.md: cortex section appended"
fi

# ══════════════════════════════════════════════
# Phase 6.5: Ensure .gitignore excludes generated files
# ══════════════════════════════════════════════

GITIGNORE_ENTRIES=(
  "# Cortex Hub (generated by /install — do not commit)"
  ".claude/"
  ".cortex/.session-state/"
  ".codex/"
  ".windsurfrules"
  ".cursorrules"
)

# A generated file is only safe to ignore while git is not already tracking it.
# In cortex-hub itself `.claude/`, `.codex/` and `.cursorrules` ARE the committed
# source of truth — install.sh regenerates them byte-for-byte from its own
# templates. Writing an ignore line for a tracked path does not untrack it, so
# nothing breaks today; it breaks for the first person who removes and re-adds
# the file, and it breaks silently. Ask git what it tracks and leave those alone.
tracked_by_git() {
  git -C "$PROJECT_DIR" ls-files --error-unmatch -- "$1" >/dev/null 2>&1
}

if [ -f ".gitignore" ]; then
  ADDED=0
  SKIPPED=""
  for entry in "${GITIGNORE_ENTRIES[@]}"; do
    # Skip comments when checking existence
    [[ "$entry" == \#* ]] && continue
    if tracked_by_git "$entry"; then
      SKIPPED="${SKIPPED:+$SKIPPED }$entry"
      continue
    fi
    if ! grep -qxF "$entry" .gitignore 2>/dev/null; then
      # Add header comment before first entry
      if [ $ADDED -eq 0 ] && ! grep -qF "Cortex Hub" .gitignore 2>/dev/null; then
        echo "" >> .gitignore
        echo "# Cortex Hub (generated by /install — do not commit)" >> .gitignore
      fi
      echo "$entry" >> .gitignore
      ADDED=$((ADDED + 1))
    fi
  done
  [ $ADDED -gt 0 ] && ok ".gitignore: added $ADDED entries" || ok ".gitignore: already configured"
  [ -n "$SKIPPED" ] && info ".gitignore: left tracked paths alone ($SKIPPED)"
else
  # Create .gitignore with cortex entries
  {
    for entry in "${GITIGNORE_ENTRIES[@]}"; do
      if [[ "$entry" == \#* ]]; then
        echo "$entry"
      elif ! tracked_by_git "$entry"; then
        echo "$entry"
      fi
    done
  } > .gitignore
  ok ".gitignore: created with cortex entries"
fi

# ══════════════════════════════════════════════
# Phase 7: Summary
# ══════════════════════════════════════════════
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Cortex Hub setup complete (v${HOOKS_VERSION}.${HOOKS_MINOR})${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Project:   $(basename "$PROJECT_DIR")"
STACK_NAME=$(python3 -c "import json; print(json.load(open('.cortex/project-profile.json'))['fingerprint']['package_manager'])" 2>/dev/null || echo "detected")
echo "  Stack:     $STACK_NAME"
echo "  MCP:       $([ "$MCP_CONFIGURED" = "true" ] && echo "✓ configured" || echo "⚠ needs API key")"
echo "  /install:  $([ -f "$HOME/.claude/skills/install/SKILL.md" ] && echo "✓ global skill active" || echo "- not installed")"
echo "  IDEs:      ${SELECTED_IDES[*]}"
echo "  Hooks:     v${HOOKS_VERSION}.${HOOKS_MINOR} (enforcement: $(ide_selected claude && echo 'claude ')$(ide_selected gemini && echo 'gemini '))"
# "configured" used to mean "lefthook.yml exists", which was true in the exact
# case where the gate did not run. Report the hook git will actually execute.
lefthook_hook_live() {
  [ -f lefthook.yml ] || return 1
  [ -z "$(git -C "$PROJECT_DIR" config --get core.hooksPath 2>/dev/null || true)" ] || return 1
  grep -q lefthook "$PROJECT_DIR/.git/hooks/pre-commit" 2>/dev/null
}
echo "  Lefthook:  $(lefthook_hook_live && echo "✓ pre-commit gate live" || { [ -f lefthook.yml ] && echo "⚠ lefthook.yml present but no git hook runs" || echo "⚠ not configured"; })"
echo ""
[ "$MCP_CONFIGURED" != "true" ] && echo -e "  ${YELLOW}→ Set HUB_API_KEY and re-run /install to configure MCP${NC}"
echo -e "  ${CYAN}→ Restart IDE to pick up changes${NC}"
echo ""
