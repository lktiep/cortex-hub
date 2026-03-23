#!/bin/bash
# bump-version.sh — Auto-increment version in version.json
# Usage:
#   ./scripts/bump-version.sh          → bump patch  (0.1.0 → 0.1.1)
#   ./scripts/bump-version.sh minor    → bump minor  (0.1.5 → 0.2.0)
#   ./scripts/bump-version.sh major    → bump major  (0.2.5 → 1.0.0)
#   ./scripts/bump-version.sh set 2.0.0 → set exact version

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION_FILE="$SCRIPT_DIR/../version.json"

if [ ! -f "$VERSION_FILE" ]; then
    echo '{"version":"0.1.0"}' > "$VERSION_FILE"
fi

# Parse version without python3 dependency
CURRENT=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$VERSION_FILE" | grep -o '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "${1:-patch}" in
    patch)
        PATCH=$((PATCH + 1))
        ;;
    minor)
        MINOR=$((MINOR + 1))
        PATCH=0
        ;;
    major)
        MAJOR=$((MAJOR + 1))
        MINOR=0
        PATCH=0
        ;;
    set)
        if [ -z "$2" ]; then
            echo "Usage: $0 set <version>"
            exit 1
        fi
        IFS='.' read -r MAJOR MINOR PATCH <<< "$2"
        ;;
    *)
        echo "Usage: $0 [patch|minor|major|set <version>]"
        exit 1
        ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

# Write version.json (pure bash, no python)
printf '{\n  "version": "%s"\n}\n' "$NEW_VERSION" > "$VERSION_FILE"

echo "$CURRENT → $NEW_VERSION"
