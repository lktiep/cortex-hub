#!/bin/bash
# Cortex Hub — Unified Installer (v0.9.0)
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
HOOKS_MINOR=16
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

# merge_settings PREV TARGET: TARGET holds the hooks this installer writes, PREV the settings
# file it replaced. Writes PREV back into TARGET with its hook entries that run a cortex hook
# script swapped for ours, and everything else (permissions, plugins, the repo's own hooks)
# kept. With TARGET empty it only strips cortex entries from PREV — for the user-level file,
# where an older install put them. Fails, changing nothing, without python3 or valid JSON.
merge_settings() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$1" "${2:-}" << 'PYEOF'
import json, re, sys
prev_path, path = sys.argv[1], sys.argv[2]
text = open(prev_path).read()
prev = json.loads(text)
ours = json.load(open(path))["hooks"] if path else {}
mine = re.compile(r"\.(claude|gemini)/hooks/(session-init|subagent-start|enforce-session|enforce-commit|nudge-lookup|session-id|recall-notes|recall-prompt|prompt-start|track-quality|session-end-check)\.sh")
def theirs(entry):
    if not isinstance(entry, dict):
        return True
    return not any(mine.search(str(h.get("command", ""))) for h in entry.get("hooks", []) if isinstance(h, dict))
hooks = prev.get("hooks") if isinstance(prev.get("hooks"), dict) else {}
merged = {}
for event in list(hooks) + [e for e in ours if e not in hooks]:
    entries = hooks.get(event, [])
    kept = [e for e in entries if theirs(e)] if isinstance(entries, list) else entries
    kept = kept + ours.get(event, [])
    if kept:
        merged[event] = kept
if not path and merged == hooks:
    sys.exit(1)
if merged:
    prev["hooks"] = merged
else:
    prev.pop("hooks", None)
indent = "\t" if "\n\t" in text else 2
open(path or prev_path, "w").write(json.dumps(prev, indent=indent, ensure_ascii=False) + "\n")
PYEOF
}

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

# ── Whose git hooks are these? ──
# A repo that runs its own checks from git hooks has already said what happens on commit
# and push. A cortex pre-commit/pre-push next to them runs every check twice, and with
# --force this installer used to overwrite the repo's own lefthook.yml outright. Such a
# repo keeps its hooks; Phase 5 adds only cortex's post-push, and only where lefthook
# merges it into the repo's config instead of replacing it.
CORTEX_LEFTHOOK_HEADER="# Auto-generated by cortex install.sh"
GIT_HOOK_NAMES="pre-commit pre-push commit-msg prepare-commit-msg post-commit post-merge"

git_tracks() { git -C "$PROJECT_DIR" ls-files --error-unmatch -- "$1" >/dev/null 2>&1; }

# Prints the repo's own lefthook config: tracked, and not one this installer generated.
repo_lefthook_config() {
  local f
  for f in lefthook.yml .lefthook.yml lefthook.yaml .lefthook.yaml lefthook.json .lefthook.json \
           lefthook.toml .lefthook.toml .config/lefthook.yml .config/lefthook.yaml; do
    git_tracks "$f" || continue
    case "$(head -n 1 "$f" 2>/dev/null)" in "$CORTEX_LEFTHOOK_HEADER"*) continue ;; esac
    echo "$f"; return 0
  done
  return 1
}

# Prints what runs the repo's git hooks when that is the repo's own, committed setup.
# Only tracked files count: an untracked hook dir is one developer's, not the repo's.
repo_hook_owner() {
  local f h hp owner
  if f=$(repo_lefthook_config); then echo "lefthook ($f)"; return 0; fi
  for h in $GIT_HOOK_NAMES; do
    git_tracks ".husky/$h" && { echo "husky (.husky/$h)"; return 0; }
  done
  git_tracks .pre-commit-config.yaml && { echo "pre-commit (.pre-commit-config.yaml)"; return 0; }
  hp=$(git -C "$PROJECT_DIR" config --get core.hooksPath 2>/dev/null || true)
  if [ -n "$hp" ]; then
    # husky keeps its stubs in `<dir>/_` and the project's own hooks one level up.
    owner="$hp"; [ "$(basename "$hp")" = "_" ] && owner="$(dirname "$hp")"
    for h in $GIT_HOOK_NAMES; do
      git_tracks "$owner/$h" && { echo "core.hooksPath=$hp"; return 0; }
    done
  fi
  return 1
}

# An exact script name: `verify:ci` is not `verify`.
pkg_has_script() {
  [ -f package.json ] || return 1
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; sys.exit(0 if sys.argv[1] in (json.load(open('package.json',encoding='utf-8-sig')).get('scripts') or {}) else 1)" "$1" 2>/dev/null
  elif command -v jq >/dev/null 2>&1; then
    jq -e --arg s "$1" '(.scripts // {}) | has($s)' package.json >/dev/null 2>&1
  else
    return 1
  fi
}

HOOKS_OWNED_BY=$(repo_hook_owner || true)
# A `verify` script is the repo saying how it checks itself; cortex does not add a second
# opinion in git hooks on top of it.
[ -z "$HOOKS_OWNED_BY" ] && pkg_has_script verify && HOOKS_OWNED_BY="package.json verify script"

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
    'type': 'http',
    'url': '${MCP_URL}',
    'headers': {'Authorization': 'Bearer ${API_KEY}'}
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
  if [ -n "$HOOKS_OWNED_BY" ]; then LH="repo-owned hooks ($HOOKS_OWNED_BY) — cortex adds no pre-commit/pre-push"
  elif [ ! -f lefthook.yml ]; then LH="no"
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
  HAS_VERIFY=""

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
    # A repo with its own `verify` script has already said what "fully checked" means;
    # build/typecheck/lint/test picked one by one would second-guess it. An exact name:
    # `grep -w` would take `verify:ci` for it.
    case " $SCRIPTS " in
      *" verify "*)
        HAS_VERIFY=1
        if [ "$PKG_MANAGER" = "npm" ]; then FULL=("\"npm run verify\""); else FULL=("\"$PKG_MANAGER verify\""); fi
        ;;
    esac
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
  if [ -z "$PRE_COMMIT_CMDS" ] && [ -z "$HAS_VERIFY" ] && [ ${#DETECTED_STACKS[@]} -gt 0 ]; then
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
# Cortex Session Init (v7.4) — arms the gates; keeps discovery state across compaction.
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
#
# v7.2 prints this conversation's id for /cs to pass as clientSessionId. Everything else the
# hub matches a session on is the same for two conversations in one checkout, so without it
# they shared one session, and the first to finish closed it under the other.
#
# v7.4 stops printing it. A line that differs in every conversation, this early in the
# context, kept the prompt cache from reusing anything after it. session-id.sh now puts the
# id straight into the cortex_session_start call.
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
rm -rf "$STATE_DIR/agents" 2>/dev/null
# Other conversations' sessions stay theirs to close; only records a week old are dropped,
# left by a conversation that ended without the exit hook getting through.
[ -d "$STATE_DIR/conversations" ] && find "$STATE_DIR/conversations" -type f -mtime +7 -exec rm -f {} + 2>/dev/null
# The lookup nudge keeps a counter per conversation and agent; a day-old one is done with.
[ -d "$STATE_DIR/nudge" ] && find "$STATE_DIR/nudge" -type f -mtime +1 -exec rm -f {} + 2>/dev/null
# File notes are shown once per conversation and agent; the record of which were is a day's.
[ -d "$STATE_DIR/notes" ] && find "$STATE_DIR/notes" -type f -name 'shown-*' -mtime +1 -exec rm -f {} + 2>/dev/null
echo "The prompt hook starts the cortex session from the first prompt; without its note, call cortex_session_start(repo, task: \"<the task in a few words>\") first. Until one of the two, edits are BLOCKED."
exit 0
HOOKEOF

  # ── enforce-session.sh ──
  cat > .claude/hooks/enforce-session.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Session Enforcement (v6.3) — hold tools back until the cortex workflow is followed.
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
AGENT_ID=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  # Without this fallback the whole gate silently became a no-op on any machine without jq.
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'AGENT_ID={repr(str(d.get(\"agent_id\",\"\")))}')
" 2>/dev/null || true)"
fi
# A subagent's calls carry its agent_id; the tracker files its recall under the same name.
SAFE_ID=$(printf '%s' "$AGENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)
# An id with nothing usable left in it is still a subagent's, never the parent's.
[ -n "$AGENT_ID" ] && [ -z "$SAFE_ID" ] && SAFE_ID=unnamed
AGENT_ID="$SAFE_ID"

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
    # A subagent starts with none of the parent's recall in its context, so the parent's
    # markers do not open the gate for it: it recalls for its own task, under its own id.
    if [ -n "$AGENT_ID" ]; then
      if ! marker_ok "agents/$AGENT_ID/knowledge-recalled" || ! marker_ok "agents/$AGENT_ID/memory-recalled"; then
        echo "BLOCKED: you are a subagent, and the parent's recall is not in your context. Run cortex_knowledge_search and cortex_memory_search on your own task before editing. $HOW_OUT" >&2
        exit 2
      fi
      exit 0
    fi
    if ! marker_ok knowledge-recalled || ! marker_ok memory-recalled; then
      echo "BLOCKED: run cortex_knowledge_search and cortex_memory_search before editing, with the words of the task in hand (the feature, the error) — they restore what previous sessions already decided and already fixed. Or pass the task to cortex_session_start (task: \"<the task in a few words>\"): its answer is that recall. $HOW_OUT" >&2
      exit 2
    fi
  fi
  exit 0
fi

# ── Session NOT started: block writes and codebase search, allow plain reads ──
# Until v7.1 of session-init this branch never ran: the init hook created the session-started
# marker itself, so every session looked started before cortex_session_start was ever called.
#
# Searching is reading, and what this gate wants before it is a cortex lookup, not a session.
# Until v6.3 a search stayed blocked here after cortex_code_search had run, under a message
# saying that very call unlocks it: an agent asked a quick question looked the code up, was
# refused grep twice, and read whole files instead — 25k characters where one grep would do.
SEARCH_HINT="BLOCKED: look it up with cortex_code_search (a behaviour) or cortex_code_context (a symbol name) first. One call unlocks find/grep/rg and Grep/Glob for the rest of the session. $HOW_OUT"
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit)
    echo "BLOCKED: call cortex_session_start first, with the task (task: \"<the task in a few words>\"). No edits without a session." >&2
    exit 2 ;;
  Grep|Glob)
    marker_ok discovery-used && exit 0
    echo "$SEARCH_HINT" >&2
    exit 2 ;;
  Bash)
    if is_codebase_search "$COMMAND" && ! marker_ok discovery-used; then
      echo "$SEARCH_HINT" >&2
      exit 2
    fi
    # The write check goes before the read allowlist, or `cat > file` passes as a read.
    if is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND"; then
      echo "BLOCKED: call cortex_session_start first, with the task (task: \"<the task in a few words>\"). No file modifications without a session." >&2
      exit 2
    fi
    # Where a command starts, and before the read allowlist: unanchored, `cp ` matched the end of
    # `hub-mcp ` and refused a read-only grep over that directory, while `ls; rm x` passed as a read.
    MODIFIES='(^|[;&|(])[[:space:]]*(git[[:space:]]+(add|commit|push|reset)|rm|mv|cp|mkdir|touch|chmod)[[:space:]]'
    [[ "$COMMAND" =~ $MODIFIES ]] && {
      echo "BLOCKED: call cortex_session_start first, with the task (task: \"<the task in a few words>\"). No file modifications without a session." >&2
      exit 2
    }
    [[ "$COMMAND" =~ ^(ls|cat|head|tail|pwd|which|echo|git\ (status|log|diff|branch|remote|show)|pnpm\ |npm\ |yarn\ |cargo\ |go\ |python|curl|dotnet\ |node\ ) ]] && exit 0
    exit 0 ;;
esac
exit 0
HOOKEOF

  # ── enforce-commit.sh ──
  cat > .claude/hooks/enforce-commit.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Commit Enforcement (v5.1) — a commit needs the workflow behind it.
#
# v4 accepted `quality-gates-passed`, which the tracker used to write the moment
# cortex_quality_report was called — so reporting a failure unlocked the commit just as
# well as passing. The marker now comes only from build/typecheck/lint actually running
# green, and the report is a separate, softer expectation.
# v5.1 refuses to skip the repo's own git hooks (--no-verify, `commit -n`, LEFTHOOK=0).
# install.sh leaves a repo that runs its checks from git hooks to those hooks, so skipping
# them skips the checks. The rule lives here and not in the repo: cortex writes this file,
# and a rule the repo added to it would be overwritten by the next install.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi

