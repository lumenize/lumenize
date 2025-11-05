#!/usr/bin/env bash
set -e

# Setup .dev.vars symlinks for all directories containing wrangler.jsonc
# Auto-discovers wrangler.jsonc files and creates symlinks to root .dev.vars

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "Setting up .dev.vars symlinks..."

# Calculate relative path from source directory to target file
calculate_relative_path() {
  local source_dir="$1"
  local target_file="$2"
  
  # Count directory depth (number of slashes)
  local depth=$(echo "$source_dir" | tr -cd '/' | wc -c)
  
  # Build ../../../ path based on depth
  local relative=""
  for ((i=0; i<depth; i++)); do
    relative="../$relative"
  done
  
  echo "${relative}${target_file}"
}

create_symlink() {
  local wrangler_dir="$1"
  local link_path="$wrangler_dir/.dev.vars"
  
  # Skip if this is the root directory (where the actual .dev.vars lives)
  if [ "$wrangler_dir" = "." ]; then
    return
  fi
  
  # Calculate relative path from wrangler dir to root .dev.vars
  local relative_target=$(calculate_relative_path "$wrangler_dir" ".dev.vars")
  
  # Check if symlink already exists and is correct
  if [ -L "$link_path" ]; then
    local current_target="$(readlink "$link_path")"
    if [ "$current_target" = "$relative_target" ]; then
      echo "  ✓ $link_path (already correct)"
      return
    else
      echo "  ⚠ $link_path (wrong target: $current_target, updating)"
      rm "$link_path"
    fi
  elif [ -e "$link_path" ]; then
    echo "  ⚠ $link_path (exists but is not a symlink, skipping)"
    return
  fi
  
  # Create symlink
  ln -s "$relative_target" "$link_path"
  echo "  ✓ $link_path (created)"
}

# Find all wrangler.jsonc files and create symlinks in their directories
while IFS= read -r wrangler_file; do
  wrangler_dir="$(dirname "$wrangler_file")"
  create_symlink "$wrangler_dir"
done < <(find . -name "wrangler.jsonc" -not -path "*/node_modules/*" -not -path "*/dist/*")

echo "✅ Symlink setup complete"

# Remind about .dev.vars if it doesn't exist
if [ ! -f ".dev.vars" ]; then
  echo ""
  echo "ℹ️  Note: .dev.vars not found. Copy .dev.vars.example to .dev.vars to get started:"
  echo "   cp .dev.vars.example .dev.vars"
fi

