#!/usr/bin/env bash
set -e

# Run experiments with wrangler tail log capture
# This script:
# 1. Starts wrangler tail in background, writing to a file
# 2. Runs the experiment
# 3. Stops wrangler tail
# 4. The experiment script parses the tail logs for billing metrics

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Configuration
TAIL_LOG_FILE="tail-logs.jsonl"
EXPERIMENT_SCRIPT="test/measurements.mjs"

echo "🚀 Starting experiment with wrangler tail log capture"
echo ""

# Check if previous tail log exists
if [ -f "$TAIL_LOG_FILE" ]; then
  echo "📁 Found existing tail log file: $TAIL_LOG_FILE"
  read -p "   Delete and start fresh? [Y/n]: " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    rm -f "$TAIL_LOG_FILE"
    echo "   ✅ Deleted old log file"
  fi
  echo ""
fi

# Start wrangler tail in background
echo "📡 Starting wrangler tail..."
wrangler tail --format json > "$TAIL_LOG_FILE" 2>&1 &
TAIL_PID=$!

# Give tail a moment to connect
sleep 3

echo "   ✅ Wrangler tail started (PID: $TAIL_PID)"
echo "   📄 Writing logs to: $TAIL_LOG_FILE"
echo ""

# Trap to ensure tail is killed on exit
cleanup() {
  echo ""
  echo "🛑 Stopping wrangler tail (PID: $TAIL_PID)..."
  kill $TAIL_PID 2>/dev/null || true
  wait $TAIL_PID 2>/dev/null || true
  echo "   ✅ Wrangler tail stopped"
  echo ""
  echo "📊 Tail log file: $TAIL_LOG_FILE"
  echo "   Lines captured: $(wc -l < "$TAIL_LOG_FILE" 2>/dev/null || echo "0")"
  echo ""
}
trap cleanup EXIT INT TERM

# Run the experiment
echo "🧪 Running experiment..."
echo ""

# Set environment variables for billing analysis
export WITH_BILLING=true
export TAIL_LOG_FILE="$TAIL_LOG_FILE"

# Use production URL if TEST_URL not already set
if [ -z "$TEST_URL" ]; then
  export TEST_URL="https://proxy-fetch-performance.transformation.workers.dev"
fi

# Support ENDPOINT_PATH env var (e.g., ENDPOINT_PATH=/delay/100 ./run-with-tail.sh 10)
# Defaults to /uuid if not set

node "$EXPERIMENT_SCRIPT" "$@"

# Cleanup will run automatically via trap

