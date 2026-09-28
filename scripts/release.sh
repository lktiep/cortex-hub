#!/usr/bin/env bash
# ============================================================
# release.sh — cut a stable Cortex Hub release
#
#   ./scripts/release.sh [patch|minor|major]      (default: minor)
#
# CI owns the version number. Every merge to master already claims the next
# patch version in version.json and publishes images under it, so bumping and
# tagging here as well would name two different commits after one version.
# This script asks CI for the release instead: the "Build and Publish Docker
# Images" workflow claims the version, builds every image from the release
# commit, tags them v<version> and :stable, then creates git tag v<version>
# and a GitHub Release on that same commit.
#
# Once it finishes, edit the generated notes with:
#   gh release edit v<version> --notes-file notes.md
# ============================================================

set -euo pipefail

BUMP="${1:-minor}"
case "$BUMP" in
  patch|minor|major) ;;
  *) echo "Usage: $0 [patch|minor|major]" >&2; exit 1 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v gh > /dev/null || { echo "gh (GitHub CLI) is required" >&2; exit 1; }

git fetch -q origin master
CURRENT=$(git show origin/master:version.json | grep -o '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*' | head -1)
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP" in
  patch) NEXT="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
  minor) NEXT="${MAJOR}.$((MINOR + 1)).0" ;;
  major) NEXT="$((MAJOR + 1)).0.0" ;;
esac

# A run still queued would claim a version first and shift this one.
if gh run list --workflow docker.yml --branch master --limit 5 --json status \
    --jq '.[] | select(.status != "completed")' | grep -q .; then
  echo "A Docker publish run is still in progress; release once it finishes." >&2
  exit 1
fi

echo "origin/master is at v${CURRENT}. Releasing v${NEXT} (stable)."
read -r -p "Continue? [y/N] " answer
[ "$answer" = "y" ] || [ "$answer" = "Y" ] || exit 1

gh workflow run docker.yml --ref master -f bump="$BUMP" -f stable=true
echo "Dispatched. Follow it with: gh run watch \$(gh run list --workflow docker.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
