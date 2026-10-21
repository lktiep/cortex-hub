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
