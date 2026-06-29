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

/** Raw `.dev.vars` text (symlinked into `apps/nebula`), read once for the cred probes. */
const DEV_VARS: string = (() => {
  try {
    return readFileSync(resolvePath(process.cwd(), '.dev.vars'), 'utf8');
  } catch {
    return '';
  }
})();

/**
 * `CLOUDFLARE_*` creds in `.dev.vars` → `wrangler dev` can proxy the `env.AI` binding to
 * Workers AI (the GHA/local AI path). Absent in the secret-less hosted lane.
 */
export const HAS_CF_CREDS: boolean = /^CLOUDFLARE_/m.test(DEV_VARS);

/**
 * A Workers-AI REST token → the hosted-lane AI path, where there are no CF account creds
 * for the binding (`DevStudio.callModel` selects REST when this is present).
 */
export const HAS_WORKERS_AI_TOKEN: boolean = /^WORKERS_AI_TOKEN=/m.test(DEV_VARS);

/**
 * ui-smoke has an AI path iff the binding (CF creds) **or** the REST token is available.
 * This is the gate the lane runs on — GHA satisfies it via creds, the hosted lane via the
 * token. (Email rides Resend + `TEST_TOKEN`, present in every target lane.)
 */
export const HAS_AI_PATH: boolean = HAS_CF_CREDS || HAS_WORKERS_AI_TOKEN;
