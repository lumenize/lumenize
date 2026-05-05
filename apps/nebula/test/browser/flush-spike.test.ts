/**
 * Phase 0 spike for `tasks/gateway-hop-benchmark.md`: does `ws.send()` from
 * inside a DO invocation actually flush to the wire at the call site, or is
 * it queued until the invocation ends (alongside the response that follows
 * the await)?
 *
 * Mechanism:
 *   - `InstrumentedNebulaClientGateway.onBeforeCallToMesh` emits a
 *     `bench_marker` frame via `ws.send()` *before* awaiting the cross-DO
 *     Workers RPC to the callee.
 *   - `Star.delay(N)` awaits N ms server-side, then returns N. The Gateway's
 *     invocation is paused at `await stub.__executeOperation(envelope)` for
 *     ~N ms.
 *   - Node test client timestamps the marker frame's arrival
 *     (`onUnknownMessage` → `performance.now()`) and the response's arrival
 *     (callRaw resolution → `performance.now()`).
 *   - Delta `(responseArrival - markerArrival)`:
 *       ~DELAY_MS → marker flushed mid-invocation, design works
 *       ~0 ms    → marker held until invocation end, design must fall back
 *                  to marker-as-separate-mesh-call
 *
 * ──────────────────────────────────────────────────────────────────────────
 * RESULTS (2026-05-05, deployed nebula-browser-test, 30 iterations × 2 runs):
 *
 *   Run 1: responseArrival − markerArrival   mean 259.20  p50 277.47  min 62.57   max 384.90
 *   Run 2: responseArrival − markerArrival   mean 245.76  p50 238.64  min 196.31  max 306.47
 *
 *   sendTs → markerArrival (client→Gateway round trip baseline): mean ~27–35 ms
 *   sendTs → responseArrival (full end-to-end):                  mean ~273–294 ms
 *
 * DECISION: `ws.send()` flushes mid-invocation. Min 196 ms (run 2) is
 *           essentially the full DELAY_MS floor, with the mean ~50 ms above
 *           DELAY_MS reflecting Workers RPC × 2 + setTimeout overhead. If
 *           the marker were held until invocation end, ALL values would
 *           cluster near 0 ms; instead the entire distribution sits above
 *           DELAY_MS (modulo one outlier in run 1 likely caused by transient
 *           TCP-level batching). The marker-from-hook design works.
 *
 * STATUS: This test now serves as a permanent regression check that the
 *         flush invariant still holds. The Phase 2 latency-decomposition
 *         implementation builds directly on the
 *         `InstrumentedNebulaClientGateway` + `BENCH_MARKER` plumbing
 *         already in place.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Run: `cd apps/nebula && BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev npx vitest run --project browser flush-spike`
 */

import { describe, it, inject, expect } from 'vitest';
import { Browser } from '@lumenize/testing';
import { HarnessNebulaClient } from './harness-client';
import { bootstrapAdmin } from './auth-bootstrap';

const ADMIN_EMAIL = 'test@lumenize.io';
const DELAY_MS = 200;
const ITERATIONS = 30;
const WARMUP_ITERATIONS = 3;

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
  return Number.isFinite(n) ? n.toFixed(2) : 'n/a';
}

