/**
 * Auto-probed capability gate for the `wrangler dev` + Docker UI-smoke lane.
 *
 * No new config, no `HAS_*` env var the dev must set (task pin): the lane probes
 * the environment directly and `describe.runIf(HAS_DOCKER)` skips cleanly when there
 * is no Docker — so the default `npm test` (which doesn't even enumerate this project)
 * never hard-depends on it. Mirrors `describe.runIf(BENCH_BASE_URL)`.
 *
 * Docker is the only gate. A model is not one: every lane that runs this project has
 * one (a `wrangler login` locally, `CLOUDFLARE_API_TOKEN` in CI's job env, a
 * `WORKERS_AI_TOKEN` in the hosted lane), and wrangler's binding never authenticates
 * from `.dev.vars`, so a probe of that file could not tell. A lane that has lost its
 * credential fails at its first turn with the provider's reason, rather than skipping
 * where nobody looks (the AI gate that used to stand here, removed 2026-10-13).
 *
 * Evaluated at module load (collection time) so `describe.runIf` sees a concrete
 * boolean; the same probe gates `global-setup.ts` so it doesn't spawn wrangler/Docker
 * for a run that will skip anyway.
 */
import { execSync } from 'node:child_process';

/** A Docker daemon is reachable (`docker info` exits 0) — the DevContainer needs it. */
export const HAS_DOCKER: boolean = (() => {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
