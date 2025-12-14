#!/bin/bash
# Version bump script for amp-acp
# Usage: ./scripts/bump-version.sh [major|minor|patch]

set -e

BUMP_TYPE="${1:-patch}"
DATE=$(date +%Y-%m-%d)

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Calculate new version
case "$BUMP_TYPE" in
  major)
    NEW_VERSION="$((MAJOR + 1)).0.0"
    ;;
  minor)
    NEW_VERSION="$MAJOR.$((MINOR + 1)).0"
    ;;
  patch)
    NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
    ;;
  *)
    echo "Usage: $0 [major|minor|patch]"
    exit 1
    ;;
esac

echo "Bumping version: $CURRENT_VERSION → $NEW_VERSION"

# Update package.json
node -e "
const fs = require('fs');
const pkg = require('./package.json');
pkg.version = '$NEW_VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Update CHANGELOG.md - replace [Unreleased] header and add comparison links
if [ -f CHANGELOG.md ]; then
  # Add new version header after [Unreleased]
  sed -i.bak "s/## \[Unreleased\]/## [Unreleased]\n\n## [$NEW_VERSION] - $DATE/" CHANGELOG.md
  
  # Update comparison links at bottom
  sed -i.bak "s|\[Unreleased\]: \(.*\)/compare/v$CURRENT_VERSION...HEAD|[Unreleased]: \1/compare/v$NEW_VERSION...HEAD\n[$NEW_VERSION]: \1/compare/v$CURRENT_VERSION...v$NEW_VERSION|" CHANGELOG.md
  
  rm -f CHANGELOG.md.bak
fi

echo "✓ Updated package.json to $NEW_VERSION"
echo "✓ Updated CHANGELOG.md with release date $DATE"
echo ""
echo "Next steps:"
echo "  1. Review changes: git diff"
echo "  2. Commit: git commit -am 'Release v$NEW_VERSION'"
echo "  3. Tag: git tag v$NEW_VERSION"
echo "  4. Push: git push && git push --tags"
