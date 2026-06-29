/**
 * ⚠ Hits the deployed `nebula-browser-test` worker. Run
 *   `npm run deploy:test-worker`
 * BEFORE this bench, or you're measuring stale code. The shared global-setup staleness
 * guard (Phase 2, `tasks/nebula-release-process.md`) now hard-fails a `BENCH_BASE_URL`
 * run whose deploy != local HEAD, so a stale deploy can't silently slip through.
 *
 * Throughput / saturation bench — measures per-Star ceiling under N concurrent
 * in-flight transactions from one client (galaxy-scoped).
 *
 * Phase 1's latency bench gave the serial single-client floor (~19 txn/s
 * deployed at N=1). This test sweeps N ∈ {1, 2, 4, …, 256} to find where the
 * curve knees. Output gates allow concurrent invocations to interleave on
 * awaits and their writes batch through group-commit, so the per-Star ceiling
 * is expected to be substantially higher than 1/serial-mean.
 *
 * Result-correlation mechanism: each iteration creates a unique resourceId
 * (`crypto.randomUUID()`); on success, the Star's response includes
 * `result.eTags` keyed by that resourceId. The client tracks
 * `Map<resourceId, {resolve, reject}>` and dispatches by inspecting eTag keys.
 * No Star-side changes needed.
 *
 * Output: raw per-iteration data → throughput-raw.json (gitignored);
 *         summary tables → THROUGHPUT-RESULTS.md.
 */

import { describe, it, expect, inject } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from '@lumenize/testing';
import { withCommitStamp } from './bench-commit-stamp';
import { ThroughputHarnessClient } from './throughput-harness-client';
import { bootstrapAdmin } from './auth-bootstrap';

const ADMIN_EMAIL = 'test@lumenize.io';
const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

const STEPS = process.env.BENCH_STEPS
  ? process.env.BENCH_STEPS.split(',').map((s) => parseInt(s.trim(), 10))
  : [1, 2, 4, 8, 16, 32, 64, 128, 256];
const STEP_WINDOW_MS = parseInt(process.env.BENCH_WINDOW_MS ?? '30000', 10);
const STEP_DROP_HEAD_MS = parseInt(process.env.BENCH_DROP_HEAD_MS ?? '5000', 10);
const STEP_DROP_TAIL_MS = parseInt(process.env.BENCH_DROP_TAIL_MS ?? '2000', 10);
const INTER_STEP_PAUSE_MS = parseInt(process.env.BENCH_PAUSE_MS ?? '2000', 10);
const PRE_WARM_TXNS = parseInt(process.env.BENCH_PRE_WARM_TXNS ?? '20', 10);
const PING_BASELINE_SAMPLES = parseInt(process.env.BENCH_PING_SAMPLES ?? '50', 10);
const TEST_TIMEOUT_MS = parseInt(process.env.BENCH_TEST_TIMEOUT_MS ?? '600000', 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function uniqueGalaxy(): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `acme-${suffix}.app`;
}

interface Completion {
  N: number;
  start: number;       // performance.now() at launch
  end: number;         // performance.now() at resolve
  latencyMs: number;
  error?: string;
}

interface StepSummary {
  N: number;
  totalCompletions: number;
  windowedCompletions: number;
  windowSec: number;
  throughputTxnPerSec: number;
  rawLatency: { p50: number; p75: number; p99: number; mean: number };
  inWorkerLatency: { p50: number; p75: number; p99: number; mean: number };
  errors: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function summarize(N: number, completions: Completion[], pingMean: number): StepSummary {
  const stepStart = completions.length > 0 ? Math.min(...completions.map(c => c.start)) : 0;
  const stepEnd = stepStart + STEP_WINDOW_MS;
  const windowStart = stepStart + STEP_DROP_HEAD_MS;
  const windowEnd = stepEnd - STEP_DROP_TAIL_MS;
  const windowSec = (windowEnd - windowStart) / 1000;

  const windowed = completions.filter(c => c.end >= windowStart && c.end <= windowEnd && !c.error);
  const errors = completions.filter(c => !!c.error).length;
  const latencies = windowed.map(c => c.latencyMs).sort((a, b) => a - b);
  const inWorker = latencies.map(l => Math.max(0, l - pingMean)).sort((a, b) => a - b);
  const mean = (arr: number[]) => arr.length === 0 ? NaN : arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    N,
    totalCompletions: completions.length,
    windowedCompletions: windowed.length,
    windowSec,
    throughputTxnPerSec: windowed.length / windowSec,
    rawLatency: { p50: percentile(latencies, 0.5), p75: percentile(latencies, 0.75), p99: percentile(latencies, 0.99), mean: mean(latencies) },
    inWorkerLatency: { p50: percentile(inWorker, 0.5), p75: percentile(inWorker, 0.75), p99: percentile(inWorker, 0.99), mean: mean(inWorker) },
    errors,
  };
}

