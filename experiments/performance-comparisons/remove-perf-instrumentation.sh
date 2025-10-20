#!/bin/bash
# Script to remove all performance instrumentation code
# Usage: ./remove-perf-instrumentation.sh

echo "Removing performance instrumentation from RPC package..."

# Remove all lines between PERF_INSTRUMENTATION markers
find ../../packages/rpc/src -name "*.ts" -type f -exec sed -i.bak '/PERF_INSTRUMENTATION: START/,/PERF_INSTRUMENTATION: END/d' {} \;

# Clean up backup files
find ../../packages/rpc/src -name "*.bak" -type f -delete

echo "Done! Performance instrumentation removed."
echo "Run 'git diff' to review changes before committing."
