#!/usr/bin/env bash
# Cortex Hub worker bootstrap: downloads the TypeScript worker from the hub and runs it.
# Usage: curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.sh | bash -s -- start --hub https://<your-mcp-host>
set -euo pipefail
die() { echo "[cortex] $*" >&2; exit 1; }
command -v git >/dev/null 2>&1 || die "git not found; install git: https://git-scm.com/downloads"
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' >/dev/null 2>&1 || die "node 20+ not found; install Node.js 20 or newer: https://nodejs.org"
HOME_DIR="${CORTEX_WORKER_HOME:-$HOME/.cortex/worker}"; W="$HOME_DIR/cortex-worker.mjs"; HUB=""; prev=""
for a in "$@"; do
  case "$a" in --hub=*) HUB="${a#--hub=}" ;; *) [ "$prev" = "--hub" ] && HUB="$a" ;; esac; prev="$a"
done
[ -n "$HUB" ] || HUB="${CORTEX_HUB_URL:-}"
[ -n "$HUB" ] || { [ -f "$W" ] && HUB="$(node "$W" hub-url 2>/dev/null)" || HUB=""; }
[ -n "$HUB" ] || die "no hub URL; pass --hub https://<your-mcp-host>"
HUB="$(printf '%s' "$HUB" | sed -E 's:^[[:space:]]+::; s:[[:space:]]+$::; s:/+$::; s:/mcp$::; s:/+$::')"
mkdir -p "$HOME_DIR"; rc=0
node -e '
const [url, out] = process.argv.slice(1);
fetch(url, { signal: AbortSignal.timeout(60000) }).then(async (r) => {
  if (r.status === 404) process.exit(44);
  if (!r.ok) { console.error("HTTP " + r.status); process.exit(1); }
  const body = await r.text();
  if (!body.startsWith("#!/usr/bin/env node")) { console.error("unexpected response body"); process.exit(1); }
  require("node:fs").writeFileSync(out, body);
}).catch((e) => { const c = e && e.cause; console.error(e && e.name === "TimeoutError" ? "timed out" : String(c && (c.code || (c.errors && c.errors[0] && c.errors[0].code) || c.message) || e)); process.exit(1); });
' "$HUB/conductor/worker.mjs" "$W.tmp.$$" || rc=$?
if [ "$rc" -eq 44 ]; then rm -f "$W.tmp.$$"; die "this hub does not serve the worker yet — upgrade the hub"; fi
if [ "$rc" -ne 0 ]; then
  rm -f "$W.tmp.$$"; [ -f "$W" ] || die "could not download the worker from $HUB"
  echo "[cortex] warning: download failed; using cached worker" >&2
else mv "$W.tmp.$$" "$W"; fi
# The cw command: `cw ls`, `cw logs 2 -f`, `cw restart --all` instead of `node <path> ...`.
# It is only ever a two-line wrapper around this worker, so a cw that is not ours stays as it is.
install_cw() {
  local bin="$HOME/.local/bin" cw w q body tmp rc found
  cw="$bin/cw"
  w="$(cd "$HOME_DIR" && pwd -P)/cortex-worker.mjs" || return 1
  if [ -e "$cw" ] && ! grep -q 'cortex-worker\.mjs' "$cw" 2>/dev/null; then
    echo "[cortex] $cw is not the Cortex one, so it stays; run the worker with: node $w" >&2; return 0
  fi
  q="$(printf '%s' "$w" | sed "s/'/'\\\\''/g")"
  body="$(printf '#!/bin/sh\n# cw: shortcut for the Cortex worker (written by run-agent.sh)\nexec node '\''%s'\'' "$@"' "$q")"
  if [ ! -f "$cw" ] || [ "$(cat "$cw")" != "$body" ]; then
    mkdir -p "$bin" || return 1
    tmp="$cw.tmp.$$"
    { printf '%s\n' "$body" > "$tmp" && chmod 755 "$tmp" && mv "$tmp" "$cw"; } || { rm -f "$tmp"; return 1; }
    echo "[cortex] installed the cw command ($cw); try: cw ls" >&2
  fi
  case ":$PATH:" in
    *":$bin:"*)
      found="$(command -v cw 2>/dev/null || true)"
      [ "$found" = "$cw" ] || echo "[cortex] another cw comes first on PATH ($found); run this one as $cw" >&2 ;;
    *)
      case "${SHELL##*/}" in zsh) rc="$HOME/.zshrc" ;; bash) rc="$HOME/.bashrc" ;; *) rc="$HOME/.profile" ;; esac
      if ! grep -qF '# Added by Cortex run-agent.sh' "$rc" 2>/dev/null; then
        printf '\n# Added by Cortex run-agent.sh: puts the cw command on PATH\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc" || return 1
        echo "[cortex] added ~/.local/bin to PATH in $rc; cw works in a new terminal" >&2
      fi ;;
  esac
}
if [ "${CORTEX_SKIP_CW:-}" != 1 ]; then install_cw || echo "[cortex] warning: could not install the cw command; run the worker with: node $W" >&2; fi
# Before a start: what the project needs and this machine lacks, in one list, asked about once.
# It never stops the start: the worker itself takes no task until the machine is ready.
# Under `curl | bash` stdin is this script, so the question goes to the terminal.
if [ "${1:-}" = start ] && [ "${CORTEX_SKIP_CHECK:-}" != 1 ]; then
  if { : </dev/tty; } 2>/dev/null; then node "$W" check --if-changed "${@:2}" </dev/tty || true
  else node "$W" check --if-changed "${@:2}" </dev/null || true; fi
fi
exec node "$W" "$@"
