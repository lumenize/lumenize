/**
 * DevContainer recover-route integration (ui-smoke lane) — the Final-Verification fold for
 * tasks/nebula-container-wakeup-fix.md. Reuses the existing wrangler-dev + Docker + vite
 * scaffold (global-setup.ts) and warms the baked container with a BARE preview GET (no
 * login/codegen needed — the recover endpoint is an ungated GET and the command-server
 * `/healthz` the corroboration probe hits is up on boot). Node `fetch` forwards
 * `Sec-Fetch-Site` (verified live), so the same-origin CSRF guard is exercised without a browser.
 *
 * Proves route-reachability + corroboration + no-hang ONLY; abort's *clear* of a real
 * deploy-staled flag stays Phase 0 / deploy (D7). What it asserts (task Final Verification):
 *   CSRF — same-origin recover-GET allowed, cross-site / header-less 403'd (D6 layer 1);
 *   (b)  — a recover-GET against a HEALTHY instance no-ops (corroboration denies the abort:
 *          benign response + the instance keeps serving);
 *   (c)  — `docker kill` still self-heals on the next preview GET (no regression);
 *   (a)  — a recover-GET against a `docker pause`d (frozen-stuck) instance SETTLES (does not
 *          hang: the ~5 s corroboration probe times out → abort) and a next preview GET serves.
 *
 * ⚠️ DESTRUCTIVE + isolation-required: it `docker kill`/`pause`s every `DevContainer`
 * container, so it must NOT run concurrently with `smoke.test.ts` (which keeps its own
 * DevContainer warm). Run it on its own:
 *     npx vitest run --project ui-smoke test/ui-smoke/recover.test.ts
 * (Confirmed live 2026-07-04: CSRF 200/403/403; (b) 200 + serves; (c) self-heal ~2.5 s;
 *  (a) settle ~5.4 s + serves-fresh. Container topology: an app container
 *  `cloudflare-dev/devcontainer` + a `-proxy` sidecar, both under `workerd-nebula-DevContainer-*`.)
 *
 * @see tasks/nebula-container-wakeup-fix.md § Final Verification, § Test strategy
 */
import { describe, it, expect, beforeAll, inject, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { HAS_DOCKER, HAS_AI_PATH } from './gates';

/** Dedicated recover scope — `test-` prefix = reaper auto-reap; single hyphens, ends `.dev`. */
const SCOPE = 'test-rec.test-g0.dev';
/** The waking interstitial marker — its presence means the container is not yet serving. */
const WAKING = 'Waking your preview';

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}
/** The DevContainer docker containers currently present (app image + `-proxy` sidecar). */
function devContainerNames(): string[] {
  return sh(`docker ps --format '{{.Names}}' --filter 'name=DevContainer'`).split('\n').filter(Boolean);
}
function killAll(names: string[]): void {
  for (const c of names) sh(`docker kill ${c}`);
}
/** Never leave a paused/dead container behind — unpause then force-remove (best-effort). */
function cleanupAll(names: string[]): void {
  for (const c of names) sh(`docker unpause ${c} 2>/dev/null; docker rm -f ${c} 2>/dev/null`);
}

