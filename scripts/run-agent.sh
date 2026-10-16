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
exec node "$W" "$@"