# Prints why a command skips the repo's git hooks; prints nothing when it does not.
skips_hooks() {
  local cmd q="'"
  local b='(^|[;&|(`[:space:]])' seg='[^;&|)]' end='([;&|)[:space:]]|$)'
  # A heredoc body is text (a commit message), not flags: drop it and keep the line that
  # opens it. Then join `\` continuations and make every line a `;`-separated command.
  cmd=$(printf '%s\n' "$1" | awk '
    tag != "" { t = $0; sub(/^\t+/, "", t); if (t == tag) tag = ""; next }
    { print
      if (match($0, /(^|[^<])<<-?[ \t]*["\047]?[A-Za-z_][A-Za-z0-9_]*/)) {
        tag = substr($0, RSTART, RLENGTH); sub(/^[^<]?<<-?[ \t]*["\047]?/, "", tag)
      } }' | awk '/\\$/ { sub(/\\$/, ""); printf "%s ", $0; next } { print }' | tr '\n' ';')
  # Quoted arguments are messages and bodies; a flag named inside one is not a flag.
  # `LEFTHOOK="0"` keeps its quotes: they follow `=`, not a space.
  cmd=$(printf '%s' "$cmd" | sed -E "s/(^|[[:space:]])'[^']*'/\1/g; s/(^|[[:space:]])\"[^\"]*\"/\1/g; s/(--[a-z-]+=)'[^']*'/\1/g; s/(--[a-z-]+=)\"[^\"]*\"/\1/g")
  local re="${b}(export[[:space:]]+)?LEFTHOOK=[\"$q]?(0|false)([\"$q;&|)[:space:]]|\$)"
  if [[ "$cmd" =~ $re ]]; then echo "LEFTHOOK=0 turns lefthook off"; return; fi
  # git takes any unambiguous prefix of a long option, so --no-veri is --no-verify.
  re="${b}git[[:space:]]${seg}*[[:space:]]--no-veri[a-z]*(=|${end})"
  if [[ "$cmd" =~ $re ]]; then echo "--no-verify skips the hooks"; return; fi
  # `git commit -n` is --no-verify. Only flags that take no value may come before the n:
  # `-mnew` is `-m new`. `git push -n` is --dry-run and stays allowed.
  local opt='[[:space:]]+-[^[:space:];&|)]*([[:space:]]+[^-[:space:];&|)][^[:space:];&|)]*)?'
  re="${b}git(${opt})*[[:space:]]+commit([[:space:]]${seg}*)?[[:space:]]-[apseioqvz]*n[a-zA-Z]*${end}"
  if [[ "$cmd" =~ $re ]]; then echo "git commit -n is --no-verify"; return; fi
}
# Checked before the `^git` match below, so `cd x && git commit --no-verify` is caught too.
SKIP_REASON=$(skips_hooks "$COMMAND")
if [ -n "$SKIP_REASON" ]; then
  echo "BLOCKED: this skips the repo's git hooks ($SKIP_REASON)." >&2
  echo "Those hooks are the repo's own checks. Run the command without the skip and fix what they report;" >&2
  echo "if a hook itself is broken, ask the user to run the command." >&2
  exit 2
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
# Cortex Quality Tracker (v4.3) — records what actually happened, as evidence.
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
#
# v4.2 also files the hub session under the conversation that opened it, in
# conversations/<IDE session id>: the rest of this directory is shared by every conversation
# in the checkout, so the exit hook had no way to tell whose session `session-id` was.
#
# v4.3 files a subagent's recall under agents/<agent_id> as well: the recall gate asks a
# subagent for its own, since none of the parent's is in its context.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat)
COMMAND=""
TOOL_NAME=""
OUTPUT=""
CLIENT_ID=""
AGENT_ID=""

if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  OUTPUT=$(printf '%s' "$INPUT" | jq -r '[(.tool_response // .tool_output // empty)] | tostring' 2>/dev/null || true)
  CLIENT_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
  AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('tool_response', d.get('tool_output',''))
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'OUTPUT={repr(json.dumps(r, ensure_ascii=False) if not isinstance(r,str) else r)}')
print(f'CLIENT_ID={repr(str(d.get(\"session_id\",\"\")))}')
print(f'AGENT_ID={repr(str(d.get(\"agent_id\",\"\")))}')
" 2>/dev/null || true)"
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# The IDE's id for this conversation, made safe to use as a file name.
CLIENT_ID=$(printf '%s' "$CLIENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)
SAFE_ID=$(printf '%s' "$AGENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)
# An id with nothing usable left in it is still a subagent's, never the parent's.
[ -n "$AGENT_ID" ] && [ -z "$SAFE_ID" ] && SAFE_ID=unnamed
AGENT_ID="$SAFE_ID"

# Evidence, not existence: the enforcement hook only accepts a marker that says who wrote it.
record() {
  printf 'tool=%s at=%s\n' "${2:-$TOOL_NAME}" "$NOW" > "$STATE_DIR/$1"
}

# The same evidence, filed under the subagent that made the call.
record_agent() {
  [ -n "$AGENT_ID" ] || return 0
  mkdir -p "$STATE_DIR/agents/$AGENT_ID"
  record "agents/$AGENT_ID/$1"
}

# A command that reports success while the build failed — `pnpm build || true`, or a pipe
# that swallows the status. If the output says it failed, the gate does not open.
# ESLint prints "✖ N problems (0 errors, N warnings)" for warnings alone, so a bare ✖
# is not a failure; only an error count above zero is.
looks_failed() {
  printf '%s' "$OUTPUT" | grep -Eq 'ERR_PNPM|ELIFECYCLE|error TS[0-9]|Command failed|✖ [0-9]+ problems? \([1-9]|FAIL |Exit status [1-9]'
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
    # Only a hub id: every hook payload opens with the IDE's own "session_id" (a conversation
    # uuid), and `head -1` used to take that one, so the exit hook tried to close a session
    # the hub had never heard of. The hub mints nothing but sess_… ids.
    SESSION_ID=$(printf '%s' "$INPUT" | tr -d '\\' \
      | grep -Eo '"session_?[iI]d"[[:space:]]*:[[:space:]]*"sess_[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
    [ -n "$SESSION_ID" ] && printf '%s\n' "$SESSION_ID" > "$STATE_DIR/session-id"
    if [ -n "$SESSION_ID" ] && [ -n "$CLIENT_ID" ]; then
      mkdir -p "$STATE_DIR/conversations"
      printf '%s\n' "$SESSION_ID" > "$STATE_DIR/conversations/$CLIENT_ID"
    fi
    # A new hub session is open, so an earlier one's "ended" no longer applies — left in
    # place it made the exit hook skip this session too.
    rm -f "$STATE_DIR/session-ended"
    # Started with the task, the answer carries the recall and the code lookup that used to be
    # three more calls. The hub prints each line only when that part answered, at the start of
    # a line ("text":"… or \n… in the escaped output, never after \"), so the task's own words
    # cannot pass for one.
    if printf '%s' "$OUTPUT" | grep -Eq '([^\\]"|\\n)recalled: knowledge\+memory for '; then
      record knowledge-recalled; record_agent knowledge-recalled
      record memory-recalled; record_agent memory-recalled
    fi
    printf '%s' "$OUTPUT" | grep -Eq '([^\\]"|\\n)located: code for ' && record discovery-used
    ;;
  *cortex_session_end*)
    record session-ended
    # This conversation closed its own session; the exit hook has nothing left to do for it.
    [ -n "$CLIENT_ID" ] && rm -f "$STATE_DIR/conversations/$CLIENT_ID"
    ;;
  *cortex_quality_report*) record quality-reported ;;
  *cortex_code_search*|*cortex_code_context*|*cortex_code_impact*|*cortex_cypher*)
    record discovery-used ;;
  # Recall is not discovery: knowledge and memory answer "why" and "has this broken before",
  # not "where is the code". Arming discovery-used here would let /cs alone open Grep and Glob.
  *cortex_knowledge_search*) record knowledge-recalled; record_agent knowledge-recalled ;;
  *cortex_memory_search*)    record memory-recalled; record_agent memory-recalled ;;
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
# Cortex Session End Check (v7.1) — closes the cortex session when the session really ends.
#
# v6 posted to ${CORTEX_HUB_API_URL:-http://localhost:4000}. Nothing sets that variable, so on
# every machine but the hub itself the close went to a port nobody listens on; curl's failure
# was swallowed and `session-ended` was written anyway. Sessions were never closed, and the
# hook said they were. v7 goes where the agent's own cortex calls go — the hub's MCP endpoint,
# with the key from the IDE's MCP config — and only records a close the hub confirmed.
#
# The close is sent with auto:true: the hub records it as 'abandoned', keeps it out of memory
# and /cs recall, and leaves a session that /ce already completed alone.
#
# Claude Code gives a SessionEnd hook 1.5s unless it declares a timeout; settings.json gives
# this one 15s, and the requests below stop well inside that.
#
# v7.1: every conversation in a checkout shares this state directory, so `session-id` is
# whichever one ran /cs last — one conversation's exit closed another's session, and one that
# never ran /cs closed somebody else's. The tracker now files each session under the IDE's id
# for the conversation that opened it, and this hook closes that one and nothing else. With no
# such record (an older tracker, an IDE that sends no id) it falls back to `session-id`.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

say() { echo "$1"; }

INPUT=$(cat 2>/dev/null || true)
CLIENT_ID=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    CLIENT_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    CLIENT_ID=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || true)
  fi
fi
CLIENT_ID=$(printf '%s' "$CLIENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)

SESSION_ID=""
OWN=""
if [ -n "$CLIENT_ID" ] && [ -d "$STATE_DIR/conversations" ]; then
  # Nothing filed under this conversation: it never opened a session, or /ce closed it.
  OWN="$STATE_DIR/conversations/$CLIENT_ID"
  [ -s "$OWN" ] || exit 0
  SESSION_ID=$(head -1 "$OWN" 2>/dev/null || true)
else
  [ -f "$STATE_DIR/session-started" ] || exit 0
  [ -f "$STATE_DIR/session-ended" ] && exit 0
  [ -s "$STATE_DIR/session-id" ] && SESSION_ID=$(cat "$STATE_DIR/session-id" 2>/dev/null || true)
fi

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  say "WARNING: cortex session not closed — no session id was recorded. Run /ce next time."
  exit 0
fi

ACTIONS=""
[ -s "$STATE_DIR/knowledge-recalled" ]   && ACTIONS="${ACTIONS} knowledge-searched"
[ -s "$STATE_DIR/memory-recalled" ]      && ACTIONS="${ACTIONS} memory-searched"
[ -s "$STATE_DIR/discovery-used" ]       && ACTIONS="${ACTIONS} code-searched"
[ -s "$STATE_DIR/changes-checked" ]      && ACTIONS="${ACTIONS} changes-checked"
[ -s "$STATE_DIR/quality-gates-passed" ] && ACTIONS="${ACTIONS} quality-passed"
[ -s "$STATE_DIR/quality-reported" ]     && ACTIONS="${ACTIONS} quality-reported"
[ -s "$STATE_DIR/tasks-checked" ]        && ACTIONS="${ACTIONS} tasks-checked"
[ -s "$STATE_DIR/gate-off" ]             && ACTIONS="${ACTIONS} gate-off($(head -c 80 "$STATE_DIR/gate-off" | tr -d '"\\\n'))"

SUMMARY="Session auto-closed (no /ce)."
[ -n "$ACTIONS" ] && SUMMARY="Session auto-closed. Activity:${ACTIONS}."

if ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  say "WARNING: cortex session $SESSION_ID not closed — needs python3 and curl. Run /ce next time."
  exit 0
fi

# The hub's MCP endpoint and Authorization header, one per line, from the environment or the
# cortex-hub entry of whichever MCP config this machine has. Both shapes the installer writes
# are read: {url, headers} and the mcp-remote bridge {args: [url, --header, ...], env}.
hub_endpoint() {
  python3 - "$PROJECT_DIR" <<'PY' 2>/dev/null
import json, os, re, sys
project, home = sys.argv[1], os.path.expanduser('~')

def emit(url, auth):
    if url and auth:
        print(url)
        print(auth if auth.lower().startswith('bearer ') else 'Bearer ' + auth)
        sys.exit(0)

emit(os.environ.get('CORTEX_MCP_URL') or os.environ.get('HUB_MCP_URL'), os.environ.get('HUB_API_KEY'))

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}

def servers(doc):
    out = {}
    for key in ('mcpServers', 'servers'):
        if isinstance(doc.get(key), dict):
            out.update(doc[key])
    return out

def entry(found):
    if 'cortex-hub' in found:
        return found['cortex-hub']
    return next((v for k, v in found.items() if 'cortex' in k.lower()), None)

def expand(value, env):
    return re.sub(r'\$\{(\w+)\}', lambda m: env.get(m.group(1)) or os.environ.get(m.group(1), ''), value)

def resolve(e):
    if not isinstance(e, dict):
        return
    env = e.get('env') if isinstance(e.get('env'), dict) else {}
    headers = e.get('headers') if isinstance(e.get('headers'), dict) else {}
    args = [a for a in e.get('args') or [] if isinstance(a, str)]
    url = e.get('url') or e.get('httpUrl') or e.get('serverUrl') or next((a for a in args if a.startswith('http')), None)
    auth = headers.get('Authorization') or headers.get('authorization')
    for i, a in enumerate(args[:-1]):
        if a == '--header' and args[i + 1].lower().startswith('authorization:'):
            auth = auth or args[i + 1].split(':', 1)[1]
    emit(url, expand(auth or '', env).strip())

claude = load(os.path.join(home, '.claude.json'))
for found in (
    servers(load(os.path.join(project, '.mcp.json'))),
    servers((claude.get('projects') or {}).get(project) or {}),
    servers(claude),
    servers(load(os.path.join(project, '.gemini', 'settings.json'))),
    servers(load(os.path.join(home, '.gemini', 'settings.json'))),
    servers(load(os.path.join(home, '.gemini', 'antigravity', 'mcp_config.json'))),
    servers(load(os.path.join(home, '.cursor', 'mcp.json'))),
    servers(load(os.path.join(home, '.codeium', 'windsurf', 'mcp_config.json'))),
    servers(load(os.path.join(project, '.vscode', 'mcp.json'))),
):
    resolve(entry(found))
PY
}

# A JSON body for the close. $1 = "mcp" for a tools/call, anything else for the REST route.
close_body() {
  python3 - "$1" "$SESSION_ID" "$SUMMARY" <<'PY'
import json, sys
kind, sid, summary = sys.argv[1:4]
args = {'sessionId': sid, 'summary': summary, 'auto': True}
if kind == 'mcp':
    print(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                      'params': {'name': 'cortex_session_end', 'arguments': args}}))
else:
    print(json.dumps({'summary': summary, 'auto': True}))
PY
}

