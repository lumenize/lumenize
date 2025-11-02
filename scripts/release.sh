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

# Auto-discover publishable packages (exclude private packages)
discover_packages() {
  local packages_dir="$ROOT_DIR/packages"
  local packages=()
  
  for dir in "$packages_dir"/*; do
    if [ -d "$dir" ] && [ -f "$dir/package.json" ]; then
      # Ensure absolute path for Node.js require
      local abs_dir="$(cd "$dir" && pwd)"
      
      # Check if package is private
      if ! node -e "const pkg = require('$abs_dir/package.json'); process.exit(pkg.private ? 1 : 0);" 2>/dev/null; then
        continue  # Skip private packages
      fi
      
      # Get relative path from ROOT_DIR
      local rel_path="${abs_dir#$ROOT_DIR/}"
      packages+=("$rel_path")
    fi
  done
  
  printf '%s\n' "${packages[@]}"
}

# Step 1: Run tests for publishable packages only
echo "1️⃣  Running package tests..."
echo ""

# Get list of publishable packages
PACKAGES=()
while IFS= read -r line; do
  [ -n "$line" ] && PACKAGES+=("$line")
done < <(discover_packages)

if [ ${#PACKAGES[@]} -eq 0 ]; then
  echo "❌ No publishable packages found in packages/"
  exit 1
fi

echo "Found ${#PACKAGES[@]} publishable package(s): ${PACKAGES[*]}"
echo ""

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

# Check external dependency versions against npm registry
echo "ℹ️  Checking external dependency versions..."

# Check Cap'n Web
CAPNWEB_CURRENT=$(node -e "console.log(require('./node_modules/capnweb/package.json').version)" 2>/dev/null || echo "not installed")
if [ "$CAPNWEB_CURRENT" != "not installed" ]; then
  CAPNWEB_LATEST=$(npm view capnweb version 2>/dev/null || echo "unknown")
  echo "   Cap'n Web installed: v$CAPNWEB_CURRENT"
  echo "   Cap'n Web latest:    v$CAPNWEB_LATEST"
  
  if [ "$CAPNWEB_CURRENT" != "$CAPNWEB_LATEST" ] && [ "$CAPNWEB_LATEST" != "unknown" ]; then
    echo ""
    echo "⚠️  WARNING: A newer version of Cap'n Web is available!"
    echo "   Consider upgrading and updating the performance comparison doc-test."
    echo ""
    read -p "Continue with release anyway? [y/N]: " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "❌ Release cancelled"
      ./scripts/restore-dev-mode.sh
      exit 1
    fi
  fi
fi

# Check @cloudflare/actors
ACTORS_CURRENT=$(node -e "console.log(require('./doc-test/actors/alarms/basic-usage/node_modules/@cloudflare/actors/package.json').version)" 2>/dev/null || echo "not installed")
if [ "$ACTORS_CURRENT" != "not installed" ]; then
  ACTORS_LATEST=$(npm view @cloudflare/actors version 2>/dev/null || echo "unknown")
  echo "   @cloudflare/actors installed: v$ACTORS_CURRENT"
  echo "   @cloudflare/actors latest:    v$ACTORS_LATEST"
  
  if [ "$ACTORS_CURRENT" != "$ACTORS_LATEST" ] && [ "$ACTORS_LATEST" != "unknown" ]; then
    echo ""
    echo "⚠️  WARNING: Lumenize is using @cloudflare/actors v$ACTORS_CURRENT,"
    echo "   but the latest version on npm is v$ACTORS_LATEST."
    echo "   Consider upgrading and updating the actors/alarms doc-test."
    echo ""
    read -p "Do you want to abort the release? [y/N]: " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      echo "❌ Release cancelled"
      ./scripts/restore-dev-mode.sh
      exit 1
    fi
  fi
fi
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
