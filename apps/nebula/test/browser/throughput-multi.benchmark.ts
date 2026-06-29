/**
 * ⚠ Hits the deployed `nebula-browser-test` worker. Run
 *   `npm run deploy:test-worker`
 * BEFORE this bench, or you're measuring stale code. The shared global-setup staleness
 * guard (Phase 2, `tasks/nebula-release-process.md`) now hard-fails a `BENCH_BASE_URL`
 * run whose deploy != local HEAD, so a stale deploy can't silently slip through.
 *
 * Phase 5 of `tasks/gateway-hop-benchmark.md`: does Gateway-DO fanout
 * raise peak per-Star throughput? Compares two load shapes at the same
 * total in-flight, so any throughput delta isolates the fanout effect:
 *
 *   - **Shape A — with fanout**: M = total clients, N = 1 in-flight each.
 *     Every concurrent call goes through its own Gateway DO. Auth/routing
 *     CPU runs in parallel across M Gateway DOs.
 *   - **Shape B — no fanout**: M = 1 client, N = total in-flight. All
 *     concurrent calls funnel through one Gateway DO.
 *
 * Both shapes converge on the same Star DO. Any throughput difference is
 * attributable to the Gateway side of the path.
 *
 * **Interpretation**:
 *   - A > B by a lot → Gateway parallelism is load-bearing. Phase 5b
 *     (alt-Star) becomes worth investigating.
 *   - A ≈ B (or small Δ) → Star storage commit dominates throughput;
 *     Gateway position doesn't matter much. The 12 ms latency cost from
 *     Phase 3 is the architecture's only price. Skip Phase 5b.
 *   - A < B → Multi-Gateway adds more queuing variance than it removes.
 *     Surprising; would warrant deeper investigation.
 *
 * **Why these specific (M, N) combinations**:
 *   - Maximum-fanout Shape A (M=total, N=1) is the cleanest test of "M
 *     Gateway DOs vs 1." Intermediate (M, N) combinations sit on a
 *     continuum between A and B; if A and B don't differ, the middle won't
 *     either.
 *   - Three total-in-flight points (64, 128, 256) bracket the saturation
 *     region where the existing single-client throughput bench peaks
 *     (~400 txn/s at N=128).
 *
 * Setup pre-creates M_max=256 clients upfront. Unused clients hibernate
 * between steps; the 5s rampup-drop window absorbs any wake variance.
 *
 * Output: `THROUGHPUT-MULTI-{label}.md` (overwritten per run; gitignored)
 *         and `throughput-multi-raw-{label}.json` (raw per-call data; gitignored).
 *
 * Run:
 *   `cd apps/nebula && BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev npm run bench:multi`
 */

import { describe, it, expect, inject } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from '@lumenize/testing';
import { withCommitStamp } from './bench-commit-stamp';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import { ThroughputHarnessClient } from './throughput-harness-client';
import { bootstrapAdmin } from './auth-bootstrap';

const ADMIN_EMAIL = 'test@lumenize.io';
const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

const TOTALS = process.env.BENCH_TOTALS
  ? process.env.BENCH_TOTALS.split(',').map((s) => parseInt(s.trim(), 10))
  : [64, 128, 256];
const STEP_WINDOW_MS = parseInt(process.env.BENCH_WINDOW_MS ?? '30000', 10);
const STEP_DROP_HEAD_MS = parseInt(process.env.BENCH_DROP_HEAD_MS ?? '5000', 10);
const STEP_DROP_TAIL_MS = parseInt(process.env.BENCH_DROP_TAIL_MS ?? '2000', 10);
const INTER_STEP_PAUSE_MS = parseInt(process.env.BENCH_PAUSE_MS ?? '3000', 10);
const PRE_WARM_TXNS = parseInt(process.env.BENCH_PRE_WARM_TXNS ?? '20', 10);
const TEST_TIMEOUT_MS = parseInt(process.env.BENCH_TEST_TIMEOUT_MS ?? '900000', 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function uniqueGalaxy(): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `acme-${suffix}.app`;
}

interface Completion {
  start: number;
  end: number;
  latencyMs: number;
  error?: string;
}