# Did the tools/call succeed? The reply is JSON, or the same JSON as SSE `data:` lines.
mcp_ok() {
  python3 -c '
import json, sys
raw = sys.stdin.read()
lines = [l[5:].strip() for l in raw.splitlines() if l.startswith("data:")] or [raw]
for line in lines:
    try:
        msg = json.loads(line)
    except Exception:
        continue
    if isinstance(msg, dict) and isinstance(msg.get("result"), dict) and not msg["result"].get("isError"):
        sys.exit(0)
sys.exit(1)'
}

CLOSED=1
WHY=""
if [ -n "${CORTEX_HUB_API_URL:-}" ]; then
  # An explicit API URL (a self-hosted hub on this machine) keeps the direct route.
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 4 -m 10 \
    -X POST "${CORTEX_HUB_API_URL%/}/api/sessions/${SESSION_ID}/end" \
    -H 'Content-Type: application/json' -d "$(close_body rest)" 2>/dev/null)
  case "$CODE" in 2??) CLOSED=0 ;; *) WHY="${CORTEX_HUB_API_URL} answered ${CODE:-nothing}" ;; esac
else
  ENDPOINT=$(hub_endpoint)
  MCP_URL=$(printf '%s\n' "$ENDPOINT" | sed -n 1p)
  MCP_AUTH=$(printf '%s\n' "$ENDPOINT" | sed -n 2p)
  if [ -z "$MCP_URL" ] || [ -z "$MCP_AUTH" ]; then
    WHY="no cortex-hub MCP server with an Authorization header in this machine's MCP config"
  else
    # The key goes in on stdin, never on the command line, where `ps` would show it.
    if printf 'Authorization: %s\n' "$MCP_AUTH" \
        | curl -sf --connect-timeout 4 -m 10 -X POST "$MCP_URL" -H @- \
            -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
            -d "$(close_body mcp)" 2>/dev/null | mcp_ok; then
      CLOSED=0
    else
      WHY="the hub at ${MCP_URL%%\?*} did not confirm it"
    fi
  fi
fi

if [ "$CLOSED" = "0" ]; then
  [ -n "$OWN" ] && rm -f "$OWN"
  # session-ended speaks for the checkout's current session, so only that one may write it.
  if [ -z "$OWN" ] || [ "$SESSION_ID" = "$(cat "$STATE_DIR/session-id" 2>/dev/null)" ]; then
    printf 'tool=session-end-check at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_DIR/session-ended"
  fi
  say "INFO: cortex session $SESSION_ID closed as abandoned.${ACTIONS:+ Activity:${ACTIONS}}"
else
  say "WARNING: cortex session $SESSION_ID not closed — ${WHY}. Run /ce next time."
fi
exit 0
HOOKEOF

  # ── nudge-lookup.sh ──
  cat > .claude/hooks/nudge-lookup.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Lookup Nudge (v1) — a reminder, never a block, when a grep is a cortex question.
#
# The session gate only makes an agent call cortex once: after the first discovery call it
# greps freely, and measured over real sessions (mods/cortex-bar/scripts/lookup-audit.mjs)
# cortex answered 3–9% of the searches it could have answered, least of all in subagents.
# This hook reads what a search looks for. A repo-wide search for a symbol or a word gets
# one line of context naming the cortex call that answers it; the search itself still runs,
# since a refused call costs the agent a whole request to recover from.
#
# It stays quiet for literals (env vars, config keys, error strings), for searches in known
# files or outside the repo, and for file-name searches: grep and find are right for those.
# It also stays quiet right after a cortex lookup, when the grep is the agent checking what
# cortex did not answer, and nudges each agent at most once every NUDGE_EVERY searches.
#
# CORTEX_NUDGE=off turns it off; so does gate-off, since the hub it points at is down. It is
# JavaScript in a shell file so the installers can ship it like every other hook; without
# node it does nothing.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ "${CORTEX_NUDGE:-}" = "off" ] && exit 0
[ -s "$STATE_DIR/gate-off" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

# read, not $(cat << …): bash 3.2, macOS's own, misparses quotes in a heredoc inside $( ).
IFS= read -r -d '' NUDGE_JS << 'NUDGEJS' || true
const fs = require('fs')
const path = require('path')

/** Searches between two nudges to one agent. */
const NUDGE_EVERY = 5
/** A search this many calls after a cortex lookup is checking its answer: no nudge. */
const AFTER_LOOKUP = 3
const LOOKUP = /cortex_(code_search|code_context|code_impact|cypher)$/

const SEARCH_TOOLS = ['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack']
const FIND_TOOLS = ['find', 'fd', 'fdfind', 'locate']
const PREFIXES = ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']
const WRAPPERS = ['command', 'builtin', 'exec', 'env', 'time', 'nice', 'noglob', 'sudo']
const TAKES_ARG = ['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-d', '-D', '-j', '-M',
  '--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--max-depth',
  '--max-columns', '--threads', '--sort', '--sortr', '--include', '--exclude', '--exclude-dir',
  '--context', '--after-context', '--before-context']
const NON_CODE = /^-$|^\/tmp\/|^\/private\/|^\/var\/|scratchpad|\.claude\/projects|node_modules|\.(log|jsonl|csv|output)$/
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const FILE_NAME = /.\.[A-Za-z0-9]+$/

// The simple commands in a shell line, each with whether a pipe feeds it: quotes and
// backslashes read as the shell reads them, redirections and heredoc bodies dropped.
// The same reading as mods/cortex-bar/hooks/lookups.js, which the audit counts with.
function shellCommands(s) {
  const out = []
  let argv = []
  let piped = false
  let word = null
  let dropNext = false
  let delimiterNext = null
  let heredocs = []
  const flushWord = () => {
    if (word === null) return
    if (delimiterNext !== null) heredocs.push({ delimiter: word, tabs: delimiterNext })
    else if (!dropNext) argv.push(word)
    delimiterNext = null
    dropNext = false
    word = null
  }
  const endCommand = (separator) => {
    flushWord()
    if (argv.length > 0) out.push({ argv, piped })
    argv = []
    piped = separator === '|' || separator === '|&'
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    const next = s[i + 1] || ''
    if (c === "'") {
      const close = s.indexOf("'", i + 1)
      if (close === -1) return []
      word = (word || '') + s.slice(i + 1, close)
      i = close + 1
    } else if (c === '"') {
      let j = i + 1
      let text = ''
      while (j < s.length && s[j] !== '"') {
        const after = s[j + 1] || ''
        if (s[j] === '\\' && after !== '' && '"\\$`\n'.includes(after)) {
          if (after !== '\n') text += after
          j += 2
        } else {
          text += s[j]
          j += 1
        }
      }
      if (j >= s.length) return []
      word = (word || '') + text
      i = j + 1
    } else if (c === '\\') {
      if (next !== '\n' && next !== '') word = (word || '') + next
      i += 2
    } else if (c === ' ' || c === '\t') {
      flushWord()
      i += 1
    } else if (c === '#' && word === null) {
      while (i < s.length && s[i] !== '\n') i += 1
    } else if (c === '\n') {
      endCommand('\n')
      i += 1
      for (const { delimiter, tabs } of heredocs) {
        for (;;) {
          if (i >= s.length) return out
          const end = s.indexOf('\n', i)
          const line = s.slice(i, end === -1 ? s.length : end)
          i = end === -1 ? s.length : end + 1
          if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) break
        }
      }
      heredocs = []
    } else if ((c === '<' || c === '>' || c === '$') && next === '(') {
      endCommand('(')
      i += 2
    } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      if (word !== null && /^\d+$/.test(word)) word = null
      flushWord()
      if (c === '&') i += 1
      const op = (/^(<<<|<<-|<<|>>|>\||<>|<&|>&|<|>)/.exec(s.slice(i)) || [c])[0]
      i += op.length
      if (op === '<<' || op === '<<-') {
        delimiterNext = op === '<<-'
      } else if (op === '<&' || op === '>&') {
        const fd = /^[0-9-]+/.exec(s.slice(i))
        if (fd) i += fd[0].length
        else dropNext = true
      } else {
        dropNext = true
      }
    } else if ('|&;()'.includes(c)) {
      const op = ['||', '|&', '&&', ';;'].find((two) => s.startsWith(two, i)) || c
      endCommand(op)
      i += op.length
    } else {
      word = (word || '') + c
      i += 1
    }
  }
  endCommand(';')
  return out
}

function withoutPrefix(argv) {
  let i = 0
  for (;;) {
    const arg = argv[i]
    if (arg === undefined) return []
    if (PREFIXES.includes(arg) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      i += 1
    } else if (WRAPPERS.includes(arg)) {
      i += 1
      while (argv[i] && argv[i].startsWith('-')) i += 1
    } else {
      return argv.slice(i)
    }
  }
}

function patternAndTargets(args) {
  const patterns = []
  const positional = []
  let options = true
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (options && arg === '--') {
      options = false
    } else if (options && TAKES_ARG.includes(arg)) {
      if (arg === '-e' || arg === '--regexp') patterns.push(args[i + 1] || '')
      i += 1
    } else if (options && arg.startsWith('--regexp=')) {
      patterns.push(arg.slice('--regexp='.length))
    } else if (!(options && arg.startsWith('-') && arg !== '-')) {
      positional.push(arg)
    }
  }
  if (patterns.length > 0) return { pattern: patterns.join('|'), targets: positional }
  return { pattern: positional[0] || '', targets: positional.slice(1) }
}

function outsideRepo(target, root) {
  if (NON_CODE.test(target) || target === '..' || target.startsWith('../')) return true
  if (!target.startsWith('/') || root === '') return false
  return target !== root && !target.startsWith(root + '/')
}

