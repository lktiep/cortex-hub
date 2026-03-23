#!/bin/bash
# bump-version.sh — Auto-increment version in version.json
# Usage:
#   ./scripts/bump-version.sh          → bump patch  (0.1.0 → 0.1.1)
#   ./scripts/bump-version.sh minor    → bump minor  (0.1.5 → 0.2.0)
#   ./scripts/bump-version.sh major    → bump major  (0.2.5 → 1.0.0)
#   ./scripts/bump-version.sh set 2.0.0 → set exact version

set -e

VERSION_FILE="$(dirname "$0")/../version.json"

if [ ! -f "$VERSION_FILE" ]; then
    echo '{"version":"0.1.0"}' > "$VERSION_FILE"
fi

CURRENT=$(python3 -c "import json; print(json.load(open('$VERSION_FILE'))['version'])")
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

# Update version.json
python3 -c "
import json
with open('$VERSION_FILE', 'w') as f:
    json.dump({'version': '$NEW_VERSION'}, f, indent=2)
    f.write('\n')
"

echo "$CURRENT → $NEW_VERSION"
