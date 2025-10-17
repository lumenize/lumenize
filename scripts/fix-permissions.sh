#!/usr/bin/env bash
# Fix executable permissions on all scripts
# Run this if you clone the repo fresh or if permissions are lost

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🔧 Setting executable permissions on scripts..."
chmod +x "$SCRIPT_DIR"/*.sh
echo "✅ Done! All scripts in $SCRIPT_DIR are now executable."