async function runStep(client: ThroughputHarnessClient, starName: string, N: number): Promise<Completion[]> {
  const completions: Completion[] = [];
  let inFlight = 0;
  let launched = 0;
  let stopLaunching = false;
  const stepStart = performance.now();
  const stepEnd = stepStart + STEP_WINDOW_MS;
  const drainDeadline = stepEnd + 30_000; // hard cap on drain wait

  // Heartbeat — visible progress every 3s so a stall is observable.
  const heartbeat = setInterval(() => {
    process.stderr.write(`[throughput] N=${N} heartbeat: in-flight=${inFlight}, launched=${launched}, completions=${completions.length}, errors=${completions.filter(c => c.error).length}, t=${((performance.now() - stepStart) / 1000).toFixed(1)}s\n`);
  }, 3_000);

  return new Promise<Completion[]>((resolveStep) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      clearInterval(drainTimer);
      resolveStep(completions);
    };
    const checkDone = () => {
      if (stopLaunching && inFlight === 0) finish();
    };

    // Hard timeout — if drain doesn't complete within 30s past stepEnd,
    // bail with whatever we have plus an error marker.
    const drainTimer = setInterval(() => {
      if (!stopLaunching) return;
      if (performance.now() >= drainDeadline) {
        process.stderr.write(`[throughput] N=${N} drain timeout: still ${inFlight} in-flight after 30s past window — bailing\n`);
        // Mark un-completed in-flight as drain-timeout errors.
        for (let i = 0; i < inFlight; i++) {
          completions.push({ N, start: -1, end: -1, latencyMs: -1, error: 'drain-timeout' });
        }
        clearInterval(drainTimer);
        finish();
      }
    }, 1_000);

    const launchOne = () => {
      if (stopLaunching) return;
      if (performance.now() >= stepEnd) { stopLaunching = true; checkDone(); return; }
      inFlight++;
      launched++;
      const start = performance.now();
      const resourceId = crypto.randomUUID();
      client.callStarTransactionForBench(starName, ONTOLOGY_VERSION, resourceId)
        .then(() => {
          const end = performance.now();
          completions.push({ N, start, end, latencyMs: end - start });
        })
        .catch((e: Error) => {
          const end = performance.now();
          completions.push({ N, start, end, latencyMs: end - start, error: e.message });
        })
        .finally(() => {
          inFlight--;
          if (performance.now() >= stepEnd) {
            stopLaunching = true;
            checkDone();
          } else {
            launchOne();
          }
        });
    };

    // Fire initial N
    for (let i = 0; i < N; i++) launchOne();
  });
}

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return 'n/a';
  return n.toFixed(digits);
}

