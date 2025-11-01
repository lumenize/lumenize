#!/usr/bin/env bash
set -e

# Restore package.json files to development mode (pointing to src/)
# Only package.json files are restored; dist/ and version changes remain

echo "🔄 Restoring package.json files to dev mode..."

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
PACKAGES=()
while IFS= read -r line; do
  [ -n "$line" ] && PACKAGES+=("$line")
done < <(discover_packages)

if [ ${#PACKAGES[@]} -eq 0 ]; then
  echo "❌ No publishable packages found in packages/"
  exit 1
fi

for package in "${PACKAGES[@]}"; do
  PACKAGE_DIR="$ROOT_DIR/$package"
  PACKAGE_JSON="$PACKAGE_DIR/package.json"
  
  echo "Restoring $package/package.json..."
  
  # Use Node.js to modify package.json
  node -e "
    const fs = require('fs');
    const path = '$PACKAGE_JSON';
    const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
    
    // Restore main entry points to src/
    pkg.main = 'src/index.ts';
    pkg.types = 'src/index.ts';
    
    // Restore exports
    if (pkg.exports) {
      if (pkg.exports['.']) {
        pkg.exports['.'].import = './src/index.ts';
        pkg.exports['.'].types = './src/index.ts';
      }
    }
    
    // Restore files array to src instead of dist
    if (pkg.files) {
      pkg.files = pkg.files.map(file => 
        file.replace(/^dist\//, 'src/')
      );
    }
    
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  "
  
  echo "✓ Restored $package/package.json"
done

echo ""
echo "✅ Development mode restored"
echo "   - package.json files point back to src/"
echo "   - Version numbers preserved"
echo "   - dist/ directories remain (use 'npm run clean' to remove)"
