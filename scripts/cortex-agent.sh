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
readonly PID_FILE="${CORTEX_AGENT_PID_FILE:-/tmp/cortex-agent.pid}"
readonly LOG_DIR="${CORTEX_AGENT_LOG_DIR:-/tmp/cortex-agent-logs}"
readonly LOG_FILE="$LOG_DIR/cortex-agent.log"
readonly MAX_LOG_SIZE=10485760  # 10 MB
readonly MAX_LOG_FILES=5
readonly RECONNECT_BASE_DELAY=2
readonly RECONNECT_MAX_DELAY=120

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Logging ──────────────────────────────────────────────────
log() {
  local level="$1"; shift
  local timestamp
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  local msg="[$timestamp] [$level] $*"
  echo "$msg" >> "$LOG_FILE" 2>/dev/null || true
  case "$level" in
    ERROR) echo -e "${RED}$msg${NC}" ;;
    WARN)  echo -e "${YELLOW}$msg${NC}" ;;
    INFO)  echo -e "${GREEN}$msg${NC}" ;;
    DEBUG) [ "${CORTEX_AGENT_DEBUG:-0}" = "1" ] && echo -e "${CYAN}$msg${NC}" ;;
  esac
}

log_info()  { log INFO "$@"; }
log_warn()  { log WARN "$@"; }
log_error() { log ERROR "$@"; }
log_debug() { log DEBUG "$@"; }

# ── Helpers ──────────────────────────────────────────────────
ensure_log_dir() {
  mkdir -p "$LOG_DIR"
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

# ── Task Execution Engines ───────────────────────────────────
execute_task_claude() {
  local task_id="$1"
  local prompt="$2"
  local working_dir="${3:-$PROJECT_ROOT}"

  log_info "Spawning Claude for task $task_id"
  local output_file="$LOG_DIR/task-${task_id}.log"

  if command -v claude >/dev/null 2>&1; then
    (
      cd "$working_dir"
      claude -p "$prompt" --permission-mode accept 2>&1 | tee "$output_file"
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

execute_task_gemini() {
  local task_id="$1"
  local prompt="$2"
  local working_dir="${3:-$PROJECT_ROOT}"

  log_info "Spawning Gemini for task $task_id"
  local output_file="$LOG_DIR/task-${task_id}.log"

  if command -v gemini >/dev/null 2>&1; then
    (
      cd "$working_dir"
      echo "$prompt" | gemini 2>&1 | tee "$output_file"
    )
    local exit_code=$?
    log_info "Gemini finished task $task_id (exit=$exit_code)"
    return $exit_code
  else
    log_error "Gemini CLI not found"
    return 1
  fi
}

execute_task() {
  local task_id="$1"
  local engine="$2"
  local prompt="$3"
  local working_dir="${4:-$PROJECT_ROOT}"

  case "$engine" in
    claude)  execute_task_claude "$task_id" "$prompt" "$working_dir" ;;
    codex)   execute_task_codex "$task_id" "$prompt" "$working_dir" ;;
    gemini)  execute_task_gemini "$task_id" "$prompt" "$working_dir" ;;
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

function emit(type, data) {
  const line = JSON.stringify({ type, ...data });
  process.stdout.write(line + '\n');
}

function connect() {
  if (ws) {
    try { ws.terminate(); } catch (_) {}
  }

  emit('status', { message: `Connecting to ${HUB_URL}...` });
  ws = new WebSocket(HUB_URL);

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
      if (cmd.type === 'send') {
        sendMessage(cmd.payload);
      } else if (cmd.type === 'quit') {
        if (pingInterval) clearInterval(pingInterval);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (ws) ws.close(1000, 'Agent shutting down');
        process.exit(0);
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
  local node_resolve_paths="$PROJECT_ROOT/node_modules"

  log_info "Starting $SCRIPT_NAME"
  log_info "Hub URL: $hub_url"
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
  trap 'log_info "Shutting down..."; echo "{\"type\":\"quit\"}" >&7 2>/dev/null; exec 7>&-; wait "$ws_pid" 2>/dev/null; cleanup_pid; rm -f "$pipe_in" "$pipe_out" "$ws_script_file"; exit 0' INT TERM

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

  # Read messages from WebSocket client and handle them
  while IFS= read -r line < "$pipe_out"; do
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
            engine=$(json_get "$payload" "o.engine||(o.task&&o.task.engine)||'claude'")
            prompt=$(json_get "$payload" "o.prompt||(o.task&&o.task.prompt)||(o.task&&o.task.description)||''")
            working_dir=$(json_get "$payload" "o.workingDir||(o.task&&o.task.workingDir)||''")
            [ -z "$working_dir" ] && working_dir="$PROJECT_ROOT"

            if [ -z "$task_id" ] || [ -z "$prompt" ]; then
              log_error "Invalid task.assigned: missing taskId or prompt"
              continue
            fi

            log_info "Task assigned: $task_id (engine=$engine)"

            # Report task accepted
            ws_send "{\"type\":\"send\",\"payload\":{\"type\":\"task.accepted\",\"taskId\":\"$task_id\",\"agentId\":\"$AGENT_ID\",\"timestamp\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"}}"

            # Execute task in background subshell
            (
              exit_code=0
              execute_task "$task_id" "$engine" "$prompt" "$working_dir" && exit_code=0 || exit_code=$?

              task_log_file="$LOG_DIR/task-${task_id}.log"
              result=""
              if [ -f "$task_log_file" ]; then
                result=$(tail -c 500 "$task_log_file" | tr '\n' ' ' | sed 's/"/\\"/g')
              fi

              status="completed"
              [ "$exit_code" -ne 0 ] && status="failed"

              # Report task complete/failed back via WebSocket
              echo "{\"type\":\"send\",\"payload\":{\"type\":\"task.complete\",\"taskId\":\"$task_id\",\"agentId\":\"$AGENT_ID\",\"status\":\"$status\",\"exitCode\":$exit_code,\"result\":\"$result\",\"timestamp\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"}}" >&7

              log_info "Task $task_id $status (exit=$exit_code)"
            ) &
            ;;

          agent.registered)
            log_info "Server confirmed registration"
            ;;

          heartbeat|ping)
            # Respond to server heartbeats
            ws_send "{\"type\":\"send\",\"payload\":{\"type\":\"pong\",\"agentId\":\"$AGENT_ID\",\"timestamp\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"}}"
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
  exec 7>&-
  wait "$ws_pid" 2>/dev/null
  cleanup_pid
  rm -f "$pipe_in" "$pipe_out" "$ws_script_file"
}

