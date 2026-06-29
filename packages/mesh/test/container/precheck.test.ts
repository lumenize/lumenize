import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

/**
 * Phase-2 feasibility precheck — RESOLVED 2026-06-17 (records the runtime fact
 * that forks the Phase-2/3 test strategy).
 *
 * **Result: a `class X extends Container {}` does NOT construct under
 * vitest-pool-workers.** The base `Container` constructor throws
 * `'Containers have not been enabled …'` (container.js:350) because pool-workers
 * leaves `ctx.container === undefined` — even with a `containers` block in the
 * test wrangler (pool-workers populates it only when it actually provisions a
 * container engine, which it does not here). The agent-channel spike confirmed
 * the same: containers run only under real `wrangler dev` + Docker.
 *
 * Consequence: the seam/guard suite tests the **composed receive contract
 * against a non-`Container` DO harness** (`container-seam.test.ts`); the
 * *assembled* `extends Container` construction + Container-lifecycle coexistence
 * are deferred to a deployed e2e (`it.skip` blockers there).
 *
 * This test is a **canary, not a tautology**: it asserts construction throws the
 * containers-not-enabled error. If pool-workers ever gains real container
 * support, this flips RED — at which point the assembled-in-process path becomes
 * feasible and the Phase-2/3 strategy should be revisited.
 */
describe('Phase 2 precheck: `extends Container` does not construct under pool-workers', () => {
  it('throws "Containers have not been enabled" when the DO is materialised', async () => {
    const stub = (env as any).PROBE_CONTAINER.getByName('precheck-probe');
    let constructed = false;
    let errorMessage: string | undefined;
    try {
      const r = await stub.ping();
      constructed = r === 'pong';
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
    }
    expect(constructed).toBe(false);
    expect(errorMessage).toContain('Containers have not been enabled');
  });
});