function isFile(target) {
  if (/[*?[{$]/.test(target)) return false
  return FILE_NAME.test(target.slice(target.lastIndexOf('/') + 1))
}

// A symbol: every alternative an identifier, one of them shaped like code. A literal: an
// UPPER_SNAKE name or text with a space, quote, `:`, `=` or `/`. Anything else is a word.
function alternativesOf(pattern) {
  const bare = pattern.replace(/\\[b<>]/g, '').replace(/[()]/g, '')
  return bare.split(/\\\||\|/).filter((part) => part !== '')
}
const shaped = (name) => /[a-z][A-Z]|[a-z]_[a-z]|^[A-Z][a-z]+[A-Z]/.test(name) || /^[A-Z].*[a-z]/.test(name)

function patternKind(pattern) {
  if (pattern === '') return 'literal'
  const alternatives = alternativesOf(pattern)
  if (alternatives.length > 0 && alternatives.every((part) => IDENTIFIER.test(part)) && alternatives.some(shaped)) {
    return 'symbol'
  }
  if (/[A-Z][A-Z0-9]*_[A-Z0-9_]+/.test(pattern) || /[\s"':=/]/.test(pattern)) return 'literal'
  return 'word'
}

function contentKind(pattern, targets, root) {
  if (targets.length > 0 && targets.every((target) => outsideRepo(target, root))) return 'non-code'
  if (targets.length > 0 && targets.every(isFile)) return 'in-file'
  return patternKind(pattern)
}

function commandSearch(argv, root) {
  const [program = '', ...rest] = argv
  let name = program.slice(program.lastIndexOf('/') + 1)
  let args = rest
  if (name === 'git') {
    let i = 0
    while (args[i] && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
    if (args[i] === 'ls-files') return { kind: 'find-file', pattern: '' }
    if (args[i] !== 'grep') return null
    name = 'grep'
    args = args.slice(i + 1)
  }
  if (FIND_TOOLS.includes(name)) return { kind: 'find-file', pattern: '' }
  if (!SEARCH_TOOLS.includes(name)) return null
  if (args.includes('--files')) return { kind: 'find-file', pattern: '' }
  const { pattern, targets } = patternAndTargets(args)
  return { kind: contentKind(pattern, targets, root), pattern }
}

function searchOf(tool, input, root) {
  if (tool === 'Grep') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    const targets = typeof input.path === 'string' && input.path !== '' ? [input.path] : []
    return { kind: contentKind(pattern, targets, root), pattern }
  }
  if (tool !== 'Bash' || typeof input.command !== 'string') return null
  for (const { argv, piped } of shellCommands(input.command)) {
    if (piped) continue
    const search = commandSearch(withoutPrefix(argv), root)
    if (search !== null) return search
  }
  return null
}

function nudgeFor({ kind, pattern }) {
  const quoted = JSON.stringify(pattern.length > 80 ? pattern.slice(0, 80) : pattern)
  if (kind === 'symbol') {
    const name = alternativesOf(pattern).find(shaped) || pattern
    return `Cortex: this search is for the symbol ${name}. cortex_code_context(name: ${JSON.stringify(name)}) ` +
      'answers where it is defined, who calls it and what it calls in one call, without reading ' +
      'grep hits. Grep stays right for an exact literal. This search runs either way.'
  }
  return `Cortex: a search for ${quoted} across the repo is a question about the code. ` +
    `cortex_code_search(query: ${quoted}, limit: 10) ranks the files that answer it; read all ten ` +
    'before choosing. Grep stays right for an exact literal. This search runs either way.'
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { raw += chunk })
process.stdin.on('end', () => {
  let event
  try { event = JSON.parse(raw) } catch { return }
  const tool = String(event.tool_name || '')
  const agent = [event.session_id, event.agent_id || 'main'].filter(Boolean).join('-')
    .replace(/[^A-Za-z0-9_-]/g, '').slice(0, 160) || 'main'
  const dir = path.join(process.env.STATE_DIR, 'nudge')
  const file = path.join(dir, agent)
  let state = { sinceLookup: null, sinceNudge: null }
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch {}
  const save = () => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(state))
    } catch {}
  }

  if (LOOKUP.test(tool)) {
    state.sinceLookup = 0
    return save()
  }
  if (state.sinceLookup !== null) state.sinceLookup += 1
  let search = null
  try { search = searchOf(tool, event.tool_input || {}, process.env.PROJECT_DIR || '') } catch {}
  const addressable = search !== null && (search.kind === 'symbol' || search.kind === 'word')
  if (!addressable) return save()
  if (state.sinceNudge !== null) state.sinceNudge += 1
  const checking = state.sinceLookup !== null && state.sinceLookup <= AFTER_LOOKUP
  const recent = state.sinceNudge !== null && state.sinceNudge < NUDGE_EVERY
  if (checking || recent) return save()
  state.sinceNudge = 0
  save()
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: nudgeFor(search) },
  }))
})
NUDGEJS
STATE_DIR="$STATE_DIR" PROJECT_DIR="$PROJECT_DIR" node -e "$NUDGE_JS" 2>/dev/null
exit 0
HOOKEOF

  # ── recall-notes.sh ──
  cat > .claude/hooks/recall-notes.sh << 'HOOKEOF'
#!/bin/bash
# Cortex File Notes (v1) — what past work learned about a file, shown before the agent opens it.
#
# Risks, lessons and fixes stored with cortex_knowledge_store(files: [...]), and the risks a
# conductor task reported when it completed, are linked to repo files on the hub. An agent
# about to read or edit one of those files gets them as context here, once per conversation
# and agent, instead of having to know that a search would have found them. Never a block.
#
# The hub is asked once for every linked path of the project (cortex_file_notes), kept in
# .cortex/.session-state/notes/index.json for NOTES_TTL, so a read costs no request at all.
# A hub that does not answer is asked again after FAILED_TTL; meanwhile the hook says nothing.
#
# CORTEX_NOTES=off turns it off; so does gate-off, since the hub is down. It is JavaScript in
# a shell file so the installers can ship it like every other hook; without node it does nothing.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ "${CORTEX_NOTES:-}" = "off" ] && exit 0
[ -s "$STATE_DIR/gate-off" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

# read, not $(cat << …): bash 3.2, macOS's own, misparses quotes in a heredoc inside $( ).
IFS= read -r -d '' NOTES_JS << 'NOTESJS' || true
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const NOTES_TTL = 10 * 60_000
const FAILED_TTL = 2 * 60_000
/** Another hook already asking the hub: its answer is waited for no longer than this. */
const LOCK_STALE = 15_000
const PER_FILE = 3

const project = process.env.PROJECT_DIR
const dir = path.join(process.env.STATE_DIR, 'notes')

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}

// The hub this machine's agents talk to, found where session-end-check.sh finds it: the env,
// then the MCP configs of each IDE. The key never leaves this process.
function hubEndpoint() {
  const bearer = (auth) => (/^bearer /i.test(auth) ? auth : `Bearer ${auth}`)
  const envUrl = process.env.CORTEX_MCP_URL || process.env.HUB_MCP_URL
  if (envUrl && process.env.HUB_API_KEY) return { url: envUrl, auth: bearer(process.env.HUB_API_KEY) }
  const home = os.homedir()
  const servers = (doc) => ({ ...(doc.mcpServers || {}), ...(doc.servers || {}) })
  const claude = load(path.join(home, '.claude.json'))
  const configs = [
    servers(load(path.join(project, '.mcp.json'))),
    servers((claude.projects || {})[project] || {}),
    servers(claude),
    servers(load(path.join(project, '.gemini', 'settings.json'))),
    servers(load(path.join(home, '.gemini', 'settings.json'))),
    servers(load(path.join(home, '.gemini', 'antigravity', 'mcp_config.json'))),
    servers(load(path.join(home, '.cursor', 'mcp.json'))),
    servers(load(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'))),
    servers(load(path.join(project, '.vscode', 'mcp.json'))),
  ]
  for (const found of configs) {
    const e = found['cortex-hub'] || Object.entries(found).find(([k]) => k.toLowerCase().includes('cortex'))?.[1]
    if (!e || typeof e !== 'object') continue
    const env = e.env && typeof e.env === 'object' ? e.env : {}
    const args = (e.args || []).filter((a) => typeof a === 'string')
    const url = e.url || e.httpUrl || e.serverUrl || args.find((a) => a.startsWith('http'))
    let auth = (e.headers || {}).Authorization || (e.headers || {}).authorization
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--header' && /^authorization:/i.test(args[i + 1])) auth = auth || args[i + 1].split(':').slice(1).join(':')
    }
    auth = String(auth || '').replace(/\$\{(\w+)\}/g, (_, v) => env[v] || process.env[v] || '').trim()
    if (url && auth) return { url, auth: bearer(auth) }
  }
  return null
}

function remoteUrl() {
  try {
    return execFileSync('git', ['-C', project, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 2000 }).trim() || undefined
  } catch { return undefined }
}

/** An MCP answer, plain JSON or one server-sent event. */
function rpcResult(text) {
  const data = text.trimStart().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('')
  const msg = JSON.parse(data)
  if (msg.error || msg.result?.isError) throw new Error('hub refused')
  return JSON.parse(msg.result.content[0].text)
}

async function askHub() {
  const hub = hubEndpoint()
  if (!hub) return null
  const res = await fetch(hub.url, {
    method: 'POST',
    headers: { Authorization: hub.auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'cortex_file_notes', arguments: { repo: remoteUrl() } },
    }),
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = rpcResult(await res.text())
  return body.notes && typeof body.notes === 'object' ? body.notes : {}
}

/** Every linked path of the project and its notes: the cached index, else the hub's. */
async function index() {
  const file = path.join(dir, 'index.json')
  const cached = load(file)
  const age = Date.now() - (cached.at || 0)
  if (age < (cached.ok ? NOTES_TTL : FAILED_TTL)) return cached.notes || {}
  const lock = path.join(dir, 'lock')
  try {
    fs.mkdirSync(lock)
  } catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_STALE) return cached.notes || {} } catch {}
    fs.rmSync(lock, { recursive: true, force: true })
    try { fs.mkdirSync(lock) } catch { return cached.notes || {} }
  }
  try {
    const notes = await askHub().catch(() => null)
    // A hub that did not answer keeps what was known: stale notes beat none.
    const next = notes === null ? { at: Date.now(), ok: false, notes: cached.notes || {} } : { at: Date.now(), ok: true, notes }
    fs.writeFileSync(file, JSON.stringify(next))
    return next.notes
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

/** The file as the hub links it, relative to the repo; null outside it. Symlinked checkouts (/tmp) match either way. */
function repoPath(target) {
  const inside = (root, file) => {
    const rel = path.relative(root, file).split(path.sep).join('/')
    return rel === '' || rel.startsWith('../') || path.isAbsolute(rel) ? null : rel
  }
  const file = path.resolve(project, target)
  let real = file
  try { real = path.join(fs.realpathSync(path.dirname(file)), path.basename(file)) } catch {}
  let root = project
  try { root = fs.realpathSync(project) } catch {}
  return inside(project, file) ?? inside(root, real)
}

async function main() {
  let event = {}
  try { event = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { return }
  const input = event.tool_input || {}
  const target = input.file_path || input.notebook_path
  if (typeof target !== 'string' || target === '') return
  const rel = repoPath(target)
  if (rel === null) return

  fs.mkdirSync(dir, { recursive: true })
  const agent = [event.session_id, event.agent_id || 'main'].filter(Boolean).join('-').replace(/[^\w.-]/g, '_')
  const shownFile = path.join(dir, `shown-${agent}`)
  let shown = []
  try { shown = fs.readFileSync(shownFile, 'utf8').split('\n') } catch {}
  if (shown.includes(rel)) return

  const notes = await index()
  const found = []
  for (const [linked, list] of Object.entries(notes)) {
    if (linked !== rel && !(linked.endsWith('/') && rel.startsWith(linked))) continue
    for (const n of Array.isArray(list) ? list : []) if (!found.some((f) => f.id === n.id)) found.push(n)
  }
  fs.appendFileSync(shownFile, `${rel}\n`)
  if (found.length === 0) return
  found.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const lines = found.slice(0, PER_FILE).map((n) => `- [${n.kind}] ${n.title}${n.note && n.note !== n.title ? ` — ${n.note}` : ''}`)
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `📌 Cortex notes on ${rel}, from earlier work on it:\n${lines.join('\n')}`,
    },
  }))
}

main().catch(() => {})
NOTESJS
STATE_DIR="$STATE_DIR" PROJECT_DIR="$PROJECT_DIR" node -e "$NOTES_JS" 2>/dev/null
exit 0
HOOKEOF

  # ── prompt-start.sh ──
  cat > .claude/hooks/prompt-start.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Prompt Start (v1) — opens the cortex session from the user's prompt, before the agent's first turn.
