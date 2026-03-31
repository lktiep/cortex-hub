#!/usr/bin/env bash
# ============================================================
# cortex-agent.sh — Cortex Hub WebSocket Agent Client
# Connects to the Hub conductor via WebSocket, receives task
# assignments in real time, and spawns AI engine processes.
# ============================================================

set -euo pipefail

# ── Constants ────────────────────────────────────────────────
readonly SCRIPT_NAME="cortex-agent"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

readonly DEFAULT_HUB_URL="ws://localhost:4000/ws/conductor"
readonly IDENTITY_FILE="$PROJECT_ROOT/.cortex/agent-identity.json"
readonly CAPABILITY_TEMPLATES="$PROJECT_ROOT/.cortex/capability-templates.json"
readonly BASE_LOG_DIR="${CORTEX_AGENT_LOG_DIR:-/tmp/cortex-agent-logs}"
readonly MAX_LOG_SIZE=10485760  # 10 MB
readonly MAX_LOG_FILES=5
readonly RECONNECT_BASE_DELAY=2
readonly RECONNECT_MAX_DELAY=120

# ── IDE Presets ─────────────────────────────────────────────
# Maps IDE name → default engine. Works on bash 3+ (no associative arrays)
ide_engine() {
  case "$1" in
    claude-code) echo "claude" ;;
    vscode)      echo "claude" ;;
    codex)       echo "codex" ;;
    cursor)      echo "claude" ;;
    antigravity) echo "antigravity" ;;
    gemini)      echo "gemini" ;;
    *)           echo "claude" ;;
  esac
}

ide_description() {
  case "$1" in
    claude-code) echo "Claude Code CLI (terminal)" ;;
    vscode)      echo "VS Code with Claude extension" ;;
    codex)       echo "OpenAI Codex (headless)" ;;
    cursor)      echo "Cursor IDE" ;;
    antigravity) echo "Antigravity (own subscription)" ;;
    gemini)      echo "Gemini CLI (Google AI)" ;;
    *)           echo "Generic cortex agent" ;;
  esac
}

# ── Capability Resolution ──────────────────────────────────
# Resolve a preset name to its capabilities JSON array.
# Returns empty string if preset not found.
resolve_preset() {
  local preset_name="$1"
  if [ ! -f "$CAPABILITY_TEMPLATES" ]; then
    echo ""
    return
  fi
  node -e "
    const d = require('$CAPABILITY_TEMPLATES');
    const p = d.presets && d.presets['$preset_name'];
    if (p && p.capabilities) { console.log(JSON.stringify(p.capabilities)); }
    else { console.log(''); }
  " 2>/dev/null || echo ""
}

# Convert a comma-separated capability string to JSON array.
# e.g. "plan,backend,review" → '["plan","backend","review"]'
caps_to_json() {
  local caps_csv="$1"
  node -e "
    const caps = '$caps_csv'.split(',').map(c => c.trim()).filter(Boolean);
    console.log(JSON.stringify(caps));
  " 2>/dev/null || echo '[]'
}

# List all available presets from capability-templates.json
list_presets() {
  if [ ! -f "$CAPABILITY_TEMPLATES" ]; then
    echo -e "  ${YELLOW}No capability-templates.json found.${NC}"
    return
  fi
  node -e "
    const d = require('$CAPABILITY_TEMPLATES');
    const presets = d.presets || {};
    for (const [name, info] of Object.entries(presets)) {
      const caps = (info.capabilities || []).join(', ');
      const pad = name + '            ';
      console.log('  ' + pad.substring(0, 16) + '— ' + (info.description || '') + ' [' + caps + ']');
    }
  " 2>/dev/null || true
}

# Flags set by argument parsing (used by cmd_start before read_identity)
_PRESET_FLAG=""
_CAP_FLAG=""

# PID_FILE and LOG_FILE are set after reading identity (need AGENT_ID)
PID_FILE=""
LOG_DIR=""
LOG_FILE=""

setup_paths() {
  local safe_id
  safe_id=$(echo "$AGENT_ID" | tr ' /' '-' | tr '[:upper:]' '[:lower:]')
  LOG_DIR="$BASE_LOG_DIR/$safe_id"
  LOG_FILE="$LOG_DIR/agent.log"
  PID_FILE="${CORTEX_AGENT_PID_FILE:-$BASE_LOG_DIR/${safe_id}.pid}"
}

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Logging ──────────────────────────────────────────────────
# CORTEX_AGENT_DAEMON=1 suppresses console echo (avoids duplicate lines in log file)
log() {
  local level="$1"; shift
  local timestamp
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  local msg="[$timestamp] [$level] $*"
  if [ -n "$LOG_FILE" ]; then
    echo "$msg" >> "$LOG_FILE" 2>/dev/null || true
  fi
  # Only echo to console if NOT running as daemon subprocess
  if [ "${CORTEX_AGENT_DAEMON:-0}" != "1" ]; then
    case "$level" in
      ERROR) echo -e "${RED}$msg${NC}" ;;
      WARN)  echo -e "${YELLOW}$msg${NC}" ;;
      INFO)  echo -e "${GREEN}$msg${NC}" ;;
      DEBUG) [ "${CORTEX_AGENT_DEBUG:-0}" = "1" ] && echo -e "${CYAN}$msg${NC}" ;;
    esac
  fi
}

log_info()  { log INFO "$@"; }
log_warn()  { log WARN "$@"; }
log_error() { log ERROR "$@"; }
log_debug() { log DEBUG "$@"; }

# ── Helpers ──────────────────────────────────────────────────
ensure_log_dir() {
  if [ -n "$LOG_DIR" ]; then
    mkdir -p "$LOG_DIR"
  else
    mkdir -p "$BASE_LOG_DIR"
  fi
}

rotate_logs() {
  if [ -f "$LOG_FILE" ]; then
    local size
    size=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$size" -gt "$MAX_LOG_SIZE" ]; then
      local i=$MAX_LOG_FILES
      while [ "$i" -gt 1 ]; do
        local prev=$((i - 1))
        [ -f "$LOG_FILE.$prev" ] && mv "$LOG_FILE.$prev" "$LOG_FILE.$i"
        i=$prev
      done
      mv "$LOG_FILE" "$LOG_FILE.1"
      log_info "Log rotated (exceeded ${MAX_LOG_SIZE} bytes)"
    fi
  fi
}

