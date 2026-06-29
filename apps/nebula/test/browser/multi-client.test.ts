/**
 * Phase 4 smoke test for `tasks/gateway-hop-benchmark.md` — verifies that the
 * multi-client harness produces M distinct authenticated WS connections, each
 * landing on its own NebulaClientGateway DO instance.
 *
 * Two checks:
 *
 *   1. **M distinct instanceNames**: each client's `instanceName` is
 *      `{sub}.{tabId}`; same `sub` (one auth bootstrap) but distinct `tabId`
 *      per Context, so the set has cardinality M. This proves M distinct
 *      Gateway DOs are addressed (DO instance is keyed by `instanceName`).
 *
 *   2. **All M clients can dispatch**: each client successfully calls
 *      `Star.delay(5)` and gets a response. Validates the auth + WS + mesh
 *      pipeline for every client, not just the first one.
 *
 * Stress test (M=64) is gated behind MULTI_CLIENT_STRESS=1 — the smoke flow
 * (M=8) runs by default and is fast (~2s on top of bootstrap). The stress
 * variant verifies no harness-level ceiling at the M values Phase 5 will
 * actually use.
 *
 * Run:
 *   `cd apps/nebula && BENCH_BASE_URL=https://nebula-browser-test.transformation.workers.dev npx vitest run --project browser multi-client`
 *   `cd apps/nebula && MULTI_CLIENT_STRESS=1 BENCH_BASE_URL=... npx vitest run --project browser multi-client`
 */

import { describe, it, expect, inject } from 'vitest';
import { Browser } from '@lumenize/testing';
import { setupMultiClient } from './multi-client';

const ADMIN_EMAIL = 'test@lumenize.io';

function uniqueGalaxy(): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `acme-${suffix}.app`;
}

describe('multi-client harness', () => {
  it('M=8: each client lands on a distinct Gateway DO', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    const testToken = inject('emailTestToken');
    const browser = new Browser();
    const galaxyScope = uniqueGalaxy();
    // Clients operate AT the star (their aud must equal it — structural guard, T6),
    // not the galaxy; all M call this same star.
    const star = `${galaxyScope}.tenant-multi`;
    const M = 8;

    const harness = await setupMultiClient({
      browser, baseUrl, testToken, galaxyScope, activeScope: star, email: ADMIN_EMAIL, M,
    });

    try {
      const instanceNames = harness.clients.map((c) => c.lmz.instanceName);
      const subs = new Set(instanceNames.map((n) => n.split('.')[0]));
      const tabIds = new Set(instanceNames.map((n) => n.split('.').slice(1).join('.')));

      // All M clients should share one sub (one auth identity) and have
      // M distinct tabIds (M distinct Gateway DOs).
      expect(subs.size).toBe(1);
      expect(tabIds.size).toBe(M);
      expect(new Set(instanceNames).size).toBe(M);

      // Each client can dispatch a call. Star.delay(5) is a 5ms sleep on the
      // Star side that returns the delay value via CALL_RESPONSE — exercises
      // the full path (WS → Gateway → Star → Gateway → WS) for every client.
      const results = await Promise.all(
        harness.clients.map((c) => c.callStarDelay(star, 5)),
      );
      for (const r of results) {
        expect(r.result).toBe(5);
        expect(r.markerArrival).toBeGreaterThan(r.sendTs);
        expect(r.responseArrival).toBeGreaterThanOrEqual(r.markerArrival);
      }
    } finally {
      harness.dispose();
    }
  }, 60_000);

  it.runIf(process.env.MULTI_CLIENT_STRESS === '1')(
    'M=64 stress: no harness-level ceiling',
    async () => {
      const baseUrl = inject('wranglerBaseUrl');
      const testToken = inject('emailTestToken');
      const browser = new Browser();
      const galaxyScope = uniqueGalaxy();
      const star = `${galaxyScope}.tenant-multi`;
      const M = 64;

      const t0 = performance.now();
      const harness = await setupMultiClient({
        browser, baseUrl, testToken, galaxyScope, activeScope: star, email: ADMIN_EMAIL, M,
      });
      const setupMs = performance.now() - t0;

      try {
        const instanceNames = harness.clients.map((c) => c.lmz.instanceName);
        expect(new Set(instanceNames).size).toBe(M);

        const tCallStart = performance.now();
        const results = await Promise.all(
          harness.clients.map((c) => c.callStarDelay(star, 5)),
        );
        const callMs = performance.now() - tCallStart;

        for (const r of results) expect(r.result).toBe(5);

        console.log(`[multi-client stress] M=${M}: setup ${setupMs.toFixed(0)}ms (incl. bootstrap), parallel calls ${callMs.toFixed(0)}ms`);
      } finally {
        harness.dispose();
      }
    },
    180_000,
  );
});
