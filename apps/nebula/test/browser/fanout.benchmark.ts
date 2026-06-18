/**
 * Fanout scaling benchmark — Phase 1 (single-subscriber baseline) and
 * Phase 3 (ramp 1 → N subscribers) for the Lumenize Gateway-1:1 pattern.
 * Phase 3's "vs Cloudflare Agents" side lives in a sibling file
 * (`fanout-agents.benchmark.ts`, Phase 3a TBD).
 *
 * See `tasks/fanout-scaling-benchmark.md` for the full plan and hypothesis.
 *
 * **Pattern under test**: Lumenize Resources → `Star.#fanout` synchronous
 * loop dispatching `lmz.call(...)` per subscriber → per-client
 * `NebulaClientGateway` DOs → WS push to each subscriber's client. The loop
 * is already fire-and-forget; each subscriber lands on its own Gateway DO.
 *
 * **Instrumentation**: `HarnessNebulaClient.handleResourceUpdate` records
 * `performance.now()` per arriving Snapshot keyed by `meta.eTag`. The
 * originator pre-generates `newETag` via `crypto.randomUUID()` and passes
 * it to `client.resources.transaction(ops, { newETag })`, so the eTag is
 * known before any subscriber receives the push. Initial-subscribe
 * snapshots use server-generated eTags and don't collide with the
 * originator-controlled mutation eTags.
 *
 * **Output**:
 *   - `RESULTS-fanout-{label}.md` (overwritten per run; gitignored)
 *   - `fanout-raw-{label}.json` (raw per-iteration per-subscriber data)
 */

import { describe, it, expect, inject } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { OperationDescriptor } from '@lumenize/nebula/client';
import { HarnessNebulaClient } from './harness-client';
import { setupMultiClient } from './multi-client';
import { bootstrapAdmin } from './auth-bootstrap';