check_dependencies() {
  local missing=()
  if ! command -v node >/dev/null 2>&1; then
    missing+=("node")
  fi
  # We need the ws package -- check via node
  if ! node -e "require('ws')" 2>/dev/null; then
    # Try from project node_modules
    if ! node -e "require('$PROJECT_ROOT/node_modules/ws')" 2>/dev/null; then
      missing+=("ws (npm package)")
    fi
  fi
  if ! command -v jq >/dev/null 2>&1; then
    # jq is nice-to-have; we can use node for JSON parsing
    log_debug "jq not found; using node for JSON parsing"
  fi
  if [ ${#missing[@]} -gt 0 ]; then
    log_error "Missing dependencies: ${missing[*]}"
    log_error "Install with: npm install -g ws  (or run pnpm install in project root)"
    exit 1
  fi
}

read_identity() {
  if [ -f "$IDENTITY_FILE" ]; then
    # agent-identity.json uses: agent_name, environment.hostname, environment.os, role, capabilities, tags
    AGENT_ID=$(node -e "
      const d=require('$IDENTITY_FILE');
      console.log(d.agentId || d.agent_name || d.id || 'unknown')
    " 2>/dev/null || echo "cortex-agent")
    AGENT_HOSTNAME=$(node -e "
      const d=require('$IDENTITY_FILE');
      console.log((d.environment && d.environment.hostname) || d.hostname || '')
    " 2>/dev/null || hostname)
    AGENT_OS=$(node -e "
      const d=require('$IDENTITY_FILE');
      console.log((d.environment && d.environment.os) || d.os || '')
    " 2>/dev/null || uname -s)
    AGENT_IDE=$(node -e "
      const d=require('$IDENTITY_FILE');
      console.log(d.ide || 'cortex-agent')
    " 2>/dev/null || echo "cortex-agent")
    AGENT_ROLE=$(node -e "
      const d=require('$IDENTITY_FILE');
      console.log(d.role || 'worker')
    " 2>/dev/null || echo "worker")
    AGENT_CAPABILITIES=$(node -e "
      const d=require('$IDENTITY_FILE');
      const caps = d.capabilities || (d.environment && d.environment.tools) || ['claude'];
      console.log(JSON.stringify(caps))
    " 2>/dev/null || echo '["claude"]')
    log_info "Loaded identity from $IDENTITY_FILE (agentId=$AGENT_ID)"
  else
    AGENT_ID="${CORTEX_AGENT_ID:-cortex-agent-$(hostname -s 2>/dev/null || hostname)}"
    AGENT_HOSTNAME="$(hostname)"
    AGENT_OS="$(uname -s)"
    AGENT_IDE="cortex-agent"
    AGENT_ROLE="worker"
    AGENT_CAPABILITIES='["claude"]'
    log_warn "No identity file at $IDENTITY_FILE; using defaults (agentId=$AGENT_ID)"
  fi

  # Allow env var overrides (highest priority)
  AGENT_ID="${CORTEX_AGENT_ID:-$AGENT_ID}"
  AGENT_IDE="${CORTEX_AGENT_IDE:-$AGENT_IDE}"

  # Apply --preset or --cap overrides (set before read_identity is called)
  if [ -n "$_PRESET_FLAG" ]; then
    local preset_caps
    preset_caps=$(resolve_preset "$_PRESET_FLAG")
    if [ -n "$preset_caps" ]; then
      AGENT_CAPABILITIES="$preset_caps"
      log_info "Capabilities set from preset '$_PRESET_FLAG': $preset_caps"
    else
      log_error "Unknown preset: $_PRESET_FLAG"
      echo -e "${RED}Unknown preset: $_PRESET_FLAG${NC}"
      echo -e "Available presets:"
      list_presets
      exit 1
    fi
  elif [ -n "$_CAP_FLAG" ]; then
    AGENT_CAPABILITIES=$(caps_to_json "$_CAP_FLAG")
    log_info "Capabilities set from --cap flag: $AGENT_CAPABILITIES"
  fi

  # Resolve engine from IDE preset
  AGENT_ENGINE="$(ide_engine "$AGENT_IDE")"

  # Setup per-agent paths
  setup_paths

  # Auto-detect Hub config from IDE settings
  detect_hub_config
}

# ── Auto-Detect Hub Config from IDE Settings ────────────────
# Reads HUB_API_KEY and Hub URL from IDE MCP configurations
# created during onboarding (onboard.sh). Checks configs in
# order: Claude Code, Cursor, Windsurf, Antigravity.
detect_hub_config() {
  # Skip if both are already explicitly set via env vars
  if [ -n "${CORTEX_HUB_WS_URL:-}" ] && [ -n "${CORTEX_HUB_API_KEY:-}" ]; then
    log_debug "Hub config: using explicit env vars"
    return 0
  fi

  # IDE config file locations (order of priority)
  local config_files=""
  config_files="$HOME/.claude.json"
  config_files="$config_files $HOME/.cursor/mcp.json"
  config_files="$config_files $HOME/.codeium/windsurf/mcp_config.json"
  config_files="$config_files $HOME/.gemini/antigravity/mcp_config.json"

  local detected_api_key=""
  local detected_mcp_url=""
  local detected_from=""

  for config_file in $config_files; do
    [ -f "$config_file" ] || continue

    # Extract API key and MCP URL from the config using node
    local result
    result=$(node -e "
      try {
        const fs = require('fs');
        const data = JSON.parse(fs.readFileSync('$config_file', 'utf8'));
        const srv = data.mcpServers && data.mcpServers['cortex-hub'];
        if (!srv) { process.exit(0); }
        const apiKey = (srv.env && srv.env.HUB_API_KEY) || '';
        const mcpUrl = (srv.args && srv.args[2]) || '';
        console.log(apiKey + '|||' + mcpUrl);
      } catch(e) { /* ignore parse errors */ }
    " 2>/dev/null || echo "")

    if [ -n "$result" ] && [ "$result" != "|||" ]; then
      detected_api_key="${result%%|||*}"
      detected_mcp_url="${result##*|||}"
      detected_from="$config_file"
      if [ -n "$detected_api_key" ]; then
        break
      fi
    fi
  done

  # Set API key if not already set
  if [ -z "${CORTEX_HUB_API_KEY:-}" ] && [ -n "$detected_api_key" ]; then
    CORTEX_HUB_API_KEY="$detected_api_key"
    log_info "Auto-detected API key from $detected_from"
  fi

  # Derive Hub WS URL from MCP URL if not already set
  # WS proxy lives on the MCP server (same domain, /ws/conductor path)
  # e.g. https://cortex-mcp.jackle.dev/mcp → wss://cortex-mcp.jackle.dev/ws/conductor
  if [ -z "${CORTEX_HUB_WS_URL:-}" ] && [ -n "$detected_mcp_url" ]; then
    local hub_ws_url
    hub_ws_url=$(node -e "
      try {
        const u = new URL('$detected_mcp_url');
        const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
        const port = u.port ? ':' + u.port : '';
        console.log(proto + '//' + u.hostname + port + '/ws/conductor');
      } catch(e) { console.log(''); }
    " 2>/dev/null || echo "")

    if [ -n "$hub_ws_url" ]; then
      CORTEX_HUB_WS_URL="$hub_ws_url"
      log_info "Auto-detected Hub URL: $hub_ws_url (from MCP endpoint)"
    fi
  fi

  # If URL still not set, check project-profile.json for hub_url field
  if [ -z "${CORTEX_HUB_WS_URL:-}" ]; then
    local profile_file="$PROJECT_ROOT/.cortex/project-profile.json"
    if [ -f "$profile_file" ]; then
      local hub_url_from_profile
      hub_url_from_profile=$(node -e "
        try {
          const d = require('$profile_file');
          if (d.hub_url) {
            const u = new URL(d.hub_url);
            const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
            const port = u.port ? ':' + u.port : '';
            console.log(proto + '//' + u.hostname + port + '/ws/conductor');
          }
        } catch(e) {}
      " 2>/dev/null || echo "")
      if [ -n "$hub_url_from_profile" ]; then
        CORTEX_HUB_WS_URL="$hub_url_from_profile"
        log_info "Hub URL from project-profile.json: $hub_url_from_profile"
      fi
    fi
  fi
}

# ── PID Management ───────────────────────────────────────────
write_pid() {
  echo $$ > "$PID_FILE"
  log_debug "PID $$ written to $PID_FILE"
}

read_pid() {
  if [ -f "$PID_FILE" ]; then
    cat "$PID_FILE"
  else
    echo ""
  fi
}

is_running() {
  local pid
  pid=$(read_pid)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  return 1
}

cleanup_pid() {
  rm -f "$PID_FILE"
}

# ── Orchestrator Prompt Builder ──────────────────────────────
build_orchestrator_prompt() {
  local template_file="$SCRIPT_DIR/orchestrator-prompt.md"
  if [ ! -f "$template_file" ]; then
    log_warn "Orchestrator template not found at $template_file"
    return 1
  fi

  local template
  template=$(cat "$template_file")

  local agents_list=""
  local hub_api_url=""
  local ws_url="${CORTEX_HUB_WS_URL:-$DEFAULT_HUB_URL}"
  hub_api_url=$(node -e "
    try {
      const u = new URL('${ws_url}');
      const proto = u.protocol === 'wss:' ? 'https:' : 'http:';
      const port = u.port ? ':' + u.port : '';
      console.log(proto + '//' + u.hostname + port + '/api/conductor/agents');
    } catch(e) { console.log(''); }
  " 2>/dev/null || echo "")

  if [ -n "$hub_api_url" ]; then
    local api_key="${CORTEX_HUB_API_KEY:-}"
    local curl_auth=""
    if [ -n "$api_key" ]; then
      curl_auth="-H \"Authorization: Bearer ${api_key}\""
    fi
    local agents_json
    agents_json=$(eval curl -s --max-time 5 "$curl_auth" "\"$hub_api_url\"" 2>/dev/null || echo "")
    if [ -n "$agents_json" ]; then
      agents_list=$(node -e "
        try {
          const data = JSON.parse(process.argv[1]);
          const agents = data.agents || [];
          if (agents.length === 0) { console.log('No agents currently online.'); }
          else {
            agents.forEach(a => {
              const caps = (a.capabilities || []).join(', ') || 'none';
              const status = a.status || 'unknown';
              console.log('- **' + (a.agentId || a.id) + '** (' + status + ')');
              console.log('  - Capabilities: ' + caps);
              console.log('  - Platform: ' + (a.platform || a.os || 'unknown'));
              console.log('  - IDE: ' + (a.ide || 'unknown'));
            });
          }
        } catch(e) { console.log('Unable to parse agent data.'); }
      " "$agents_json" 2>/dev/null || echo "Unable to fetch agent list.")
    else
      agents_list="Unable to reach Hub API."
    fi
  else
    agents_list="Hub API URL could not be determined."
  fi

  local result
  result=$(node -e "
    const tpl = Buffer.from(process.argv[1], 'base64').toString('utf8');
    const agents = Buffer.from(process.argv[2], 'base64').toString('utf8');
    console.log(tpl.replace('{{AGENTS_LIST}}', agents));
  " "$(printf '%s' "$template" | base64)" "$(printf '%s' "$agents_list" | base64)" 2>/dev/null)

  if [ -n "$result" ]; then
    printf '%s' "$result"
  else
    printf '%s' "$template"
  fi
}

# ── Task Execution Engines ───────────────────────────────────
execute_task_claude() {
  local task_id="$1"
  local prompt="$2"
  local working_dir="${3:-$PROJECT_ROOT}"

  # Inject orchestrator prompt if agent has "orchestrate" capability
  if echo "$AGENT_CAPABILITIES" | grep -q '"orchestrate"'; then
    log_info "Injecting orchestrator prompt for task $task_id"
    local orch_prompt
    orch_prompt=$(build_orchestrator_prompt)
    if [ -n "$orch_prompt" ]; then
      prompt="$(printf '%s\n\n---\n\n## Task:\n%s' "$orch_prompt" "$prompt")"
    fi
  fi

  log_info "Spawning Claude for task $task_id"
  local output_file="$LOG_DIR/task-${task_id}.log"

  if command -v claude >/dev/null 2>&1; then
    (
      cd "$working_dir"
      claude -p "$prompt" --permission-mode auto 2>&1 | tee "$output_file"
    )
    local exit_code=$?
    log_info "Claude finished task $task_id (exit=$exit_code)"
    return $exit_code
  else
    log_error "Claude CLI not found. Install: https://docs.anthropic.com/claude-code"
    return 1
  fi
}

execute_task_codex() {
  local task_id="$1"
  local prompt="$2"
  local working_dir="${3:-$PROJECT_ROOT}"

  log_info "Spawning Codex for task $task_id"
  local output_file="$LOG_DIR/task-${task_id}.log"

  if command -v codex >/dev/null 2>&1; then
    (
      cd "$working_dir"
      codex exec "$prompt" 2>&1 | tee "$output_file"
    )
    local exit_code=$?
    log_info "Codex finished task $task_id (exit=$exit_code)"
    return $exit_code
  else
    log_error "Codex CLI not found"
    return 1
  fi
}

execute_task_antigravity() {
  local task_id="$1"
  local prompt="$2"
  local working_dir="${3:-$PROJECT_ROOT}"

  log_info "Spawning Antigravity for task $task_id (separate subscription from Gemini CLI)"
  local output_file="$LOG_DIR/task-${task_id}.log"

  if ! command -v antigravity >/dev/null 2>&1; then
    log_error "Antigravity CLI not found. Install Antigravity from: https://antigravity.dev"
    log_error "Note: Antigravity has its own subscription. Do NOT use gemini CLI as substitute."
    return 1
  fi

  (
    cd "$working_dir"
    antigravity -p "$prompt" --yolo 2>&1 | tee "$output_file"
  )
  local exit_code=$?
  log_info "Antigravity finished task $task_id (exit=$exit_code)"
  return $exit_code
}

execute_task_gemini() {
  local task_id="$1"
  local prompt="$2"
  local working_dir="${3:-$PROJECT_ROOT}"

  log_info "Spawning Gemini CLI for task $task_id"
  local output_file="$LOG_DIR/task-${task_id}.log"

  if ! command -v gemini >/dev/null 2>&1; then
    log_error "Gemini CLI not found. Install: npm i -g @anthropic-ai/gemini-cli"
    return 1
  fi

  (
    cd "$working_dir"
    gemini -p "$prompt" --yolo 2>&1 | tee "$output_file"
  )
  local exit_code=$?
  log_info "Gemini finished task $task_id (exit=$exit_code)"
  return $exit_code
}

execute_task() {
  local task_id="$1"
  local engine="$2"
  local prompt="$3"
  local working_dir="${4:-$PROJECT_ROOT}"

  case "$engine" in
    claude)        execute_task_claude "$task_id" "$prompt" "$working_dir" ;;
    codex)         execute_task_codex "$task_id" "$prompt" "$working_dir" ;;
    antigravity)   execute_task_antigravity "$task_id" "$prompt" "$working_dir" ;;
    gemini)        execute_task_gemini "$task_id" "$prompt" "$working_dir" ;;
    *)
      log_error "Unknown engine: $engine (falling back to claude)"
      execute_task_claude "$task_id" "$prompt" "$working_dir"
      ;;
  esac
}

# ── WebSocket Client (Node.js) ──────────────────────────────
# We use an inline Node.js script with the ws package for
# reliable WebSocket communication. The script communicates
# with this bash process via stdout line protocol.
generate_ws_client_script() {
  local hub_url="$1"
  cat << 'NODESCRIPT'
const WebSocket = require('ws');
const path = require('path');

const HUB_URL = process.env.CORTEX_HUB_WS_URL;
const API_KEY = process.env.CORTEX_HUB_API_KEY || '';
const AGENT_ID = process.env.CORTEX_AGENT_ID;
const AGENT_HOSTNAME = process.env.CORTEX_AGENT_HOSTNAME;
const AGENT_OS = process.env.CORTEX_AGENT_OS;
const AGENT_IDE = process.env.CORTEX_AGENT_IDE;
const AGENT_ROLE = process.env.CORTEX_AGENT_ROLE;
const AGENT_CAPABILITIES = JSON.parse(process.env.CORTEX_AGENT_CAPABILITIES || '["claude"]');

let ws = null;
let reconnectAttempt = 0;
const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 120000;
let reconnectTimer = null;
let pingInterval = null;

// Handle EPIPE gracefully (bash closed the pipe)
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
});
process.on('SIGPIPE', () => process.exit(0));

function emit(type, data) {
  const line = JSON.stringify({ type, ...data });
  try { process.stdout.write(line + '\n'); } catch (_) {}
}

function connect() {
  if (ws) {
    try { ws.terminate(); } catch (_) {}
  }

  // Build connection URL with apiKey query param
  const sep = HUB_URL.includes('?') ? '&' : '?';
  const connectUrl = API_KEY ? `${HUB_URL}${sep}apiKey=${API_KEY}` : HUB_URL;
  // Also send Authorization header for proxies that check headers
  const wsOptions = API_KEY ? { headers: { 'Authorization': `Bearer ${API_KEY}` } } : {};

  // Log URL without API key for security
  emit('status', { message: `Connecting to ${HUB_URL}...` });
  ws = new WebSocket(connectUrl, wsOptions);

  ws.on('open', () => {
    reconnectAttempt = 0;
    emit('status', { message: 'Connected to Hub conductor' });

    // Register agent identity
    const registration = {
      type: 'agent.register',
      agentId: AGENT_ID,
      hostname: AGENT_HOSTNAME,
      os: AGENT_OS,
      ide: AGENT_IDE,
      role: AGENT_ROLE,
      capabilities: AGENT_CAPABILITIES,
      timestamp: new Date().toISOString()
    };
    ws.send(JSON.stringify(registration));
    emit('registered', { agentId: AGENT_ID });

    // Start ping/keepalive every 30s
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      emit('message', { payload: msg });
    } catch (e) {
      emit('error', { message: `Invalid message: ${raw.toString().substring(0, 200)}` });
    }
  });

  ws.on('close', (code, reason) => {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    emit('disconnected', { code, reason: reason.toString() });
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    emit('error', { message: err.message });
    // on('close') will fire after this, triggering reconnect
  });

  ws.on('pong', () => {
    emit('pong', { timestamp: new Date().toISOString() });
  });
}

function scheduleReconnect() {
  reconnectAttempt++;
  const delay = Math.min(RECONNECT_BASE * Math.pow(2, reconnectAttempt - 1), RECONNECT_MAX);
  const jitter = Math.floor(Math.random() * 1000);
  emit('status', { message: `Reconnecting in ${Math.round((delay + jitter) / 1000)}s (attempt ${reconnectAttempt})...` });
  reconnectTimer = setTimeout(connect, delay + jitter);
}

function sendMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

// Listen for commands from bash parent via stdin
process.stdin.setEncoding('utf8');
let stdinBuffer = '';
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let lines = stdinBuffer.split('\n');
  stdinBuffer = lines.pop(); // keep incomplete line in buffer
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const cmd = JSON.parse(line);
      if (cmd.type === 'quit') {
        if (pingInterval) clearInterval(pingInterval);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (ws) ws.close(1000, 'Agent shutting down');
        process.exit(0);
      } else {
        // Forward any other message directly to WebSocket
        sendMessage(cmd);
      }
    } catch (e) {
      emit('error', { message: `Invalid stdin command: ${e.message}` });
    }
  }
});

// Handle termination signals gracefully
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Start connection
connect();
NODESCRIPT
}

# ── Main Agent Loop ──────────────────────────────────────────
run_agent() {
  local hub_url="${CORTEX_HUB_WS_URL:-$DEFAULT_HUB_URL}"
  local api_key="${CORTEX_HUB_API_KEY:-}"
  local node_resolve_paths="$PROJECT_ROOT/node_modules"

  # Append apiKey and agentId as query parameters
  local qs=""
  if [ -n "$api_key" ]; then
    qs="apiKey=${api_key}"
  fi
  if [ -n "$AGENT_ID" ]; then
    qs="${qs:+${qs}&}agentId=${AGENT_ID}"
  fi
  if [ -n "$AGENT_HOSTNAME" ]; then
    qs="${qs:+${qs}&}hostname=${AGENT_HOSTNAME}"
  fi
  if [ -n "$AGENT_IDE" ]; then
    qs="${qs:+${qs}&}ide=${AGENT_IDE}"
  fi
  if [ -n "$AGENT_CAPABILITIES" ] && [ "$AGENT_CAPABILITIES" != "[]" ]; then
    local encoded_caps
    encoded_caps=$(node -e "console.log(encodeURIComponent('$AGENT_CAPABILITIES'))" 2>/dev/null || echo "")
    if [ -n "$encoded_caps" ]; then
      qs="${qs:+${qs}&}capabilities=${encoded_caps}"
    fi
  fi
  if [ -n "$qs" ]; then
    case "$hub_url" in
      *\?*) hub_url="${hub_url}&${qs}" ;;
      *)    hub_url="${hub_url}?${qs}" ;;
    esac
  fi

  log_info "Starting $SCRIPT_NAME"
  log_info "Hub URL: ${hub_url%%\?*}"  # Log URL without query params (hide API key)
  if [ -n "$api_key" ]; then
    log_info "API Key: configured (auto-detected)"
  else
    log_info "API Key: not set"
  fi
  log_info "Agent ID: $AGENT_ID"
  log_info "Capabilities: $AGENT_CAPABILITIES"

  write_pid

  # Write the Node.js WS client script to a temp file
  local ws_script_file="/tmp/cortex-agent-ws-$$.js"
  generate_ws_client_script "$hub_url" > "$ws_script_file"

  # Named pipes for bidirectional communication
  local pipe_in="/tmp/cortex-agent-in-$$"
  local pipe_out="/tmp/cortex-agent-out-$$"
  rm -f "$pipe_in" "$pipe_out"
  mkfifo "$pipe_in"
  mkfifo "$pipe_out"

  export CORTEX_HUB_WS_URL="$hub_url"
  export CORTEX_HUB_API_KEY="${CORTEX_HUB_API_KEY:-}"
  export CORTEX_AGENT_ID="$AGENT_ID"
  export CORTEX_AGENT_HOSTNAME="$AGENT_HOSTNAME"
  export CORTEX_AGENT_OS="$AGENT_OS"
  export CORTEX_AGENT_IDE="$AGENT_IDE"
  export CORTEX_AGENT_ROLE="$AGENT_ROLE"
  export CORTEX_AGENT_CAPABILITIES="$AGENT_CAPABILITIES"
  export NODE_PATH="$node_resolve_paths"

  # Start the Node.js WebSocket client: reads from pipe_in, writes to pipe_out
  NODE_PATH="$node_resolve_paths" node "$ws_script_file" < "$pipe_in" > "$pipe_out" 2>>"$LOG_FILE" &
  local ws_pid=$!

  log_debug "WebSocket client started (pid=$ws_pid)"

  # Keep the write end of pipe_in open so node does not see EOF
  exec 7>"$pipe_in"

  # Cleanup on exit
  trap 'log_info "Shutting down..."; echo "{\"type\":\"quit\"}" >&7 2>/dev/null; exec 7>&-; exec 8<&- 2>/dev/null; wait "$ws_pid" 2>/dev/null; cleanup_pid; rm -f "$pipe_in" "$pipe_out" "$ws_script_file"; exit 0' INT TERM

  # Helper: send a command to the Node.js process
  ws_send() {
    echo "$1" >&7
  }

  # Helper: parse a JSON field using node (small inline call)
  json_get() {
    local json="$1"
    local expr="$2"
    echo "$json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);console.log($expr)}catch{console.log('')}})" 2>/dev/null || echo ""
  }

  # Keep the read end of pipe_out open on fd 8
  exec 8<"$pipe_out"

  # Read messages from WebSocket client and handle them
  while IFS= read -r line <&8; do
    [ -z "$line" ] && continue
    log_debug "WS recv: $line"

    local msg_type
    msg_type=$(json_get "$line" "o.type||'unknown'")

    case "$msg_type" in
      status|registered|pong)
        local status_msg
        status_msg=$(json_get "$line" "o.message||o.agentId||''")
        log_info "$msg_type: $status_msg"
        ;;

      disconnected)
        log_warn "Disconnected from Hub (will auto-reconnect)"
        ;;

      error)
        local err_msg
        err_msg=$(json_get "$line" "o.message||''")
        log_error "WS error: $err_msg"
        ;;

      message)
        # Extract the payload from the message envelope
        local payload
        payload=$(json_get "$line" "JSON.stringify(o.payload)||'{}'")

        local payload_type
        payload_type=$(json_get "$payload" "o.type||''")

        log_debug "Payload type: $payload_type"

        case "$payload_type" in
          task.assigned)
            local task_id engine prompt working_dir
            task_id=$(json_get "$payload" "o.taskId||(o.task&&o.task.id)||''")
            # Use task-specified engine if provided, otherwise use agent's configured engine
            engine=$(json_get "$payload" "o.engine||(o.task&&o.task.engine)||''")
            [ -z "$engine" ] && engine="$AGENT_ENGINE"
            prompt=$(json_get "$payload" "o.prompt||o.description||(o.task&&(o.task.prompt||o.task.description))||o.title||''")
            working_dir=$(json_get "$payload" "o.workingDir||(o.task&&o.task.workingDir)||''")
            [ -z "$working_dir" ] && working_dir="$PROJECT_ROOT"

            if [ -z "$task_id" ] || [ -z "$prompt" ]; then
              log_error "Invalid task.assigned: missing taskId or prompt"
              continue
            fi

            log_info "Task assigned: $task_id (engine=$engine)"

            # Report task accepted
            ws_send "{\"type\":\"task.accept\",\"taskId\":\"$task_id\",\"agentId\":\"$AGENT_ID\",\"timestamp\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"}"

            # Execute task in background subshell with live output streaming
            (
              task_log_file="$LOG_DIR/task-${task_id}.log"

              # Start output streamer: tails log file and sends progress via WS every 2s
              (
                sleep 1  # wait for log file to be created
                local last_size=0
                while true; do
                  if [ -f "$task_log_file" ]; then
                    local cur_size
                    cur_size=$(wc -c < "$task_log_file" 2>/dev/null || echo 0)
                    if [ "$cur_size" -gt "$last_size" ]; then
                      local chunk
                      chunk=$(tail -c $((cur_size - last_size)) "$task_log_file" 2>/dev/null | tail -c 2000 | tr '\n' '\012' | sed 's/"/\\"/g' | tr '\012' '\n')
                      if [ -n "$chunk" ]; then
                        echo "{\"type\":\"task.progress\",\"taskId\":\"$task_id\",\"agentId\":\"$AGENT_ID\",\"message\":\"$chunk\",\"timestamp\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"}" >&7 2>/dev/null || true
                      fi
                      last_size=$cur_size
                    fi
                  fi
                  sleep 2
                done
              ) &
              local streamer_pid=$!

              exit_code=0
              execute_task "$task_id" "$engine" "$prompt" "$working_dir" && exit_code=0 || exit_code=$?

              # Stop streamer
              kill "$streamer_pid" 2>/dev/null || true

              # Send final result
              result=""
              if [ -f "$task_log_file" ]; then
                result=$(tail -c 1000 "$task_log_file" | tr '\n' ' ' | sed 's/"/\\"/g')
              fi

              status="completed"
              [ "$exit_code" -ne 0 ] && status="failed"

              echo "{\"type\":\"task.complete\",\"taskId\":\"$task_id\",\"result\":\"$result\",\"timestamp\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"}" >&7

              log_info "Task $task_id $status (exit=$exit_code)"
            ) &
            ;;

          agent.registered)
            log_info "Server confirmed registration"
            ;;

          heartbeat|ping)
            # Respond to server heartbeats
            ws_send "{\"type\":\"pong\",\"agentId\":\"$AGENT_ID\",\"timestamp\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"}"
            ;;

          *)
            log_debug "Unhandled message type: $payload_type"
            ;;
        esac
        ;;

      *)
        log_debug "Unknown event type: $msg_type"
        ;;
    esac
  done

  # If we get here, the WS client has exited
  log_warn "WebSocket client process exited"
  exec 7>&- 2>/dev/null
  exec 8<&- 2>/dev/null
  wait "$ws_pid" 2>/dev/null
  cleanup_pid
  rm -f "$pipe_in" "$pipe_out" "$ws_script_file"
}

