#!/bin/bash
# Cortex Session End Check (v3) — Warns if session not properly closed
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
if [ -f "$STATE_DIR/session-started" ] && [ ! -f "$STATE_DIR/session-ended" ]; then
  echo "WARNING: cortex_session_end has not been called. Call it with sessionId and summary before ending."
fi
exit 0
