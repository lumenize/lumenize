/**
 * Measure round-trip latency for the SFC-Galaxy-loop spike.
 *
 * Run against:
 *   - Local: `wrangler dev` running on localhost:8787
 *   - Remote: a deployed Cloudflare Worker URL
 *
 * Usage:
 *   npx tsx probes/measure-roundtrip.ts --url http://localhost:8787
 *   npx tsx probes/measure-roundtrip.ts --url https://spike-sfc-galaxy-loop.<subdomain>.workers.dev
 *
 * Options:
 *   --url <url>          Base URL of the Worker (default: http://localhost:8787)
 *   --iterations <n>     Total iterations to run (default: 20)
 *   --warmup <n>         Warmup iterations excluded from stats (default: 3)
 *
 * What it measures:
 *   Time from POST /compile send to receiving 'reload' on the WS, per iteration.
 *   Each iteration opens a fresh WS (models a real page-reload cycle).
 *   Measurement happens in Node.js via performance.now() — outside the Workers
 *   runtime, so Date.now() pinning inside the DO doesn't affect us.
 *
 * What it does NOT measure:
 *   - WS open time (the WS is opened before the POST; if WS-open were
 *     included, real per-cycle latency for a page-reload model would be
 *     higher than these numbers).
 *   - Network jitter / CF eyeball routing (use the remote URL to capture
 *     real network behavior).
 */

import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8787' },
    iterations: { type: 'string', default: '20' },
    warmup: { type: 'string', default: '3' },
  },
});

const baseUrl = values.url!;
const iterations = parseInt(values.iterations!, 10);
const warmup = parseInt(values.warmup!, 10);
const wsBase = baseUrl.replace(/^http/, 'ws');

const REPRESENTATIVE_SFC = `<template>
  <div :class="{ done: completed }">
    <h2>{{ title }}</h2>
    <input v-model="title" />
  </div>
</template>

<script setup>
import { ref } from 'vue';
const title = ref('Hello');
const completed = ref(false);
</script>

<style scoped>
.done { text-decoration: line-through; }
</style>`;

interface Measurement {
  iteration: number;
  isWarmup: boolean;
  wsOpenMs: number;
  postToReloadMs: number;
}