# ── Commands ─────────────────────────────────────────────────
cmd_start() {
  # Parse flags from arguments (order-independent)
  local daemon_flag=""
  _PRESET_FLAG=""
  _CAP_FLAG=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --daemon|-d)
        daemon_flag="1"
        shift
        ;;
      --preset)
        shift
        _PRESET_FLAG="${1:-}"
        if [ -z "$_PRESET_FLAG" ]; then
          echo -e "${RED}--preset requires a value (e.g. --preset fullstack)${NC}"
          exit 1
        fi
        shift
        ;;
      --cap)
        shift
        _CAP_FLAG="${1:-}"
        if [ -z "$_CAP_FLAG" ]; then
          echo -e "${RED}--cap requires a value (e.g. --cap plan,backend,review)${NC}"
          exit 1
        fi
        shift
        ;;
      *)
        echo -e "${YELLOW}Unknown flag: $1${NC}"
        shift
        ;;
    esac
  done

  # Validate: --preset and --cap are mutually exclusive
  if [ -n "$_PRESET_FLAG" ] && [ -n "$_CAP_FLAG" ]; then
    echo -e "${RED}Cannot use both --preset and --cap. Pick one.${NC}"
    exit 1
  fi

  read_identity
  ensure_log_dir
  rotate_logs
  check_dependencies

  if is_running; then
    local pid
    pid=$(read_pid)
    log_warn "Agent is already running (pid=$pid)"
    echo -e "${YELLOW}Agent is already running (pid=$pid). Use 'stop' first.${NC}"
    exit 1
  fi

  if [ "$daemon_flag" = "1" ]; then
    log_info "Starting agent in daemon mode..."
    # Pass identity env vars + capabilities to the daemon subprocess
    CORTEX_AGENT_ID="$AGENT_ID" CORTEX_AGENT_IDE="$AGENT_IDE" \
      CORTEX_AGENT_CAPABILITIES_OVERRIDE="$AGENT_CAPABILITIES" \
      CORTEX_AGENT_DAEMON=1 \
      nohup "$0" _run >> "$LOG_FILE" 2>&1 &
    local bg_pid=$!
    echo "$bg_pid" > "$PID_FILE"
    local ide_desc="$(ide_description "$AGENT_IDE")"
    local display_hub_url="${CORTEX_HUB_WS_URL:-$DEFAULT_HUB_URL}"
    local display_api_key="${CORTEX_HUB_API_KEY:+auto-detected}"
    display_api_key="${display_api_key:-not set (set CORTEX_HUB_API_KEY or configure MCP in your IDE)}"
    echo ""
    echo -e "${GREEN}Agent started in background (pid=$bg_pid)${NC}"
    local display_preset="${_PRESET_FLAG:-none}"
    echo -e "  Agent ID:      ${BLUE}$AGENT_ID${NC}"
    echo -e "  IDE:           ${BLUE}$AGENT_IDE${NC} ($ide_desc)"
    echo -e "  Engine:        ${BLUE}$AGENT_ENGINE${NC}"
    echo -e "  Preset:        ${BLUE}$display_preset${NC}"
    echo -e "  Capabilities:  ${BLUE}$AGENT_CAPABILITIES${NC}"
    echo -e "  Hub URL:       ${BLUE}$display_hub_url${NC}"
    echo -e "  API Key:       ${BLUE}$display_api_key${NC}"
    echo -e "  PID file:      ${BLUE}$PID_FILE${NC}"
    echo -e "  Log file:      ${BLUE}$LOG_FILE${NC}"
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo -e "  1. Check logs:      ${GREEN}tail -f $LOG_FILE${NC}"
    echo -e "  2. Check status:    ${GREEN}CORTEX_AGENT_ID=$AGENT_ID $0 status${NC}"
    echo -e "  3. Create a task:   Dashboard → Conductor → + New Task (assign to '${AGENT_ID}')"
    echo -e "                      or: cortex_task_create(title: '...', assignTo: '${AGENT_ID}')"
    echo -e "  4. Agent auto-picks up matching tasks → executes via ${AGENT_ENGINE}"
    echo -e "  5. Stop this agent: ${GREEN}CORTEX_AGENT_ID=$AGENT_ID $0 stop${NC}"
    echo ""
  else
    run_agent
  fi
}

