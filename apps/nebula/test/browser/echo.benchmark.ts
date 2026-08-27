/**
 * Cold-start anatomy — echo bench (2026-07-22).
 *
 * Measures the PURE mesh round-trip to a true NebulaDO (StarTest) with ZERO
 * data-plane work: client → Gateway → Star.echo(value) → back. Same worker,
 * same `InstrumentedNebulaClientGateway` marker decomposition, same harness as
 * transactions.benchmark.ts — so COLD echo is directly comparable to the
 * cold-transaction number (~1.28 s) but with no ontology / parse-validate.
 *
 * Question this settles: is a COLD echo on a fresh Star ~300–600 ms (⇒ the 1.2 s
 * is data-plane work) or ~1.2 s (⇒ it's fresh-Star cold-wake itself)?
 *
 * Blocks (sequential single-client, decomposed WS-hop vs Gateway-onward):
 *   - ping        — Star.ping() no-op mesh-callback (existing WS-leg floor)
 *   - warm echo   — hot Star, echo(value) round trip
 *   - cold echo   — fresh Star per iteration; fresh-Star cold-wake, no data plane
 *
 * Plus a transaction-outcome PROBE: fires a few COLD transactions (fresh Star,
 * same ontology setup as the transactions bench) and records whether each
 * SUCCEEDS or returns OntologyStaleError — settling whether the transactions
 * bench's cold block measured a real Galaxy hop or an error-after-wake path.
 *
 * ⚠ Hits the deployed `nebula-browser-test` worker. Run `npm run deploy:test-worker`
 * BEFORE this bench, or you're measuring stale code. Deployed:
 *   BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev \
 *     npx vitest --run --project browser-bench echo
 */

import { describe, it, expect, inject } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { OperationDescriptor } from '@lumenize/nebula/client';
import { HarnessNebulaClient } from './harness-client';
import { bootstrapUniverseAdmin } from './auth-bootstrap';

const ADMIN_EMAIL = 'test@lumenize.io';
const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

const WARM_ITERATIONS = parseInt(process.env.BENCH_WARM_ITERS ?? '50', 10);
const COLD_ITERATIONS = parseInt(process.env.BENCH_COLD_ITERS ?? '20', 10);
const PING_ITERATIONS = parseInt(process.env.BENCH_PING_ITERS ?? '50', 10);
const PROBE_ITERATIONS = parseInt(process.env.BENCH_PROBE_ITERS ?? '5', 10);
const WARMUP_ITERATIONS = parseInt(process.env.BENCH_WARMUP_ITERS ?? '5', 10);
const TEST_TIMEOUT_MS = parseInt(process.env.BENCH_TEST_TIMEOUT_MS ?? '600000', 10);