interface StepResult {
  shape: 'A' | 'B';
  total: number;
  M: number;
  N: number;
  completions: Completion[];
  windowedCompletions: number;
  windowSec: number;
  throughputTxnPerSec: number;
  errors: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

/**
 * Run a single saturation step. Maintains exactly N in-flight per client
 * (M clients total) for STEP_WINDOW_MS, then drains. Returns all
 * completions including drain-tail.
 */
async function runStep(
  shape: 'A' | 'B',
  clients: ThroughputHarnessClient[],
  starName: string,
  N: number,
  total: number,
): Promise<StepResult> {
  const M = clients.length;
  const completions: Completion[] = [];
  let inFlight = 0;
  let launched = 0;
  let stopLaunching = false;
  const stepStart = performance.now();
  const stepEnd = stepStart + STEP_WINDOW_MS;
  const drainDeadline = stepEnd + 30_000;

  const heartbeat = setInterval(() => {
    process.stderr.write(
      `[multi] ${shape}/total=${total} (M=${M}, N=${N}) heartbeat: in-flight=${inFlight}, launched=${launched}, ` +
      `completions=${completions.length}, errors=${completions.filter((c) => c.error).length}, ` +
      `t=${((performance.now() - stepStart) / 1000).toFixed(1)}s\n`,
    );
  }, 3_000);

  return new Promise<StepResult>((resolveStep) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      clearInterval(drainTimer);
      const stepStartT = stepStart;
      const stepEndT = stepEndT_compute();
      const windowStart = stepStartT + STEP_DROP_HEAD_MS;
      const windowEnd = stepEndT - STEP_DROP_TAIL_MS;
      const windowSec = (windowEnd - windowStart) / 1000;
      const windowed = completions.filter((c) => c.end >= windowStart && c.end <= windowEnd && !c.error);
      const errors = completions.filter((c) => !!c.error).length;
      resolveStep({
        shape,
        total,
        M,
        N,
        completions,
        windowedCompletions: windowed.length,
        windowSec,
        throughputTxnPerSec: windowed.length / windowSec,
        errors,
      });
    };
    function stepEndT_compute(): number {
      // Use the real wall-clock end (when drain finished) for windowing,
      // not the artificial deadline. The completions array is the source
      // of truth here; `stepEnd` is just the hard cutoff for new launches.
      const lastEnd = completions.length === 0 ? stepStart : Math.max(...completions.map((c) => c.end));
      return Math.min(lastEnd, stepEnd);
    }
    const checkDone = () => {
      if (stopLaunching && inFlight === 0) finish();
    };

    const drainTimer = setInterval(() => {
      if (!stopLaunching) return;
      if (performance.now() >= drainDeadline) {
        process.stderr.write(
          `[multi] ${shape}/total=${total} drain timeout: still ${inFlight} in-flight after 30s — bailing\n`,
        );
        for (let i = 0; i < inFlight; i++) {
          completions.push({ start: -1, end: -1, latencyMs: -1, error: 'drain-timeout' });
        }
        finish();
      }
    }, 1_000);

    const launchOnClient = (client: ThroughputHarnessClient) => {
      if (stopLaunching) return;
      if (performance.now() >= stepEnd) {
        stopLaunching = true;
        checkDone();
        return;
      }
      inFlight++;
      launched++;
      const start = performance.now();
      const resourceId = crypto.randomUUID();
      client
        .callStarTransactionForBench(starName, ONTOLOGY_VERSION, resourceId)
        .then(() => {
          const end = performance.now();
          completions.push({ start, end, latencyMs: end - start });
        })
        .catch((e: Error) => {
          const end = performance.now();
          completions.push({ start, end, latencyMs: end - start, error: e.message });
        })
        .finally(() => {
          inFlight--;
          if (performance.now() >= stepEnd) {
            stopLaunching = true;
            checkDone();
          } else {
            launchOnClient(client);
          }
        });
    };

    // Fire initial N per client across all M clients = M*N total in-flight.
    for (const client of clients) {
      for (let i = 0; i < N; i++) launchOnClient(client);
    }
  });
}

