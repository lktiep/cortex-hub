#!/bin/bash
# Cortex Session Init (v3) — Resets session markers + prints mandatory reminder
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR/session-started" "$STATE_DIR/quality-gates-passed" \
      "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" \
      "$STATE_DIR/session-ended" 2>/dev/null
cat <<'MSG'
MANDATORY SESSION PROTOCOL — You MUST complete these steps NOW before any other work:
1. Call cortex_session_start with repo, mode: "development", agentId: "claude-code"
2. If recentChanges.count > 0, warn user and run git pull
3. Read STATE.md for current task progress
DO NOT proceed with any code changes until step 1 is complete.
MSG
