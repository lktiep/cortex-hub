#!/bin/bash
# Cortex Session Init (v6.0) — Creates session marker + resets quality gates
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
STATE_DIR="$PROJECT_DIR/.cortex/.session-state"
mkdir -p "$STATE_DIR"
touch "$STATE_DIR/session-started"
rm -f "$STATE_DIR/quality-gates-passed" \
      "$STATE_DIR/gate-build" "$STATE_DIR/gate-typecheck" "$STATE_DIR/gate-lint" \
      "$STATE_DIR/session-ended" "$STATE_DIR/discovery-used" \
      "$STATE_DIR/knowledge-recalled" "$STATE_DIR/memory-recalled" 2>/dev/null
echo "Run /cs to initialize Cortex session. Grep/Edit BLOCKED until cortex discovery tools used."
