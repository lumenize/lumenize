#!/usr/bin/env bash
set -e

# Full release orchestration script
# This script performs the complete release process:
# 1. Run all tests (packages + doc-tests)
# 2. Build packages
# 3. Update package.json to point to dist/
# 4. Version bump with Lerna
# 5. Publish to npm with Lerna
# 6. Restore package.json to point to src/
# 7. Commit the restored package.json files

echo "🚀 Starting release process..."
echo ""

# Get the root directory
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Check for uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Error: You have uncommitted changes. Please commit or stash them before releasing."
  git status --short
  exit 1
fi

echo "✅ Working directory is clean"
echo ""

# Step 1: Run tests for publishable packages only
echo "1️⃣  Running package tests..."
echo ""

PACKAGES=(
  "packages/rpc"
  "packages/testing"
  "packages/utils"
)

for package in "${PACKAGES[@]}"; do
  echo "Testing $package..."
  cd "$ROOT_DIR/$package"
  npm run test
  echo ""
done

cd "$ROOT_DIR"
echo "✅ Package tests passed"
echo ""

# Step 2: Run all doc-tests
echo "2️⃣  Running doc-tests..."
echo ""

# Find all doc-test directories
DOC_TEST_DIRS=(
  "doc-test/testing/testing-plain-do"
  "doc-test/testing/testing-agent-with-agent-client"
  "doc-test/rpc/quick-start"
)

for doc_test in "${DOC_TEST_DIRS[@]}"; do
  if [ -d "$doc_test" ]; then
    echo "Running tests in $doc_test..."
    cd "$ROOT_DIR/$doc_test"
    npm run test
    echo ""
  fi
done

cd "$ROOT_DIR"
echo "✅ Doc-tests passed"
echo ""

# Step 3: Build packages and update package.json
echo "3️⃣  Preparing packages for publish..."
echo ""
./scripts/prepare-for-publish.sh
echo ""

# Step 4: Version bump with Lerna
echo "4️⃣  Bumping version with Lerna..."
echo ""
echo "Choose version bump type:"
echo "  1) patch (0.8.0 → 0.8.1)"
echo "  2) minor (0.8.0 → 0.9.0)"
echo "  3) major (0.8.0 → 1.0.0)"
echo "  4) custom version"
echo ""
read -p "Enter choice [1-4]: " version_choice

case $version_choice in
  1)
    VERSION_ARG="patch"
    ;;
  2)
    VERSION_ARG="minor"
    ;;
  3)
    VERSION_ARG="major"
    ;;
  4)
    read -p "Enter custom version: " custom_version
    VERSION_ARG="$custom_version"
    ;;
  *)
    echo "❌ Invalid choice"
    ./scripts/restore-dev-mode.sh
    exit 1
    ;;
esac

npx lerna version $VERSION_ARG --yes
echo ""
echo "✅ Version bumped"
echo ""

# Step 5: Publish to npm
echo "5️⃣  Publishing to npm..."
echo ""
npx lerna publish from-package --yes
echo ""
echo "✅ Published to npm"
echo ""

# Step 6: Restore dev mode
echo "6️⃣  Restoring development mode..."
echo ""
./scripts/restore-dev-mode.sh
echo ""

# Step 7: Commit the restored package.json files
echo "7️⃣  Committing restored package.json files..."
echo ""
git add packages/*/package.json
git commit -m "chore: restore package.json to dev mode after publish"
git push
echo ""
echo "✅ Changes committed and pushed"
echo ""

echo "🎉 Release complete!"
echo ""
echo "📋 Summary:"
echo "   ✓ All tests passed"
echo "   ✓ Packages built and published to npm"
echo "   ✓ Development mode restored and committed"
echo ""