#
# cortex_session_start with the task answers the recall and the first code lookup in one call,
# but the agent still spent a whole turn making it: a turn that re-reads the entire context to
# write one tool call whose arguments a script already knows. Measured on a large repo, that
# turn was most of what a hub-backed run cost over a plain grep one. So the prompt goes to the
# hub here, the answer goes in front of the agent with the prompt, and the gates open on the
# hub's evidence lines, the same ones track-quality.sh accepts from the agent's own call.
#
# What is sent: the first 300 characters of the prompt (the hub's limit on a task), with
# anything that looks like a key, token or password replaced. The hub embeds it to search
# and keeps nothing of it; no model reads it. Slash commands and short replies ("ok", "go on")
# send nothing, and a hub that does not answer in time leaves the agent to start the session
# itself, as before.
#
# CORTEX_PROMPT_START=off turns it off; so does gate-off, since the hub is down. It is JavaScript
# in a shell file so the installers can ship it like every other hook; without node it does nothing.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

[ "${CORTEX_PROMPT_START:-}" = "off" ] && exit 0
[ -s "$STATE_DIR/gate-off" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

# read, not $(cat << …): bash 3.2, macOS's own, misparses quotes in a heredoc inside $( ).
IFS= read -r -d '' START_JS << 'STARTJS' || true
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

/** The prompt waits on this hook: a slow hub costs the user this much, then the agent starts it. */
const START_TIMEOUT = 5000
const MIN_CHARS = 12
/** The hub's limit on a task, and more than enough to say what a prompt is about. */
const MAX_TASK = 300

const project = process.env.PROJECT_DIR
const stateDir = process.env.STATE_DIR

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}

// The hub this machine's agents talk to, found where session-end-check.sh finds it: the env,
// then the MCP configs of each IDE. The key never leaves this process.
function hubEndpoint() {
  const bearer = (auth) => (/^bearer /i.test(auth) ? auth : `Bearer ${auth}`)
  const envUrl = process.env.CORTEX_MCP_URL || process.env.HUB_MCP_URL
  if (envUrl && process.env.HUB_API_KEY) return { url: envUrl, auth: bearer(process.env.HUB_API_KEY) }
  const home = os.homedir()
  const servers = (doc) => ({ ...(doc.mcpServers || {}), ...(doc.servers || {}) })
  const claude = load(path.join(home, '.claude.json'))
  const configs = [
    servers(load(path.join(project, '.mcp.json'))),
    servers((claude.projects || {})[project] || {}),
    servers(claude),
    servers(load(path.join(project, '.gemini', 'settings.json'))),
    servers(load(path.join(home, '.gemini', 'settings.json'))),
    servers(load(path.join(home, '.gemini', 'antigravity', 'mcp_config.json'))),
    servers(load(path.join(home, '.cursor', 'mcp.json'))),
    servers(load(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'))),
    servers(load(path.join(project, '.vscode', 'mcp.json'))),
  ]
  for (const found of configs) {
    const e = found['cortex-hub'] || Object.entries(found).find(([k]) => k.toLowerCase().includes('cortex'))?.[1]
    if (!e || typeof e !== 'object') continue
    const env = e.env && typeof e.env === 'object' ? e.env : {}
    const args = (e.args || []).filter((a) => typeof a === 'string')
    const url = e.url || e.httpUrl || e.serverUrl || args.find((a) => a.startsWith('http'))
    let auth = (e.headers || {}).Authorization || (e.headers || {}).authorization
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--header' && /^authorization:/i.test(args[i + 1])) auth = auth || args[i + 1].split(':').slice(1).join(':')
    }
    auth = String(auth || '').replace(/\$\{(\w+)\}/g, (_, v) => env[v] || process.env[v] || '').trim()
    if (url && auth) return { url, auth: bearer(auth) }
  }
  return null
}

function git(...args) {
  try {
    return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', timeout: 2000 }).trim() || undefined
  } catch { return undefined }
}

// Keys pasted into a prompt stay on this machine: provider-shaped keys, JWTs, credentials in a
// URL, `token=…`-style assignments, and any long unbroken run of key-like characters.
const SECRETS = [
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1<redacted>@'],
  [/\b((?:api[_-]?)?(?:key|token|secret|passw(?:or)?d|pwd))(\s*[=:]\s*)\S+/gi, '$1$2<redacted>'],
  [/\bBearer\s+\S+/gi, 'Bearer <redacted>'],
  [/\b(?:sk|pk|rk)[_-][A-Za-z0-9_-]{8,}/g, '<redacted>'],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}/g, '<redacted>'],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, '<redacted>'],
  [/\bAKIA[0-9A-Z]{12,}/g, '<redacted>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, '<redacted>'],
  [/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+){1,2}/g, '<redacted>'],
  // Letters and digits mixed, 32 or more: a key or a hash. A long-named path or symbol has no digit.
  [/(?=[A-Za-z0-9+_=-]*\d)(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{32,}/g, '<redacted>'],
]

/** The prompt as the hub gets it: no secrets, one line, at most MAX_TASK characters. */
function scrub(prompt) {
  let task = prompt
  for (const [re, to] of SECRETS) task = task.replace(re, to)
  return task.replace(/\s+/g, ' ').trim().slice(0, MAX_TASK)
}

/** The same identity session-id.sh puts on the agent's own call, so the hub keeps one session. */
function identity() {
  const who = load(path.join(project, '.cortex', 'agent-identity.json'))
  const env = who.environment && typeof who.environment === 'object' ? who.environment : {}
  const found = {
    hostname: env.hostname, os: env.os, role: who.role, branch: git('branch', '--show-current'),
    ide: /vscode/.test(process.env.CLAUDE_CODE_ENTRYPOINT || '') ? 'claude-code-vscode' : 'claude-code-cli',
  }
  const out = Object.fromEntries(Object.entries(found).filter(([, v]) => typeof v === 'string' && v))
  if (Array.isArray(who.capabilities) && who.capabilities.length && who.capabilities.every((c) => typeof c === 'string')) {
    out.capabilities = who.capabilities
  }
  return out
}

/** An MCP answer, plain JSON or one server-sent event: its text blocks. */
function rpcTexts(text) {
  const data = text.trimStart().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('')
  const msg = JSON.parse(data)
  if (msg.error || msg.result?.isError) throw new Error('hub refused')
  return (msg.result.content || []).filter((b) => b.type === 'text').map((b) => b.text)
}

async function startSession(task, clientSessionId) {
  const hub = hubEndpoint()
  // Credentials in the remote stay here: only the host and path go to the hub.
  const repo = git('config', '--get', 'remote.origin.url')?.replace(/:\/\/[^/@]+@/, '://')
  if (!hub || !repo) return null
  const res = await fetch(hub.url, {
    method: 'POST',
    headers: { Authorization: hub.auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'cortex_session_start',
        arguments: { ...identity(), repo, mode: 'development', agentId: 'claude-code', task, clientSessionId },
      },
    }),
    signal: AbortSignal.timeout(START_TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const [head, ...brief] = rpcTexts(await res.text())
  const status = JSON.parse(head)
  // Without the hub the tool still answers, with an id only it knows: no session to speak of.
  if (status.hub_error || !/^sess_/.test(String(status.session_id || ''))) return null
  return { sessionId: status.session_id, note: status.project_note, brief: brief.join('\n') }
}

/** Evidence as track-quality.sh writes it, naming this hook. */
function record(name) {
  fs.writeFileSync(path.join(stateDir, name), `tool=prompt-start at=${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}\n`)
}

async function main() {
  let event = {}
  try { event = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { return }
  const prompt = typeof event.prompt === 'string' ? event.prompt.trim() : ''
  // A slash command runs its own start; a short reply has no task to look up.
  if (prompt.length < MIN_CHARS || prompt.startsWith('/')) return
  const clientSessionId = String(event.session_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128)
  if (!clientSessionId) return
  const task = scrub(prompt)
  if (task.length < MIN_CHARS) return

  const started = await startSession(task, clientSessionId).catch(() => null)
  if (!started) return

  fs.mkdirSync(path.join(stateDir, 'conversations'), { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'session-id'), `${started.sessionId}\n`)
  fs.writeFileSync(path.join(stateDir, 'conversations', clientSessionId), `${started.sessionId}\n`)
  record('session-started')
  fs.rmSync(path.join(stateDir, 'session-ended'), { force: true })
  // The hub prints each line only when that part answered.
  if (/^recalled: knowledge\+memory for /m.test(started.brief)) { record('knowledge-recalled'); record('memory-recalled') }
  if (/^located: code for /m.test(started.brief)) record('discovery-used')

  const context = [
    `Cortex session ${started.sessionId} is open for this prompt: cortex_session_start already ran with it as the task, so do not call it again.`,
    started.note,
    started.brief,
  ].filter(Boolean).join('\n')
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }))
}

main().catch(() => {})
STARTJS
STATE_DIR="$STATE_DIR" PROJECT_DIR="$PROJECT_DIR" node -e "$START_JS" 2>/dev/null
exit 0
HOOKEOF

  cat > .claude/hooks/subagent-start.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Subagent Start (v1.0) — tells a subagent what the session it joins expects.
#
# A subagent begins with the prompt its parent wrote and none of the recall /cs did. The
# recall gate holds its edits until it recalls for itself, and this is where it learns that
# before running into the gate.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

cat >/dev/null 2>&1 || true

# No cortex session in this checkout, or the gates declared off: nothing to follow.
[ -f "$STATE_DIR/session-started" ] || exit 0
[ -s "$STATE_DIR/gate-off" ] && exit 0

CONTEXT="Cortex: you are a subagent in a Cortex session, and the parent's recall is not in your context. \
Before editing any file, run cortex_knowledge_search and cortex_memory_search on your own task: \
edits stay blocked until you do. \
Find code with cortex_code_context for a known symbol or cortex_code_search for a behaviour (read all ten hits); \
grep is for exact literals. \
When something fails, search knowledge for the error before fixing it."

printf '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"%s"}}\n' "$CONTEXT"
exit 0
HOOKEOF

  cat > .claude/hooks/session-id.sh << 'HOOKEOF'
#!/bin/bash
# Cortex Session Id (v1.2) — fills in clientSessionId and the agent identity on cortex_session_start,
# and the checkout's repo on cortex_code_search.
#
# The hub keeps two conversations in one checkout on separate sessions by this id. Until
# session-init v7.4 the agent copied it from a line that hook printed, but that line differs
# in every conversation and sits ahead of CLAUDE.md and the rest of the opening context, so
# the prompt cache could never reuse anything after it: ~6k tokens written anew per
# conversation, most of what made a hub lookup cost more than a plain grep. The hook payload
# already carries the id, so it goes straight into the call and the context stays the same.
#
# v1.1: the identity too. CLAUDE.md told the agent to read .cortex/agent-identity.json and the
# git branch before its first call, two more turns in every conversation for values a script
# can look up. What the agent passes itself still wins; only the id is always this hook's.
#
# v1.2: a cortex_code_search that names no repo, project or org gets `here`, this checkout's
# remote. Agents left repo out in half their searches, and the hub then searched every repo of
# the organization at once: graph flows only, no ranked files or lines, and nothing from the
# repo being worked on. With `here` it searches this repo in full and lists the others below.
INPUT=$(cat 2>/dev/null || true)
[ -z "$INPUT" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
IDENTITY_FILE="$PROJECT_DIR/.cortex/agent-identity.json"
BRANCH=$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || true)
case "${CLAUDE_CODE_ENTRYPOINT:-}" in
  *vscode*) IDE=claude-code-vscode ;;
  *) IDE=claude-code-cli ;;
esac

# Credentials in the remote stay here: only the host and path go to the hub.
HERE=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null | sed -E 's#://[^/@]+@#://#' || true)