const ADMIN_EMAIL = 'test@lumenize.io';
const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; count: number; }`;

// v3: the engine generates the per-transaction `newETag`, so the originator no
// longer pre-knows it — it reads the committed eTag back off the outcome (which
// equals the eTag every subscriber's fanout snapshot carries).
function committedETag(outcome: unknown, rid: string): string {
  const o = outcome as { kind?: string; resources?: Record<string, { kind?: string; eTag?: string }> };
  const r = o?.resources?.[rid];
  if (o?.kind !== 'committed' || r?.kind !== 'committed' || !r.eTag) {
    throw new Error(`expected committed for ${rid}: ${JSON.stringify(outcome)}`);
  }
  return r.eTag;
}

const BASELINE_ITERATIONS = parseInt(process.env.FANOUT_BASELINE_ITERS ?? '20', 10);
const WARMUP_ITERATIONS = parseInt(process.env.FANOUT_WARMUP_ITERS ?? '5', 10);
const FANOUT_TIMEOUT_MS = parseInt(process.env.FANOUT_TIMEOUT_MS ?? '30000', 10);
const TEST_TIMEOUT_MS = parseInt(process.env.FANOUT_TEST_TIMEOUT_MS ?? '600000', 10);

/** Comma-separated N values to ramp over. Each N is "subscriber count" (originator is N+1th client). */
const RAMP_N_VALUES = (process.env.FANOUT_N_VALUES ?? '10,50,100')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

const RAMP_COMMITS_PER_N = parseInt(process.env.FANOUT_COMMITS_PER_N ?? '5', 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function uniqueGalaxy(): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `acme-${suffix}.app`;
}

interface Stats {
  mean: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function statsOf(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    mean: sorted.length === 0 ? NaN : sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

describe('fanout latency — Phase 1 (single-subscriber baseline)', () => {
  it('measures M=2 push delivery (one originator, one subscriber)', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const testToken = inject('emailTestToken');
    const browser = new Browser();
    const galaxyScope = uniqueGalaxy();
    const isDeployed = !!process.env.BENCH_BASE_URL;
    const label = isDeployed ? 'deployed' : 'local';

    console.log(`[fanout-bench Phase 1] ${label} — ${baseUrl} — galaxy ${galaxyScope}`);

    await bootstrapAdmin({ browser, baseUrl, scope: galaxyScope, email: ADMIN_EMAIL, testToken });

    // Register ontology + warm up the bundle via a one-off transaction.
    const ctx = browser.context(baseUrl);
    const setupClient = new HarnessNebulaClient({
      baseUrl,
      authScope: galaxyScope,
      activeScope: galaxyScope,
      appVersion: ONTOLOGY_VERSION,
      fetch: browser.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });
    try {
      const start = Date.now();
      while (setupClient.connectionState !== 'connected') {
        if (Date.now() - start > 10_000) throw new Error('setup WS did not connect within 10s');
        await new Promise((r) => globalThis.setTimeout(r, 25));
      }
      await setupClient.callGalaxyAppendOntologyVersion(galaxyScope, {
        version: ONTOLOGY_VERSION,
        types: TEST_TYPES,
      });
      // Warm the bundle for this galaxy via the public API. This goes to the
      // setupClient's activeScope Star (the bare galaxyScope), which is also
      // the Star the M=2 harness will eventually hit — so the warmup also
      // primes the test Star directly. Public API is deploy-agnostic; it
      // doesn't care whether deployed Star takes 2 or 3 positional args.
      const warmupOutcome = await setupClient.resources.transaction(
        {
          [crypto.randomUUID()]: {
            op: 'create',
            typeName: 'TestResource',
            nodeId: ROOT_NODE_ID,
            value: { title: 'warmup', count: 0 },
          },
        },
      );
      if (warmupOutcome.kind !== 'committed') {
        throw new Error(`warmup did not commit: ${JSON.stringify(warmupOutcome)}`);
      }
    } finally {
      (setupClient as any)[Symbol.dispose]?.();
    }

    // M=2 multi-client harness. Both clients share one JWT; each lands on its
    // own Gateway DO via distinct `tabId`. activeScope = the star (the structural
    // guard requires aud == star — scope-isolation T6), so both hit the same tenant.
    const starName = `${galaxyScope}.tenant-fanout`;
    const harness = await setupMultiClient({
      browser,
      baseUrl,
      testToken,
      galaxyScope,
      activeScope: starName,
      email: ADMIN_EMAIL,
      M: 2,
    });

    try {
      const [originator, subscriber] = harness.clients;
      console.log(`[fanout-bench Phase 1] M=${harness.clients.length} clients connected`);

      // Step 1: originator creates the resource. We use a known resourceId so
      // we can subscribe to it. The first eTag is auto-generated for the
      // create op; we capture it from the transaction outcome.
      const resourceId = crypto.randomUUID();
      const createOutcome = await originator.resources.transaction(
        {
          [resourceId]: {
            op: 'create',
            typeName: 'TestResource',
            nodeId: ROOT_NODE_ID,
            value: { title: 'fanout-base', count: 0 },
          },
        },
      );
      const createETag = committedETag(createOutcome, resourceId);
      console.log(`[fanout-bench Phase 1] resource created — id=${resourceId} eTag=${createETag.slice(0, 8)}`);

      // Step 2: subscriber subscribes. Initial snapshot arrives via
      // handleResourceUpdate with the create-time eTag — captured but not the
      // measurement target.
      const initialSnapshot = await subscriber.resources.subscribe('TestResource', resourceId).snapshot;
      if (!initialSnapshot) throw new Error('subscriber received null initial snapshot');
      expect(initialSnapshot.meta.eTag).toBe(createETag);
      console.log(`[fanout-bench Phase 1] subscriber subscribed — initial eTag matches`);

      // Step 3: warmup iterations — let the hot path settle before measurement.
      let currentETag = createETag;
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        const out = await originator.resources.transaction(
          { [resourceId]: { op: 'put', typeName: 'TestResource', eTag: currentETag, value: { title: `warmup-${i}`, count: i } } },
        );
        const newETag = committedETag(out, resourceId);
        await subscriber.waitForFanoutArrival(newETag, FANOUT_TIMEOUT_MS);
        currentETag = newETag;
      }
      subscriber.resetFanoutArrivals();
      console.log(`[fanout-bench Phase 1] warmup done; starting ${BASELINE_ITERATIONS} measured iterations`);

      // Step 4: measured iterations.
      interface IterSample {
        iter: number;
        eTag: string;
        tBeforeCommit: number;
        tAfterCommit: number;
        tArrived: number;
      }
      const samples: IterSample[] = [];

      for (let i = 0; i < BASELINE_ITERATIONS; i++) {
        const tBeforeCommit = performance.now();
        const out = await originator.resources.transaction(
          { [resourceId]: { op: 'put', typeName: 'TestResource', eTag: currentETag, value: { title: `measured-${i}`, count: i + 1000 } } },
        );
        const tAfterCommit = performance.now();
        const newETag = committedETag(out, resourceId);
        const tArrived = await subscriber.waitForFanoutArrival(newETag, FANOUT_TIMEOUT_MS);
        samples.push({ iter: i, eTag: newETag, tBeforeCommit, tAfterCommit, tArrived });
        currentETag = newETag;
      }

      // Step 5: summarize. Two metrics:
      //   - `commit-to-arrival`: t_arrived - t_after_commit. Can be negative
      //     if the subscriber's same-DC fanout RT is shorter than the
      //     originator's transaction round trip. That's expected and useful
      //     to see — it tells us "subscriber learned of the change before
      //     the originator got confirmation."
      //   - `end-to-end`: t_arrived - t_before_commit. The wall-clock
      //     latency from "user pressed submit" to "other tab updated."
      const commitToArrival = samples.map((s) => s.tArrived - s.tAfterCommit);
      const endToEnd = samples.map((s) => s.tArrived - s.tBeforeCommit);
      const commitDuration = samples.map((s) => s.tAfterCommit - s.tBeforeCommit);

      const summary = {
        label,
        baseUrl,
        galaxyScope,
        starName,
        M: harness.clients.length,
        iterations: samples.length,
        commitToArrival: statsOf(commitToArrival),
        endToEnd: statsOf(endToEnd),
        commitDuration: statsOf(commitDuration),
      };

      console.log('\n==================== fanout-bench Phase 1 results ====================');
      console.log(`M=${summary.M} subscribers (1 originator + 1 subscriber), ${summary.iterations} iterations`);
      console.log(`  commit duration (originator):  mean ${fmt(summary.commitDuration.mean)} ms  p50 ${fmt(summary.commitDuration.p50)} ms  p99 ${fmt(summary.commitDuration.p99)} ms`);
      console.log(`  commit-to-arrival (Δ):         mean ${fmt(summary.commitToArrival.mean)} ms  p50 ${fmt(summary.commitToArrival.p50)} ms  p99 ${fmt(summary.commitToArrival.p99)} ms`);
      console.log(`  end-to-end (commit→see):       mean ${fmt(summary.endToEnd.mean)} ms  p50 ${fmt(summary.endToEnd.p50)} ms  p99 ${fmt(summary.endToEnd.p99)} ms`);
      console.log('======================================================================\n');

      const rawPath = path.join(__dirname, `fanout-raw-${label}.json`);
      fs.writeFileSync(rawPath, JSON.stringify({ summary, samples }, null, 2));
      console.log(`[fanout-bench Phase 1] raw → ${rawPath}`);

      const lines = [
        `# Fanout Bench — Phase 1 (single-subscriber baseline, ${label})`,
        ``,
        `- **baseUrl**: \`${baseUrl}\``,
        `- **galaxy scope**: \`${galaxyScope}\` (unique per run)`,
        `- **star**: \`${starName}\``,
        `- **M**: ${summary.M} clients (1 originator + 1 subscriber)`,
        `- **iterations**: ${summary.iterations}`,
        `- **bench source**: [fanout.benchmark.ts](fanout.benchmark.ts) · [harness-client.ts](harness-client.ts)`,
        ``,
        `## Latency`,
        ``,
        `| Metric | mean | p50 | p75 | p95 | p99 | min | max |`,
        `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
        `| commit duration (originator) | ${fmt(summary.commitDuration.mean)} | ${fmt(summary.commitDuration.p50)} | ${fmt(summary.commitDuration.p75)} | ${fmt(summary.commitDuration.p95)} | ${fmt(summary.commitDuration.p99)} | ${fmt(summary.commitDuration.min)} | ${fmt(summary.commitDuration.max)} |`,
        `| commit-to-arrival Δ | ${fmt(summary.commitToArrival.mean)} | ${fmt(summary.commitToArrival.p50)} | ${fmt(summary.commitToArrival.p75)} | ${fmt(summary.commitToArrival.p95)} | ${fmt(summary.commitToArrival.p99)} | ${fmt(summary.commitToArrival.min)} | ${fmt(summary.commitToArrival.max)} |`,
        `| end-to-end (commit→see) | ${fmt(summary.endToEnd.mean)} | ${fmt(summary.endToEnd.p50)} | ${fmt(summary.endToEnd.p75)} | ${fmt(summary.endToEnd.p95)} | ${fmt(summary.endToEnd.p99)} | ${fmt(summary.endToEnd.min)} | ${fmt(summary.endToEnd.max)} |`,
        ``,
        `All values in milliseconds.`,
        ``,
        `**commit duration** is how long the originator's \`client.resources.transaction()\` took to resolve — proxy for client↔Star↔client round trip plus parse-validate work.`,
        ``,
        `**commit-to-arrival Δ** is \`t_arrived − t_after_commit\`. Negative values are normal: the subscriber's same-DC fanout one-way is often shorter than the originator's full round trip, so the subscriber learns of the change before the originator gets confirmation.`,
        ``,
        `**end-to-end** is \`t_arrived − t_before_commit\` — the wall-clock latency from "user pressed submit" to "other tab updated."`,
        ``,
        `## How to re-run`,
        ``,
        '```',
        `cd apps/nebula && npm run bench:fanout`,
        '```',
        ``,
        `Deployed:`,
        '```',
        `cd apps/nebula && BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev npm run bench:fanout`,
        '```',
        ``,
      ];
      const summaryPath = path.join(__dirname, `RESULTS-fanout-${label}.md`);
      fs.writeFileSync(summaryPath, lines.join('\n'));
      console.log(`[fanout-bench Phase 1] summary → ${summaryPath}`);

      // Sanity assertions — bench shouldn't pass if structurally broken.
      expect(summary.iterations).toBe(BASELINE_ITERATIONS);
      expect(summary.endToEnd.mean).toBeGreaterThan(0);
      expect(summary.commitDuration.mean).toBeGreaterThan(0);
    } finally {
      harness.dispose();
    }
  }, TEST_TIMEOUT_MS);
});

