#!/usr/bin/env bash
set -e

# Build all publishable packages
# This script compiles TypeScript source to JavaScript in dist/ directories

echo "🔨 Building packages..."

# Get the root directory
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

# Get list of publishable packages
mapfile -t PACKAGES < <(discover_packages)

if [ ${#PACKAGES[@]} -eq 0 ]; then
  echo "❌ No publishable packages found in packages/"
  exit 1
fi

echo "Found ${#PACKAGES[@]} publishable package(s): ${PACKAGES[*]}"
echo ""

for package in "${PACKAGES[@]}"; do
  echo "Building $package..."
  cd "$ROOT_DIR/$package"
  
  # Clean previous build
  rm -rf dist
  
  # Build with TypeScript
  npx tsc --project tsconfig.build.json
  
  echo "✓ Built $package"
done

cd "$ROOT_DIR"
echo "✅ All packages built successfully"
