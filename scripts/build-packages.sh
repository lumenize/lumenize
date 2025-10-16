#!/usr/bin/env bash
set -e

# Build all publishable packages
# This script compiles TypeScript source to JavaScript in dist/ directories

echo "🔨 Building packages..."

# Get the root directory
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Build each package
PACKAGES=(
  "packages/rpc"
  "packages/testing"
  "packages/utils"
)

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