interface CommitMeasurement {
  commitIndex: number;
  /** eTag the originator pre-generated for this commit. */
  eTag: string;
  /** `performance.now()` when originator started transaction(). */
  tBeforeCommit: number;
  /** `performance.now()` when originator's transaction() resolved. */
  tAfterCommit: number;
  /**
   * Per-subscriber arrival times (subscriberIndex → t_arrived). subscriberIndex
   * matches the harness's subscribe order, which is what Star's Subscriptions
   * map iterates (insertion-ordered).
   */
  arrivals: Array<{ subscriberIndex: number; tArrived: number }>;
  /** subscriberIndexes that never delivered within FANOUT_TIMEOUT_MS. */
  missing: number[];
}

interface RampStepResult {
  N: number;
  resourceId: string;
  commits: CommitMeasurement[];
}

async function runRampStep(args: {
  N: number;
  originator: HarnessNebulaClient;
  subscribers: HarnessNebulaClient[];
  galaxyScope: string;
}): Promise<RampStepResult> {
  const { N, originator, subscribers, galaxyScope } = args;
  if (subscribers.length !== N) {
    throw new Error(`runRampStep: expected ${N} subscribers, got ${subscribers.length}`);
  }

  // Fresh resource per N so prior-step subscriptions don't leak in.
  const resourceId = crypto.randomUUID();
  const createOutcome = await originator.resources.transaction(
    {
      [resourceId]: {
        op: 'create',
        typeName: 'TestResource',
        nodeId: ROOT_NODE_ID,
        value: { title: `ramp-N=${N}`, count: 0 },
      },
    },
  );
  const createETag = committedETag(createOutcome, resourceId);

  // All N subscribers subscribe in parallel. Each subscribe() resolves when
  // the subscriber sees the initial snapshot.
  await Promise.all(
    subscribers.map((sub) => sub.resources.subscribe('TestResource', resourceId)),
  );

  // Reset per-subscriber arrival maps so initial-snapshot eTag entries don't
  // sit there (memory bound only — we don't look them up).
  for (const sub of subscribers) sub.resetFanoutArrivals();

  let currentETag = createETag;
  const commits: CommitMeasurement[] = [];

  for (let c = 0; c < RAMP_COMMITS_PER_N; c++) {
    const tBeforeCommit = performance.now();
    const out = await originator.resources.transaction(
      { [resourceId]: { op: 'put', typeName: 'TestResource', eTag: currentETag, value: { title: `ramp-N=${N}-c=${c}`, count: c + 1 } } },
    );
    const tAfterCommit = performance.now();
    const newETag = committedETag(out, resourceId);

    // Wait for all subscribers' arrivals in parallel. Each Promise resolves
    // with the per-subscriber t_arrived. Failed (timeout) Promises go to the
    // `missing` list.
    const arrivals: Array<{ subscriberIndex: number; tArrived: number }> = [];
    const missing: number[] = [];
    await Promise.all(
      subscribers.map(async (sub, idx) => {
        try {
          const tArrived = await sub.waitForFanoutArrival(newETag, FANOUT_TIMEOUT_MS);
          arrivals.push({ subscriberIndex: idx, tArrived });
        } catch {
          missing.push(idx);
        }
      }),
    );

    commits.push({
      commitIndex: c,
      eTag: newETag,
      tBeforeCommit,
      tAfterCommit,
      arrivals,
      missing,
    });
    currentETag = newETag;

    // Reset arrival maps between commits to bound memory at high N.
    for (const sub of subscribers) sub.resetFanoutArrivals();
  }

  void galaxyScope;
  return { N, resourceId, commits };
}

