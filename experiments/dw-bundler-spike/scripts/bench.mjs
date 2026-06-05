#!/usr/bin/env node

// Benchmark client — run from YOUR machine against deployed Worker.
// Usage: node scripts/bench.mjs <base-url>

const BASE = process.argv[2];

if (!BASE) {
  console.error('Usage: node scripts/bench.mjs <base-url>');
  console.error('Example: node scripts/bench.mjs https://dw-bundler-spike.transformation.workers.dev');
  process.exit(1);
}

async function run(path) {
  const url = `${BASE}${path}`;
  const start = performance.now();
  const res = await fetch(url);
  const wallMs = Math.round(performance.now() - start);

  if (!res.ok) {
    const text = await res.text();
    const match = text.match(/error_desc">(.*?)</) || ['', `HTTP ${res.status}`];
    return { wallMs, error: match[1] };
  }

  const data = await res.json();
  return { wallMs, data };
}

function fmt(r) {
  if (r.error) return `FAIL — ${r.error} (${r.wallMs} ms)`;
  return `${r.wallMs} ms`;
}

async function main() {
  console.log(`\nBenchmarking ${BASE}\n`);

  // 1. Ping — pure network round-trip
  console.log('--- Ping (network baseline) ---');
  const pings = [];
  for (let i = 0; i < 5; i++) pings.push((await run('/ping')).wallMs);
  const pingMedian = [...pings].sort((a, b) => a - b)[Math.floor(pings.length / 2)];
  console.log(`  ${pings.join(', ')} ms  (median: ${pingMedian} ms)`);

  // 2. In-process tsc (no DW)
  console.log('\n--- In-process tsc (no DW, 5x single check) ---');
  for (let i = 0; i < 5; i++) {
    const r = await run('/inprocess/check');
    console.log(`  #${i + 1}: ${fmt(r)}`);
  }

  console.log('\n--- In-process E2E (6 validations, no DW) ---');
  const ipe = await run('/inprocess/e2e');
  console.log(`  ${fmt(ipe)}`);

  // 3. Plain Worker (Service Binding)
  console.log('\n--- Plain Worker via Service Binding (5x single check) ---');
  for (let i = 0; i < 5; i++) {
    const r = await run('/worker/check');
    if (r.error) {
      console.log(`  #${i + 1}: ${fmt(r)}`);
    } else {
      const isFirst = r.data?.isFirstCall;
      console.log(`  #${i + 1}: ${r.wallMs} ms${isFirst ? ' (first call)' : ''}`);
    }
  }

  console.log('\n--- Plain Worker E2E (6 validations) ---');
  const we = await run('/worker/e2e');
  console.log(`  ${fmt(we)}`);

  // 4. Pre-bundled DW cold
  console.log('\n--- Pre-bundled DW Cold (3x fresh isolate) ---');
  for (let i = 0; i < 3; i++) {
    const r = await run('/prebundled/cold');
    console.log(`  #${i + 1}: ${fmt(r)}`);
  }

  // 4. Pre-bundled DW warm
  console.log('\n--- Pre-bundled DW Warm (5x same id) ---');
  for (let i = 0; i < 5; i++) {
    const r = await run('/prebundled/warm?n=1');
    if (r.error) {
      console.log(`  #${i + 1}: ${fmt(r)}`);
    } else {
      const isFirst = r.data[0]?.extra?.result?.isFirstCall;
      console.log(`  #${i + 1}: ${r.wallMs} ms${isFirst ? ' (first call — tsc loading)' : ''}`);
    }
  }

  // 5. Pre-bundled DW E2E
  console.log('\n--- Pre-bundled DW E2E (6 validations) ---');
  const dwe = await run('/prebundled/e2e');
  console.log(`  ${fmt(dwe)}`);

  // Summary
  console.log(`\n--- Summary ---`);
  console.log(`  Ping:           ${pingMedian} ms`);
  console.log(`  In-process overhead = inprocess - ping`);
  console.log(`  DW overhead         = dw_warm - ping`);

  console.log('\n=== Done ===\n');
}

main().catch(console.error);