interface BenchPlan {
  shape: 'A' | 'B';
  total: number;
  M: number;
  N: number;
}

function buildPlan(totals: number[], maxClients: number): BenchPlan[] {
  const plan: BenchPlan[] = [];
  for (const total of totals) {
    if (total > maxClients) {
      throw new Error(`buildPlan: total=${total} exceeds maxClients=${maxClients}`);
    }
    plan.push({ shape: 'B', total, M: 1, N: total });
    plan.push({ shape: 'A', total, M: total, N: 1 });
  }
  return plan;
}

interface ResultRow {
  total: number;
  shapeA: StepResult;
  shapeB: StepResult;
}

function buildMarkdown(args: {
  label: string;
  baseUrl: string;
  galaxyScope: string;
  rows: ResultRow[];
}): string {
  const { label, baseUrl, galaxyScope, rows } = args;

  const lines = [
    `# Phase 5 Throughput Comparison: Shape A vs Shape B (${label})`,
    ``,
    `Comparing peak per-Star throughput between two load shapes at the same total in-flight, to test whether Gateway-DO fanout raises throughput. See [gateway-hop-benchmark.md](../../../../tasks/gateway-hop-benchmark.md) Phase 5.`,
    ``,
    `- **Shape A (with fanout)**: M = total clients, N = 1 in-flight each. Every concurrent call goes through its own Gateway DO.`,
    `- **Shape B (no fanout)**: M = 1 client, N = total in-flight. All concurrent calls funnel through one Gateway DO.`,
    ``,
    `Both shapes converge on the same Star DO. Any throughput delta is attributable to the Gateway side.`,
    ``,
    `- **baseUrl**: \`${baseUrl}\``,
    `- **galaxy scope**: \`${galaxyScope}\` (unique per run)`,
    `- **window per step**: ${STEP_WINDOW_MS / 1000} s; steady-state window after dropping ${STEP_DROP_HEAD_MS / 1000} s rampup + ${STEP_DROP_TAIL_MS / 1000} s drain.`,
    `- **bench source**: [throughput-multi.benchmark.ts](throughput-multi.benchmark.ts) · [throughput-harness-client.ts](throughput-harness-client.ts) · [multi-client.ts](multi-client.ts)`,
    ``,
    `## Headline`,
    ``,
    `| total in-flight | Shape A (M=total, N=1) | Shape B (M=1, N=total) | Δ (A − B) | direction |`,
    `| ---: | ---: | ---: | ---: | --- |`,
  ];

  for (const row of rows) {
    const a = row.shapeA.throughputTxnPerSec;
    const b = row.shapeB.throughputTxnPerSec;
    const delta = a - b;
    const pct = b === 0 ? Infinity : (delta / b) * 100;
    const direction =
      Math.abs(pct) < 5 ? 'break-even' :
      delta > 0 ? `A wins (+${pct.toFixed(0)}%)` :
      `B wins (${pct.toFixed(0)}%)`;
    lines.push(
      `| ${row.total} | ${fmt(a)} txn/s | ${fmt(b)} txn/s | ${delta >= 0 ? '+' : ''}${fmt(delta)} | ${direction} |`,
    );
  }

  lines.push(
    ``,
    `## Per-step detail`,
    ``,
    `| total | shape | M | N | throughput (txn/s) | windowed completions | errors |`,
    `| ---: | --- | ---: | ---: | ---: | ---: | ---: |`,
  );
  for (const row of rows) {
    for (const step of [row.shapeB, row.shapeA]) {
      lines.push(
        `| ${step.total} | ${step.shape} | ${step.M} | ${step.N} | ${fmt(step.throughputTxnPerSec)} | ${step.windowedCompletions} | ${step.errors} |`,
      );
    }
  }

  // Decision interpretation
  const peakA = Math.max(...rows.map((r) => r.shapeA.throughputTxnPerSec));
  const peakB = Math.max(...rows.map((r) => r.shapeB.throughputTxnPerSec));
  const peakDelta = peakA - peakB;
  const peakPct = peakB === 0 ? Infinity : (peakDelta / peakB) * 100;

  let decision: string;
  if (Math.abs(peakPct) < 5) {
    decision = `**Star storage commit dominates throughput.** Gateway position doesn't matter much — the 12 ms latency cost from Phase 3 is the architecture's only price. **Skip Phase 5b** (no need to investigate alt-Star).`;
  } else if (peakDelta > 0) {
    decision = `**Gateway parallelism is load-bearing** (peak A is ${peakPct.toFixed(0)}% above peak B). Phase 5b (alt-Star) becomes worth investigating to confirm whether a Gateway-less architecture would HURT throughput.`;
  } else {
    decision = `**Surprising direction**: Shape A peaked *below* Shape B (${peakPct.toFixed(0)}%). Multi-Gateway adds more queuing variance than it removes. Worth investigating before drawing conclusions.`;
  }

  lines.push(
    ``,
    `## Decision`,
    ``,
    `Peak Shape A: **${fmt(peakA)} txn/s**. Peak Shape B: **${fmt(peakB)} txn/s**. Δ: **${peakDelta >= 0 ? '+' : ''}${fmt(peakDelta)} txn/s** (${peakPct >= 0 ? '+' : ''}${peakPct.toFixed(0)}%).`,
    ``,
    decision,
    ``,
  );

  return lines.join('\n');
}