async function runIteration(sessionId: string, iteration: number, isWarmup: boolean): Promise<Measurement> {
  // Open WebSocket and wait for ready.
  const wsOpenStartedAt = performance.now();
  const ws = new WebSocket(`${wsBase}/galaxy/spike/reload/${sessionId}`);
  await new Promise<void>((resolve, reject) => {
    const onError = (e: Event) => reject(new Error(`WS open failed: ${(e as any).message ?? 'unknown'}`));
    ws.addEventListener('open', () => {
      ws.removeEventListener('error', onError);
      resolve();
    }, { once: true });
    ws.addEventListener('error', onError, { once: true });
  });
  const wsOpenedAt = performance.now();

  // Set up reload-message capture with timing.
  const reloadReceivedAt = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for reload')), 10_000);
    ws.addEventListener('message', (event) => {
      if (event.data === 'reload') {
        clearTimeout(timeout);
        resolve(performance.now());
      }
    }, { once: true });
  });

  // POST compile trigger.
  const postStartedAt = performance.now();
  const compileResponse = await fetch(`${baseUrl}/galaxy/spike/compile/${sessionId}`, {
    method: 'POST',
    body: REPRESENTATIVE_SFC,
  });
  if (!compileResponse.ok) {
    throw new Error(`Compile request failed: ${compileResponse.status} ${compileResponse.statusText}`);
  }

  // Wait for reload message.
  const reloadAt = await reloadReceivedAt;

  ws.close();

  return {
    iteration,
    isWarmup,
    wsOpenMs: wsOpenedAt - wsOpenStartedAt,
    postToReloadMs: reloadAt - postStartedAt,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function fmt(n: number): string {
  return n.toFixed(2);
}

async function main() {
  console.log(`Measuring round-trip latency against ${baseUrl}`);
  console.log(`Iterations: ${iterations} (warmup: ${warmup})`);
  console.log('');

  // Pre-warm: a GET to the root triggers module load (~700 ms for
  // @vue/compiler-sfc cold-import) without us having to time out the
  // first WS open. The cold-import cost is the spike's known property,
  // already measured by the kill criterion — we don't need to remeasure
  // it here, but we DO need to pay it before iterations start so the
  // WS handshake on iter 0 doesn't hit the import block.
  const prewarmStartedAt = performance.now();
  const prewarmResponse = await fetch(`${baseUrl}/`);
  await prewarmResponse.text();
  console.log(`Pre-warm GET / → ${prewarmResponse.status} in ${fmt(performance.now() - prewarmStartedAt)} ms`);
  // The DO doesn't load until the first DO-routed request. Hit /galaxy/spike/compile/prewarm
  // to force DO load too.
  const doWarmStartedAt = performance.now();
  await fetch(`${baseUrl}/galaxy/spike/compile/prewarm`, {
    method: 'POST',
    body: REPRESENTATIVE_SFC,
  }).then((r) => r.text());
  console.log(`Pre-warm DO compile → in ${fmt(performance.now() - doWarmStartedAt)} ms (no peers; just loads module)`);
  console.log('');

  const measurements: Measurement[] = [];

  for (let i = 0; i < iterations; i++) {
    const isWarmup = i < warmup;
    const sessionId = `bench-${i}-${Date.now()}`;
    try {
      const m = await runIteration(sessionId, i, isWarmup);
      measurements.push(m);
      const label = isWarmup ? '[warmup ]' : '[measure]';
      console.log(`  ${label} iter ${String(i).padStart(2)}:  ws-open=${fmt(m.wsOpenMs).padStart(7)} ms   post→reload=${fmt(m.postToReloadMs).padStart(7)} ms`);
    } catch (err) {
      console.error(`  iter ${i} FAILED: ${err}`);
      process.exit(1);
    }
  }

  const measured = measurements.filter((m) => !m.isWarmup);
  const postToReloadSorted = [...measured].map((m) => m.postToReloadMs).sort((a, b) => a - b);
  const wsOpenSorted = [...measured].map((m) => m.wsOpenMs).sort((a, b) => a - b);

  console.log('');
  console.log('=== Results (warmup excluded) ===');
  console.log(`  Samples: ${postToReloadSorted.length}`);
  console.log('');
  console.log('  POST → reload-received (the main latency metric):');
  console.log(`    min:  ${fmt(postToReloadSorted[0]).padStart(7)} ms`);
  console.log(`    p50:  ${fmt(percentile(postToReloadSorted, 0.5)).padStart(7)} ms`);
  console.log(`    p90:  ${fmt(percentile(postToReloadSorted, 0.9)).padStart(7)} ms`);
  console.log(`    p99:  ${fmt(percentile(postToReloadSorted, 0.99)).padStart(7)} ms`);
  console.log(`    max:  ${fmt(postToReloadSorted[postToReloadSorted.length - 1]).padStart(7)} ms`);
  console.log('');
  console.log('  WS-open (per iteration, fresh connection each time):');
  console.log(`    min:  ${fmt(wsOpenSorted[0]).padStart(7)} ms`);
  console.log(`    p50:  ${fmt(percentile(wsOpenSorted, 0.5)).padStart(7)} ms`);
  console.log(`    p99:  ${fmt(percentile(wsOpenSorted, 0.99)).padStart(7)} ms`);

  const warmupRuns = measurements.filter((m) => m.isWarmup);
  if (warmupRuns.length > 0) {
    console.log('');
    console.log('  Warmup runs (typically including module-import cold cost):');
    for (const w of warmupRuns) {
      console.log(`    iter ${w.iteration}: ws-open=${fmt(w.wsOpenMs).padStart(7)} ms  post→reload=${fmt(w.postToReloadMs).padStart(7)} ms`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
