#!/usr/bin/env bash
# ============================================================
# Cortex Hub — Remote Agent Bootstrap
# Downloads cortex-agent.sh + dependencies, then launches.
# No repo clone needed.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.sh | bash
#   curl ... | bash -s -- launch
#   curl ... | bash -s -- start --daemon --preset fullstack
#   curl ... | bash -s -- start -d CORTEX_AGENT_IDE=codex CORTEX_AGENT_ID=rev-1
# ============================================================

set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/lktiep/cortex-hub/master"
WORK_DIR="${CORTEX_AGENT_HOME:-${TMPDIR:-/tmp}/cortex-agent-remote}"

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${BLUE}[cortex]${NC} $*"; }
ok()    { echo -e "${GREEN}[cortex]${NC} $*"; }
err()   { echo -e "${RED}[cortex]${NC} $*" >&2; }

# ── Check prerequisites ──
for cmd in curl node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "$cmd is required but not found."
    exit 1
  fi
done

# ── Setup workspace ──
mkdir -p "$WORK_DIR/scripts" "$WORK_DIR/.cortex" "$WORK_DIR/node_modules"
info "Workspace: $WORK_DIR"

# ── Download files (only if missing or older than 1 hour) ──
download_if_needed() {
  local url="$1" dest="$2"
  if [ -f "$dest" ]; then
    # Re-download if older than 1 hour
    local age=$(( $(date +%s) - $(stat -f%m "$dest" 2>/dev/null || stat -c%Y "$dest" 2>/dev/null || echo 0) ))
    if [ "$age" -lt 3600 ]; then
      return 0
    fi
  fi
  curl -fsSL "$url" -o "$dest" 2>/dev/null
}

info "Downloading agent scripts..."
download_if_needed "$REPO_RAW/scripts/cortex-agent.sh" "$WORK_DIR/scripts/cortex-agent.sh"
chmod +x "$WORK_DIR/scripts/cortex-agent.sh"

# Optional files (non-fatal if missing)
download_if_needed "$REPO_RAW/scripts/orchestrator-prompt.md" "$WORK_DIR/scripts/orchestrator-prompt.md" 2>/dev/null || true
download_if_needed "$REPO_RAW/.cortex/capability-templates.json" "$WORK_DIR/.cortex/capability-templates.json" 2>/dev/null || true
download_if_needed "$REPO_RAW/.cortex/agent-identity.json" "$WORK_DIR/.cortex/agent-identity.json" 2>/dev/null || true

# ── Install ws package if needed ──
if ! node -e "require('ws')" 2>/dev/null; then
  if ! node -e "require('$WORK_DIR/node_modules/ws')" 2>/dev/null; then
    info "Installing ws package..."
    (cd "$WORK_DIR" && npm install --no-save ws 2>/dev/null) || {
      err "Failed to install ws package. Run: npm install -g ws"
      exit 1
    }
    ok "ws package installed"
  fi
fi

# ── Add node_modules to NODE_PATH so ws is resolvable ──
export NODE_PATH="$WORK_DIR/node_modules:${NODE_PATH:-}"

ok "Ready. Launching cortex-agent..."
echo ""

# ── Forward all arguments to cortex-agent.sh ──
exec "$WORK_DIR/scripts/cortex-agent.sh" "$@"
