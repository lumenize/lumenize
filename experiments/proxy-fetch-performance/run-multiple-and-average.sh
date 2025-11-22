#!/usr/bin/env bash
set -e

# Run multiple test runs and average the results
# This avoids Cloudflare's 6-request queueing and timeout issues

ENDPOINT_PATH=$1
OPS_PER_RUN=${2:-6}
NUM_RUNS=${3:-5}

if [ -z "$ENDPOINT_PATH" ]; then
  echo "Usage: $0 <endpoint_path> [ops_per_run] [num_runs]"
  echo "Example: $0 /uuid 6 5"
  exit 1
fi

echo "🧪 Running $NUM_RUNS runs of $OPS_PER_RUN operations each"
echo "   Endpoint: $ENDPOINT_PATH"
echo ""

# Set endpoint
echo "$ENDPOINT_PATH" | wrangler secret put ENDPOINT_PATH > /dev/null 2>&1

# Results storage
RESULTS_DIR="/tmp/proxy-fetch-results-$$"
mkdir -p "$RESULTS_DIR"

# Run multiple times
for i in $(seq 1 $NUM_RUNS); do
  echo "Run $i/$NUM_RUNS..."
  rm -f tail-logs.jsonl
  
  # Run test
  echo "y" | ./run-with-tail.sh $OPS_PER_RUN > "$RESULTS_DIR/run-$i.txt" 2>&1 || {
    echo "  ⚠️  Run $i failed or incomplete"
    continue
  }
  
  # Extract key metrics from actual output format
  # Direct latency: "Avg: 62.50ms per operation"
  grep -A3 "direct:" "$RESULTS_DIR/run-$i.txt" | grep "Avg:" | sed 's/.*Avg: \([0-9.]*\)ms.*/\1/' > "$RESULTS_DIR/direct-latency-$i.txt" 2>/dev/null || true
  
  # Direct wall time: "Avg Wall Time: 41.60ms"
  grep -A8 "direct:" "$RESULTS_DIR/run-$i.txt" | grep "Avg Wall Time:" | sed 's/.*Avg Wall Time: \([0-9.]*\)ms.*/\1/' > "$RESULTS_DIR/direct-wall-$i.txt" 2>/dev/null || true
  
  # ProxyFetch latency: "Avg: 86.67ms per operation"
  grep -A3 "proxyfetch:" "$RESULTS_DIR/run-$i.txt" | grep "Avg:" | sed 's/.*Avg: \([0-9.]*\)ms.*/\1/' > "$RESULTS_DIR/proxyfetch-latency-$i.txt" 2>/dev/null || true
  
  # ProxyFetch wall time: "Avg Wall Time: 30.75ms"
  grep -A8 "proxyfetch:" "$RESULTS_DIR/run-$i.txt" | grep "Avg Wall Time:" | sed 's/.*Avg Wall Time: \([0-9.]*\)ms.*/\1/' > "$RESULTS_DIR/proxyfetch-wall-$i.txt" 2>/dev/null || true
  
  # Worker CPU time: "Worker: X logs, Yms CPU (Zms wall, not billed)"
  grep -A20 "Breakdown:" "$RESULTS_DIR/run-$i.txt" | grep "Worker:" | sed 's/.*Worker: [0-9]* logs, \([0-9.]*\)ms CPU.*/\1/' > "$RESULTS_DIR/worker-cpu-$i.txt" 2>/dev/null || true
  
  # Cost savings: "Cost savings: 26.3%"
  grep "Cost savings:" "$RESULTS_DIR/run-$i.txt" | sed 's/.*Cost savings: \([0-9.]*\)%.*/\1/' > "$RESULTS_DIR/savings-$i.txt" 2>/dev/null || true
  
  # Latency overhead: "ProxyFetch: +24.67ms (+39.8%)"
  grep "ProxyFetch:" "$RESULTS_DIR/run-$i.txt" | grep "Latency Overhead" | sed 's/.*ProxyFetch: \([+-][0-9.]*\)ms.*/\1/' > "$RESULTS_DIR/overhead-ms-$i.txt" 2>/dev/null || true
  grep "ProxyFetch:" "$RESULTS_DIR/run-$i.txt" | grep "Latency Overhead" | sed 's/.*(\([+-]*[0-9.]*\)%).*/\1/' > "$RESULTS_DIR/overhead-pct-$i.txt" 2>/dev/null || true
  
  echo "  ✅ Run $i complete"