describe('Phase 5 throughput comparison: Shape A vs Shape B', () => {
  it('compares peak per-Star throughput', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const testToken = inject('emailTestToken');
    const browser = new Browser();
    const galaxyScope = uniqueGalaxy();
    const warmStar = `${galaxyScope}.tenant-warm`;
    const isDeployed = !!process.env.BENCH_BASE_URL;
    const label = isDeployed ? 'deployed' : 'local';
    const M_MAX = Math.max(...TOTALS);

    console.log(`[multi] ${label} — ${baseUrl} — galaxy ${galaxyScope} — totals ${TOTALS.join(',')} — pre-creating ${M_MAX} clients`);

    // Bootstrap auth once + mint shared JWT (mirrors multi-client.ts logic
    // inline because we need ThroughputHarnessClient instances, not
    // HarnessNebulaClient — refactoring multi-client.ts to be generic over
    // client type is overkill for this single use).
    await bootstrapAdmin({ browser, baseUrl, scope: galaxyScope, email: ADMIN_EMAIL, testToken });

    const refreshResponse = await browser.fetch(
      `${baseUrl}/auth/${galaxyScope}/refresh-token`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeScope: galaxyScope }),
      },
    );
    if (!refreshResponse.ok) {
      throw new Error(`refresh-token failed ${refreshResponse.status} ${await refreshResponse.text()}`);
    }
    const { access_token: accessToken, sub } = await refreshResponse.json() as { access_token: string; sub: string };

    const allClients: ThroughputHarnessClient[] = [];
    const allContexts: ReturnType<Browser['context']>[] = [];
    for (let i = 0; i < M_MAX; i++) {
      const ctx = browser.context(baseUrl);
      const tabId = crypto.randomUUID().slice(0, 8);
      const client = new ThroughputHarnessClient({
        baseUrl,
        authScope: galaxyScope,
        activeScope: galaxyScope,
        appVersion: 'v1',
        fetch: browser.fetch,
        sessionStorage: ctx.sessionStorage,
        BroadcastChannel: ctx.BroadcastChannel,
        accessToken,
        instanceName: `${sub}.${tabId}`,
      });
      allContexts.push(ctx);
      allClients.push(client);
    }

    try {
      // Wait for all M_MAX WS connections in parallel.
      console.log(`[multi] waiting for ${M_MAX} WS connections`);
      const wsStart = Date.now();
      await Promise.all(
        allClients.map(async (client, idx) => {
          while (client.connectionState !== 'connected') {
            if (Date.now() - wsStart > 30_000) {
              throw new Error(`Client ${idx} did not connect within 30s (state=${client.connectionState})`);
            }
            await new Promise((r) => globalThis.setTimeout(r, 25));
          }
        }),
      );
      console.log(`[multi] all ${M_MAX} clients connected in ${Date.now() - wsStart}ms`);

      // Register ontology + pre-warm bundle. Use clients[0] for both.
      console.log('[multi] registering ontology + pre-warming bundle');
      await allClients[0].callGalaxyAppendOntologyVersion(galaxyScope, {
        version: ONTOLOGY_VERSION,
        types: TEST_TYPES,
      });
      for (let i = 0; i < PRE_WARM_TXNS; i++) {
        await allClients[0].callStarTransactionForBench(
          `${galaxyScope}.tenant-warmup`,
          ONTOLOGY_VERSION,
          crypto.randomUUID(),
        );
      }
      console.log(`[multi] pre-warmed (${PRE_WARM_TXNS} sequential txns on warmup tenant)`);

      // Run the bench plan: B then A for each total.
      const plan = buildPlan(TOTALS, M_MAX);
      const stepResults: StepResult[] = [];
      for (const step of plan) {
        const clientsForStep = step.shape === 'A' ? allClients.slice(0, step.M) : [allClients[0]];
        console.log(`[multi] running ${step.shape}/total=${step.total} (M=${step.M}, N=${step.N})`);
        const result = await runStep(step.shape, clientsForStep, warmStar, step.N, step.total);
        stepResults.push(result);
        console.log(
          `[multi] ${step.shape}/total=${step.total} done — ${fmt(result.throughputTxnPerSec)} txn/s, ` +
          `${result.windowedCompletions} windowed completions, ${result.errors} errors`,
        );
        await new Promise((r) => globalThis.setTimeout(r, INTER_STEP_PAUSE_MS));
      }

      // Pair B and A results by total.
      const rows: ResultRow[] = TOTALS.map((total) => {
        const shapeA = stepResults.find((s) => s.shape === 'A' && s.total === total)!;
        const shapeB = stepResults.find((s) => s.shape === 'B' && s.total === total)!;
        return { total, shapeA, shapeB };
      });

      // Console headline
      console.log('\n==================== Phase 5 multi results ====================');
      for (const row of rows) {
        const a = row.shapeA.throughputTxnPerSec;
        const b = row.shapeB.throughputTxnPerSec;
        const delta = a - b;
        const pct = b === 0 ? 0 : (delta / b) * 100;
        console.log(
          `total=${row.total}: Shape A ${fmt(a)} txn/s  vs  Shape B ${fmt(b)} txn/s  →  Δ ${delta >= 0 ? '+' : ''}${fmt(delta)} (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)`,
        );
      }
      console.log('================================================================\n');

      // Outputs
      const rawPath = path.join(__dirname, `throughput-multi-raw-${label}.json`);
      fs.writeFileSync(
        rawPath,
        JSON.stringify({ label, baseUrl, galaxyScope, totals: TOTALS, steps: stepResults }, null, 2),
      );
      console.log(`[multi] raw data → ${rawPath}`);

      const summaryPath = path.join(__dirname, `THROUGHPUT-MULTI-${label}.md`);
      fs.writeFileSync(summaryPath, withCommitStamp(buildMarkdown({ label, baseUrl, galaxyScope, rows })));
      console.log(`[multi] summary → ${summaryPath}`);

      // Sanity assertions
      for (const step of stepResults) {
        expect(step.throughputTxnPerSec, `${step.shape}/total=${step.total} throughput > 0`).toBeGreaterThan(0);
      }
      const totalErrors = stepResults.reduce((acc, s) => acc + s.errors, 0);
      const totalCompletions = stepResults.reduce((acc, s) => acc + s.completions.length, 0);
      const errorRate = totalCompletions === 0 ? 0 : totalErrors / totalCompletions;
      console.log(`[multi] total completions: ${totalCompletions}, errors: ${totalErrors} (${(errorRate * 100).toFixed(2)}%)`);
      expect(errorRate, 'error rate < 5%').toBeLessThan(0.05);
    } finally {
      for (const c of allClients) (c as any)[Symbol.dispose]?.();
      for (const ctx of allContexts) ctx.close();
    }
  }, TEST_TIMEOUT_MS);
});
