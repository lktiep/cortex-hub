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
