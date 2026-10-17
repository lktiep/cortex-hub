#!/usr/bin/env bash
# Cortex Hub: installs the cortex-agent extension into Antigravity IDE, VS Code, Cursor and Windsurf.
# Downloads cortex-agent.vsix from the latest GitHub release and installs it into every editor whose
# command line it finds, replacing an older copy (same id, cortex-hub.cortex-agent).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install-extension.sh | bash
#   ... | bash -s -- --ide antigravity        # one editor: antigravity, code, cursor or windsurf
#   ... | bash -s -- --release v1.0.1         # the VSIX of one release instead of the latest
#   bash install-extension.sh --vsix ./cortex-agent.vsix   # a VSIX you built (pnpm --filter cortex-agent package)
#
# Restart or reload the editor window afterwards (Developer: Reload Window).
set -euo pipefail
die() { echo "[cortex] $*" >&2; exit 1; }

REPO="lktiep/cortex-hub"
IDE="all"; RELEASE=""; VSIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ide) IDE="${2:-}"; shift 2 ;;
    --ide=*) IDE="${1#--ide=}"; shift ;;
    --release) RELEASE="${2:-}"; shift 2 ;;
    --release=*) RELEASE="${1#--release=}"; shift ;;
    --vsix) VSIX="${2:-}"; shift 2 ;;
    --vsix=*) VSIX="${1#--vsix=}"; shift ;;
    -h|--help) sed -n '2,12p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown argument: $1 (try --ide, --release or --vsix)" ;;
  esac
done
case "$IDE" in all|antigravity|code|cursor|windsurf) ;; *) die "--ide must be antigravity, code, cursor or windsurf" ;; esac

# The editor's command line: on PATH, else inside the macOS app bundle.
find_cli() {
  local cmd="$1" app="$2" bin
  if command -v "$cmd" >/dev/null 2>&1; then command -v "$cmd"; return 0; fi
  for bin in "/Applications/$app.app/Contents/Resources/app/bin/$cmd" "$HOME/Applications/$app.app/Contents/Resources/app/bin/$cmd"; do
    [ -x "$bin" ] && { echo "$bin"; return 0; }
  done
  return 1
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if [ -z "$VSIX" ]; then
  if [ -n "$RELEASE" ]; then
    case "$RELEASE" in v*) ;; *) RELEASE="v$RELEASE" ;; esac
    URL="https://github.com/$REPO/releases/download/$RELEASE/cortex-agent.vsix"
  else
    URL="https://github.com/$REPO/releases/latest/download/cortex-agent.vsix"
  fi
  echo "[cortex] downloading $URL"
  VSIX="$TMP/cortex-agent.vsix"
  curl -fsSL --retry 2 -o "$VSIX" "$URL" || die "download failed: $URL"
fi
[ -f "$VSIX" ] || die "no such file: $VSIX"
[ "$(head -c 2 "$VSIX")" = "PK" ] || die "$VSIX is not a VSIX (not a zip archive)"

installed=0
for entry in "antigravity:antigravity-ide:Antigravity IDE" "code:code:Visual Studio Code" "cursor:cursor:Cursor" "windsurf:windsurf:Windsurf"; do
  name="${entry%%:*}"; rest="${entry#*:}"; cmd="${rest%%:*}"; app="${rest#*:}"
  [ "$IDE" = "all" ] || [ "$IDE" = "$name" ] || continue
  cli="$(find_cli "$cmd" "$app")" || { [ "$IDE" = "all" ] || die "$app not found (no $cmd on PATH)"; continue; }
  echo "[cortex] $app: installing"
  if "$cli" --install-extension "$VSIX" --force >/dev/null; then
    version="$("$cli" --list-extensions --show-versions 2>/dev/null | grep -i '^cortex-hub.cortex-agent@' || true)"
    echo "[cortex] $app: ${version:-installed}"
    installed=$((installed + 1))
  else
    echo "[cortex] $app: install failed" >&2
  fi
done
[ "$installed" -gt 0 ] || die "no editor found; install Antigravity IDE, VS Code, Cursor or Windsurf, or pass --ide"
echo "[cortex] done. Reload each editor window (Developer: Reload Window), then open Cortex: Open Agent Panel."