cmd_stop() {
  if ! is_running; then
    echo -e "${YELLOW}Agent is not running.${NC}"
    exit 0
  fi

  local pid
  pid=$(read_pid)
  log_info "Stopping agent (pid=$pid)..."
  kill "$pid" 2>/dev/null || true

  # Wait up to 10 seconds for graceful shutdown
  local count=0
  while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
    sleep 1
    count=$((count + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    log_warn "Force-killing agent (pid=$pid)..."
    kill -9 "$pid" 2>/dev/null || true
  fi

  cleanup_pid
  echo -e "${GREEN}Agent stopped.${NC}"
}

cmd_status() {
  read_identity
  local ide_desc="$(ide_description "$AGENT_IDE")"
  if is_running; then
    local pid
    pid=$(read_pid)
    local display_api_key="${CORTEX_HUB_API_KEY:+configured}"
    display_api_key="${display_api_key:-not set}"
    echo -e "${GREEN}Agent is running (pid=$pid)${NC}"
    echo -e "  Agent ID:      ${BLUE}$AGENT_ID${NC}"
    echo -e "  IDE:           ${BLUE}$AGENT_IDE${NC} ($ide_desc)"
    echo -e "  Engine:        ${BLUE}$AGENT_ENGINE${NC}"
    echo -e "  Hostname:      ${BLUE}$AGENT_HOSTNAME${NC}"
    echo -e "  OS:            ${BLUE}$AGENT_OS${NC}"
    echo -e "  Role:          ${BLUE}$AGENT_ROLE${NC}"
    echo -e "  Capabilities:  ${BLUE}$AGENT_CAPABILITIES${NC}"
    echo -e "  Hub URL:       ${BLUE}${CORTEX_HUB_WS_URL:-$DEFAULT_HUB_URL}${NC}"
    echo -e "  API Key:       ${BLUE}$display_api_key${NC}"
    echo -e "  PID file:      ${BLUE}$PID_FILE${NC}"
    echo -e "  Log file:      ${BLUE}$LOG_FILE${NC}"
    if [ -f "$LOG_FILE" ]; then
      echo ""
      echo -e "${CYAN}Last 5 log lines:${NC}"
      tail -5 "$LOG_FILE" 2>/dev/null || true
    fi
    exit 0
  else
    echo -e "${YELLOW}Agent '$AGENT_ID' is not running.${NC}"
    echo -e "Start with: ${GREEN}CORTEX_AGENT_ID=$AGENT_ID $0 start --daemon${NC}"
    exit 1
  fi
}

cmd_list() {
  echo -e "${BLUE}Running cortex agents:${NC}"
  echo ""
  local found=0
  for pidfile in "$BASE_LOG_DIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    local pid
    pid=$(cat "$pidfile")
    local name
    name=$(basename "$pidfile" .pid)
    if kill -0 "$pid" 2>/dev/null; then
      echo -e "  ${GREEN}●${NC} $name  (pid=$pid)"
      found=$((found + 1))
    else
      # Stale PID file
      rm -f "$pidfile"
    fi
  done
  if [ "$found" -eq 0 ]; then
    echo -e "  ${YELLOW}No agents running.${NC}"
  fi
  echo ""
  echo -e "${BLUE}Available IDE presets:${NC}"
  echo ""
  echo -e "  ${GREEN}claude-code${NC}   — Claude Code CLI (engine: claude)"
  echo -e "  ${GREEN}vscode${NC}        — VS Code + Claude extension (engine: claude)"
  echo -e "  ${GREEN}codex${NC}         — OpenAI Codex headless (engine: codex)"
  echo -e "  ${GREEN}cursor${NC}        — Cursor IDE (engine: claude)"
  echo -e "  ${GREEN}antigravity${NC}   — Antigravity / Gemini (engine: antigravity)"
  echo ""
  echo -e "${BLUE}Available capability presets:${NC}"
  echo ""
  list_presets
  echo ""
  echo -e "${BLUE}Quick start examples:${NC}"
  echo ""
  echo -e "  # Launch with a capability preset"
  echo -e "  ${GREEN}$0 start --daemon --preset fullstack${NC}"
  echo ""
  echo -e "  # Launch with custom capabilities"
  echo -e "  ${GREEN}$0 start --daemon --cap plan,backend,review${NC}"
  echo ""
  echo -e "  # Launch a Claude Code agent"
  echo -e "  ${GREEN}CORTEX_AGENT_IDE=claude-code CORTEX_AGENT_ID=claude-1 $0 start --daemon${NC}"
  echo ""
  echo -e "  # Launch a Codex agent"
  echo -e "  ${GREEN}CORTEX_AGENT_IDE=codex CORTEX_AGENT_ID=codex-1 $0 start --daemon${NC}"
  echo ""
  echo -e "  # Stop a specific agent"
  echo -e "  ${GREEN}CORTEX_AGENT_ID=claude-1 $0 stop${NC}"
  echo ""
  echo -e "  # Stop ALL agents"
  echo -e "  ${GREEN}$0 stop-all${NC}"
  echo ""
}

cmd_stop_all() {
  local found=0
  for pidfile in "$BASE_LOG_DIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    local pid
    pid=$(cat "$pidfile")
    local name
    name=$(basename "$pidfile" .pid)
    if kill -0 "$pid" 2>/dev/null; then
      echo -e "Stopping ${BLUE}$name${NC} (pid=$pid)..."
      kill "$pid" 2>/dev/null || true
      found=$((found + 1))
    fi
    rm -f "$pidfile"
  done
  if [ "$found" -eq 0 ]; then
    echo -e "${YELLOW}No agents were running.${NC}"
  else
    echo -e "${GREEN}Stopped $found agent(s).${NC}"
  fi
}

cmd_logs() {
  if [ -f "$LOG_FILE" ]; then
    local lines="${1:-50}"
    tail -"$lines" "$LOG_FILE"
  else
    echo -e "${YELLOW}No log file found at $LOG_FILE${NC}"
  fi
}

cmd_help() {
  cat << EOF
${BLUE}cortex-agent.sh${NC} — Cortex Hub WebSocket Agent Client

${GREEN}Commands:${NC}
  $0 launch                 Interactive wizard — pick IDE, preset, launch
  $0 start [flags]          Start the agent (see flags below)
  $0 stop                   Stop the current agent (by CORTEX_AGENT_ID)
  $0 stop-all               Stop ALL running agents
  $0 status                 Show agent status and recent logs
  $0 list                   List running agents, presets, and examples
  $0 logs [N]               Show last N log lines (default: 50)
  $0 help                   Show this help message

${GREEN}Start Flags:${NC}
  --daemon, -d               Run in background (daemon mode)
  --preset NAME              Use a capability preset (e.g. fullstack, reviewer, devops)
  --cap cap1,cap2,...        Set capabilities directly (comma-separated)
  Note: --preset and --cap are mutually exclusive.

${GREEN}Environment Variables:${NC}
  CORTEX_AGENT_ID            Agent ID (unique per instance, REQUIRED for multi-agent)
  CORTEX_AGENT_IDE           IDE preset: claude-code | vscode | codex | cursor | antigravity
  CORTEX_HUB_WS_URL          Hub WebSocket URL (default: auto-detected or $DEFAULT_HUB_URL)
  CORTEX_HUB_API_KEY          Hub API key (default: auto-detected from IDE config)
  CORTEX_AGENT_LOG_DIR        Custom log directory
  CORTEX_AGENT_DEBUG          Set to 1 for debug logging

${GREEN}Auto-Detection:${NC}
  The agent automatically reads Hub API key and URL from your IDE's MCP config.
  Checked in order: ~/.claude.json, ~/.cursor/mcp.json, ~/.codeium/windsurf/mcp_config.json,
  ~/.gemini/antigravity/mcp_config.json. Set env vars above to override.

${GREEN}IDE Presets:${NC}
  claude-code   → engine: claude   (claude -p --permission-mode accept)
  vscode        → engine: claude   (claude -p --permission-mode accept)
  codex         → engine: codex    (codex exec)
  cursor        → engine: claude   (claude -p --permission-mode accept)
  antigravity   → engine: gemini   (gemini)

${GREEN}Capability Presets:${NC}
  Use --preset to assign a predefined set of capabilities from
  .cortex/capability-templates.json. Use --cap for custom capabilities.

  # Full-stack developer preset
  $0 start --daemon --preset fullstack

  # Custom capabilities
  $0 start --daemon --cap plan,backend,review

  # Game developer preset
  $0 start --daemon --preset game-dev

  # Code reviewer preset
  $0 start --daemon --preset reviewer

${GREEN}Multi-Agent Examples:${NC}

  # 1) Claude Code agent (full-stack preset)
  CORTEX_AGENT_IDE=claude-code CORTEX_AGENT_ID=claude-1 $0 start --daemon --preset fullstack

  # 2) Codex agent (backend preset)
  CORTEX_AGENT_IDE=codex CORTEX_AGENT_ID=codex-1 $0 start --daemon --preset backend-dev

  # 3) Cursor agent (UI preset)
  CORTEX_AGENT_IDE=cursor CORTEX_AGENT_ID=cursor-1 $0 start --daemon --preset ui-dev

  # 4) Review agent
  CORTEX_AGENT_ID=reviewer-1 $0 start --daemon --preset reviewer

  # List all running agents + available presets
  $0 list

  # Assign a task to a specific agent (via MCP or Dashboard)
  cortex_task_create(title: "Fix bug", assignTo: "codex-1")

  # Stop one agent
  CORTEX_AGENT_ID=codex-1 $0 stop

  # Stop ALL agents
  $0 stop-all

${GREEN}How It Works:${NC}
  1. Agent connects to Hub via WebSocket
  2. Hub pushes task.assigned events when a task matches this agent
  3. Agent spawns the engine (claude/codex/gemini) to execute the task
  4. Result is reported back via WebSocket → visible in Dashboard

EOF
}

# ── Interactive Launch Wizard ────────────────────────────────
cmd_launch() {
  echo ""
  echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║   ${GREEN}Cortex Agent — Interactive Launch${BLUE}      ║${NC}"
  echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
  echo ""

  # Step 1: Agent ID
  local default_id="agent-$(date +%s | tail -c 5)"
  echo -e "${CYAN}Step 1/4: Agent ID${NC}"
  echo -e "  A unique name for this agent (e.g. claude-1, codex-review, my-agent)"
  read -rp "  Agent ID [$default_id]: " input_id < /dev/tty
  local agent_id="${input_id:-$default_id}"
  echo ""

  # Step 2: IDE / Engine
  echo -e "${CYAN}Step 2/4: IDE / Engine${NC}"
  echo -e "  ${GREEN}1)${NC} claude-code  — Claude Code CLI ${CYAN}(claude -p --permission-mode auto)${NC}"
  echo -e "  ${GREEN}2)${NC} codex        — OpenAI Codex ${CYAN}(codex exec)${NC}"
  echo -e "  ${GREEN}3)${NC} antigravity  — Antigravity ${CYAN}(antigravity -p --yolo)${NC} ${YELLOW}← own subscription${NC}"
  echo -e "  ${GREEN}4)${NC} gemini       — Gemini CLI ${CYAN}(gemini -p --yolo)${NC} ${YELLOW}← separate subscription${NC}"
  echo -e "  ${GREEN}5)${NC} cursor       — Cursor IDE ${CYAN}(claude -p)${NC}"
  read -rp "  Select [1-5, default=1]: " input_ide < /dev/tty
  local ide
  case "${input_ide:-1}" in
    1) ide="claude-code" ;;
    2) ide="codex" ;;
    3) ide="antigravity" ;;
    4) ide="gemini" ;;
    5) ide="cursor" ;;
    *) ide="claude-code" ;;
  esac
  echo ""

  # Step 3: Capability preset
  echo -e "${CYAN}Step 3/4: Capability Preset${NC}"
  echo ""
  echo -e "  ${GREEN}1)${NC} fullstack     — plan, backend, frontend, review, database"
  echo -e "  ${GREEN}2)${NC} backend-dev   — backend, database, server"
  echo -e "  ${GREEN}3)${NC} ui-dev        — frontend, design"
  echo -e "  ${GREEN}4)${NC} reviewer      — review, security, testing"
  echo -e "  ${GREEN}5)${NC} devops        — devops, docker, deploy"
  echo -e "  ${GREEN}6)${NC} orchestrator  — plan, orchestrate, review"
  echo -e "  ${GREEN}7)${NC} game-dev      — godot, resources, game-logic, server"
  echo -e "  ${GREEN}8)${NC} custom        — enter capabilities manually"
  echo ""
  read -rp "  Select [1-8, default=1]: " input_preset < /dev/tty
  local preset_flag=""
  local cap_flag=""
  case "${input_preset:-1}" in
    1) preset_flag="fullstack" ;;
    2) preset_flag="backend-dev" ;;
    3) preset_flag="ui-dev" ;;
    4) preset_flag="reviewer" ;;
    5) preset_flag="devops" ;;
    6) preset_flag="orchestrator" ;;
    7) preset_flag="game-dev" ;;
    8)
      echo ""
      echo -e "  Available: plan, orchestrate, backend, frontend, design, review,"
      echo -e "  godot, resources, game-logic, server, build-game, database,"
      echo -e "  devops, security, testing, docker, deploy"
      read -rp "  Enter capabilities (comma-separated): " cap_flag < /dev/tty
      ;;
    *) preset_flag="fullstack" ;;
  esac
  echo ""

  # Step 4: Confirm
  local engine="$(ide_engine "$ide")"
  local ide_desc="$(ide_description "$ide")"
  local caps_display=""
  if [ -n "$preset_flag" ]; then
    caps_display="$(resolve_preset "$preset_flag")"
    [ -z "$caps_display" ] && caps_display="(preset: $preset_flag)"
  else
    caps_display="[$cap_flag]"
  fi

  echo -e "${CYAN}Step 4/4: Confirm${NC}"
  echo ""
  echo -e "  ┌─────────────────────────────────────────┐"
  echo -e "  │ Agent ID:     ${GREEN}$agent_id${NC}"
  echo -e "  │ IDE:          ${GREEN}$ide${NC} ($ide_desc)"
  echo -e "  │ Engine:       ${GREEN}$engine${NC}"
  if [ -n "$preset_flag" ]; then
  echo -e "  │ Preset:       ${GREEN}$preset_flag${NC}"
  fi
  echo -e "  │ Capabilities: ${GREEN}$caps_display${NC}"
  echo -e "  └─────────────────────────────────────────┘"
  echo ""
  read -rp "  Launch this agent? [Y/n]: " confirm < /dev/tty
  if [ "${confirm:-Y}" = "n" ] || [ "${confirm:-Y}" = "N" ]; then
    echo -e "${YELLOW}Cancelled.${NC}"
    return 0
  fi

  # Launch
  echo ""
  local preset_arg=""
  local cap_arg=""
  [ -n "$preset_flag" ] && preset_arg="--preset $preset_flag"
  [ -n "$cap_flag" ] && cap_arg="--cap $cap_flag"

  CORTEX_AGENT_IDE="$ide" CORTEX_AGENT_ID="$agent_id" \
    "$0" start --daemon $preset_arg $cap_arg
}