function summarizeRampStep(step: RampStepResult): {
  N: number;
  commits: number;
  errors: number;
  span: Stats;
  perSubscriberLatency: Stats;
  endToEnd: Stats;
  /** Originator's transaction RT (`tAfterCommit - tBeforeCommit`) per commit. */
  commitDuration: Stats;
} {
  const spans: number[] = [];
  const perSubscriber: number[] = [];
  const endToEnd: number[] = [];
  const commitDuration: number[] = [];
  let errors = 0;

  for (const commit of step.commits) {
    errors += commit.missing.length;
    commitDuration.push(commit.tAfterCommit - commit.tBeforeCommit);
    if (commit.arrivals.length === 0) continue;
    const times = commit.arrivals.map((a) => a.tArrived);
    const min = Math.min(...times);
    const max = Math.max(...times);
    spans.push(max - min);
    for (const a of commit.arrivals) {
      perSubscriber.push(a.tArrived - commit.tAfterCommit);
      endToEnd.push(a.tArrived - commit.tBeforeCommit);
    }
  }

  return {
    N: step.N,
    commits: step.commits.length,
    errors,
    span: statsOf(spans),
    perSubscriberLatency: statsOf(perSubscriber),
    endToEnd: statsOf(endToEnd),
    commitDuration: statsOf(commitDuration),
  };
}