done

echo ""
echo "📊 Averaging results..."
echo ""

# Parse and average
echo "=== AVERAGED RESULTS ==="
echo ""

# Direct latency
direct_lat=$(cat "$RESULTS_DIR/direct-latency-"*.txt 2>/dev/null | awk '{sum+=$1; count++} END {if(count>0) printf "%.2f", sum/count; else print "N/A"}')
direct_lat_count=$(cat "$RESULTS_DIR/direct-latency-"*.txt 2>/dev/null | wc -l | tr -d ' ')
echo "Direct Latency: ${direct_lat}ms/op (from $direct_lat_count runs)"

# Direct wall time
direct_wall=$(cat "$RESULTS_DIR/direct-wall-"*.txt 2>/dev/null | awk '{sum+=$1; count++} END {if(count>0) printf "%.2f", sum/count; else print "N/A"}')
direct_wall_count=$(cat "$RESULTS_DIR/direct-wall-"*.txt 2>/dev/null | wc -l | tr -d ' ')
echo "Direct Wall Time: ${direct_wall}ms/op (from $direct_wall_count runs)"

# ProxyFetch latency
proxy_lat=$(cat "$RESULTS_DIR/proxyfetch-latency-"*.txt 2>/dev/null | awk '{sum+=$1; count++} END {if(count>0) printf "%.2f", sum/count; else print "N/A"}')
proxy_lat_count=$(cat "$RESULTS_DIR/proxyfetch-latency-"*.txt 2>/dev/null | wc -l | tr -d ' ')
echo "ProxyFetch Latency: ${proxy_lat}ms/op (from $proxy_lat_count runs)"

# ProxyFetch wall time
proxy_wall=$(cat "$RESULTS_DIR/proxyfetch-wall-"*.txt 2>/dev/null | awk '{sum+=$1; count++} END {if(count>0) printf "%.2f", sum/count; else print "N/A"}')
proxy_wall_count=$(cat "$RESULTS_DIR/proxyfetch-wall-"*.txt 2>/dev/null | wc -l | tr -d ' ')
echo "ProxyFetch Wall Time: ${proxy_wall}ms/op (from $proxy_wall_count runs)"

# Calculate savings
if [ "$direct_wall" != "N/A" ] && [ "$proxy_wall" != "N/A" ]; then
  savings=$(echo "$direct_wall $proxy_wall" | awk '{printf "%.1f", (($1-$2)/$1)*100}')
  echo "Cost Savings: ${savings}%"
fi

# Worker CPU time
worker_cpu=$(cat "$RESULTS_DIR/worker-cpu-"*.txt 2>/dev/null | awk '{sum+=$1; count++} END {if(count>0) printf "%.2f", sum/count; else print "N/A"}')
worker_cpu_count=$(cat "$RESULTS_DIR/worker-cpu-"*.txt 2>/dev/null | wc -l | tr -d ' ')
if [ "$worker_cpu" != "N/A" ]; then
  echo "Worker CPU Time: ${worker_cpu}ms/op (from $worker_cpu_count runs) - This is what's billed for Workers"
fi

# Latency overhead (calculate from averages if not extracted)
if [ "$direct_lat" != "N/A" ] && [ "$proxy_lat" != "N/A" ]; then
  overhead_calc=$(echo "$direct_lat $proxy_lat" | awk '{printf "%.2f", $2-$1}')
  overhead_pct_calc=$(echo "$direct_lat $proxy_lat" | awk '{printf "%.1f", (($2-$1)/$1)*100}')
  echo "Latency Overhead: +${overhead_calc}ms (${overhead_pct_calc}%)"
else
  # Try to extract from files
  overhead_ms=$(cat "$RESULTS_DIR/overhead-ms-"*.txt 2>/dev/null | awk '{sum+=$1; count++} END {if(count>0) printf "%.2f", sum/count; else print "N/A"}')
  overhead_pct=$(cat "$RESULTS_DIR/overhead-pct-"*.txt 2>/dev/null | awk '{sum+=$1; count++} END {if(count>0) printf "%.1f", sum/count; else print "N/A"}')
  if [ "$overhead_ms" != "N/A" ]; then
    echo "Latency Overhead: +${overhead_ms}ms (${overhead_pct}%)"
  fi
fi

echo ""
echo "📁 Detailed results saved in: $RESULTS_DIR"
echo "   Review individual runs for verification"