# ── Entry Point ──────────────────────────────────────────────
main() {
  local command="${1:-}"
  shift || true

  # No argument: show quick-start guide with both modes
  if [ -z "$command" ]; then
    echo ""
    echo -e "${BLUE}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   ${GREEN}Cortex Agent${BLUE} — AI Agent Daemon for Hub     ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${GREEN}Interactive mode:${NC}"
    echo -e "  ${CYAN}$0 launch${NC}"
    echo -e "  Step-by-step wizard: pick agent ID, IDE, capabilities, then launch."
    echo ""
    echo -e "${GREEN}Quick start (one-liner):${NC}"
    echo -e "  ${CYAN}CORTEX_AGENT_IDE=claude-code CORTEX_AGENT_ID=claude-1 $0 start --daemon --preset fullstack${NC}"
    echo ""
    echo -e "${GREEN}Available IDE engines:${NC}"
    echo -e "  claude-code   → claude -p --permission-mode auto"
    echo -e "  codex         → codex exec"
    echo -e "  antigravity   → antigravity -p --yolo  ${YELLOW}(own subscription)${NC}"
    echo -e "  gemini        → gemini -p --yolo       ${YELLOW}(separate subscription)${NC}"
    echo -e "  cursor        → claude -p"
    echo ""
    echo -e "${GREEN}Available presets:${NC}"
    list_presets
    echo ""
    echo -e "${GREEN}Management:${NC}"
    echo -e "  $0 list                   — Show running agents + presets"
    echo -e "  $0 status                 — Show current agent status"
    echo -e "  $0 stop                   — Stop current agent"
    echo -e "  $0 stop-all               — Stop ALL agents"
    echo -e "  $0 logs [N]               — Show last N log lines"
    echo -e "  $0 help                   — Full help with all options"
    echo ""
    echo -e "${GREEN}Examples:${NC}"
    echo ""
    echo -e "  ${CYAN}# Backend developer${NC}"
    echo -e "  CORTEX_AGENT_IDE=claude-code CORTEX_AGENT_ID=dev-1 $0 start -d --preset backend-dev"
    echo ""
    echo -e "  ${CYAN}# UI developer (Antigravity)${NC}"
    echo -e "  CORTEX_AGENT_IDE=antigravity CORTEX_AGENT_ID=ui-1 $0 start -d --preset ui-dev"
    echo ""
    echo -e "  ${CYAN}# Code reviewer (Codex)${NC}"
    echo -e "  CORTEX_AGENT_IDE=codex CORTEX_AGENT_ID=rev-1 $0 start -d --preset reviewer"
    echo ""
    return 0
  fi

  case "$command" in
    launch)   cmd_launch ;;
    start)    cmd_start "$@" ;;
    stop)     read_identity; cmd_stop ;;
    stop-all) cmd_stop_all ;;
    status)   cmd_status ;;
    list|ls)  cmd_list ;;
    logs)     read_identity; cmd_logs "$@" ;;
    help|--help|-h) cmd_help ;;
    _run)
      # Internal: used by daemon mode to re-enter the script
      # Pick up capabilities override passed from cmd_start daemon
      if [ -n "${CORTEX_AGENT_CAPABILITIES_OVERRIDE:-}" ]; then
        _CAP_FLAG=""
        _PRESET_FLAG=""
      fi
      read_identity
      # Apply capabilities override after identity is read
      if [ -n "${CORTEX_AGENT_CAPABILITIES_OVERRIDE:-}" ]; then
        AGENT_CAPABILITIES="$CORTEX_AGENT_CAPABILITIES_OVERRIDE"
      fi
      ensure_log_dir
      check_dependencies
      run_agent
      ;;
    *)
      echo -e "${RED}Unknown command: $command${NC}"
      cmd_help
      exit 1
      ;;
  esac
}

main "$@"
