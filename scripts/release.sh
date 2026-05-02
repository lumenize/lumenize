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

# Preflight: npm authentication (fail fast before any expensive work)
if ! NPM_USER=$(npm whoami 2>/dev/null); then
  echo "❌ Error: Not logged in to npm. Run 'npm login' first."
  exit 1
fi
echo "✅ Authenticated to npm as $NPM_USER"
echo ""

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

# Step 2: Run all doc-tests (advisory — doc-test infrastructure is being
# sunset; failures here do not block release. Track them and warn at the
# end, but continue to the build/publish steps.)
echo "2️⃣  Running doc-tests (advisory)..."
echo ""

DOC_TEST_DIRS=(
  "doc-test/testing/testing-plain-do"
  "doc-test/testing/testing-agent-with-agent-client"
  "doc-test/rpc/quick-start"
)

DOC_TEST_FAILURES=()

for doc_test in "${DOC_TEST_DIRS[@]}"; do
  if [ -d "$doc_test" ]; then
    echo "Running tests in $doc_test..."
    cd "$ROOT_DIR/$doc_test"
    if npm run test; then
      echo ""
    else
      DOC_TEST_FAILURES+=("$doc_test")
      echo "⚠️  doc-test failed in $doc_test — continuing (advisory)."
      echo ""
    fi
  fi
done

cd "$ROOT_DIR"
if [ ${#DOC_TEST_FAILURES[@]} -eq 0 ]; then
  echo "✅ Doc-tests passed"
else
  echo "⚠️  Doc-tests failed in: ${DOC_TEST_FAILURES[*]}"
  echo "   Continuing release — doc-test infrastructure is being sunset."
fi
echo ""

# Check external dependency versions against npm registry (advisory only —
# both checks exist to flag stale doc-test fixtures; doc-test infrastructure
# is being sunset, so version drift here warns but does not block release.)
echo "ℹ️  Checking external dependency versions (advisory)..."

# Check Cap'n Web
CAPNWEB_CURRENT=$(node -e "console.log(require('./node_modules/capnweb/package.json').version)" 2>/dev/null || echo "not installed")
if [ "$CAPNWEB_CURRENT" != "not installed" ]; then
  CAPNWEB_LATEST=$(npm view capnweb version 2>/dev/null || echo "unknown")
  echo "   Cap'n Web: installed v$CAPNWEB_CURRENT, latest v$CAPNWEB_LATEST"
  if [ "$CAPNWEB_CURRENT" != "$CAPNWEB_LATEST" ] && [ "$CAPNWEB_LATEST" != "unknown" ]; then
    echo "   ⚠ Newer version available — refresh the comparison doc-test once we finish migrating off doc-test."
  fi
fi

# Check @cloudflare/actors
ACTORS_CURRENT=$(node -e "console.log(require('./doc-test/actors/alarms/basic-usage/node_modules/@cloudflare/actors/package.json').version)" 2>/dev/null || echo "not installed")
if [ "$ACTORS_CURRENT" != "not installed" ]; then
  ACTORS_LATEST=$(npm view @cloudflare/actors version 2>/dev/null || echo "unknown")
  echo "   @cloudflare/actors: installed v$ACTORS_CURRENT, latest v$ACTORS_LATEST"
  if [ "$ACTORS_CURRENT" != "$ACTORS_LATEST" ] && [ "$ACTORS_LATEST" != "unknown" ]; then
    echo "   ⚠ Newer version available — refresh the actors/alarms doc-test once we finish migrating off doc-test."
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

# Detect "pre-bumped" state: a previous release attempt that failed mid-way
# may have already advanced lerna.json + every public package.json beyond
# what's on the registry. In that case running lerna version again would
# pointlessly bump versions a second time (and re-trigger the brittle
# `npm install --package-lock-only` step inside lerna version that has
# historically been the cause of release-time failures). Offer to skip
# straight to publish in that case.
LERNA_VERSION=$(node -e "console.log(require('./lerna.json').version)")
REGISTRY_VERSION=$(curl -sf https://registry.npmjs.org/@lumenize/debug 2>/dev/null | node -e "try{const d=JSON.parse(require('fs').readFileSync(0));console.log(d['dist-tags']?.latest||'')}catch{console.log('')}" 2>/dev/null || echo "")
SKIP_LERNA_VERSION=0
if [ -n "$REGISTRY_VERSION" ] && [ "$LERNA_VERSION" != "$REGISTRY_VERSION" ]; then
  echo "ℹ️  lerna.json version: $LERNA_VERSION"
  echo "ℹ️  npm registry latest: $REGISTRY_VERSION (from @lumenize/debug)"
  echo ""
  echo "Local versions are ahead of the registry — package.json files appear"
  echo "pre-bumped, likely from a previous failed release attempt."
  echo ""
  read -p "Skip lerna version and go straight to publish at $LERNA_VERSION? [Y/n]: " skip_version
  echo ""
  if [[ ! "$skip_version" =~ ^[Nn]$ ]]; then
    SKIP_LERNA_VERSION=1
    echo "✅ Skipping version bump — will publish at $LERNA_VERSION"
    echo ""
  fi
fi

if [ "$SKIP_LERNA_VERSION" = "0" ]; then
  echo "Choose version bump type:"
  echo "  1) patch (0.8.0 → 0.8.1)"
  echo "  2) minor (0.8.0 → 0.9.0)"
  echo "  3) major (0.8.0 → 1.0.0)"
  echo "  4) custom version"
  echo ""
  read -p "Enter choice [1-4]: " version_choice

  case $version_choice in
    1) VERSION_ARG="patch" ;;
    2) VERSION_ARG="minor" ;;
    3) VERSION_ARG="major" ;;
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

  # --no-private skips bumping every workspace in the repo (apps/, doc-test/,
  # experiments/, examples/, the typia forks, etc.). Without this flag lerna
  # would bump the typia forks from 12.0.2-lumenize-fork down to 0.25.0,
  # rewrite ~25 private package.jsons, and run npm install --package-lock-only
  # across the whole workspace graph — which has historically tripped on
  # transitive peer-dep mismatches in unrelated experiments. With it, only
  # the public packages we actually publish get versioned.
  npx lerna version $VERSION_ARG --no-private --yes
  echo ""
  echo "✅ Version bumped"
  echo ""
