/**
 * Vitest globalSetup — auto-spawns `wrangler dev` against the browser
 * test-app and exposes its URL + the email-test TEST_TOKEN to browser
 * tests via `provide()`.
 *
 * Why this exists: browser tests need a real Worker isolate to talk to
 * (vitest-pool-workers' miniflare runs in-process, where Cloudflare's
 * `performance.now()` pinning ruins timing). Spawning real wrangler dev
 * gives us a real Worker; timing happens client-side in Chromium where
 * the wall clock advances normally.
 *
 * Why HTTPS: NebulaAuth sets cookies with `Secure`, which browsers refuse
 * over plain http on a non-localhost-treated origin. `--local-protocol https`
 * makes wrangler generate a self-signed cert; Playwright is configured with
 * `ignoreHTTPSErrors` to accept it. This keeps the cookie path identical
 * to production — no test-mode bypasses.
 *
 * Why no NEBULA_AUTH_TEST_MODE: tests exercise the real magic-link email
 * flow via Cloudflare Email Sending → Email Routing → deployed
 * email-test Worker → WebSocket back to the test. Test mode in any
 * wrangler invocation is a leak risk.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { execSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';
import { spawnWranglerDev } from '@lumenize/testing/wrangler';

const WRANGLER_CONFIG = './test/browser/worker/wrangler.jsonc';

/**
 * Bench-staleness guard (Phase 2: tasks/nebula-release-process.md). The SINGLE deployed-mode
 * chokepoint: this globalSetup is shared by BOTH the `browser-bench` project (the *.benchmark.ts
 * files) AND the `browser` project (the deployed *.test.ts files), so checking here covers EVERY
 * deployed run in one place — never wire the per-file `const isDeployed = !!process.env.BENCH_BASE_URL`
 * locals (those are per-`it` skip copies that miss the .test.ts files).
 *
 * Submits local HEAD to the deployed worker's public `/_version?sha=` compare endpoint (Phase 1):
 * throws fast on `match:false` (deployed != local HEAD → numbers would measure stale code), warns
 * on `match:true, dirty:true` (deployed-from-dirty → not reproducible). The guard only ever submits
 * its own SHA — the endpoint never discloses the deployed one.
 */
async function assertDeployedMatchesHead(baseUrl: string): Promise<void> {
  const headSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const url = `${baseUrl.replace(/\/$/, '')}/_version?sha=${headSha}`;

  let body: { match: boolean; dirty: boolean };
  try {
    const res = await fetch(url);
    body = (await res.json()) as { match: boolean; dirty: boolean };
  } catch (err) {
    throw new Error(
      `Bench-staleness guard: could not reach ${url} to verify the deployed worker matches local ` +
      `HEAD. Is BENCH_BASE_URL correct and the worker deployed? Underlying error: ${(err as Error).message}`,
    );
  }

  if (!body.match) {
    throw new Error(
      `Bench-staleness guard: the deployed bench worker at ${baseUrl} was NOT built from local HEAD ` +
      `(${headSha}). Benchmark numbers would be measured against stale code. ` +
      `Run \`npm run deploy:test-worker\` first.`,
    );
  }
  if (body.dirty) {
    // eslint-disable-next-line no-console
    console.warn(
      `⚠️  Bench-staleness guard: deployed worker matches HEAD but was deployed from a DIRTY tree — ` +
      `benchmark numbers are not reproducible. Commit and redeploy for publishable numbers.`,
    );
  }
}

let cleanupWrangler: (() => Promise<void>) | null = null;

/**
 * Read the email-test deployment's TEST_TOKEN from the root .dev.vars so the
 * browser tests can authenticate to its WebSocket. The wrangler-dev process
 * has its own .dev.vars symlink for the Worker's secrets; this reads the
 * same file from globalSetup's Node context.
 */
function readTestToken(): string {
  const path = resolvePath(process.cwd(), '.dev.vars');
  const contents = readFileSync(path, 'utf8');
  const match = contents.match(/^TEST_TOKEN=(.*)$/m);
  if (!match) {
    throw new Error(`TEST_TOKEN not found in ${path}. Required for the browser harness's e2e email flow.`);
  }
  return match[1].trim();
}

export default async function setup(project: TestProject) {
  const testToken = readTestToken();

  // BENCH_BASE_URL override: point the bench at a deployed Worker instead of
  // spawning wrangler-dev. Used to capture publishable numbers from real
  // Cloudflare infrastructure. .dev.vars still supplies TEST_TOKEN for the
  // email-test WebSocket; everything else lives on the deployed Worker.
  const overrideBaseUrl = process.env.BENCH_BASE_URL;
  if (overrideBaseUrl) {
    // Refuse to run against a stale deploy BEFORE provisioning the URL to the tests.
    await assertDeployedMatchesHead(overrideBaseUrl);
    project.provide('wranglerBaseUrl', overrideBaseUrl);
    project.provide('emailTestToken', testToken);
    return; // No wrangler-dev to tear down.
  }

  const { baseUrl, cleanup } = await spawnWranglerDev({
    configPath: WRANGLER_CONFIG,
    extraArgs: [
      '--local-protocol', 'https',
      '--var', 'NEBULA_AUTH_BOOTSTRAP_EMAIL:test@lumenize.io',
      '--var', 'PRIMARY_JWT_KEY:BLUE',
      '--var', 'NEBULA_AUTH_REDIRECT:/app',
      // Enable debug logging so email-send failures and other auth-flow
      // issues surface in the wrangler-dev stdout buffer (otherwise they're
      // caught and silently swallowed by LumenizeAuth's #sendEmail try/catch).
      '--var', 'DEBUG:auth,nebula-auth,nebula',
      '--log-level', 'info',
    ],
  });
  cleanupWrangler = cleanup;

  project.provide('wranglerBaseUrl', baseUrl);
  project.provide('emailTestToken', testToken);

  return async () => {
    await cleanupWrangler?.();
    cleanupWrangler = null;
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    wranglerBaseUrl: string;
    emailTestToken: string;
  }
}
