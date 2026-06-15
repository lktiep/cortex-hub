#!/usr/bin/env bash
# ============================================================
# release.sh — Cortex Hub + Extension Release Pipeline
# Bumps version, builds, packages extension, tags, pushes.
# Usage: ./scripts/release.sh [patch|minor|major]
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

BUMP="${1:-patch}"

echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   ${GREEN}Cortex Hub — Release Pipeline${BLUE}          ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

cd "$PROJECT_ROOT"

# ── Step 1: Ensure clean working tree ──
if [ -n "$(git status --porcelain -- ':!pnpm-lock.yaml' ':!.claude/')" ]; then
  echo -e "${RED}Error: Working tree not clean. Commit or stash changes first.${NC}"
  git status --short
  exit 1
fi

# ── Step 2: Bump Hub version ──
CURRENT_VERSION=$(node -e "console.log(require('./version.json').version)")
case "$BUMP" in
  patch) NEW_VERSION=$(node -e "const v='$CURRENT_VERSION'.split('.');v[2]=+v[2]+1;console.log(v.join('.'))") ;;
  minor) NEW_VERSION=$(node -e "const v='$CURRENT_VERSION'.split('.');v[1]=+v[1]+1;v[2]=0;console.log(v.join('.'))") ;;
  major) NEW_VERSION=$(node -e "const v='$CURRENT_VERSION'.split('.');v[0]=+v[0]+1;v[1]=0;v[2]=0;console.log(v.join('.'))") ;;
  *) echo -e "${RED}Usage: $0 [patch|minor|major]${NC}"; exit 1 ;;
esac

echo -e "${GREEN}1/7${NC} Version bump: ${YELLOW}$CURRENT_VERSION${NC} → ${GREEN}$NEW_VERSION${NC}"
node -e "const f=require('fs');const d=JSON.parse(f.readFileSync('version.json','utf8'));d.version='$NEW_VERSION';f.writeFileSync('version.json',JSON.stringify(d,null,2)+'\n')"

# ── Step 3: Bump Extension version (sync with hub) ──
EXT_DIR="$PROJECT_ROOT/apps/cortex-extension"
if [ -f "$EXT_DIR/package.json" ]; then
  EXT_OLD=$(node -e "console.log(require('$EXT_DIR/package.json').version)")
  cd "$EXT_DIR"
  npm version "$BUMP" --no-git-tag-version > /dev/null 2>&1
  EXT_NEW=$(node -e "console.log(require('./package.json').version)")
  echo -e "${GREEN}2/7${NC} Extension: ${YELLOW}$EXT_OLD${NC} → ${GREEN}$EXT_NEW${NC}"
  cd "$PROJECT_ROOT"
else
  echo -e "${YELLOW}2/7${NC} Extension not found, skipping"
  EXT_NEW=""
fi

# ── Step 4: Full build ──
echo -e "${GREEN}3/7${NC} Building all packages..."
pnpm build > /dev/null 2>&1
echo -e "     Build ${GREEN}✓${NC}"

# ── Step 5: Build + Package Extension ──
if [ -n "$EXT_NEW" ]; then
  echo -e "${GREEN}4/7${NC} Packaging extension v${EXT_NEW}..."
  cd "$EXT_DIR"
  npm run build > /dev/null 2>&1
  npx @vscode/vsce package --no-dependencies > /dev/null 2>&1
  VSIX_FILE="cortex-agent-${EXT_NEW}.vsix"
  echo -e "     VSIX: ${GREEN}$VSIX_FILE${NC} ($(du -h "$VSIX_FILE" | cut -f1 | xargs))"
  cd "$PROJECT_ROOT"
fi

# ── Step 6: Commit + Tag ──
echo -e "${GREEN}5/7${NC} Committing release..."
git add version.json
[ -n "$EXT_NEW" ] && git add apps/cortex-extension/package.json apps/cortex-extension/package-lock.json "apps/cortex-extension/cortex-agent-${EXT_NEW}.vsix" 2>/dev/null || true
git commit -m "chore: release v${NEW_VERSION} (extension v${EXT_NEW:-N/A})" > /dev/null 2>&1

echo -e "${GREEN}6/7${NC} Tagging v${NEW_VERSION}..."
git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"

# ── Step 7: Push ──
echo -e "${GREEN}7/7${NC} Pushing to origin..."
git push origin master --tags 2>/dev/null

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Release v${NEW_VERSION} complete!              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Hub:       ${GREEN}v${NEW_VERSION}${NC}"
[ -n "$EXT_NEW" ] && echo -e "  Extension: ${GREEN}v${EXT_NEW}${NC} ($VSIX_FILE)"
echo -e "  Tag:       ${GREEN}v${NEW_VERSION}${NC}"
echo ""
echo -e "  ${BLUE}Next: deploy to server${NC}"
echo -e "  ssh user@host 'cd /path/to/cortex-hub && git pull && docker compose -f infra/docker-compose.yml build --no-cache && docker compose -f infra/docker-compose.yml up -d'"
echo ""