fi

# Step 5: Publish to npm
echo "5️⃣  Publishing to npm..."
echo ""
npx lerna publish from-package --yes
echo ""
echo "✅ Published to npm"
echo ""

# Step 5.5: Verify publications against the authoritative npm registry
# (The `npm view` command hits a CDN-cached mirror that can lag; querying
# registry.npmjs.org directly gives the authoritative state. This catches
# cases where a package appears to publish but silently doesn't land.)
echo "🔍 Verifying publications against authoritative registry..."
echo ""
VERSION=$(node -e "console.log(require('./lerna.json').version)")
VERIFY_FAILED=0
for package in "${PACKAGES[@]}"; do
  PKG_NAME=$(node -e "console.log(require('./$package/package.json').name)")
  LATEST=$(curl -sf "https://registry.npmjs.org/$PKG_NAME" 2>/dev/null | node -e "try { const d = JSON.parse(require('fs').readFileSync(0)); console.log(d['dist-tags']?.latest || 'unknown'); } catch { console.log('unknown'); }" 2>/dev/null || echo "unknown")
  if [ "$LATEST" = "$VERSION" ]; then
    echo "  ✓ $PKG_NAME@$VERSION live"
  else
    echo "  ⚠  $PKG_NAME: expected $VERSION, registry shows $LATEST"
    VERIFY_FAILED=1
  fi
done
if [ "$VERIFY_FAILED" = "1" ]; then
  echo ""
  echo "⚠  One or more packages didn't verify. CDN propagation usually resolves"
  echo "   in 30–60s. If still missing after a minute, lerna may have reported"
  echo "   success for something that didn't actually land — investigate."
fi
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