describe.runIf(HAS_DOCKER && HAS_AI_PATH)('DevContainer recover route (wrangler dev + Docker)', () => {
  let previewUrl: string;
  let recoverUrl: string;

  beforeAll(() => {
    const workerBaseUrl = inject('workerBaseUrl');
    previewUrl = `${workerBaseUrl}/dev-container/${SCOPE}/`;
    recoverUrl = `${workerBaseUrl}/dev-container/${SCOPE}/_nebula/recover`;
  });

  /** True once the preview serves the real app (not the waking interstitial). Bounded so a
   *  frozen container can't wedge the poll. */
  async function isServing(): Promise<boolean> {
    try {
      const res = await fetch(previewUrl, {
        headers: { 'sec-fetch-dest': 'document' },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.text();
      return res.status === 200 && !body.includes(WAKING);
    } catch {
      return false;
    }
  }
  async function warmUntilServing(timeout = 90_000): Promise<void> {
    await vi.waitFor(async () => expect(await isServing()).toBe(true), { timeout, interval: 2_000 });
  }
  /** A recover-GET, bounded on the Node side so a true server hang surfaces as the ceiling
   *  rather than an infinite wait. Returns settle time + status (or `ERR:<name>` when the abort
   *  resets the connection — which still counts as SETTLED, not hung). */
  async function recoverGet(
    site: string | undefined,
    nodeTimeout = 30_000,
  ): Promise<{ settleMs: number; status: number | string }> {
    const t0 = Date.now();
    try {
      const res = await fetch(recoverUrl, {
        headers: site ? { 'Sec-Fetch-Site': site } : {},
        signal: AbortSignal.timeout(nodeTimeout),
      });
      await res.text().catch(() => {});
      return { settleMs: Date.now() - t0, status: res.status };
    } catch (e) {
      return { settleMs: Date.now() - t0, status: `ERR:${(e as Error).name}` };
    }
  }

  it('recover route: CSRF guard + healthy no-op + kill self-heal + frozen-stuck settle (no hang)', async () => {
    const touched: string[] = []; // every container we kill/pause → cleaned up at the end
    try {
      // ── Warm the baked container (ungated preview GET) ──────────────────────────
      await warmUntilServing();

      // ── CSRF guard (D6 layer 1): cross-site / header-less rejected, same-origin allowed ──
      expect((await recoverGet('cross-site')).status).toBe(403);
      expect((await recoverGet(undefined)).status).toBe(403);
      const healthy = await recoverGet('same-origin');
      expect(typeof healthy.status === 'number' && healthy.status < 400, `same-origin recover reached + benign: ${healthy.status}`).toBe(true);

      // ── (b) Corroboration NO-OP on a HEALTHY instance ───────────────────────────
      // The same-origin recover-GET reached #probeStuck → /healthz 200 → not stuck → NO abort,
      // so the instance keeps serving. (If corroboration were dropped, this would abort a healthy
      // neighbor — the cross-tenant vector D6 closes.)
      expect(await isServing(), '(b) healthy instance still serves after a recover-GET').toBe(true);

      // ── (c) NO-REGRESSION: docker kill → next preview GET self-heals ─────────────
      const killTargets = devContainerNames();
      expect(killTargets.length, 'a warm DevContainer must be present to kill').toBeGreaterThan(0);
      touched.push(...killTargets);
      killAll(killTargets);
      await warmUntilServing(90_000); // base self-heal still works → reds if killing wedged it

      // ── (a) FROZEN-STUCK: docker pause → recover-GET SETTLES (no hang) → serves fresh ──
      const pauseTargets = devContainerNames();
      expect(pauseTargets.length, 'a fresh DevContainer must be present to pause').toBeGreaterThan(0);
      touched.push(...pauseTargets);
      for (const c of pauseTargets) sh(`docker pause ${c}`);
      // The load-bearing no-hang: the recover-GET against a frozen container must SETTLE well under
      // the Node ceiling — the ~5 s corroboration probe times out → #forceReset → ctx.abort() ends
      // the request. Live-observed ~5.4 s; assert generously under the 40 s ceiling for sandbox variance.
      const frozen = await recoverGet('same-origin', 40_000);
      expect(frozen.settleMs, `recover-GET against a frozen-stuck container must SETTLE, not hang (${frozen.settleMs}ms)`).toBeLessThan(20_000);
      // The abort's destroy removes the paused container locally, so a next preview GET serves fresh.
      cleanupAll(pauseTargets); // ensure nothing stays paused before re-warm (abort/destroy may have already removed it)
      await warmUntilServing(90_000);

      // NOTE — the cooldown read-back across abort→reconstruct (Phase-2 criterion #4) is NOT asserted
      // here: it is NOT locally verifiable. miniflare's local `ctx.abort()` reconstructs the DO with
      // WIPED storage, so NO abort-timestamp write survives locally (confirmed 2026-07-04: a 2nd
      // stuck-recover re-aborted with both a sync `kv.put` AND an `await ctx.storage.put`). In CLOUD,
      // abort→reconstruct preserves kv (Phase-0), so the cooldown's durability is a DEPLOY-only check —
      // and whether the sync write is even committed before abort in cloud is itself open (see the
      // ⚠️ note in dev-container.ts #forceReset). Left to Phase 3.
    } finally {
      cleanupAll([...new Set(touched)]);
    }
  });
});
