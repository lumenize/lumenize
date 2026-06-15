/**
 * Phase 6 of `tasks/gateway-hop-benchmark.md` — empirical cross-region
 * Workers RPC measurement.
 *
 * Compares `Star.delay(200)` latency for two stars on the same Gateway:
 *
 *   - **Same-DC star**: addressed by name (`idFromName`). Cloudflare places
 *     this DO in the same colo as the user's Gateway DO (which follows the
 *     user's first-access colo). For Larry-in-Pittsburgh hitting
 *     `nebula-browser-test.transformation.workers.dev`, both end up in IAD.
 *   - **Cross-region star**: created via `newUniqueId({ jurisdiction: 'eu' })`
 *     at the bench Worker's `/bench/cross-region-star` endpoint, which
 *     forces EU placement (typically ARN, Stockholm). Addressed by its
 *     64-char hex ID — `getDOStub()` auto-detects IDs vs names.
 *
 * Both calls go through the same Gateway DO (same user, same connection),
 * so the WS hop client↔Gateway is constant. The only thing that changes is
 * the Workers RPC hop Gateway↔Star: same-DC for the named star,
 * transatlantic for the EU one. Subtracting their `gateway-onward` times
 * isolates the cross-region Workers RPC delta.
 *
 * Method: `Star.delay(200)` on the Star side, marker emitted by
 * `InstrumentedNebulaClientGateway.onBeforeCallToMesh` *before* the
 * Workers RPC dispatch. `gateway-onward = responseArrival − markerArrival`
 * isolates the entire Cloudflare-side time between Gateway entry and
 * Gateway-exit, with the WS hop cancelling out (it appears in both
 * arrival times). The 200 ms `setTimeout` on Star is constant in both
 * shapes, so the delta is pure Workers RPC RT.
 *
 * Output: prints the comparison; no markdown file. The result feeds into
 * the gateway.mdx Latency bullet update.
 *
 * Run:
 *   `cd apps/nebula && BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev npx vitest run --project browser cross-region`
 */

import { describe, it, inject, expect } from 'vitest';
import { Browser } from '@lumenize/testing';
import { HarnessNebulaClient } from './harness-client';
import { bootstrapAdmin } from './auth-bootstrap';

const ADMIN_EMAIL = 'test@lumenize.io';
const DELAY_MS = 200;
const ITERATIONS = 20;

function uniqueGalaxy(): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `acme-${suffix}.app`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : 'n/a';
}

interface Stats {
  mean: number;
  p50: number;
  p99: number;
  min: number;
  max: number;
}

