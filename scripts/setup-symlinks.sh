#!/usr/bin/env bash
set -e

# Setup .dev.vars symlinks for test directories
# This ensures fresh clones work, especially on Windows or if symlinks get deleted

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "Setting up .dev.vars symlinks..."

# Define symlinks: target_path:link_path (relative to PROJECT_ROOT)
SYMLINKS=(
  ".dev.vars:tooling/test-endpoints/.dev.vars:../.."
  ".dev.vars:tooling/test-endpoints/test/.dev.vars:../../.."
  ".dev.vars:packages/proxy-fetch/test/do/.dev.vars:../../../.."
  ".dev.vars:packages/proxy-fetch/test/queue/.dev.vars:../../../.."
  ".dev.vars:packages/proxy-fetch/test/for-docs/.dev.vars:../../../.."
  ".dev.vars:packages/proxy-fetch/test/production/.dev.vars:../../../.."
)

create_symlink() {
  local target="$1"      # What we're pointing to (e.g., .dev.vars)
  local link_path="$2"   # Where the symlink lives
  local relative="$3"    # Relative path from link to target
  
  local link_dir="$(dirname "$link_path")"
  
  # Create parent directory if needed
  mkdir -p "$link_dir"
  
  # Check if symlink already exists and is correct
  if [ -L "$link_path" ]; then
    local current_target="$(readlink "$link_path")"
    if [ "$current_target" = "$relative/$target" ]; then
      echo "  ✓ $link_path (already correct)"
      return
    else
      echo "  ⚠ $link_path (wrong target: $current_target)"
      rm "$link_path"
    fi
  elif [ -e "$link_path" ]; then
    echo "  ⚠ $link_path (exists but is not a symlink, skipping)"
    return
  fi
  
  # Create symlink
  ln -s "$relative/$target" "$link_path"
  echo "  ✓ $link_path (created)"
}

for entry in "${SYMLINKS[@]}"; do
  IFS=':' read -r target link_path relative <<< "$entry"
  create_symlink "$target" "$link_path" "$relative"
done

echo "✅ Symlink setup complete"

# Remind about .dev.vars if it doesn't exist
if [ ! -f ".dev.vars" ]; then
  echo ""
  echo "ℹ️  Note: .dev.vars not found. Copy .dev.vars.example to .dev.vars to get started:"
  echo "   cp .dev.vars.example .dev.vars"
fi

