/**
 * Vitest globalSetup for the Studio UI-smoke lane — boots the *model-A* dev stack
 * headlessly so a raw-Playwright browser can drive the rendered Studio:
 *
 *   1. `wrangler dev` on the **apps/nebula** config (`./wrangler.jsonc`) — the only
 *      config with DEV_STUDIO / DEV_CONTAINER / `containers` + the `AI` binding
 *      (NOT `test/browser/worker/wrangler.jsonc`, which is StarTest/BenchAgent and
 *      can't drive the preview or codegen). Needs Docker Desktop for the DevContainer.
 *   2. `vite` serving the **real** Studio SPA (`apps/nebula-studio-ui`), proxying
 *      `/auth /gateway /dev-container` → the Worker. The Studio's own vite proxy is
 *      the same-origin bridge (no `dynamic-env-proxy`); everything is plain
 *      `http://localhost` (localhost is a secure context, so the `Secure;SameSite=Strict`
 *      refresh cookie flows without TLS).
 *
 * Auth POSTs from the browser pass with NO Origin-rewrite because apps/nebula runs
 * `LUMENIZE_APPROVED_ORIGINS=""` → CORS disabled → no server-side Origin check. Do NOT
 * add the vite port to an allow-list or bypass the proxy.
 *
 * Skips booting entirely when Docker/creds are absent (the test file's `describe.runIf`
 * skips the tests; this avoids spawning wrangler/Docker for a run that will skip anyway).
 *
 * @see tasks/nebula-local-smoke.md — Phase 1 (exploratory harness)
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { TestProject } from 'vitest/node';
import { spawnWranglerDev } from '@lumenize/testing/wrangler';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { HAS_DOCKER, HAS_CF_CREDS } from './gates';

/** apps/nebula config — vitest cwd is the apps/nebula package dir. */
const WRANGLER_CONFIG = './wrangler.jsonc';
const STUDIO_UI_DIR = resolvePath(process.cwd(), '../nebula-studio-ui');

/** TEST_TOKEN authenticates the deployed `email-test` Worker WebSocket (real magic-link loop). */
function readTestToken(): string {
  const path = resolvePath(process.cwd(), '.dev.vars');
  const match = readFileSync(path, 'utf8').match(/^TEST_TOKEN=(.*)$/m);
  if (!match) throw new Error(`TEST_TOKEN not found in ${path}. Required for the UI-smoke email loop.`);
  return match[1].trim();
}

let wranglerCleanup: (() => Promise<void>) | null = null;
let vite: ViteDevServer | null = null;

export default async function setup(project: TestProject) {
  if (!HAS_DOCKER || !HAS_CF_CREDS) {
    project.provide('uiSmokeSkipped', true);
    return; // nothing booted → nothing to tear down
  }

  const testToken = readTestToken();

  // apps/nebula/wrangler.jsonc now declares an `assets` block (the Studio SPA prod-serving
  // config); wrangler HARD-ERRORS if `assets.directory` is absent. `dist` is gitignored
  // (built only at deploy), and this lane serves the Studio via vite (not Assets), so an
  // EMPTY dir satisfies wrangler with zero build. mkdir it before spawning wrangler dev.
  mkdirSync(resolvePath(STUDIO_UI_DIR, 'dist'), { recursive: true });

  // 1. wrangler dev on the apps/nebula config. `--var NEBULA_AUTH_BOOTSTRAP_EMAIL`
  //    overrides the .dev.vars default (dev@example.com) to test@lumenize.io — the
  //    address CF Email Routing forwards to the email-test Worker AND the bootstrap
  //    admin email (first login at a scope → admin). Container image build can be slow
  //    on a cold boot, so allow a generous ready timeout.
  const { baseUrl: workerBaseUrl, cleanup } = await spawnWranglerDev({
    configPath: WRANGLER_CONFIG,
    readyTimeoutMs: 120_000,
    extraArgs: [
      '--var', 'NEBULA_AUTH_BOOTSTRAP_EMAIL:test@lumenize.io',
      // Send magic-link email from the account's VERIFIED domain (lumenize.io) so the
      // deployed email-test Worker catches the routed mail. Without this the real-email
      // round-trip silently drops (prod default from-domain isn't verified for sending).
      '--var', 'AUTH_EMAIL_FROM:test@lumenize.io',
      '--log-level', 'info',
    ],
    onStdio: (c) => { if (process.env.UI_SMOKE_DEBUG) process.stderr.write(c); },
  });
  wranglerCleanup = cleanup;

  // 2. vite serving the real Studio. NEBULA_WORKER_URL is read by
  //    nebula-studio-ui/vite.config.ts at config load → proxies to this worker.
  //    strictPort:false so a manually-running `dev:studio` on :5174 isn't a hard
  //    collision (vite auto-increments); Playwright navigates the resolved URL.
  process.env.NEBULA_WORKER_URL = workerBaseUrl;
  vite = await createViteServer({
    root: STUDIO_UI_DIR,
    configFile: resolvePath(STUDIO_UI_DIR, 'vite.config.ts'),
    server: { port: 5174, strictPort: false },
    logLevel: 'warn',
  });
  await vite.listen();
  const viteBaseUrl = (vite.resolvedUrls?.local?.[0] ?? 'http://localhost:5174/').replace(/\/$/, '');

  project.provide('uiSmokeSkipped', false);
  project.provide('viteBaseUrl', viteBaseUrl);
  project.provide('workerBaseUrl', workerBaseUrl);
  project.provide('emailTestToken', testToken);

  return async () => {
    await vite?.close();
    await wranglerCleanup?.();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    uiSmokeSkipped: boolean;
    viteBaseUrl: string;
    workerBaseUrl: string;
    emailTestToken: string;
  }
}