function buildMarkdown(args: {
  label: string;
  baseUrl: string;
  galaxyScope: string;
  pingMean: number;
  pingMin: number;
  pingMax: number;
  preWarmMean: number;
  steps: StepSummary[];
}): string {
  const { label, baseUrl, galaxyScope, pingMean, pingMin, pingMax, preWarmMean, steps } = args;
  const knee = findKnee(steps);

  const lines = [
    `# Parse-Validate Throughput / Saturation Bench Results`,
    ``,
    `Run label: **${label}**.`,
    ``,
    `Per-Star saturation ramp under N concurrent in-flight transactions from one client (galaxy-scoped). See [parse-validate-throughput.md](../../../../tasks/parse-validate-throughput.md) for design.`,
    ``,
    `- **baseUrl**: \`${baseUrl}\``,
    `- **galaxy scope**: \`${galaxyScope}\` (unique per run)`,
    `- **ping baseline (sequential, ${PING_BASELINE_SAMPLES} samples)**: mean ${fmt(pingMean)} ms, min ${fmt(pingMin)} ms, max ${fmt(pingMax)} ms`,
    `- **pre-warm transaction mean (${PRE_WARM_TXNS} sequential txns on the warm Star)**: ${fmt(preWarmMean)} ms`,
    ``,
    `## Saturation curve`,
    ``,
    `| N | throughput (txn/s) | mean lat (raw, ms) | p50 (raw) | p99 (raw) | mean lat (in-Worker) | p50 (in-W) | p99 (in-W) | windowed completions | errors |`,
    `| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
  ];
  for (const s of steps) {
    lines.push(
      `| ${s.N} | ${fmt(s.throughputTxnPerSec, 1)} | ${fmt(s.rawLatency.mean)} | ${fmt(s.rawLatency.p50)} | ${fmt(s.rawLatency.p99)} | ${fmt(s.inWorkerLatency.mean)} | ${fmt(s.inWorkerLatency.p50)} | ${fmt(s.inWorkerLatency.p99)} | ${s.windowedCompletions} | ${s.errors} |`,
    );
  }

  lines.push(
    ``,
    `## Headline`,
    ``,
    knee
      ? `**N* ≈ ${knee.N}** — throughput plateau at ~${fmt(knee.throughput, 1)} txn/s. Latency p50 stays near serial baseline up to N=${knee.N}; rises sharply past it.`
      : `No clear knee within tested range (max N=${steps[steps.length - 1].N}). See Phase 2 for upgrading the load generator.`,
    ``,
    `Compared to the latency bench's serial floor (~19 txn/s deployed at N=1, [RESULTS.md](RESULTS.md)): peak throughput is ${steps.length > 0 ? fmt(Math.max(...steps.map(s => s.throughputTxnPerSec)) / 19, 1) : 'n/a'}× the serial number. Output-gate group-commit batching is what lets concurrent in-flight calls scale past the serial ceiling.`,
    ``,
    `## Notes`,
    ``,
    `- **Window per step**: ${STEP_WINDOW_MS / 1000} s. Steady-state window after dropping first ${STEP_DROP_HEAD_MS / 1000} s (rampup) and last ${STEP_DROP_TAIL_MS / 1000} s (drain): ${(STEP_WINDOW_MS - STEP_DROP_HEAD_MS - STEP_DROP_TAIL_MS) / 1000} s used for the throughput + latency stats above.`,
    `- **In-Worker latency**: \`raw - pingMean\`. The constant-subtraction approximation is fine at low N but may understate true in-Worker latency at high N if the WS leg becomes contended. See "open question on ping under load" in the task file.`,
    `- **Inter-step pause**: ${INTER_STEP_PAUSE_MS / 1000} s, lets the DO settle between steps.`,
    `- **Errors**: should be 0 for all rows. Non-zero means the bench hit an unexpected condition (validation failure, network drop, etc.) — investigate before trusting numbers.`,
    ``,
  );
  return lines.join('\n');
}

function findKnee(steps: StepSummary[]): { N: number; throughput: number } | null {
  // Heuristic: knee is the largest N whose throughput is within 10% of the
  // running max throughput. If throughput is still climbing at the last N,
  // return null (no knee in tested range).
  if (steps.length < 2) return null;
  const maxThru = Math.max(...steps.map(s => s.throughputTxnPerSec));
  if (steps[steps.length - 1].throughputTxnPerSec >= maxThru * 0.95) return null;

  let knee = steps[0];
  for (const s of steps) {
    if (s.throughputTxnPerSec >= maxThru * 0.9) knee = s;
  }
  return { N: knee.N, throughput: knee.throughputTxnPerSec };
}

