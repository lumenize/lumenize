#!/usr/bin/env bash
set -e

# Generate TypeScript types for all wrangler.jsonc files in packages/ and apps/
# Each wrangler.jsonc gets a worker-configuration.d.ts generated alongside it

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "Generating TypeScript types from wrangler.jsonc files..."
echo ""

while IFS= read -r wrangler_file; do
  wrangler_dir="$(dirname "$wrangler_file")"

  # Show relative path for clarity
  echo "📦 $wrangler_dir"
  cd "$wrangler_dir"

  # Run wrangler types, suppress verbose output
  if wrangler types > /dev/null 2>&1; then
    echo "   ✓ Types generated"
  else
    echo "   ⚠ Failed to generate types"
  fi

  cd "$PROJECT_ROOT"
  echo ""
done < <(find packages apps -name "wrangler.jsonc" -not -path "*/node_modules/*" -not -path "*/dist/*")

echo "✅ Type generation complete"
