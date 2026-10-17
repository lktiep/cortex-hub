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

# The editor's command line: on PATH, else inside the macOS app bundle, else where Linux packages
# put it (deb: /usr/share/<cmd>/bin, snap: /snap/bin).
find_cli() {
  local cmd="$1" app="$2" bin
  if command -v "$cmd" >/dev/null 2>&1; then command -v "$cmd"; return 0; fi
  for bin in "/Applications/$app.app/Contents/Resources/app/bin/$cmd" "$HOME/Applications/$app.app/Contents/Resources/app/bin/$cmd" \
             "/usr/share/$cmd/bin/$cmd" "/snap/bin/$cmd"; do
    [ -x "$bin" ] && { echo "$bin"; return 0; }
  done
  return 1
}

EXT_ID="cortex-hub.cortex-agent"
# The version inside the VSIX (extension/package.json); empty without unzip.
vsix_version() {
  { unzip -p "$1" extension/package.json 2>/dev/null || true; } | sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}
# The version of cortex-agent the editor lists; empty when it lists none.
installed_version() {
  { "$1" --list-extensions --show-versions 2>/dev/null || true; } | grep -i "^$EXT_ID@" | head -n 1 | cut -d@ -f2 || true
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
DOWNLOADED=0
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
  DOWNLOADED=1
fi
[ -f "$VSIX" ] || die "no such file: $VSIX"
[ "$(head -c 2 "$VSIX")" = "PK" ] || die "$VSIX is not a VSIX (not a zip archive)"

EXPECTED="$(vsix_version "$VSIX")"

installed=0; failed=""
for entry in "antigravity:antigravity-ide:Antigravity IDE" "code:code:Visual Studio Code" "cursor:cursor:Cursor" "windsurf:windsurf:Windsurf"; do
  name="${entry%%:*}"; rest="${entry#*:}"; cmd="${rest%%:*}"; app="${rest#*:}"
  [ "$IDE" = "all" ] || [ "$IDE" = "$name" ] || continue
  cli="$(find_cli "$cmd" "$app")" || {
    [ "$IDE" = "all" ] || die "$app not found (no $cmd on PATH). Install it by hand: Extensions view, ... menu, Install from VSIX..."
    continue
  }
  echo "[cortex] $app: installing $EXT_ID${EXPECTED:+@$EXPECTED}"
  # Editors print warnings on stderr even when the install works (Antigravity IDE: "... depends on
  # antigravityAnalytics which is NOT registered"), so keep the output and show it only on failure.
  rc=0; "$cli" --install-extension "$VSIX" --force >"$TMP/$name.log" 2>&1 || rc=$?
  version="$(installed_version "$cli")"
  if [ -n "$version" ] && { [ -z "$EXPECTED" ] || [ "$version" = "$EXPECTED" ]; }; then
    echo "[cortex] $app: $EXT_ID@$version"
    installed=$((installed + 1))
  elif [ "$rc" -eq 0 ] && [ -z "$version" ]; then
    echo "[cortex] $app: installed (the editor did not list its version)"
    installed=$((installed + 1))
  else
    if [ -n "$version" ]; then why="it still lists $EXT_ID@$version"; else why="the install exited with code $rc"; fi
    echo "[cortex] $app: install failed: $why" >&2
    { grep -v 'NOT registered' "$TMP/$name.log" || true; } | tail -n 5 | sed 's/^/  /' >&2
    failed="${failed:+$failed, }$app"
  fi
done
[ "$installed" -gt 0 ] || [ -n "$failed" ] || die "no editor found; install Antigravity IDE, VS Code, Cursor or Windsurf, or pass --ide"
if [ -n "$failed" ]; then
  keep="$VSIX"
  if [ "$DOWNLOADED" = 1 ]; then
    # The download sits in a temp folder that is removed on exit: keep a copy to pick by hand.
    dir="$HOME/Downloads"; [ -d "$dir" ] || dir="$HOME"
    keep="$dir/cortex-agent${EXPECTED:+-$EXPECTED}.vsix"
    cp "$VSIX" "$keep"
  fi
  echo "[cortex] Install it by hand in $failed: open the Extensions view, click the ... menu, choose Install from VSIX..., and pick $keep"
  die "install failed in $failed"
fi
echo "[cortex] done. Reload each editor window (Developer: Reload Window), then open Cortex: Open Agent Panel."