# The same id, with the same characters kept, that the tracker and the exit hook file this
# conversation's session under. Whatever the agent passed is replaced: this one is current.
if command -v jq >/dev/null 2>&1; then
  IDENTITY=$(jq -c 'if type == "object" then . else {} end' "$IDENTITY_FILE" 2>/dev/null || true)
  [ -z "$IDENTITY" ] && IDENTITY='{}'
  printf '%s' "$INPUT" | jq -c --argjson who "$IDENTITY" --arg branch "$BRANCH" --arg ide "$IDE" --arg here "$HERE" '
    if (.tool_name // "" | test("cortex_code_search$")) then
      (.tool_input // {}) as $in
      | select($here != "" and ([$in.repo, $in.projectId, $in.org, $in.here] | all(. == null)))
      | {hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: ($in + {here: $here})}}
    else
    (.session_id // "" | gsub("[^A-Za-z0-9_-]"; "") | .[0:128]) as $id
    | select($id != "")
    | ($who.environment | if type == "object" then . else {} end) as $env
    # A value of the wrong type fails the schema of the tool, and with it the whole call, so a
    # hand-edited file only contributes what it got right.
    | (({hostname: $env.hostname, os: $env.os, role: $who.role, branch: $branch, ide: $ide}
        | with_entries(select(.value | type == "string" and . != "")))
       + ($who.capabilities | if type == "array" and length > 0 and all(type == "string")
           then {capabilities: .} else {} end)) as $found
    | {hookSpecificOutput: {hookEventName: "PreToolUse",
        updatedInput: ($found + (.tool_input // {}) + {clientSessionId: $id})}}
    end' 2>/dev/null
elif command -v python3 >/dev/null 2>&1; then
  printf '%s' "$INPUT" | IDENTITY_FILE="$IDENTITY_FILE" BRANCH="$BRANCH" IDE="$IDE" HERE="$HERE" python3 -c '
import json, os, re, sys
d = json.load(sys.stdin)
cid = re.sub(r"[^A-Za-z0-9_-]", "", str(d.get("session_id") or ""))[:128]
if str(d.get("tool_name") or "").endswith("cortex_code_search"):
    args = d.get("tool_input") or {}
    if os.environ.get("HERE") and all(args.get(k) is None for k in ("repo", "projectId", "org", "here")):
        args["here"] = os.environ["HERE"]
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": args}}))
elif cid:
    try:
        who = json.load(open(os.environ["IDENTITY_FILE"], encoding="utf-8-sig"))
        who = who if isinstance(who, dict) else {}
    except Exception:
        who = {}
    env = who.get("environment") if isinstance(who.get("environment"), dict) else {}
    found = {"hostname": env.get("hostname"), "os": env.get("os"), "role": who.get("role"),
             "branch": os.environ.get("BRANCH"), "ide": os.environ.get("IDE")}
    args = {k: v for k, v in found.items() if isinstance(v, str) and v}
    caps = who.get("capabilities")
    if isinstance(caps, list) and caps and all(isinstance(c, str) for c in caps):
        args["capabilities"] = caps
    args.update(d.get("tool_input") or {})
    args["clientSessionId"] = cid
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": args}}))
' 2>/dev/null
fi
exit 0
HOOKEOF

  chmod +x .claude/hooks/*.sh
  ok "Hooks: all 9 hooks installed (v${HOOKS_VERSION}.${HOOKS_MINOR})"

  # ── settings.json ──
  # Call bash directly — works on macOS (native) and Windows (Git Bash).
  # The path is anchored to CLAUDE_PROJECT_DIR because Claude Code runs a hook in the
  # shell cwd, which follows every cd: a relative path failed with No such file in a
  # subdirectory, and Claude Code treats that as non-blocking, so every gate opened.
  # A repo may already commit its own settings (permissions, hooks, plugins): set it aside
  # and merge it back below, or onboarding wipes them.
  PREV_SETTINGS=""
  if [ -f .claude/settings.json ]; then
    PREV_SETTINGS="$(mktemp)"
    cp .claude/settings.json "$PREV_SETTINGS"
  fi
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
    "SubagentStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/subagent-start.sh\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/prompt-start.sh\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit|Bash|Grep|Glob",
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
    ,
      {
        "matcher": "Bash|Grep|Glob|mcp__.*cortex_(code_search|code_context|code_impact|cypher)",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/nudge-lookup.sh\""
          }
        ]
      },
      {
        "matcher": "mcp__.*cortex_(session_start|code_search)",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/session-id.sh\""
          }
        ]
      },
      {
        "matcher": "Read|Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/recall-notes.sh\""
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
            "command": "bash \"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/session-end-check.sh\"",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
EOF
  if [ -n "$PREV_SETTINGS" ]; then
    if merge_settings "$PREV_SETTINGS" .claude/settings.json; then
      ok "Settings: cortex hooks merged into the existing .claude/settings.json"
    else
      cp "$PREV_SETTINGS" .claude/settings.json.bak
      warn "Settings: could not merge into the existing .claude/settings.json (needs python3 and valid JSON) — replaced it, the old one is .claude/settings.json.bak"
    fi
    rm -f "$PREV_SETTINGS"
  else
    ok "Settings: .claude/settings.json generated"
  fi

  # ── Clean user-level hooks (prevent duplicate/stale hooks) ──
  # Only the entries an older install put there: the user's own hooks are not ours to remove.
  USER_SETTINGS="$HOME/.claude/settings.json"
  if [ -f "$USER_SETTINGS" ] && merge_settings "$USER_SETTINGS" 2>/dev/null; then
    ok "Removed stale cortex hooks from user-level settings (~/.claude/settings.json)"
  fi

  # ── Slash commands (/cs, /ce) ──
  mkdir -p .claude/commands
  cat > .claude/commands/cs.md << 'CMDEOF'
# /cs — Cortex Start v0.10.0

> Version: 0.10.0 | Updated: 2026-10-22
> Changelog: v0.10.0 — one call: session_start with the task answers the recall and the files to read
> Changelog: v0.9.4 — recall with the task's own words; the generic session query is already in session_start's answer
> Changelog: v0.9.0 — cortex_plan_quality is actually registered; it scores 0-10 and takes the request too
> Changelog: v0.8.0 — search-once/read-all-ten ordering from measured retrieval; recall no longer counts as discovery

## 1. Start, with the task
```
cortex_session_start(repo: "__GIT_REPO__", task: "<the task in a few words>")
```
The task's own words: the feature, the error, the file. The answer holds the recall for it
(`recalled:` knowledge and memory) and where the code is (`located:` files, line ranges, symbols).
That is the recall and the first lookup: do not repeat them with separate searches. A hook adds
the conversation id, branch, IDE and identity. No task yet? Start without one, and call it again
with the task once you have it.

## 2. Only when it applies
- Uncommitted changes in `git status` → `cortex_detect_changes(diff: "<git diff HEAD>")`.
- Shared files another agent may hold → `cortex_changes(projectId)`.
- Conductor work → `cortex_task_pickup()`; then `cortex_task_accept`, `cortex_task_update`.
- A plan of several steps → `cortex_plan_quality(plan, request)`; 8.0 or more → execute.

## 3. While working
- A symbol name → `cortex_code_context(name)`. A behaviour → `cortex_code_search(query)`.
  An exact literal → `rg`; in the organization's other repos → `cortex_code_grep`. Read the lines a hit names, not the whole file.
- Something breaks → `cortex_knowledge_search` and `cortex_memory_search` with the error; a
  non-obvious fix → `cortex_knowledge_store`.
- Before committing → build, typecheck and lint last, then `cortex_detect_changes(diff)`; after
  pushing → `cortex_code_reindex(repo, branch)`.
CMDEOF
  sed_inplace "s|__GIT_REPO__|${GIT_REPO}|g" .claude/commands/cs.md

  cat > .claude/commands/ce.md << 'CMDEOF'
# /ce — Cortex End v0.9.0

> Version: 0.9.0 | Updated: 2026-09-28
> Changelog: v0.9.0 — version synced with the v0.9.0 release
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
# Cortex Session Init (v7.2) — Gemini variant.
#
# v3 wiped the gate markers on every SessionStart. Where the host distinguishes a resumed or
# compacted session from a fresh one, re-arming the discovery gate mid-task is a bug: the agent
# already did the recall, and it cannot prove it any more. v3 also never cleared changes-checked
# or tasks-checked, so those markers survived for months and the checks silently stopped running.
#
# And it cleared session-started on every start, which is right — but the claude variant used to
# create it here instead, making its whole session gate vacuous. Only the tracker writes it, from
# a real cortex_session_start call.
# v7.2 names this conversation's id for cortex_session_start's clientSessionId, so two
# conversations in one checkout get a hub session each instead of sharing one.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"

INPUT=$(cat 2>/dev/null || true)
SOURCE=""
CLIENT_ID=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null || true)
    CLIENT_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    SOURCE=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("source",""))' 2>/dev/null || true)
    CLIENT_ID=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || true)
  fi
fi
SOURCE=$(printf '%s' "$SOURCE" | tr -cd 'A-Za-z0-9_-')
CLIENT_ID=$(printf '%s' "$CLIENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)
CONVERSATION=""
[ -n "$CLIENT_ID" ] && CONVERSATION=" This conversation's clientSessionId is ${CLIENT_ID} — pass it to cortex_session_start."

case "$SOURCE" in
  compact|resume)
    echo '{"systemMessage":"Cortex: same session ('"$SOURCE"') — discovery state kept.'"$CONVERSATION"'"}'
    exit 0 ;;
esac

rm -f "$STATE_DIR/session-started" "$STATE_DIR/quality-gates-passed" \
      "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" \
      "$STATE_DIR/quality-reported" "$STATE_DIR/session-ended" \
      "$STATE_DIR/discovery-used" "$STATE_DIR/knowledge-recalled" \
      "$STATE_DIR/memory-recalled" "$STATE_DIR/changes-checked" \
      "$STATE_DIR/tasks-checked" "$STATE_DIR/gate-off" "$STATE_DIR/session-id" 2>/dev/null
# Other conversations' sessions stay theirs to close; only week-old records are dropped.
[ -d "$STATE_DIR/conversations" ] && find "$STATE_DIR/conversations" -type f -mtime +7 -exec rm -f {} + 2>/dev/null
echo '{"systemMessage":"MANDATORY: call cortex_session_start with the task (task: <the task in a few words>) before any edit: one call answers the recall for the task and the files and lines to read, and opens the edit and search gates.'"$CONVERSATION"'"}'
exit 0
GHOOKEOF

    cat > .gemini/hooks/enforce-session.sh << 'GHOOKEOF'
#!/bin/bash
# Cortex Session Enforcement (v6.2) — Gemini variant.
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
      deny "BLOCKED: run cortex_knowledge_search and cortex_memory_search before editing, with the words of the task in hand (the feature, the error) — they restore what previous sessions already decided and already fixed. $HOW_OUT"
    fi
  fi
  allow
fi

# Session not started: block writes and codebase search, allow plain reads. Searching is
# reading, so a cortex lookup unlocks it here as it does in a session — see the Claude hook.
SEARCH_HINT="BLOCKED: look it up with cortex_code_search (a behaviour) or cortex_code_context (a symbol name) first. One call unlocks find/grep/rg, glob and search_file_content for the rest of the session. $HOW_OUT"
case "$TOOL_NAME" in
  write_file|replace|edit_file|create_file|insert_text)
    deny "BLOCKED: call cortex_session_start first, with the task (task: <the task in a few words>). No edits without a session." ;;
  glob|search_file_content)
    marker_ok discovery-used || deny "$SEARCH_HINT" ;;
  run_shell_command|shell)
    is_codebase_search "$COMMAND" && ! marker_ok discovery-used && deny "$SEARCH_HINT"
    is_file_write "$COMMAND" && ! is_gate_off_write "$COMMAND" \
      && deny "BLOCKED: call cortex_session_start first, with the task (task: <the task in a few words>). No file modifications without a session."
    printf '%s' "$COMMAND" | grep -Eq '(git[[:space:]]+(add|commit|push|reset)|^rm[[:space:]]|^mv[[:space:]]|^cp[[:space:]]|^mkdir[[:space:]])' \
      && deny "BLOCKED: call cortex_session_start first, with the task (task: <the task in a few words>). No file modifications without a session." ;;
esac
allow
GHOOKEOF

    cat > .gemini/hooks/enforce-commit.sh << 'GHOOKEOF'
#!/bin/bash
# Cortex Commit Enforcement (v5.1) — Gemini variant.
#
# v3 accepted quality-gates-passed, which the tracker wrote the moment cortex_quality_report was
# called — so reporting a failure unlocked the commit just as well as passing. The marker now
# comes only from build/typecheck/lint actually running green.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
# v5.1 refuses to skip the repo's own git hooks (--no-verify, `commit -n`, LEFTHOOK=0): cortex
# writes this file, so the rule has to live here rather than be added by the repo.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
INPUT=$(cat)
COMMAND=""
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)
fi

# Prints why a command skips the repo's git hooks; prints nothing when it does not.
skips_hooks() {
  local cmd q="'"
  local b='(^|[;&|(`[:space:]])' seg='[^;&|)]' end='([;&|)[:space:]]|$)'
  # A heredoc body is text (a commit message), not flags: drop it and keep the line that
  # opens it. Then join `\` continuations and make every line a `;`-separated command.
  cmd=$(printf '%s\n' "$1" | awk '
    tag != "" { t = $0; sub(/^\t+/, "", t); if (t == tag) tag = ""; next }
    { print
      if (match($0, /(^|[^<])<<-?[ \t]*["\047]?[A-Za-z_][A-Za-z0-9_]*/)) {
        tag = substr($0, RSTART, RLENGTH); sub(/^[^<]?<<-?[ \t]*["\047]?/, "", tag)
      } }' | awk '/\\$/ { sub(/\\$/, ""); printf "%s ", $0; next } { print }' | tr '\n' ';')
  # Quoted arguments are messages and bodies; a flag named inside one is not a flag.
  # `LEFTHOOK="0"` keeps its quotes: they follow `=`, not a space.
  cmd=$(printf '%s' "$cmd" | sed -E "s/(^|[[:space:]])'[^']*'/\1/g; s/(^|[[:space:]])\"[^\"]*\"/\1/g; s/(--[a-z-]+=)'[^']*'/\1/g; s/(--[a-z-]+=)\"[^\"]*\"/\1/g")
  local re="${b}(export[[:space:]]+)?LEFTHOOK=[\"$q]?(0|false)([\"$q;&|)[:space:]]|\$)"
  if [[ "$cmd" =~ $re ]]; then echo "LEFTHOOK=0 turns lefthook off"; return; fi
  # git takes any unambiguous prefix of a long option, so --no-veri is --no-verify.
  re="${b}git[[:space:]]${seg}*[[:space:]]--no-veri[a-z]*(=|${end})"
  if [[ "$cmd" =~ $re ]]; then echo "--no-verify skips the hooks"; return; fi
  # `git commit -n` is --no-verify. Only flags that take no value may come before the n:
  # `-mnew` is `-m new`. `git push -n` is --dry-run and stays allowed.
  local opt='[[:space:]]+-[^[:space:];&|)]*([[:space:]]+[^-[:space:];&|)][^[:space:];&|)]*)?'
  re="${b}git(${opt})*[[:space:]]+commit([[:space:]]${seg}*)?[[:space:]]-[apseioqvz]*n[a-zA-Z]*${end}"
  if [[ "$cmd" =~ $re ]]; then echo "git commit -n is --no-verify"; return; fi
}
# Checked before the `^git commit` match below, so `cd x && git push --no-verify` is caught too.
SKIP_REASON=$(skips_hooks "$COMMAND")
if [ -n "$SKIP_REASON" ]; then
  printf '{"decision":"deny","reason":"BLOCKED: this skips the git hooks of the repo (%s). Those hooks are its own checks: run the command without the skip and fix what they report; if a hook itself is broken, ask the user to run the command."}\n' "$SKIP_REASON"
  exit 0
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
# Cortex Quality Tracker (v4.2) — Gemini variant.
#
# Two bugs from v3: cortex_quality_report touched quality-gates-passed, so reporting a failure
# counted as passing; and every marker was an empty `touch`, which the enforcement hook could not
# tell apart from a forged one. Markers now carry the tool and time that produced them, a gate is
# only marked when the command output does not look like a failure, and the cortex session id is
# captured so the session can actually be closed.
# v4.2 files that session under the conversation that opened it (conversations/<session_id>),
# so the exit hook closes this conversation's session and not another's in the same checkout.
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
INPUT=$(cat)

TOOL_NAME=""; COMMAND=""; OUTPUT=""; CLIENT_ID=""
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
  OUTPUT=$(printf '%s' "$INPUT" | jq -r '[(.tool_response // .tool_output // empty)] | tostring' 2>/dev/null || true)
  CLIENT_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  eval "$(printf '%s' "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'TOOL_NAME={repr(d.get(\"tool_name\",\"\"))}')
print(f'COMMAND={repr(d.get(\"tool_input\",{}).get(\"command\",\"\"))}')
print(f'OUTPUT={repr(json.dumps(d.get(\"tool_response\", d.get(\"tool_output\",\"\")), ensure_ascii=False))}')
print(f'CLIENT_ID={repr(str(d.get(\"session_id\",\"\")))}')
" 2>/dev/null || true)"
fi

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
CLIENT_ID=$(printf '%s' "$CLIENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)
record() { printf 'tool=%s at=%s\n' "${2:-$TOOL_NAME}" "$NOW" > "$STATE_DIR/$1"; }
# ESLint prints "✖ N problems (0 errors, N warnings)" for warnings alone, so a bare ✖
# is not a failure; only an error count above zero is.
looks_failed() {
  printf '%s' "$OUTPUT" | grep -Eq 'ERR_PNPM|ELIFECYCLE|error TS[0-9]|Command failed|✖ [0-9]+ problems? \([1-9]|FAIL |Exit status [1-9]'
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
    # Only a hub id: every hook payload opens with the IDE's own "session_id" (a conversation
    # uuid), and `head -1` used to take that one, so the exit hook tried to close a session
    # the hub had never heard of. The hub mints nothing but sess_… ids.
    SESSION_ID=$(printf '%s' "$INPUT" | tr -d '\\' \
      | grep -Eo '"session_?[iI]d"[[:space:]]*:[[:space:]]*"sess_[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
    [ -n "$SESSION_ID" ] && printf '%s\n' "$SESSION_ID" > "$STATE_DIR/session-id"
    if [ -n "$SESSION_ID" ] && [ -n "$CLIENT_ID" ]; then
      mkdir -p "$STATE_DIR/conversations"
      printf '%s\n' "$SESSION_ID" > "$STATE_DIR/conversations/$CLIENT_ID"
    fi
    # A new hub session is open, so an earlier one's "ended" no longer applies — left in
    # place it made the exit hook skip this session too.
    rm -f "$STATE_DIR/session-ended"
    # Started with the task, the answer carries the recall and the code lookup. The hub prints
    # each line only when that part answered, at the start of a line, never after \".
    if printf '%s' "$OUTPUT" | grep -Eq '([^\\]"|\\n)recalled: knowledge\+memory for '; then
      record knowledge-recalled; record memory-recalled
    fi
    printf '%s' "$OUTPUT" | grep -Eq '([^\\]"|\\n)located: code for ' && record discovery-used
    ;;
  *cortex_session_end*)
    record session-ended
    [ -n "$CLIENT_ID" ] && rm -f "$STATE_DIR/conversations/$CLIENT_ID"
    ;;
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
# Cortex Session End Check (v7.1) — Gemini variant.
#
# v6 posted to ${CORTEX_HUB_API_URL:-http://localhost:4000}. Nothing sets that variable, so on
# every machine but the hub itself the close went to a port nobody listens on; curl's failure
# was swallowed and `session-ended` was written anyway. Sessions were never closed, and the
# hook said they were. v7 goes where the agent's own cortex calls go — the hub's MCP endpoint,
# with the key from the IDE's MCP config — and only records a close the hub confirmed.
#
# The close is sent with auto:true: the hub records it as 'abandoned', keeps it out of memory
# and /cs recall, and leaves a session that /ce already completed alone.
#
# v7.1: every conversation in a checkout shares this state directory, so `session-id` is
# whichever one ran cortex_session_start last. The tracker files each session under the
# conversation that opened it, and this hook closes that one and nothing else; with no such
# record it falls back to `session-id`.
#
# An explicit project dir beats guessing: `git rev-parse` points at the main checkout from
# inside a worktree, and at whatever repo the tests happen to run from.
PROJECT_DIR="${CORTEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"

# Gemini shows a hook's systemMessage; plain stdout is not read.
say() { printf '{"systemMessage":"%s"}\n' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

INPUT=$(cat 2>/dev/null || true)
CLIENT_ID=""
if [ -n "$INPUT" ]; then
  if command -v jq >/dev/null 2>&1; then
    CLIENT_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    CLIENT_ID=$(printf '%s' "$INPUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || true)
  fi
fi
CLIENT_ID=$(printf '%s' "$CLIENT_ID" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)

SESSION_ID=""
OWN=""
if [ -n "$CLIENT_ID" ] && [ -d "$STATE_DIR/conversations" ]; then
  # Nothing filed under this conversation: it never opened a session, or closed it itself.
  OWN="$STATE_DIR/conversations/$CLIENT_ID"
  [ -s "$OWN" ] || exit 0
  SESSION_ID=$(head -1 "$OWN" 2>/dev/null || true)
else
  [ -f "$STATE_DIR/session-started" ] || exit 0
  [ -f "$STATE_DIR/session-ended" ] && exit 0
  [ -s "$STATE_DIR/session-id" ] && SESSION_ID=$(cat "$STATE_DIR/session-id" 2>/dev/null || true)
fi

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  say "WARNING: cortex session not closed — no session id was recorded. Call cortex_session_end next time."
  exit 0
fi

ACTIONS=""
[ -s "$STATE_DIR/knowledge-recalled" ]   && ACTIONS="${ACTIONS} knowledge-searched"
[ -s "$STATE_DIR/memory-recalled" ]      && ACTIONS="${ACTIONS} memory-searched"
[ -s "$STATE_DIR/discovery-used" ]       && ACTIONS="${ACTIONS} code-searched"
[ -s "$STATE_DIR/changes-checked" ]      && ACTIONS="${ACTIONS} changes-checked"
[ -s "$STATE_DIR/quality-gates-passed" ] && ACTIONS="${ACTIONS} quality-passed"
[ -s "$STATE_DIR/quality-reported" ]     && ACTIONS="${ACTIONS} quality-reported"
[ -s "$STATE_DIR/tasks-checked" ]        && ACTIONS="${ACTIONS} tasks-checked"
[ -s "$STATE_DIR/gate-off" ]             && ACTIONS="${ACTIONS} gate-off($(head -c 80 "$STATE_DIR/gate-off" | tr -d '"\\\n'))"

SUMMARY="Session auto-closed (gemini, no cortex_session_end)."
[ -n "$ACTIONS" ] && SUMMARY="Session auto-closed (gemini). Activity:${ACTIONS}."

if ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  say "WARNING: cortex session $SESSION_ID not closed — needs python3 and curl. Call cortex_session_end next time."
  exit 0
fi

# The hub's MCP endpoint and Authorization header, one per line, from the environment or the
# cortex-hub entry of whichever MCP config this machine has. Both shapes the installer writes
# are read: {url, headers} and the mcp-remote bridge {args: [url, --header, ...], env}.
hub_endpoint() {
  python3 - "$PROJECT_DIR" <<'PY' 2>/dev/null
import json, os, re, sys
project, home = sys.argv[1], os.path.expanduser('~')

def emit(url, auth):
    if url and auth:
        print(url)
        print(auth if auth.lower().startswith('bearer ') else 'Bearer ' + auth)
        sys.exit(0)

emit(os.environ.get('CORTEX_MCP_URL') or os.environ.get('HUB_MCP_URL'), os.environ.get('HUB_API_KEY'))

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}

def servers(doc):
    out = {}
    for key in ('mcpServers', 'servers'):
        if isinstance(doc.get(key), dict):
            out.update(doc[key])
    return out

def entry(found):
    if 'cortex-hub' in found:
        return found['cortex-hub']
    return next((v for k, v in found.items() if 'cortex' in k.lower()), None)

def expand(value, env):
    return re.sub(r'\$\{(\w+)\}', lambda m: env.get(m.group(1)) or os.environ.get(m.group(1), ''), value)

def resolve(e):
    if not isinstance(e, dict):
        return
    env = e.get('env') if isinstance(e.get('env'), dict) else {}
    headers = e.get('headers') if isinstance(e.get('headers'), dict) else {}
    args = [a for a in e.get('args') or [] if isinstance(a, str)]
    url = e.get('url') or e.get('httpUrl') or e.get('serverUrl') or next((a for a in args if a.startswith('http')), None)
    auth = headers.get('Authorization') or headers.get('authorization')
    for i, a in enumerate(args[:-1]):
        if a == '--header' and args[i + 1].lower().startswith('authorization:'):
            auth = auth or args[i + 1].split(':', 1)[1]
    emit(url, expand(auth or '', env).strip())

claude = load(os.path.join(home, '.claude.json'))
for found in (
    servers(load(os.path.join(project, '.mcp.json'))),
    servers((claude.get('projects') or {}).get(project) or {}),
    servers(claude),
    servers(load(os.path.join(project, '.gemini', 'settings.json'))),
    servers(load(os.path.join(home, '.gemini', 'settings.json'))),
    servers(load(os.path.join(home, '.gemini', 'antigravity', 'mcp_config.json'))),
    servers(load(os.path.join(home, '.cursor', 'mcp.json'))),
    servers(load(os.path.join(home, '.codeium', 'windsurf', 'mcp_config.json'))),
    servers(load(os.path.join(project, '.vscode', 'mcp.json'))),
):
    resolve(entry(found))
PY
}

# A JSON body for the close. $1 = "mcp" for a tools/call, anything else for the REST route.
close_body() {
  python3 - "$1" "$SESSION_ID" "$SUMMARY" <<'PY'
import json, sys
kind, sid, summary = sys.argv[1:4]
args = {'sessionId': sid, 'summary': summary, 'auto': True}
if kind == 'mcp':
    print(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                      'params': {'name': 'cortex_session_end', 'arguments': args}}))
else:
    print(json.dumps({'summary': summary, 'auto': True}))
PY
}

# Did the tools/call succeed? The reply is JSON, or the same JSON as SSE `data:` lines.
mcp_ok() {
  python3 -c '
import json, sys
raw = sys.stdin.read()
lines = [l[5:].strip() for l in raw.splitlines() if l.startswith("data:")] or [raw]
for line in lines:
    try:
        msg = json.loads(line)
    except Exception:
        continue
    if isinstance(msg, dict) and isinstance(msg.get("result"), dict) and not msg["result"].get("isError"):
        sys.exit(0)
sys.exit(1)'
}

CLOSED=1
WHY=""
if [ -n "${CORTEX_HUB_API_URL:-}" ]; then
  # An explicit API URL (a self-hosted hub on this machine) keeps the direct route.
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 4 -m 10 \
    -X POST "${CORTEX_HUB_API_URL%/}/api/sessions/${SESSION_ID}/end" \
    -H 'Content-Type: application/json' -d "$(close_body rest)" 2>/dev/null)
  case "$CODE" in 2??) CLOSED=0 ;; *) WHY="${CORTEX_HUB_API_URL} answered ${CODE:-nothing}" ;; esac
else
  ENDPOINT=$(hub_endpoint)
  MCP_URL=$(printf '%s\n' "$ENDPOINT" | sed -n 1p)
  MCP_AUTH=$(printf '%s\n' "$ENDPOINT" | sed -n 2p)
  if [ -z "$MCP_URL" ] || [ -z "$MCP_AUTH" ]; then
    WHY="no cortex-hub MCP server with an Authorization header in this machine's MCP config"
  else
    # The key goes in on stdin, never on the command line, where `ps` would show it.
    if printf 'Authorization: %s\n' "$MCP_AUTH" \
        | curl -sf --connect-timeout 4 -m 10 -X POST "$MCP_URL" -H @- \
            -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
            -d "$(close_body mcp)" 2>/dev/null | mcp_ok; then
      CLOSED=0
    else
      WHY="the hub at ${MCP_URL%%\?*} did not confirm it"
    fi
  fi
fi

if [ "$CLOSED" = "0" ]; then
  [ -n "$OWN" ] && rm -f "$OWN"
  # session-ended speaks for the checkout's current session, so only that one may write it.
  if [ -z "$OWN" ] || [ "$SESSION_ID" = "$(cat "$STATE_DIR/session-id" 2>/dev/null)" ]; then
    printf 'tool=session-end-check at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_DIR/session-ended"
  fi
  say "INFO: cortex session $SESSION_ID closed as abandoned.${ACTIONS:+ Activity:${ACTIONS}}"
else
  say "WARNING: cortex session $SESSION_ID not closed — ${WHY}. Call cortex_session_end next time."
fi
exit 0
GHOOKEOF

    chmod +x .gemini/hooks/*.sh

    # Gemini settings.json — merged into one the repo already has, like .claude/settings.json.
    PREV_SETTINGS=""
    if [ -f .gemini/settings.json ]; then
      PREV_SETTINGS="$(mktemp)"
      cp .gemini/settings.json "$PREV_SETTINGS"
    fi
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
    if [ -n "$PREV_SETTINGS" ]; then
      if ! merge_settings "$PREV_SETTINGS" .gemini/settings.json; then
        cp "$PREV_SETTINGS" .gemini/settings.json.bak
        warn "Gemini: could not merge into the existing .gemini/settings.json (needs python3 and valid JSON) — replaced it, the old one is .gemini/settings.json.bak"
      fi
      rm -f "$PREV_SETTINGS"
    fi
    ok "Gemini: hooks + settings.json installed (v${HOOKS_VERSION}.${HOOKS_MINOR})"
  fi

  # ── Instruction files for IDEs without runtime hooks ──
  # These IDEs rely on instruction-based enforcement only (no hooks API)
  generate_instruction_content() {
    local agent_id="$1"
    cat << INSTREOF
<!-- cortex-hub:auto-mcp -->
## Cortex Hub — MANDATORY

Once you know the task: \`cortex_session_start(repo: "$GIT_REPO", agentId: "$agent_id", task: "<the task in a few words>")\`.
Its answer is the recall (knowledge, memory) and the first lookup (files, lines and the symbols
they fall in): read those lines next, with no separate search first.

- A symbol name → \`cortex_code_context(name)\`. A behaviour → \`cortex_code_search(query)\`: scan the
  whole list, the target is not always first. An exact literal → \`rg\`; in the organization's other repos → \`cortex_code_grep\`.
- Read just the lines a hit names (Read with offset/limit), not the whole file.
- \`cortex_code_impact\` before changing something exported or shared.
- Something breaks → \`cortex_knowledge_search\` and \`cortex_memory_search\` with the error first;
  store a non-obvious fix with \`cortex_knowledge_store\`.
- Before committing: the verify commands from \`.cortex/project-profile.json\`, after the last edit
  (a later write closes the commit gate again), then \`cortex_detect_changes(diff: "<git diff --staged>")\`.
  After a push: \`cortex_code_reindex(repo: "$GIT_REPO", branch: "<branch>")\`.
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
postpush_yaml() {
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
}

# lefthook merges lefthook-local.yml into the repo's own config, whatever that config is
# called — the one place cortex can add a hook to a lefthook repo without replacing the
# repo's. The file is each developer's own, so ours sits between markers: a re-run swaps
# that block and leaves every other line alone.
LEFTHOOK_LOCAL_BEGIN="# >>> cortex post-push (managed by cortex install.sh, rewritten on every install)"
LEFTHOOK_LOCAL_END="# <<< cortex post-push"
WROTE_LEFTHOOK_LOCAL=""
write_lefthook_local() {
  local f="lefthook-local.yml" rest
  # lefthook reads .lefthook-local.yml only when lefthook-local.yml is absent.
  [ ! -f "$f" ] && [ -f .lefthook-local.yml ] && f=".lefthook-local.yml"
  if git_tracks "$f"; then
    warn "Lefthook: $f is committed to the repo — not adding cortex's post-push to it"; return 0
  fi
  if [ -f "$f" ] && grep -qxF "$LEFTHOOK_LOCAL_BEGIN" "$f" && ! grep -qxF "$LEFTHOOK_LOCAL_END" "$f"; then
    warn "Lefthook: $f has cortex's start marker but not its end — left as it is"; return 0
  fi
  rest=""
  [ -f "$f" ] && rest=$(B="$LEFTHOOK_LOCAL_BEGIN" E="$LEFTHOOK_LOCAL_END" awk '
    $0 == ENVIRON["B"] { skip = 1; next }
    skip { if ($0 == ENVIRON["E"]) skip = 0; next }
    { print }' "$f")
  # A second top-level `post-push:` key would make the whole file invalid YAML.
  if grep -q '^post-push:' <<< "$rest"; then
    warn "Lefthook: $f has its own post-push — not adding cortex's to it"; return 0
  fi
  {
    [ -n "$rest" ] && printf '%s\n\n' "$rest"
    echo "$LEFTHOOK_LOCAL_BEGIN"
    postpush_yaml
    echo "$LEFTHOOK_LOCAL_END"
  } > "$f.cortex-tmp" && mv "$f.cortex-tmp" "$f"
  WROTE_LEFTHOOK_LOCAL="$f"
  ok "Lefthook: cortex's post-push added to $f (merged into the repo's config, not replacing it)"
}

if [ -n "$HOOKS_OWNED_BY" ]; then
  # Even with --force: the repo's hooks are its own checks, not this installer's to redo.
  info "Lefthook: this repo's git hooks are its own ($HOOKS_OWNED_BY) — cortex adds no pre-commit/pre-push"
  if repo_lefthook_config >/dev/null; then
    write_lefthook_local
    # `lefthook install` refuses while core.hooksPath points elsewhere, and clearing a path
    # the repo set is not ours to do.
    if [ -n "$WROTE_LEFTHOOK_LOCAL" ] && [ -z "$(git -C "$PROJECT_DIR" config --get core.hooksPath 2>/dev/null || true)" ]; then
      if command -v lefthook >/dev/null 2>&1; then
        lefthook install >/dev/null 2>&1 && ok "Lefthook: git hooks installed" || warn "Lefthook: install failed"
      elif command -v npx >/dev/null 2>&1; then
        npx --yes lefthook install >/dev/null 2>&1 && ok "Lefthook: git hooks installed (via npx)" || warn "Lefthook: install skipped"
      fi
    fi
  else
    # Without the repo's own lefthook config there is nothing for lefthook-local.yml to merge
    # into: lefthook would make it the whole config, and `lefthook install` would take the
    # git hooks over from whatever runs them now.
    info "Lefthook: no lefthook config of the repo's own to merge into — cortex writes no git hooks"
  fi
  case "$(head -n 1 lefthook.yml 2>/dev/null)" in
    "$CORTEX_LEFTHOOK_HEADER"*)
      warn "Lefthook: lefthook.yml was generated by an earlier cortex install and still runs its own"
      warn "          pre-commit/pre-push next to the repo's checks. Remove it if nothing else uses it."
      ;;
  esac
elif [ ! -f "lefthook.yml" ] || [ "$FORCE" = "true" ]; then
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
    postpush_yaml
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
## Cortex Hub — MANDATORY (enforced by hooks)

A prompt usually arrives with a "Cortex session … is open" note: the hook already started the
session with the prompt as the task, and the note holds the recall (knowledge, memory) and the
first lookup (files, lines and the symbols they fall in). Read those lines next, with no separate
search first. Without the note, once you know the task: `cortex_session_start(repo: "__GIT_REPO__",
task: "<the task in a few words>")`, which answers the same. Until one of the two, Edit, Write and
file-modifying Bash are refused.

- A symbol name → `cortex_code_context(name)`. A behaviour → `cortex_code_search(query)`: scan the
  whole list, the target is not always first. An exact literal → `rg`; in the organization's other repos → `cortex_code_grep`.
- Read just the lines a hit names (Read with offset/limit), not the whole file.
- `cortex_code_impact` before changing something exported or shared.
- Something breaks → `cortex_knowledge_search` and `cortex_memory_search` with the error first;
  store a non-obvious fix with `cortex_knowledge_store`.
- Before committing: the verify commands from `.cortex/project-profile.json`, after the last edit
  (a later write closes the commit gate again), then `cortex_detect_changes(diff: "<git diff --staged>")`.
  After a push: `cortex_code_reindex(repo: "__GIT_REPO__", branch: "<branch>")`.
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
# Phase 5 wrote cortex's post-push into the developer's own lefthook-local file.
[ -n "$WROTE_LEFTHOOK_LOCAL" ] && GITIGNORE_ENTRIES+=("$WROTE_LEFTHOOK_LOCAL")

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
if [ -n "$HOOKS_OWNED_BY" ]; then
  echo "  Lefthook:  repo-owned hooks ($HOOKS_OWNED_BY) — cortex adds no pre-commit/pre-push"
else
  echo "  Lefthook:  $(lefthook_hook_live && echo "✓ pre-commit gate live" || { [ -f lefthook.yml ] && echo "⚠ lefthook.yml present but no git hook runs" || echo "⚠ not configured"; })"
fi
echo ""
[ "$MCP_CONFIGURED" != "true" ] && echo -e "  ${YELLOW}→ Set HUB_API_KEY and re-run /install to configure MCP${NC}"
echo -e "  ${CYAN}→ Restart IDE to pick up changes${NC}"
echo ""
