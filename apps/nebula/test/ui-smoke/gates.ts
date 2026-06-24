/**
 * Auto-probed capability gates for the `wrangler dev` + Docker UI-smoke lane.
 *
 * No new config, no `HAS_*` env var the dev must set (task pin): the lane probes
 * the environment directly and `describe.runIf(HAS_DOCKER && HAS_CF_CREDS)` skips
 * cleanly when the real-infra isn't present — so the default `npm test` (which
 * doesn't even enumerate this project) never hard-depends on Docker/creds. Mirrors
 * `describe.runIf(BENCH_BASE_URL)`.
 *
 * These are evaluated at module load (collection time) so `describe.runIf` sees a
 * concrete boolean; the same probes gate `global-setup.ts` so it doesn't spawn
 * wrangler/Docker for a run that will skip anyway.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/** A Docker daemon is reachable (`docker info` exits 0) — the DevContainer needs it. */
export const HAS_DOCKER: boolean = (() => {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * The `CLOUDFLARE_*` creds are present in the root `.dev.vars` (symlinked into
 * `apps/nebula`). `wrangler dev` needs them to proxy `env.AI` to Workers AI and to
 * reach the deployed `email-test` Worker for the real magic-link round-trip.
 */
export const HAS_CF_CREDS: boolean = (() => {
  try {
    const devVars = readFileSync(resolvePath(process.cwd(), '.dev.vars'), 'utf8');
    return /^CLOUDFLARE_/m.test(devVars);
  } catch {
    return false;
  }
})();
