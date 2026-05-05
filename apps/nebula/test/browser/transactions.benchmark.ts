/**
 * ⚠ Hits the deployed `nebula-browser-test` worker. Run
 *   `wrangler deploy --config test/browser/worker/wrangler.jsonc`
 * BEFORE this bench, or you're measuring stale code. No automatic
 * version-pinning today — see `tasks/nebula-release-process.md`.
 *
 * Sequential latency bench for the integrated parse-validate stack, with
 * **per-call hop decomposition** via the marker-frame instrumentation in
 * `InstrumentedNebulaClientGateway` (see `tasks/gateway-hop-benchmark.md`).
 *
 * Each iteration captures three Node-side timestamps via `performance.now()`:
 *   - `sendTs`           — when the outbound CALL message is sent
 *   - `markerArrival`    — when the Gateway-emitted `bench_marker` arrives
 *   - `responseArrival`  — when the Promise settles (CALL_RESPONSE for delay,
 *                          mesh callback for transaction/ping)
 *
 * Three deltas:
 *   - WS hop (client↔Gateway, round trip) = `markerArrival − sendTs`
 *   - Gateway-onward                       = `responseArrival − markerArrival`
 *   - end-to-end                           = `responseArrival − sendTs`
 *
 * "Gateway-onward" includes Workers RPC × 2 between Gateway and Star + Star
 * processing + (for mesh-callback patterns) the callback Workers RPC + the
 * Gateway's outbound INCOMING_CALL processing + the Gateway-to-client WS
 * one-way. The exact sub-shape differs across patterns; the two-bucket split
 * is the headline. Finer decomposition is a Phase 5 follow-up.
 *
 * Three blocks, all sequential single-client:
 *   - ping    — `Star.ping()` no-op handler (mesh-callback pattern). WS-leg
 *               baseline; comparing this Gateway-onward to transaction's
 *               isolates the parse-validate work.
 *   - warm    — same Star across iterations, hot Handler 1 cache, no Galaxy
 *               hop. Steady-state cost of one transaction on a hot DO.
 *   - cold    — fresh Star per iteration (varies tenant segment only).
 *               Galaxy + bundle stay warm; Star pays a cache miss + Galaxy
 *               hop. Common real-world cold path.
 *
 * Replaces the old `transactions.bench.ts` (vi.bench-based, single-number
 * per block). Why the switch: vi.bench measures one number per `bench()`
 * block; the decomposition needs three. The throughput bench already uses
 * the `it()` + manual-loop pattern; this bench follows suit so we have one
 * pattern across all benches.
 *
 * Output: `RESULTS-{label}.md` (overwritten per run; gitignored) and
 *         `transactions-raw-{label}.json` (raw per-iteration data; gitignored).
 *         Hand-curated `RESULTS.md` cites these.
 */

import { describe, it, expect, inject } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { OperationDescriptor } from '@lumenize/nebula/client';
import { HarnessNebulaClient, type DecomposedCallResult } from './harness-client';
import { bootstrapAdmin } from './auth-bootstrap';

const ADMIN_EMAIL = 'test@lumenize.io';
const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

const WARM_ITERATIONS = parseInt(process.env.BENCH_WARM_ITERS ?? '100', 10);
const COLD_ITERATIONS = parseInt(process.env.BENCH_COLD_ITERS ?? '30', 10);
const PING_ITERATIONS = parseInt(process.env.BENCH_PING_ITERS ?? '100', 10);
const WARMUP_ITERATIONS = parseInt(process.env.BENCH_WARMUP_ITERS ?? '5', 10);
const TEST_TIMEOUT_MS = parseInt(process.env.BENCH_TEST_TIMEOUT_MS ?? '600000', 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function uniqueGalaxy(): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `acme-${suffix}.app`;
}