function uniqueGalaxy(): string {
  return `acme-${crypto.randomUUID().slice(0, 8)}.app`;
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

interface Sample { sendTs: number; markerArrival: number; responseArrival: number; }
interface Stats { mean: number; p50: number; p99: number; min: number; max: number; }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function statsOf(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    mean: sorted.length ? sum / sorted.length : NaN,
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function fmt(n: number, d = 2): string { return Number.isFinite(n) ? n.toFixed(d) : 'n/a'; }

interface BlockSummary { name: string; iterations: number; wsHop: Stats; gatewayOnward: Stats; endToEnd: Stats; }

function summarizeBlock(name: string, samples: Sample[]): BlockSummary {
  return {
    name,
    iterations: samples.length,
    wsHop: statsOf(samples.map((s) => s.markerArrival - s.sendTs)),
    gatewayOnward: statsOf(samples.map((s) => s.responseArrival - s.markerArrival)),
    endToEnd: statsOf(samples.map((s) => s.responseArrival - s.sendTs)),
  };
}

async function runSequentialBlock(
  iterations: number,
  callOnce: (i: number) => Promise<{ sendTs: number; markerArrival: number; responseArrival: number }>,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let i = 0; i < iterations; i++) {
    const r = await callOnce(i);
    samples.push({ sendTs: r.sendTs, markerArrival: r.markerArrival, responseArrival: r.responseArrival });
  }
  return samples;
}

describe('echo latency (cold-start anatomy)', () => {
  it('ping / warm-echo / cold-echo + cold-transaction probe', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const testToken = inject('emailTestToken');
    const browser = new Browser();
    const galaxyScope = uniqueGalaxy();
    const warmStar = `${galaxyScope}.tenant-warm`;
    const label = process.env.BENCH_BASE_URL ? 'deployed' : 'local';
    console.log(`[echo-bench] ${label} — ${baseUrl} — galaxy ${galaxyScope}`);

    const universeScope = await bootstrapUniverseAdmin({ browser, baseUrl, scope: galaxyScope, email: ADMIN_EMAIL, testToken });
    const ctx = browser.context(baseUrl);
    const client = new HarnessNebulaClient({
      baseUrl,
      authScope: universeScope,
      activeScope: galaxyScope,
      ontologyVersion: 'v1',
      fetch: browser.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });

    const wsStart = Date.now();
    while (client.connectionState !== 'connected') {
      if (Date.now() - wsStart > 10_000) {
        throw new Error(`WS did not connect within 10s (state=${client.connectionState})`);
      }
      await new Promise((r) => globalThis.setTimeout(r, 25));
    }

    // --- ECHO measurement (the main event) — captured first so a probe failure
    //     below can't cost us the numbers. echo touches no ontology, so no setup. ---
    for (let i = 0; i < WARMUP_ITERATIONS; i++) await client.callStarEcho(warmStar, 'warm');

    const pingSamples = await runSequentialBlock(PING_ITERATIONS, () => client.callStarPing(warmStar));
    const warmSamples = await runSequentialBlock(WARM_ITERATIONS, () => client.callStarEcho(warmStar, 'x'));
    const coldSamples = await runSequentialBlock(COLD_ITERATIONS, () => {
      const star = `${galaxyScope}.tenant-cold-${crypto.randomUUID().slice(0, 8)}`;
      return client.callStarEcho(star, 'x');
    });

    const blocks = [
      summarizeBlock('ping (no-op)', pingSamples),
      summarizeBlock('warm echo', warmSamples),
      summarizeBlock('cold echo (fresh Star)', coldSamples),
    ];
    console.log('\n==================== echo-bench results ====================');
    for (const b of blocks) {
      console.log(`\n${b.name}  (${b.iterations} iters)`);
      console.log(`  WS hop client<->Gateway:  mean ${fmt(b.wsHop.mean)}  p50 ${fmt(b.wsHop.p50)}  p99 ${fmt(b.wsHop.p99)} ms`);
      console.log(`  Gateway-onward:           mean ${fmt(b.gatewayOnward.mean)}  p50 ${fmt(b.gatewayOnward.p50)}  p99 ${fmt(b.gatewayOnward.p99)} ms`);
      console.log(`  end-to-end:               mean ${fmt(b.endToEnd.mean)}  p50 ${fmt(b.endToEnd.p50)}  p99 ${fmt(b.endToEnd.p99)} ms`);
    }

    // --- Transaction-outcome PROBE (bonus; wrapped so it can't lose the echo numbers).
    //     Same ontology setup as transactions.benchmark.ts, then a handful of COLD
    //     transactions on fresh Stars: SUCCESS ⇒ real ontology/Galaxy path on cold;
    //     ontology-stale ⇒ the transactions bench's cold block timed an error-after-wake. ---
    const probe: Record<string, number> = {};
    try {
      await client.callGalaxyAppendOntologyVersion(galaxyScope, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
      await client.callStarTransaction(`${galaxyScope}.tenant-warmup`, ONTOLOGY_VERSION, createOp());
      for (let i = 0; i < PROBE_ITERATIONS; i++) {
        const star = `${galaxyScope}.tenant-probe-${crypto.randomUUID().slice(0, 8)}`;
        let outcome: string;
        try {
          await client.callStarTransaction(star, ONTOLOGY_VERSION, createOp());
          outcome = 'success';
        } catch (err: any) {
          outcome = err?.name === 'OntologyStaleError' ? 'ontology-stale' : `error:${err?.name ?? 'unknown'}`;
        }
        probe[outcome] = (probe[outcome] ?? 0) + 1;
      }
    } catch (err: any) {
      probe[`setup-failed:${err?.name ?? 'unknown'}`] = 1;
    }
    console.log(`\ncold-transaction probe (${PROBE_ITERATIONS} fresh Stars): ${JSON.stringify(probe)}`);
    console.log('============================================================\n');

    // Capable-of-failing: every block produced finite decomposed timings.
    expect(coldSamples.length).toBe(COLD_ITERATIONS);
    for (const b of blocks) {
      expect(Number.isFinite(b.endToEnd.p50)).toBe(true);
      expect(b.endToEnd.p50).toBeGreaterThan(0);
    }
  }, TEST_TIMEOUT_MS);
});
