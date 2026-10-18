#!/bin/bash
# Tests for the cw command that run-agent.sh installs.
#
# run-agent.sh runs on people's own machines and writes to their home folder and shell rc,
# so each case below runs it against a scratch HOME, a fake SHELL and a local hub that
# serves a stand-in worker. Nothing here touches the real home folder.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
T=$(mktemp -d)
trap 'kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null; rm -rf "$T"' EXIT

check() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf '  FAIL %s (want %s, got %s)\n' "$1" "$2" "$3"; fi
}
yes_no() { if eval "$1"; then echo yes; else echo no; fi; }

# The stand-in worker prints how it was called.
cat > "$T/worker.mjs" <<'EOF'
#!/usr/bin/env node
console.log('worker: ' + process.argv.slice(2).join(' '));
if (process.argv[2] === 'check' && process.env.CHECK_FAILS === '1') process.exit(3);
EOF
node -e '
const fs = require("node:fs");
const [body, portFile] = process.argv.slice(1);
require("node:http").createServer((req, res) => {
  if (req.url !== "/conductor/worker.mjs") { res.writeHead(404); res.end(); return; }
  res.end(fs.readFileSync(body));
}).listen(0, "127.0.0.1", function () { fs.writeFileSync(portFile, String(this.address().port)); });
' "$T/worker.mjs" "$T/port" &
SERVER=$!
for _ in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
HUB="http://127.0.0.1:$(cat "$T/port")"

# PATH without any ~/.local/bin, so the installer has to add it.
BASE_PATH="$(dirname "$(command -v node)"):/usr/bin:/bin"

# run <home> <shell> [VAR=value ...] -- <worker args...>; stdout and stderr go to $T/out
run() {
  local home="$1" sh="$2"; shift 2
  local vars=()
  while [ "$1" != -- ]; do vars+=("$1"); shift; done; shift
  env -i HOME="$home" SHELL="$sh" PATH="$BASE_PATH" ${vars[@]+"${vars[@]}"} \
    bash "$REPO/scripts/run-agent.sh" "$@" --hub "$HUB" > "$T/out" 2>&1
}

echo "run-agent.sh - a fresh machine on zsh"
H="$T/zsh-home"; mkdir -p "$H"
run "$H" /bin/zsh -- ls
check "runs the worker"                       yes "$(yes_no "grep -q '^worker: ls --hub' '$T/out'")"
check "installs cw"                           yes "$(yes_no "[ -x '$H/.local/bin/cw' ]")"
check "says so"                               yes "$(yes_no "grep -q 'installed the cw command' '$T/out'")"
check "cw runs the worker"                    "worker: status 2" "$("$H/.local/bin/cw" status 2)"
check "puts ~/.local/bin on PATH in .zshrc"   1 "$(grep -c '^export PATH="$HOME/.local/bin:$PATH"$' "$H/.zshrc")"
run "$H" /bin/zsh -- ls
check "a second run adds no second line"      1 "$(grep -c 'Added by Cortex run-agent.sh' "$H/.zshrc")"
check "and says nothing about cw"             no "$(yes_no "grep -q 'cw' '$T/out'")"

echo "run-agent.sh - bash, another shell, and ~/.local/bin already on PATH"
H="$T/bash-home"; mkdir -p "$H"
run "$H" /bin/bash -- ls
check "bash gets the line in .bashrc"         1 "$(grep -c 'Added by Cortex run-agent.sh' "$H/.bashrc")"
H="$T/sh-home"; mkdir -p "$H"
run "$H" /bin/sh -- ls
check "any other shell gets it in .profile"   1 "$(grep -c 'Added by Cortex run-agent.sh' "$H/.profile")"
H="$T/onpath-home"; mkdir -p "$H/.local/bin"
BASE_PATH="$H/.local/bin:$BASE_PATH" run "$H" /bin/zsh -- ls
check "on PATH already: no rc file written"   no "$(yes_no "[ -e '$H/.zshrc' ]")"
check "but cw is installed"                   yes "$(yes_no "[ -x '$H/.local/bin/cw' ]")"
mkdir -p "$T/other-bin"; printf '#!/bin/sh\necho other\n' > "$T/other-bin/cw"; chmod 755 "$T/other-bin/cw"
BASE_PATH="$T/other-bin:$H/.local/bin:$BASE_PATH" run "$H" /bin/zsh -- ls
check "warns when another cw comes first"     yes "$(yes_no "grep -q 'another cw comes first on PATH' '$T/out'")"

echo "run-agent.sh - leaves alone what is not its own"
H="$T/foreign-home"; mkdir -p "$H/.local/bin"
printf '#!/bin/sh\necho mine\n' > "$H/.local/bin/cw"; chmod 755 "$H/.local/bin/cw"
run "$H" /bin/zsh -- ls
check "a cw that is not ours is kept"         mine "$("$H/.local/bin/cw")"
check "and the worker still runs"             yes "$(yes_no "grep -q '^worker: ls' '$T/out'")"
H="$T/skip-home"; mkdir -p "$H"
run "$H" /bin/zsh CORTEX_SKIP_CW=1 -- ls
check "CORTEX_SKIP_CW=1: no cw"               no "$(yes_no "[ -e '$H/.local/bin/cw' ]")"
check "CORTEX_SKIP_CW=1: no rc file"          no "$(yes_no "[ -e '$H/.zshrc' ]")"
H="$T/ro-home"; mkdir -p "$H/.local"; chmod 555 "$H/.local"
run "$H" /bin/zsh -- ls
chmod 755 "$H/.local"
check "cannot write cw: still runs the worker" yes "$(yes_no "grep -q '^worker: ls' '$T/out'")"
check "and warns"                             yes "$(yes_no "grep -q 'could not install the cw command' '$T/out'")"

echo "run-agent.sh - checks the machine before a start"
H="$T/check-home"; mkdir -p "$H"
calls() { sed -n 's/^worker: \([a-z-]*\).*/\1/p' "$T/out" | tr '\n' ' '; }
run "$H" /bin/zsh -- start acme -d
check "start: check first, then start"        "check start " "$(calls)"
check "check gets the start's arguments"      yes "$(yes_no "grep -q '^worker: check --if-changed acme -d --hub' '$T/out'")"
run "$H" /bin/zsh -- ls
check "no check for other commands"           "ls " "$(calls)"
run "$H" /bin/zsh CHECK_FAILS=1 -- start acme
check "a failed check still starts"           "check start " "$(calls)"
run "$H" /bin/zsh CORTEX_SKIP_CHECK=1 -- start acme
check "CORTEX_SKIP_CHECK=1: no check"         "start " "$(calls)"

echo "run-agent.sh - a worker folder with a quote and a space in its name"
H="$T/quote-home"; mkdir -p "$H"
run "$H" /bin/zsh "CORTEX_WORKER_HOME=$T/it's here" -- ls
check "cw still finds the worker"             "worker: logs 1" "$("$H/.local/bin/cw" logs 1)"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