describe('fanout latency — Phase 3 (N-subscriber ramp, Lumenize Gateway 1:1)', () => {
  it('measures fanout shape across N values', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const testToken = inject('emailTestToken');
    const browser = new Browser();
    const galaxyScope = uniqueGalaxy();
    const isDeployed = !!process.env.BENCH_BASE_URL;
    const label = isDeployed ? 'deployed' : 'local';

    const N_MAX = Math.max(...RAMP_N_VALUES);
    const M_MAX = N_MAX + 1; // 1 originator + N subscribers

    console.log(
      `[fanout-bench Phase 3] ${label} — ${baseUrl} — galaxy ${galaxyScope} — N values [${RAMP_N_VALUES.join(',')}] — pre-creating ${M_MAX} clients`,
    );

    await bootstrapAdmin({ browser, baseUrl, scope: galaxyScope, email: ADMIN_EMAIL, testToken });

    // Inline the multi-client bootstrap (mirroring throughput-multi.benchmark.ts)
    // so we can pre-create M_MAX clients and slice subsets per N step.
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

    const allClients: HarnessNebulaClient[] = [];
    const allContexts: ReturnType<Browser['context']>[] = [];
    for (let i = 0; i < M_MAX; i++) {
      const ctx = browser.context(baseUrl);
      const tabId = crypto.randomUUID().slice(0, 8);
      const client = new HarnessNebulaClient({
        baseUrl,
        authScope: galaxyScope,
        activeScope: galaxyScope,
        appVersion: ONTOLOGY_VERSION,
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
      const wsTimeoutMs = parseInt(process.env.FANOUT_WS_TIMEOUT_MS ?? '120000', 10);
      console.log(`[fanout-bench Phase 3] waiting for ${M_MAX} WS connections (timeout ${wsTimeoutMs}ms)`);
      const wsStart = Date.now();
      await Promise.all(
        allClients.map(async (client, idx) => {
          while (client.connectionState !== 'connected') {
            if (Date.now() - wsStart > wsTimeoutMs) {
              throw new Error(`Client ${idx} did not connect within ${wsTimeoutMs}ms (state=${client.connectionState})`);
            }
            await new Promise((r) => globalThis.setTimeout(r, 25));
          }
        }),
      );
      console.log(`[fanout-bench Phase 3] all ${M_MAX} clients connected in ${Date.now() - wsStart}ms`);

      // Register ontology + pre-warm bundle via the public API. The warmup
      // create lands on `allClients[0]`'s activeScope Star (the bare
      // galaxyScope) — same Star each ramp step uses, so this primes both
      // the bundle cache AND the test Star directly. Public API is
      // deploy-agnostic.
      await allClients[0].callGalaxyAppendOntologyVersion(galaxyScope, {
        version: ONTOLOGY_VERSION,
        types: TEST_TYPES,
      });
      const warmupOutcome = await allClients[0].resources.transaction(
        {
          [crypto.randomUUID()]: {
            op: 'create',
            typeName: 'TestResource',
            nodeId: ROOT_NODE_ID,
            value: { title: 'warmup', count: 0 },
          },
        },
      );
      if (warmupOutcome.kind !== 'committed') {
        throw new Error(`Phase 3 warmup did not commit: ${JSON.stringify(warmupOutcome)}`);
      }
      console.log(`[fanout-bench Phase 3] ontology registered + bundle pre-warmed`);

      // Walk N values from smallest to largest. Originator is always clients[0];
      // subscribers are clients[1..N+1].
      const stepResults: RampStepResult[] = [];
      const summaries: ReturnType<typeof summarizeRampStep>[] = [];
      const sortedN = [...RAMP_N_VALUES].sort((a, b) => a - b);
      for (const N of sortedN) {
        console.log(`[fanout-bench Phase 3] N=${N} — ${RAMP_COMMITS_PER_N} commits`);
        const stepStart = Date.now();
        const step = await runRampStep({
          N,
          originator: allClients[0],
          subscribers: allClients.slice(1, N + 1),
          galaxyScope,
        });
        const summary = summarizeRampStep(step);
        stepResults.push(step);
        summaries.push(summary);
        console.log(
          `[fanout-bench Phase 3] N=${N} done in ${Date.now() - stepStart}ms — ` +
          `span p50=${fmt(summary.span.p50)} p99=${fmt(summary.span.p99)} ms — ` +
          `per-sub p50=${fmt(summary.perSubscriberLatency.p50)} p99=${fmt(summary.perSubscriberLatency.p99)} ms — ` +
          `errors=${summary.errors}`,
        );
      }

      // Console summary table.
      console.log('\n==================== fanout-bench Phase 3 results ====================');
      console.log(`${'N'.padStart(6)} | ${'commits'.padStart(7)} | ${'errors'.padStart(6)} | ` +
        `${'commit p50'.padStart(10)} | ${'e2e p50'.padStart(9)} | ${'e2e p99'.padStart(9)} | ${'e2e max'.padStart(9)}`);
      for (const s of summaries) {
        console.log(
          `${String(s.N).padStart(6)} | ${String(s.commits).padStart(7)} | ${String(s.errors).padStart(6)} | ` +
          `${fmt(s.commitDuration.p50).padStart(10)} | ` +
          `${fmt(s.endToEnd.p50).padStart(9)} | ${fmt(s.endToEnd.p99).padStart(9)} | ${fmt(s.endToEnd.max).padStart(9)}`,
        );
      }
      console.log('======================================================================\n');

      // Write raw + summary files.
      const rawPath = path.join(__dirname, `fanout-ramp-raw-${label}.json`);
      fs.writeFileSync(rawPath, JSON.stringify({ label, baseUrl, galaxyScope, summaries, stepResults }, null, 2));
      console.log(`[fanout-bench Phase 3] raw → ${rawPath}`);

      const headerRow = '| N | commits | errors | commit p50 (ms) | e2e p50 (ms) | e2e p99 (ms) | e2e max (ms) |';
      const sepRow = '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |';
      const rows = summaries.map((s) =>
        `| ${s.N} | ${s.commits} | ${s.errors} | ${fmt(s.commitDuration.p50)} | ${fmt(s.endToEnd.p50)} | ${fmt(s.endToEnd.p99)} | ${fmt(s.endToEnd.max)} |`,
      );

      const lines = [
        `# Fanout Bench — Phase 3 (N-subscriber ramp, Lumenize Gateway 1:1, ${label})`,
        ``,
        `- **baseUrl**: \`${baseUrl}\``,
        `- **galaxy scope**: \`${galaxyScope}\``,
        `- **clients pre-created**: ${M_MAX} (1 originator + ${N_MAX} subscribers)`,
        `- **N values**: ${RAMP_N_VALUES.join(', ')}`,
        `- **commits per N**: ${RAMP_COMMITS_PER_N}`,
        `- **bench source**: [fanout.benchmark.ts](fanout.benchmark.ts) · [harness-client.ts](harness-client.ts)`,
        ``,
        `## Latency vs N`,
        ``,
        headerRow,
        sepRow,
        ...rows,
        ``,
        `\`commit p50\` = \`t_after_commit − t_before_commit\` median across commits — the originator's transaction round-trip time, independent of the fanout shape downstream. Useful for separating "what the originator pays" from "what the fanout costs."`,
        ``,
        `\`e2e\` = \`t_arrived − t_before_commit\` per subscriber per commit — wall-clock from "originator called \`transaction()\`" to "subscriber's \`handleResourceUpdate\` fired." \`p50\` is the median subscriber's wait; \`p99\` is the 99th-percentile subscriber's wait; \`max\` is the worst observed subscriber across all commits at this N.`,
        ``,
        `\`errors > 0\` means at least one subscriber didn't receive the push within \`FANOUT_TIMEOUT_MS\`.`,
        ``,
        `Raw per-subscriber arrival data + the full Stats (mean, p50, p75, p95, p99, min, max) for span / per-subscriber-latency / end-to-end are in [fanout-ramp-raw-${label}.json](fanout-ramp-raw-${label}.json).`,
        ``,
      ];
      const summaryPath = path.join(__dirname, `RESULTS-fanout-ramp-${label}.md`);
      fs.writeFileSync(summaryPath, lines.join('\n'));
      console.log(`[fanout-bench Phase 3] summary → ${summaryPath}`);

      // Sanity assertions
      expect(stepResults.length).toBe(RAMP_N_VALUES.length);
      for (const s of summaries) {
        expect(s.commits).toBe(RAMP_COMMITS_PER_N);
      }
    } finally {
      for (const c of allClients) (c as any)[Symbol.dispose]?.();
      for (const ctx of allContexts) ctx.close();
    }
  }, TEST_TIMEOUT_MS);
});
