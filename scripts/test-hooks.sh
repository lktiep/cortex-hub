#!/bin/bash
# Tests for the Cortex enforcement hooks.
#
# These hooks decide whether an agent may search, edit or commit, and nothing checked
# them until now. Every case below is a hole that was open in a shipped version, so a
# failure here means that hole is back.
set -u
HOOKS_DIR="$(cd "$(dirname "$0")/../.claude/hooks" && pwd)"
PASS=0; FAIL=0

setup() {
  SANDBOX=$(mktemp -d)
  mkdir -p "$SANDBOX/.cortex/.session-state"
  STATE="$SANDBOX/.cortex/.session-state"
}
teardown() { rm -rf "$SANDBOX"; }

run() {
  printf '%s' "$2" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/$1" >/dev/null 2>&1
  echo $?
}

check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf '  FAIL %s (want exit %s, got %s)\n' "$1" "$2" "$3"; fi
}

bash_payload() { printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"; }
tool_payload() { printf '{"tool_name":"%s","tool_input":{}}' "$1"; }
discovered() { printf 'tool=cortex_code_search at=2026-09-28T00:00:00Z\n' > "$STATE/discovery-used"; }

echo "enforce-session.sh — session started, no discovery yet"
setup; touch "$STATE/session-started"
check "Grep blocked"                       2 "$(run enforce-session.sh "$(tool_payload Grep)")"
check "Glob blocked"                       2 "$(run enforce-session.sh "$(tool_payload Glob)")"
check "bare grep blocked"                  2 "$(run enforce-session.sh "$(bash_payload 'grep -rn foo .')")"
check "cd && grep blocked"                 2 "$(run enforce-session.sh "$(bash_payload 'cd apps && grep -rn foo .')")"
check "; grep blocked"                     2 "$(run enforce-session.sh "$(bash_payload 'echo hi; grep -rn foo .')")"
check "rg blocked"                         2 "$(run enforce-session.sh "$(bash_payload 'rg foo apps/')")"
check "fd blocked"                         2 "$(run enforce-session.sh "$(bash_payload 'fd -e ts')")"
check "git grep blocked"                   2 "$(run enforce-session.sh "$(bash_payload 'git grep foo')")"
check "piped grep filters output, allowed"  0 "$(run enforce-session.sh "$(bash_payload 'pnpm build | grep error')")"
check "grep inside a heredoc is data"      0 "$(run enforce-session.sh "$(bash_payload 'cat << EOF
grep -rn foo .
EOF')")"
check "cat allowed"                        0 "$(run enforce-session.sh "$(bash_payload 'cat package.json')")"
check "Edit blocked without recall"        2 "$(run enforce-session.sh "$(tool_payload Edit)")"
check "NotebookEdit blocked"               2 "$(run enforce-session.sh "$(tool_payload NotebookEdit)")"
check "redirect write blocked"             2 "$(run enforce-session.sh "$(bash_payload 'echo x > out.txt')")"
check "sed -i blocked"                     2 "$(run enforce-session.sh "$(bash_payload 'sed -i s/a/b/ f.ts')")"
check "2>/dev/null is not a write"         0 "$(run enforce-session.sh "$(bash_payload 'ls foo 2>/dev/null')")"
check "writing gate-off is never blocked"  0 "$(run enforce-session.sh "$(bash_payload 'echo reason > .cortex/.session-state/gate-off')")"
teardown

echo "enforce-session.sh — a touched marker is not discovery"
setup; touch "$STATE/session-started" "$STATE/discovery-used"
check "empty marker does not unlock"       2 "$(run enforce-session.sh "$(tool_payload Grep)")"
discovered
check "marker with evidence unlocks"       0 "$(run enforce-session.sh "$(tool_payload Grep)")"
teardown

echo "enforce-session.sh — recall gate on edits"
setup; touch "$STATE/session-started"
printf 'tool=cortex_knowledge_search at=now\n' > "$STATE/knowledge-recalled"
check "knowledge alone is not enough"      2 "$(run enforce-session.sh "$(tool_payload Edit)")"
printf 'tool=cortex_memory_search at=now\n' > "$STATE/memory-recalled"
check "knowledge + memory unlocks Edit"    0 "$(run enforce-session.sh "$(tool_payload Edit)")"
teardown

echo "enforce-session.sh — declared escape hatch"
setup; touch "$STATE/session-started" "$STATE/gate-off"
check "empty gate-off does nothing"        2 "$(run enforce-session.sh "$(tool_payload Grep)")"
printf 'hub unreachable\n' > "$STATE/gate-off"
check "gate-off with a reason opens it"     0 "$(run enforce-session.sh "$(tool_payload Grep)")"
teardown

echo "enforce-session.sh — no session at all"
setup
check "Edit blocked without session"       2 "$(run enforce-session.sh "$(tool_payload Edit)")"
check "ls allowed without session"         0 "$(run enforce-session.sh "$(bash_payload 'ls -la')")"
check "git commit blocked"                 2 "$(run enforce-session.sh "$(bash_payload 'git commit -m x')")"
check "Grep blocked without session"       2 "$(run enforce-session.sh "$(tool_payload Grep)")"
check "rg blocked without session"         2 "$(run enforce-session.sh "$(bash_payload 'rg foo apps/')")"
# `cat` is on the read allowlist, so the write check has to come first or this passes as a read
check "cat > file blocked without session" 2 "$(run enforce-session.sh "$(bash_payload 'cat > f.ts << EOF
x
EOF')")"
check "gate-off write allowed, no session"  0 "$(run enforce-session.sh "$(bash_payload 'echo why > .cortex/.session-state/gate-off')")"
teardown

echo "enforce-session.sh — parses without jq"
setup; touch "$STATE/session-started"
NOJQ=$(mktemp -d)
for b in bash cat grep sed printf python3 mktemp rm dirname pwd; do
  [ -x "$(command -v $b 2>/dev/null)" ] && ln -sf "$(command -v $b)" "$NOJQ/$b"
done
GOT=$(printf '%s' "$(tool_payload Grep)" | CLAUDE_PROJECT_DIR="$SANDBOX" PATH="$NOJQ" bash "$HOOKS_DIR/enforce-session.sh" >/dev/null 2>&1; echo $?)
check "still blocks with python3 only"     2 "$GOT"
rm -rf "$NOJQ"; teardown

echo "session-init.sh — compaction must not re-arm the gate"
setup; discovered
printf '{"source":"compact"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" >/dev/null 2>&1
check "discovery survives compact"         0 "$([ -s "$STATE/discovery-used" ] && echo 0 || echo 1)"
printf '{"source":"resume"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" >/dev/null 2>&1
check "discovery survives resume"          0 "$([ -s "$STATE/discovery-used" ] && echo 0 || echo 1)"
printf '{"source":"startup"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" >/dev/null 2>&1
check "startup clears discovery"           0 "$([ ! -f "$STATE/discovery-used" ] && echo 0 || echo 1)"
teardown

echo "session-init.sh — the session gate must not arm itself"
setup; printf 'tool=cortex_session_start at=old\n' > "$STATE/session-started"
printf '{"source":"startup"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" >/dev/null 2>&1
check "startup clears a stale session"     0 "$([ ! -f "$STATE/session-started" ] && echo 0 || echo 1)"
check "and does not create a new one"      2 "$(run enforce-session.sh "$(tool_payload Edit)")"
POST='{"tool_name":"mcp__cortex-hub__cortex_session_start","tool_input":{},"tool_response":{"content":[{"type":"text","text":"{\"session_id\":\"s1\"}"}]}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "only the tracker arms it"           0 "$(grep -q '^tool=' "$STATE/session-started" 2>/dev/null && echo 0 || echo 1)"
teardown

setup; touch "$STATE/changes-checked" "$STATE/tasks-checked"
printf '{"source":"startup"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/session-init.sh" >/dev/null 2>&1
check "stale changes-checked cleared"      0 "$([ ! -f "$STATE/changes-checked" ] && echo 0 || echo 1)"
check "stale tasks-checked cleared"        0 "$([ ! -f "$STATE/tasks-checked" ] && echo 0 || echo 1)"
teardown

echo "track-quality.sh — markers must carry evidence"
setup
POST='{"tool_name":"mcp__cortex-hub__cortex_code_search","tool_input":{},"tool_response":{"content":[{"type":"text","text":"3 results"}]}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "code_search records discovery"      0 "$(grep -q '^tool=' "$STATE/discovery-used" 2>/dev/null && echo 0 || echo 1)"
check "code_search is not a knowledge recall" 0 "$([ ! -f "$STATE/knowledge-recalled" ] && echo 0 || echo 1)"
teardown

setup
POST='{"tool_name":"mcp__cortex-hub__cortex_memory_search","tool_input":{},"tool_response":{}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "memory_search records the recall"   0 "$(grep -q '^tool=' "$STATE/memory-recalled" 2>/dev/null && echo 0 || echo 1)"
# Recall must not open the discovery gate, or /cs alone unlocks Grep and Glob and the agent
# never has to ask cortex where the code is.
check "memory_search is not discovery"     0 "$([ ! -f "$STATE/discovery-used" ] && echo 0 || echo 1)"
teardown

echo "track-quality.sh — session id comes from tool_response"
setup
POST='{"tool_name":"mcp__cortex-hub__cortex_session_start","tool_input":{},"tool_response":{"content":[{"type":"text","text":"{\"session_id\":\"sess-42\",\"projectId\":\"proj-1\"}"}]}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "session id captured"                0 "$([ "$(cat "$STATE/session-id" 2>/dev/null)" = "sess-42" ] && echo 0 || echo 1)"
teardown

echo "track-quality.sh — quality gates need the commands, not a report"
setup
POST='{"tool_name":"mcp__cortex-hub__cortex_quality_report","tool_input":{},"tool_response":{}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "report alone does not pass gates"   0 "$([ ! -f "$STATE/quality-gates-passed" ] && echo 0 || echo 1)"
check "report is recorded separately"      0 "$(grep -q '^tool=' "$STATE/quality-reported" 2>/dev/null && echo 0 || echo 1)"
teardown

setup
for c in build typecheck lint; do
  printf '{"tool_name":"Bash","tool_input":{"command":"pnpm %s"},"tool_response":{"stdout":"Tasks: 12 successful","stderr":""}}' "$c" \
    | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
done
check "three green commands pass the gates" 0 "$(grep -q '^tool=' "$STATE/quality-gates-passed" 2>/dev/null && echo 0 || echo 1)"
teardown

setup
printf '{"tool_name":"Bash","tool_input":{"command":"pnpm build || true"},"tool_response":{"stdout":"ELIFECYCLE Command failed with exit code 1","stderr":""}}' \
  | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$HOOKS_DIR/track-quality.sh" >/dev/null 2>&1
check "a hidden build failure opens nothing" 0 "$([ ! -f "$STATE/gate-build" ] && echo 0 || echo 1)"
teardown

# ── Gemini variants ──────────────────────────────────────────────────────────────────────
# Same gates, different protocol: gemini reads {"decision":"deny"} from stdout and the hook
# always exits 0. The variants shipped three versions behind and enforced almost none of this.
GHOOKS="$(cd "$(dirname "$0")/../.gemini/hooks" && pwd)"
gdecision() {
  printf '%s' "$2" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/$1" 2>/dev/null \
    | grep -q '"decision":"deny"' && echo deny || echo allow
}
gpayload() { printf '{"tool_name":"%s","tool_input":{"command":%s}}' "$1" "$(printf '%s' "${2:-}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"; }

echo "gemini enforce-session.sh — discovery gate"
setup; printf 'tool=cortex_session_start at=now\n' > "$STATE/session-started"
check "search_file_content denied"         deny "$(gdecision enforce-session.sh "$(gpayload search_file_content)")"
check "glob denied"                        deny "$(gdecision enforce-session.sh "$(gpayload glob)")"
check "shell grep denied"                  deny "$(gdecision enforce-session.sh "$(gpayload run_shell_command 'grep -rn foo .')")"
check "piped grep allowed"                 allow "$(gdecision enforce-session.sh "$(gpayload run_shell_command 'pnpm build | grep error')")"
check "replace denied before recall"       deny "$(gdecision enforce-session.sh "$(gpayload replace)")"
discovered
check "search allowed after discovery"     allow "$(gdecision enforce-session.sh "$(gpayload search_file_content)")"
teardown

echo "gemini enforce-session.sh — recall gate and escape hatch"
setup; printf 'tool=cortex_session_start at=now\n' > "$STATE/session-started"
printf 'tool=cortex_knowledge_search at=now\n' > "$STATE/knowledge-recalled"
check "knowledge alone is not enough"      deny "$(gdecision enforce-session.sh "$(gpayload write_file)")"
printf 'tool=cortex_memory_search at=now\n' > "$STATE/memory-recalled"
check "knowledge + memory unlocks write"   allow "$(gdecision enforce-session.sh "$(gpayload write_file)")"
printf 'hub unreachable\n' > "$STATE/gate-off"
check "gate-off opens the gemini gate"     allow "$(gdecision enforce-session.sh "$(gpayload glob)")"
teardown

echo "gemini enforce-session.sh — no session at all"
setup
check "write_file denied without session"  deny "$(gdecision enforce-session.sh "$(gpayload write_file)")"
check "glob denied without session"        deny "$(gdecision enforce-session.sh "$(gpayload glob)")"
check "ls allowed without session"         allow "$(gdecision enforce-session.sh "$(gpayload run_shell_command 'ls -la')")"
teardown

echo "gemini enforce-commit.sh — a report is not a passing build"
setup; printf 'tool=cortex_session_start at=now\n' > "$STATE/session-started"; discovered
printf 'tool=cortex_quality_report at=now\n' > "$STATE/quality-reported"
check "commit denied without green gates"  deny "$(gdecision enforce-commit.sh "$(gpayload run_shell_command 'git commit -m x')")"
printf 'tool=build+typecheck+lint at=now\n' > "$STATE/quality-gates-passed"
check "commit allowed once gates pass"     allow "$(gdecision enforce-commit.sh "$(gpayload run_shell_command 'git commit -m x')")"
teardown

echo "gemini track-quality.sh — evidence, not touches"
setup
POST='{"tool_name":"mcp__cortex-hub__cortex_code_search","tool_input":{},"tool_response":{"content":[{"type":"text","text":"3 results"}]}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/track-quality.sh" >/dev/null 2>&1
check "discovery marker has evidence"      0 "$(grep -q '^tool=' "$STATE/discovery-used" 2>/dev/null && echo 0 || echo 1)"
POST='{"tool_name":"mcp__cortex-hub__cortex_quality_report","tool_input":{},"tool_response":{}}'
printf '%s' "$POST" | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/track-quality.sh" >/dev/null 2>&1
check "report does not pass the gates"     0 "$([ ! -f "$STATE/quality-gates-passed" ] && echo 0 || echo 1)"
printf '{"tool_name":"run_shell_command","tool_input":{"command":"pnpm build"},"tool_response":{"stdout":"ELIFECYCLE Command failed"}}' \
  | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/track-quality.sh" >/dev/null 2>&1
check "a hidden failure opens nothing"     0 "$([ ! -f "$STATE/gate-build" ] && echo 0 || echo 1)"
teardown

echo "gemini session-init.sh — compaction must not re-arm the gate"
setup; discovered
printf '{"source":"compact"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/session-init.sh" >/dev/null 2>&1
check "discovery survives compact"         0 "$([ -s "$STATE/discovery-used" ] && echo 0 || echo 1)"
printf '{"source":"startup"}' | CLAUDE_PROJECT_DIR="$SANDBOX" bash "$GHOOKS/session-init.sh" >/dev/null 2>&1
check "startup clears discovery"           0 "$([ ! -f "$STATE/discovery-used" ] && echo 0 || echo 1)"
check "and does not arm the session"       0 "$([ ! -f "$STATE/session-started" ] && echo 0 || echo 1)"
teardown

echo "onboarding scripts must not carry their own copy of the hooks or the rules"
# scripts/onboard.sh is what the public "Member" path runs (install.sh at the repo root and
# scripts/bootstrap.sh both exec it), and it shipped its own hooks three versions behind the
# ones tested above — so a fresh onboard installed a session gate that never fired.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
check "onboard.sh writes no hooks itself"  0 "$(grep -q 'HOOKEOF' "$REPO/scripts/onboard.sh" && echo 1 || echo 0)"
check "onboard.sh delegates to install.sh" 0 "$(grep -q 'INSTALL_SH" --skip-global' "$REPO/scripts/onboard.sh" && echo 0 || echo 1)"
check "onboard.ps1 delegates to install.ps1" 0 "$(grep -q 'installPs1 -SkipGlobal' "$REPO/scripts/onboard.ps1" && echo 0 || echo 1)"
for f in scripts/onboard.sh scripts/onboard.ps1 scripts/install.sh scripts/install.ps1 .cortex/agent-rules.md; do
  check "no STATE.md in $f"                0 "$(grep -q 'Read .*STATE.md' "$REPO/$f" && echo 1 || echo 0)"
  check "no old tool ladder in $f"         0 "$(grep -q 'Tool Priority' "$REPO/$f" && echo 1 || echo 0)"
done

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