describe('parse-validate throughput', () => {
  it('finds saturation', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const testToken = inject('emailTestToken');
    const browser = new Browser();
    const galaxyScope = uniqueGalaxy();
    const warmStar = `${galaxyScope}.tenant-warm`;
    const isDeployed = !!process.env.BENCH_BASE_URL;
    const label = isDeployed ? 'deployed' : 'local';

    console.log(`[throughput] ${label} — ${baseUrl} — galaxy ${galaxyScope}`);

    // 1. Bootstrap admin at galaxy scope.
    await bootstrapAdmin({ browser, baseUrl, scope: galaxyScope, email: ADMIN_EMAIL, testToken });

    const ctx = browser.context(baseUrl);
    const client = new ThroughputHarnessClient({
      baseUrl,
      authScope: galaxyScope,
      activeScope: galaxyScope,
      appVersion: 'v1',
      fetch: browser.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });

    try {
      // 2. Wait for WS connection.
      const wsStart = Date.now();
      while (client.connectionState !== 'connected') {
        if (Date.now() - wsStart > 10_000) {
          throw new Error(`WS did not connect within 10s (state=${client.connectionState})`);
        }
        await new Promise((r) => globalThis.setTimeout(r, 25));
      }

      // 3. Register ontology.
      await client.callGalaxyAppendOntologyVersion(galaxyScope, {
        version: ONTOLOGY_VERSION,
        types: TEST_TYPES,
      });

      // 4. Pre-warm: fire N sequential transactions on the target Star to
      //    hot up the ontology cache, facet bundle, and DO.
      console.log(`[throughput] pre-warming with ${PRE_WARM_TXNS} sequential transactions`);
      const preWarmLatencies: number[] = [];
      for (let i = 0; i < PRE_WARM_TXNS; i++) {
        const t0 = performance.now();
        await client.callStarTransactionForBench(warmStar, ONTOLOGY_VERSION, crypto.randomUUID());
        preWarmLatencies.push(performance.now() - t0);
      }
      const preWarmMean = preWarmLatencies.reduce((a, b) => a + b, 0) / preWarmLatencies.length;
      console.log(`[throughput] pre-warm mean: ${preWarmMean.toFixed(2)} ms`);

      // 5. Capture ping baseline.
      console.log(`[throughput] capturing ping baseline (${PING_BASELINE_SAMPLES} sequential pings)`);
      const pings: number[] = [];
      for (let i = 0; i < PING_BASELINE_SAMPLES; i++) {
        const t0 = performance.now();
        await client.callStarPing(warmStar);
        pings.push(performance.now() - t0);
      }
      const pingMean = pings.reduce((a, b) => a + b, 0) / pings.length;
      const pingMin = Math.min(...pings);
      const pingMax = Math.max(...pings);
      console.log(`[throughput] ping baseline: mean ${pingMean.toFixed(2)} ms, min ${pingMin.toFixed(2)} ms, max ${pingMax.toFixed(2)} ms`);

      // 6. Ramp.
      const summaries: StepSummary[] = [];
      const allCompletions: Completion[] = [];
      for (const N of STEPS) {
        console.log(`[throughput] step N=${N} starting (window ${STEP_WINDOW_MS / 1000}s)`);
        const stepCompletions = await runStep(client, warmStar, N);
        const summary = summarize(N, stepCompletions, pingMean);
        summaries.push(summary);
        allCompletions.push(...stepCompletions);
        console.log(`[throughput] step N=${N} done — throughput ${summary.throughputTxnPerSec.toFixed(1)} txn/s, mean lat ${summary.rawLatency.mean.toFixed(1)} ms, p99 ${summary.rawLatency.p99.toFixed(1)} ms, ${summary.windowedCompletions} windowed completions, ${summary.errors} errors`);

        // runStep already drained via drainTimer; per-call timeouts clean up
        // any leftover #pending entries. Just pause briefly between steps.
        await new Promise((r) => globalThis.setTimeout(r, INTER_STEP_PAUSE_MS));
      }

      // 7. Write outputs.
      const rawPath = path.join(__dirname, `throughput-raw-${label}.json`);
      fs.writeFileSync(rawPath, JSON.stringify({
        label,
        baseUrl,
        galaxyScope,
        pingMean,
        pingMin,
        pingMax,
        pingSamples: pings,
        preWarmLatencies,
        steps: summaries.map(s => ({ ...s, completions: allCompletions.filter(c => c.N === s.N) })),
      }, null, 2));
      console.log(`[throughput] raw data → ${rawPath}`);

      const summaryPath = path.join(__dirname, `THROUGHPUT-RESULTS-${label}.md`);
      fs.writeFileSync(summaryPath, withCommitStamp(buildMarkdown({
        label, baseUrl, galaxyScope, pingMean, pingMin, pingMax, preWarmMean, steps: summaries,
      })));
      console.log(`[throughput] summary → ${summaryPath}`);

      // Sanity check: throughput at N=1 should be > 0; total errors should be a small fraction.
      const totalCompletions = summaries.reduce((a, s) => a + s.totalCompletions, 0);
      const totalErrors = summaries.reduce((a, s) => a + s.errors, 0);
      const errorRate = totalCompletions === 0 ? 0 : totalErrors / totalCompletions;
      console.log(`[throughput] total completions: ${totalCompletions}, errors: ${totalErrors} (${(errorRate * 100).toFixed(2)}%)`);
      expect(summaries[0].throughputTxnPerSec, 'N=1 throughput should be > 0').toBeGreaterThan(0);
      expect(errorRate, 'error rate should be below 5%').toBeLessThan(0.05);
    } finally {
      (client as any)[Symbol.dispose]?.();
    }
  }, TEST_TIMEOUT_MS);
});