function createOp(): Record<string, OperationDescriptor> {
  return {
    [crypto.randomUUID()]: {
      op: 'create',
      typeName: 'TestResource',
      nodeId: ROOT_NODE_ID,
      value: { title: 'bench' },
    },
  };
}

interface Sample {
  sendTs: number;
  markerArrival: number;
  responseArrival: number;
}

interface Stats {
  mean: number;
  p50: number;
  p75: number;
  p99: number;
  min: number;
  max: number;
}

interface BlockSummary {
  name: string;
  iterations: number;
  wsHop: Stats;
  gatewayOnward: Stats;
  endToEnd: Stats;
  errors: number;
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
    p99: percentile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function summarizeBlock(name: string, samples: Sample[]): BlockSummary {
  const wsHop = samples.map((s) => s.markerArrival - s.sendTs);
  const gatewayOnward = samples.map((s) => s.responseArrival - s.markerArrival);
  const endToEnd = samples.map((s) => s.responseArrival - s.sendTs);
  return {
    name,
    iterations: samples.length,
    wsHop: statsOf(wsHop),
    gatewayOnward: statsOf(gatewayOnward),
    endToEnd: statsOf(endToEnd),
    errors: 0,
  };
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

function buildMarkdown(args: {
  label: string;
  baseUrl: string;
  galaxyScope: string;
  blocks: BlockSummary[];
}): string {
  const { label, baseUrl, galaxyScope, blocks } = args;

  const headerRow =
    '| Block | iterations | WS hop client↔Gateway (mean / p50 / p99) | Gateway-onward (mean / p50 / p99) | end-to-end (mean / p50 / p99) |';
  const sepRow =
    '| --- | ---: | ---: | ---: | ---: |';

  const rows = blocks.map((b) => {
    const ws = `${fmt(b.wsHop.mean)} / ${fmt(b.wsHop.p50)} / ${fmt(b.wsHop.p99)}`;
    const gw = `${fmt(b.gatewayOnward.mean)} / ${fmt(b.gatewayOnward.p50)} / ${fmt(b.gatewayOnward.p99)}`;
    const e2e = `${fmt(b.endToEnd.mean)} / ${fmt(b.endToEnd.p50)} / ${fmt(b.endToEnd.p99)}`;
    return `| ${b.name} | ${b.iterations} | ${ws} ms | ${gw} ms | ${e2e} ms |`;
  });

  const lines = [
    `# Transactions Bench Results (${label})`,
    ``,
    `Sequential single-client latency for the integrated parse-validate stack, with per-call decomposition via the \`InstrumentedNebulaClientGateway\` marker pattern. See [gateway-hop-benchmark.md](../../../../tasks/gateway-hop-benchmark.md) for design.`,
    ``,
    `- **baseUrl**: \`${baseUrl}\``,
    `- **galaxy scope**: \`${galaxyScope}\` (unique per run)`,
    `- **bench source**: [transactions.benchmark.ts](transactions.benchmark.ts) · [harness-client.ts](harness-client.ts)`,
    ``,
    `## Decomposed latency`,
    ``,
    headerRow,
    sepRow,
    ...rows,
    ``,
    `**WS hop client↔Gateway**: round trip from the test client to the Gateway DO and back. Measured as \`markerArrival − sendTs\` where the marker is emitted by \`InstrumentedNebulaClientGateway.onBeforeCallToMesh\` *before* the Workers RPC dispatch to Star.`,
    ``,
    `**Gateway-onward**: \`responseArrival − markerArrival\`. Includes Workers RPC × 2 between Gateway and Star + Star processing + (for mesh-callback patterns) the callback Workers RPC + the outbound INCOMING_CALL Gateway processing + the Gateway-to-client WS one-way. The Gateway-to-client WS one-way appears in *both* \`markerArrival\` and \`responseArrival\` and cancels in the subtraction.`,
    ``,
    `**end-to-end**: \`responseArrival − sendTs\`. Matches the wall-clock latency a real client would observe.`,
    ``,
    `### Cross-block readings`,
    ``,
    `- Subtracting **ping**'s \`Gateway-onward\` from **warm transaction**'s \`Gateway-onward\` isolates the parse-validate transaction work (parse + DagTree permission check + storage write + result construction). Both blocks share the same WS path, the same Workers RPC × 2 to Star and back, and the same mesh-callback shape.`,
    `- Subtracting **warm**'s \`Gateway-onward\` from **cold**'s \`Gateway-onward\` isolates the cache-miss + Galaxy-hop overhead.`,
    `- The **WS hop** column is the same shape across all three blocks (it's the client↔Gateway round trip, independent of what the Gateway does next), so any drift is harness/network noise. Stable WS hop ↔ trustworthy decomposition.`,
    ``,
    `## How to re-run`,
    ``,
    `Local (auto-spawns wrangler dev):`,
    ``,
    '```',
    `cd apps/nebula && npm run bench`,
    '```',
    ``,
    `Deployed (override base URL):`,
    ``,
    '```',
    `cd apps/nebula && BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev npm run bench`,
    '```',
    ``,
    `To redeploy after code changes:`,
    ``,
    '```',
    `cd apps/nebula && npx wrangler deploy --config test/browser/worker/wrangler.jsonc`,
    '```',
    ``,
  ];
  return lines.join('\n');
}

async function runSequentialBlock(
  name: string,
  iterations: number,
  callOnce: (i: number) => Promise<DecomposedCallResult<unknown>>,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let i = 0; i < iterations; i++) {
    const r = await callOnce(i);
    samples.push({ sendTs: r.sendTs, markerArrival: r.markerArrival, responseArrival: r.responseArrival });
  }
  return samples;
}

describe('transactions latency (decomposed)', () => {
  it('measures ping / warm / cold blocks with hop decomposition', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const testToken = inject('emailTestToken');
    const browser = new Browser();
    const galaxyScope = uniqueGalaxy();
    const warmStar = `${galaxyScope}.tenant-warm`;
    const isDeployed = !!process.env.BENCH_BASE_URL;
    const label = isDeployed ? 'deployed' : 'local';

    console.log(`[transactions-bench] ${label} — ${baseUrl} — galaxy ${galaxyScope}`);

    await bootstrapAdmin({ browser, baseUrl, scope: galaxyScope, email: ADMIN_EMAIL, testToken });

    const ctx = browser.context(baseUrl);
    const client = new HarnessNebulaClient({
      baseUrl,
      authScope: galaxyScope,
      activeScope: galaxyScope,
      fetch: browser.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });

    try {
      const wsStart = Date.now();
      while (client.connectionState !== 'connected') {
        if (Date.now() - wsStart > 10_000) {
          throw new Error(`WS did not connect within 10s (state=${client.connectionState})`);
        }
        await new Promise((r) => globalThis.setTimeout(r, 25));
      }

      // Register ontology and pre-warm bundle. Pre-warm pattern matches the
      // throwaway tenant approach in the old transactions.bench.ts: hits
      // any Star under the galaxy to populate Worker Loader cache for
      // `<galaxy>/<version>` so cold-block iteration 1 doesn't pay the
      // ~262 ms one-time bundle load.
      console.log('[transactions-bench] registering ontology + pre-warming bundle');
      await client.callGalaxyAppendOntologyVersion(galaxyScope, {
        version: ONTOLOGY_VERSION,
        types: TEST_TYPES,
      });
      await client.callStarTransaction(`${galaxyScope}.tenant-warmup`, ONTOLOGY_VERSION, createOp());

      // Warmup iterations on the warm Star — gets the harness, the WS, and
      // Handler 1's cache hot before measurement starts.
      console.log(`[transactions-bench] warmup (${WARMUP_ITERATIONS} iterations)`);
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        await client.callStarTransaction(warmStar, ONTOLOGY_VERSION, createOp());
      }

      console.log(`[transactions-bench] ping block (${PING_ITERATIONS} iterations)`);
      const pingSamples = await runSequentialBlock('ping', PING_ITERATIONS, () =>
        client.callStarPing(warmStar),
      );

      console.log(`[transactions-bench] warm block (${WARM_ITERATIONS} iterations)`);
      const warmSamples = await runSequentialBlock('warm', WARM_ITERATIONS, () =>
        client.callStarTransaction(warmStar, ONTOLOGY_VERSION, createOp()),
      );

      console.log(`[transactions-bench] cold block (${COLD_ITERATIONS} iterations, fresh Star per iter)`);
      const coldSamples = await runSequentialBlock('cold', COLD_ITERATIONS, () => {
        const star = `${galaxyScope}.tenant-cold-${crypto.randomUUID().slice(0, 8)}`;
        return client.callStarTransaction(star, ONTOLOGY_VERSION, createOp());
      });

      const blocks: BlockSummary[] = [
        summarizeBlock('ping (no-op handler)', pingSamples),
        summarizeBlock('warm transaction (hot Star)', warmSamples),
        summarizeBlock('cold transaction (fresh Star, cache miss + Galaxy hop)', coldSamples),
      ];

      console.log('\n==================== transactions-bench results ====================');
      for (const b of blocks) {
        console.log(`\n${b.name}  (${b.iterations} iterations)`);
        console.log(`  WS hop client↔Gateway:    mean ${fmt(b.wsHop.mean)} ms  p50 ${fmt(b.wsHop.p50)} ms  p99 ${fmt(b.wsHop.p99)} ms`);
        console.log(`  Gateway-onward:           mean ${fmt(b.gatewayOnward.mean)} ms  p50 ${fmt(b.gatewayOnward.p50)} ms  p99 ${fmt(b.gatewayOnward.p99)} ms`);
        console.log(`  end-to-end:               mean ${fmt(b.endToEnd.mean)} ms  p50 ${fmt(b.endToEnd.p50)} ms  p99 ${fmt(b.endToEnd.p99)} ms`);
      }
      console.log('\n=====================================================================\n');

      const rawPath = path.join(__dirname, `transactions-raw-${label}.json`);
      fs.writeFileSync(rawPath, JSON.stringify({
        label,
        baseUrl,
        galaxyScope,
        blocks: [
          { name: 'ping', samples: pingSamples },
          { name: 'warm', samples: warmSamples },
          { name: 'cold', samples: coldSamples },
        ],
      }, null, 2));
      console.log(`[transactions-bench] raw data → ${rawPath}`);

      const summaryPath = path.join(__dirname, `RESULTS-${label}.md`);
      fs.writeFileSync(summaryPath, buildMarkdown({ label, baseUrl, galaxyScope, blocks }));
      console.log(`[transactions-bench] summary → ${summaryPath}`);

      // Sanity assertions — the bench itself shouldn't pass if something is
      // structurally broken. Loose bounds; tighten to regression-test
      // thresholds later.
      expect(blocks[0].endToEnd.mean, 'ping end-to-end mean should be > 0').toBeGreaterThan(0);
      expect(blocks[1].endToEnd.mean, 'warm transaction end-to-end mean should be > 0').toBeGreaterThan(0);
      expect(blocks[2].endToEnd.mean, 'cold transaction end-to-end mean should be > 0').toBeGreaterThan(0);
      // Decomposition consistency: ws_hop_mean + gateway_onward_mean ≈ end_to_end_mean within 1ms (modulo `performance.now()` precision).
      for (const b of blocks) {
        const sum = b.wsHop.mean + b.gatewayOnward.mean;
        expect(Math.abs(sum - b.endToEnd.mean), `${b.name}: decomposition consistency`).toBeLessThan(1);
      }
    } finally {
      (client as any)[Symbol.dispose]?.();
    }
  }, TEST_TIMEOUT_MS);
});
