#!/bin/bash
# Stress test to catch intermittent failures

RUNS=20
FAILURES=0
PASSES=0

for i in $(seq 1 $RUNS); do
  echo "===== Run $i/$RUNS ====="
  
  npm test > /tmp/proxy-fetch-test-$i.log 2>&1
  
  if [ $? -eq 0 ]; then
    echo "✅ Pass"
    PASSES=$((PASSES + 1))
  else
    echo "❌ Fail - saved to /tmp/proxy-fetch-test-$i.log"
    FAILURES=$((FAILURES + 1))
    # Show the failure
    grep -A 20 "FAIL" /tmp/proxy-fetch-test-$i.log | head -25
  fi
  
  echo ""
  sleep 0.5
done

echo "=========================================="
echo "Results: $PASSES passes, $FAILURES failures out of $RUNS runs"
echo "Failure rate: $(echo "scale=2; $FAILURES * 100 / $RUNS" | bc)%"
echo "=========================================="

if [ $FAILURES -gt 0 ]; then
  echo "Failure logs saved to /tmp/proxy-fetch-test-*.log"
  exit 1
fi

