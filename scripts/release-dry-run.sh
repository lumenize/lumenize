#!/usr/bin/env bash
set -e

# Release orchestration script (DRY RUN)
# This script runs all the steps of a release without actually publishing

echo "🚀 Starting release dry-run..."
echo ""

# Get the root directory
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Preflight: npm authentication (same gate as release.sh, so the dry-run
# catches the exact same class of problem before you discover it mid-release)
if ! NPM_USER=$(npm whoami 2>/dev/null); then
  echo "❌ Error: Not logged in to npm. Run 'npm login' first."
  exit 1
fi
echo "✅ Authenticated to npm as $NPM_USER"
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

# Step 2: Run all doc-tests (advisory — see release.sh for rationale.
# Mirror the actual release behavior so the dry-run accurately reflects
# what the release will do.)
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
  echo "   Continuing dry-run — doc-test infrastructure is being sunset."
fi
echo ""

# Step 3: Build packages
echo "3️⃣  Building packages..."
echo ""
./scripts/prepare-for-publish.sh
echo ""

# Step 4: Version bump (dry-run)
echo "4️⃣  Simulating version bump..."
echo ""
echo "This would run: npx lerna version --no-git-tag-version --no-push"
echo "Skipping actual version bump in dry-run mode"
echo ""

# Step 5: Publish (dry-run)
echo "5️⃣  Simulating npm publish..."
echo ""
echo "This would run: npx lerna publish from-package --yes"
echo "Skipping actual publish in dry-run mode"
echo ""

# Step 6: Restore dev mode
echo "6️⃣  Restoring development mode..."
echo ""
./scripts/restore-dev-mode.sh
echo ""

echo "✅ Dry-run complete!"
echo ""
echo "📋 Summary:"
echo "   ✓ All package tests passed"
if [ ${#DOC_TEST_FAILURES[@]} -eq 0 ]; then
  echo "   ✓ All doc-tests passed"
else
  echo "   ⚠ Doc-tests failed (advisory): ${DOC_TEST_FAILURES[*]}"
fi
echo "   ✓ All packages built successfully"
echo "   ✓ Development mode restored"
echo ""
echo "To perform an actual release, run: npm run release"