function statsOf(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    mean: sorted.length === 0 ? NaN : sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

// EU-jurisdiction Star placement (Cloudflare jurisdictionalRestrictions) is a
// deployed-only feature — wrangler-dev's local miniflare doesn't honor it, so
// `/bench/cross-region-star?jurisdiction=eu` returns 500. Gate this test on
// BENCH_BASE_URL being set (the env var that points the bench at a deployed
// Worker), matching the existing `MULTI_CLIENT_STRESS` gating pattern in
// multi-client.test.ts.
describe.runIf(process.env.BENCH_BASE_URL)('Phase 6 cross-region: same-DC vs EU Workers RPC', () => {
  it('measures Workers RPC RT for same-DC vs cross-region Star', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const testToken = inject('emailTestToken');
    const browser = new Browser();
    const galaxyScope = uniqueGalaxy();

    // Step 1: bootstrap auth
    await bootstrapAdmin({ browser, baseUrl, scope: galaxyScope, email: ADMIN_EMAIL, testToken });

    // Step 2: discover the Worker's colo (= Gateway colo for our consistent client)
    const coloRes = await browser.fetch(`${baseUrl}/bench/colo`);
    const { workerColo } = await coloRes.json() as { workerColo: string };
    console.log(`[cross-region] Worker colo: ${workerColo}`);

    // Step 3: create cross-region Star (returns hex ID + its colo, confirming EU placement)
    const crRes = await browser.fetch(`${baseUrl}/bench/cross-region-star?jurisdiction=eu`);
    if (!crRes.ok) throw new Error(`cross-region-star failed: ${crRes.status} ${await crRes.text()}`);
    const { id: crStarId, colo: crStarColo } = await crRes.json() as { id: string; colo: string };
    console.log(`[cross-region] EU-jurisdiction Star colo: ${crStarColo} (id ${crStarId.slice(0, 16)}…)`);

    // Sanity check: the cross-region Star MUST be in a different colo than the Worker.
    // If they're the same, the test is meaningless.
    if (crStarColo === workerColo) {
      throw new Error(
        `Cross-region Star landed in the same colo (${workerColo}) as the Worker. ` +
        `EU jurisdiction was requested but Cloudflare placed it locally — bench cannot proceed.`,
      );
    }

    // Step 4: construct a single client. The Gateway DO it spawns will be in
    // the user's colo (= workerColo).
    const ctx = browser.context(baseUrl);
    const client = new HarnessNebulaClient({
      baseUrl,
      authScope: galaxyScope,
      activeScope: galaxyScope,
      appVersion: 'v1',
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

      // Step 5: warm the same-DC Star + confirm its colo. We use a fresh
      // tenant scope as the same-DC Star's name; it'll be placed near the
      // Gateway (same colo as Worker).
      const sameDcStarName = `${galaxyScope}.tenant-samedc`;
      // Triggers same-DC Star creation via a delay(1) call (creates the DO)
      await client.callStarDelay(sameDcStarName, 1);

      // Both stars now exist. Run the comparison.
      console.log(`[cross-region] running ${ITERATIONS} iterations of Star.delay(${DELAY_MS}) on each`);

      const sameDcOnward: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const r = await client.callStarDelay(sameDcStarName, DELAY_MS);
        sameDcOnward.push(r.responseArrival - r.markerArrival);
      }

      const crOnward: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const r = await client.callStarDelay(crStarId, DELAY_MS);
        crOnward.push(r.responseArrival - r.markerArrival);
      }

      const sameDcStats = statsOf(sameDcOnward);
      const crStats = statsOf(crOnward);

      // Workers RPC RT estimate: gateway-onward minus the 200 ms artificial
      // delay on Star. The remainder is Workers RPC RT (G→S + S→G) plus
      // small fixed overhead (Gateway processing, setTimeout slack). The
      // overhead is constant, so subtracting same-DC from cross-region
      // gives a clean Workers RPC RT delta.
      const sameDcRpcRt = sameDcStats.p50 - DELAY_MS;
      const crRpcRt = crStats.p50 - DELAY_MS;
      const rpcRtDelta = crRpcRt - sameDcRpcRt;

      console.log('\n==================== Phase 6 cross-region results ====================');
      console.log(`Same-DC Star  (${workerColo}, named):   p50 ${fmt(sameDcStats.p50)}  mean ${fmt(sameDcStats.mean)}  p99 ${fmt(sameDcStats.p99)}  [${fmt(sameDcStats.min)}, ${fmt(sameDcStats.max)}] ms`);
      console.log(`Cross-region  (${crStarColo}, EU id):    p50 ${fmt(crStats.p50)}  mean ${fmt(crStats.mean)}  p99 ${fmt(crStats.p99)}  [${fmt(crStats.min)}, ${fmt(crStats.max)}] ms`);
      console.log('');
      console.log(`Workers RPC RT (gateway-onward − ${DELAY_MS} ms delay):`);
      console.log(`  Same-DC (${workerColo}↔${workerColo}):  ~${fmt(sameDcRpcRt)} ms`);
      console.log(`  Cross-region (${workerColo}↔${crStarColo}):  ~${fmt(crRpcRt)} ms`);
      console.log(`  Δ (cross-region − same-DC):          ~${fmt(rpcRtDelta)} ms`);
      console.log('=====================================================================\n');

      // Soft sanity assertions on means (per-iteration values can dip below
      // DELAY_MS due to TCP-level jitter on the marker frame's WS leg —
      // see RESULTS.md "Why p50 not mean" for the full explanation).
      expect(sameDcStats.mean, 'same-DC mean must be ≥ DELAY_MS').toBeGreaterThanOrEqual(DELAY_MS);
      expect(crStats.mean, 'cross-region mean must be ≥ DELAY_MS').toBeGreaterThanOrEqual(DELAY_MS);
      // Cross-region must be slower than same-DC by at least 20 ms (otherwise
      // either the EU Star wasn't actually placed in EU, or the methodology
      // broke).
      expect(rpcRtDelta, 'cross-region RPC RT must exceed same-DC by ≥ 20 ms').toBeGreaterThanOrEqual(20);
    } finally {
      (client as any)[Symbol.dispose]?.();
    }
  }, 180_000);
});