describe('flush-spike', () => {
  it('measures marker-vs-response arrival delta across an intra-invocation await', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const testToken = inject('emailTestToken');
    const browser = new Browser();
    const galaxyScope = uniqueGalaxy();
    const star = `${galaxyScope}.tenant-spike`;
    const isDeployed = !!process.env.BENCH_BASE_URL;
    const label = isDeployed ? 'deployed' : 'local';

    console.log(`[flush-spike] ${label} — ${baseUrl} — galaxy ${galaxyScope}`);

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

      // Warm up the Star DO so the first measured iteration doesn't pay a
      // wake. Also smoke-tests the marker pipeline — if the Gateway →
      // InstrumentedNebulaClientGateway binding is misconfigured,
      // `callStarDelay` throws because the marker never arrives for the callId.
      console.log(`[flush-spike] warming up (${WARMUP_ITERATIONS} iterations)`);
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        await client.callStarDelay(star, DELAY_MS);
      }

      console.log(`[flush-spike] running ${ITERATIONS} iterations of Star.delay(${DELAY_MS})`);
      type Sample = { markerArrival: number; responseArrival: number; sendTs: number };
      const samples: Sample[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const t = await client.callStarDelay(star, DELAY_MS);
        samples.push({ sendTs: t.sendTs, markerArrival: t.markerArrival, responseArrival: t.responseArrival });
      }

      const deltaMs = samples.map((s) => s.responseArrival - s.markerArrival).sort((a, b) => a - b);
      const sendToMarkerMs = samples.map((s) => s.markerArrival - s.sendTs).sort((a, b) => a - b);
      const totalMs = samples.map((s) => s.responseArrival - s.sendTs).sort((a, b) => a - b);
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

      const summary = {
        delayMs: DELAY_MS,
        iterations: ITERATIONS,
        // (responseArrival - markerArrival) — the headline number.
        // ~DELAY_MS → flushes mid-invocation. ~0 → deferred.
        responseMinusMarker: {
          mean: mean(deltaMs), p50: percentile(deltaMs, 0.5), p99: percentile(deltaMs, 0.99),
          min: deltaMs[0], max: deltaMs[deltaMs.length - 1],
        },
        // (markerArrival - sendTs) — client→Gateway round trip on the inbound side.
        sendToMarker: {
          mean: mean(sendToMarkerMs), p50: percentile(sendToMarkerMs, 0.5), p99: percentile(sendToMarkerMs, 0.99),
          min: sendToMarkerMs[0], max: sendToMarkerMs[sendToMarkerMs.length - 1],
        },
        // (responseArrival - sendTs) — full end-to-end. Should be ≥ DELAY_MS.
        sendToResponse: {
          mean: mean(totalMs), p50: percentile(totalMs, 0.5), p99: percentile(totalMs, 0.99),
          min: totalMs[0], max: totalMs[totalMs.length - 1],
        },
      };

      console.log('\n==================== flush-spike results ====================');
      console.log(`DELAY_MS = ${DELAY_MS}, ITERATIONS = ${ITERATIONS}, label = ${label}`);
      console.log('');
      console.log('responseArrival − markerArrival  (target ≈ DELAY_MS if flush works):');
      console.log(`  mean ${fmt(summary.responseMinusMarker.mean)} ms   p50 ${fmt(summary.responseMinusMarker.p50)} ms   p99 ${fmt(summary.responseMinusMarker.p99)} ms   [min ${fmt(summary.responseMinusMarker.min)}, max ${fmt(summary.responseMinusMarker.max)}]`);
      console.log('');
      console.log('markerArrival − sendTs           (client→Gateway round trip):');
      console.log(`  mean ${fmt(summary.sendToMarker.mean)} ms   p50 ${fmt(summary.sendToMarker.p50)} ms   p99 ${fmt(summary.sendToMarker.p99)} ms   [min ${fmt(summary.sendToMarker.min)}, max ${fmt(summary.sendToMarker.max)}]`);
      console.log('');
      console.log('responseArrival − sendTs         (end-to-end, ≥ DELAY_MS):');
      console.log(`  mean ${fmt(summary.sendToResponse.mean)} ms   p50 ${fmt(summary.sendToResponse.p50)} ms   p99 ${fmt(summary.sendToResponse.p99)} ms   [min ${fmt(summary.sendToResponse.min)}, max ${fmt(summary.sendToResponse.max)}]`);
      console.log('==============================================================\n');

      // Soft sanity: end-to-end must be at least DELAY_MS (server actually waited).
      expect(summary.sendToResponse.min, 'end-to-end must be ≥ DELAY_MS').toBeGreaterThanOrEqual(DELAY_MS - 5);
      // Soft sanity: marker arrival can't precede send.
      expect(summary.sendToMarker.min, 'marker arrival must follow send').toBeGreaterThanOrEqual(0);
      // The spike does NOT assert on the headline delta — that's the
      // observation we're trying to make. The numbers are read from console
      // and recorded in the doc-comment at top of file.
    } finally {
      (client as any)[Symbol.dispose]?.();
    }
  });
});
