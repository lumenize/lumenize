#!/usr/bin/env bash
set -e

# Generate TypeScript types for all packages with wrangler.jsonc at root
# This ensures src/ files can reference Env types

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "Generating TypeScript types from wrangler.jsonc files..."
echo ""

# Find all package-root wrangler.jsonc files (not in test/ subdirs)
while IFS= read -r wrangler_file; do
  wrangler_dir="$(dirname "$wrangler_file")"
  
  # Skip if this is inside a test directory
  if [[ "$wrangler_dir" == *"/test/"* ]] || [[ "$wrangler_dir" == *"/test" ]]; then
    continue
  fi
  
  echo "📦 $(basename "$wrangler_dir")"
  cd "$wrangler_dir"
  
  # Run wrangler types, suppress verbose output
  if wrangler types > /dev/null 2>&1; then
    echo "   ✓ Types generated"
  else
    echo "   ⚠ Failed to generate types"
  fi
  
  cd "$PROJECT_ROOT"
  echo ""
done < <(find packages tooling -name "wrangler.jsonc" -not -path "*/node_modules/*" -not -path "*/dist/*")

echo "✅ Type generation complete"