# ── Commands ─────────────────────────────────────────────────
cmd_start() {
  ensure_log_dir
  rotate_logs
  check_dependencies
  read_identity

  if is_running; then
    local pid
    pid=$(read_pid)
    log_warn "Agent is already running (pid=$pid)"
    echo -e "${YELLOW}Agent is already running (pid=$pid). Use 'stop' first.${NC}"
    exit 1
  fi

  local daemon="${1:-}"
  if [ "$daemon" = "--daemon" ] || [ "$daemon" = "-d" ]; then
    log_info "Starting agent in daemon mode..."
    nohup "$0" _run >> "$LOG_FILE" 2>&1 &
    local bg_pid=$!
    echo "$bg_pid" > "$PID_FILE"
    echo ""
    echo -e "${GREEN}Agent started in background (pid=$bg_pid)${NC}"
    echo -e "  Agent ID:  ${BLUE}$AGENT_ID${NC}"
    echo -e "  IDE:       ${BLUE}$AGENT_IDE${NC}"
    echo -e "  Hub URL:   ${BLUE}${CORTEX_HUB_WS_URL:-$DEFAULT_HUB_URL}${NC}"
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo -e "  1. Check logs:     ${GREEN}tail -f $LOG_FILE${NC}"
    echo -e "  2. Check status:   ${GREEN}$0 status${NC}"
    echo -e "  3. Create a task:  Use Dashboard Conductor page or cortex_task_create MCP tool"
    echo -e "  4. Agent will auto-pickup matching tasks and execute them"
    echo -e "  5. Stop agent:     ${GREEN}$0 stop${NC}"
    echo ""
    echo -e "  ${YELLOW}Tip:${NC} Override identity with env vars:"
    echo -e "    CORTEX_AGENT_ID=my-agent CORTEX_AGENT_IDE=claude-code $0 start --daemon"
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
  if is_running; then
    local pid
    pid=$(read_pid)
    echo -e "${GREEN}Agent is running (pid=$pid)${NC}"
    echo -e "  Agent ID:  ${BLUE}$AGENT_ID${NC}"
    echo -e "  IDE:       ${BLUE}$AGENT_IDE${NC}"
    echo -e "  Hostname:  ${BLUE}$AGENT_HOSTNAME${NC}"
    echo -e "  OS:        ${BLUE}$AGENT_OS${NC}"
    echo -e "  Role:      ${BLUE}$AGENT_ROLE${NC}"
    echo -e "  Hub URL:   ${BLUE}${CORTEX_HUB_WS_URL:-$DEFAULT_HUB_URL}${NC}"
    echo -e "  Log file:  ${BLUE}$LOG_FILE${NC}"
    if [ -f "$LOG_FILE" ]; then
      echo ""
      echo -e "${CYAN}Last 5 log lines:${NC}"
      tail -5 "$LOG_FILE" 2>/dev/null || true
    fi
    exit 0
  else
    echo -e "${YELLOW}Agent is not running.${NC}"
    echo -e "Start with: ${GREEN}$0 start --daemon${NC}"
    exit 1
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

${GREEN}Usage:${NC}
  $0 start [--daemon|-d]    Start the agent (optionally in background)
  $0 stop                   Stop the running agent
  $0 status                 Show agent status and recent logs
  $0 logs [N]               Show last N log lines (default: 50)
  $0 help                   Show this help message

${GREEN}Environment Variables:${NC}
  CORTEX_HUB_WS_URL         Hub WebSocket URL (default: $DEFAULT_HUB_URL)
  CORTEX_AGENT_ID            Override agent ID
  CORTEX_AGENT_PID_FILE      Custom PID file location
  CORTEX_AGENT_LOG_DIR       Custom log directory
  CORTEX_AGENT_DEBUG         Set to 1 for debug logging

${GREEN}Agent Identity:${NC}
  Place a JSON file at: $IDENTITY_FILE
  Fields: agentId, hostname, os, ide, role, capabilities

${GREEN}Examples:${NC}
  $0 start                  # Interactive mode (foreground)
  $0 start --daemon         # Background daemon mode
  CORTEX_HUB_WS_URL=ws://hub.example.com:4000/ws/conductor $0 start

EOF
}

# ── Entry Point ──────────────────────────────────────────────
main() {
  local command="${1:-help}"
  shift || true

  case "$command" in
    start)   cmd_start "$@" ;;
    stop)    cmd_stop ;;
    status)  cmd_status ;;
    logs)    cmd_logs "$@" ;;
    help|--help|-h) cmd_help ;;
    _run)
      # Internal: used by daemon mode to re-enter the script
      ensure_log_dir
      check_dependencies
      read_identity
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
