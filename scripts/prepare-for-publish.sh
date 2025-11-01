#!/usr/bin/env bash
set -e

# Prepare packages for publishing by:
# 1. Building TypeScript to JavaScript
# 2. Updating package.json to point to dist/ instead of src/

echo "📦 Preparing packages for publish..."

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

# First, build all packages
"$ROOT_DIR/scripts/build-packages.sh"

# Get list of publishable packages
mapfile -t PACKAGES < <(discover_packages)

if [ ${#PACKAGES[@]} -eq 0 ]; then
  echo "❌ No publishable packages found in packages/"
  exit 1
fi

echo ""
echo "📝 Updating package.json files to point to dist/..."

for package in "${PACKAGES[@]}"; do
  PACKAGE_DIR="$ROOT_DIR/$package"
  PACKAGE_JSON="$PACKAGE_DIR/package.json"
  
  echo "Updating $package/package.json..."
  
  # Use Node.js to modify package.json
  node -e "
    const fs = require('fs');
    const path = '$PACKAGE_JSON';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    
    // Update main entry points
    pkg.main = 'dist/index.js';
    pkg.types = 'dist/index.d.ts';
    
    // Update exports
    if (pkg.exports) {
      if (pkg.exports['.']) {
        pkg.exports['.'].import = './dist/index.js';
        pkg.exports['.'].types = './dist/index.d.ts';
      }
    }
    
    // Update files array to include dist instead of src
    if (pkg.files) {
      pkg.files = pkg.files.map(file => 
        file.replace(/^src\//, 'dist/')
      );
    }
    
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  "
  
  echo "✓ Updated $package/package.json"
done

echo ""
echo "✅ Packages prepared for publishing"
echo "   - Built to dist/"
echo "   - package.json files point to dist/"
