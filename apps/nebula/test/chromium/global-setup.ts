/**
 * Vitest globalSetup for the real-chromium `chromium` project — auto-spawns
 * `wrangler dev` against the browser test-app worker and exposes its URL +
 * the `email-test` Worker's TEST_TOKEN to browser tests via `project.provide()`.
 *
 * Same-origin via Vite proxy (see `dynamicEnvProxyPlugin` in vitest.config.js).
 * The test page is served on vite-browser's port; the worker runs on a
 * different localhost port. NebulaAuth's `Secure; SameSite=Strict` refresh-token
 * cookie would never reach the worker on a cross-origin POST, so the proxy
 * forwards `/worker/*` (HTTP + WS) to wrangler-dev. This setup spawns wrangler
 * dev, then writes its URL to `process.env.WRANGLER_PROXY_TARGET` so the proxy
 * resolves it dynamically. Tests use `/worker` as their relative baseUrl prefix.
 *
 * Reuses the EXISTING `test/browser/worker/` config (full Nebula stack + the
 * real-email `TestNebulaEmailSender`) but persists to a SEPARATE state dir so
 * it never contends with the Node-side `browser` project's wrangler-dev. The
 * upstream is plain http — the proxy terminates nothing-to-terminate and the
 * browser only ever sees `http://localhost` (a secure context, so `Secure`
 * cookies are accepted). No `--local-protocol https` needed (that's only for
 * the Node-side `browser` project, which talks to wrangler-dev directly).
 *
 * No NEBULA_AUTH_TEST_MODE: auth runs the real magic-link email flow
 * (Cloudflare Email Sending → Email Routing → deployed email-test Worker →
 * WebSocket back to the test), matching the Node-side harness. A test-mode flag
 * in any wrangler invocation is a leak risk — and note `audit-test-mode.sh` does
 * NOT scan `.ts` (only wrangler configs / package.json / *.sh / CI yml / .dev.vars),
 * so keeping this spawn test-mode-free is a discipline here, not an enforced gate.
 * NEBULA_AUTH_BOOTSTRAP_EMAIL=test@lumenize.io auto-approves that subject as admin
 * so the auth gate doesn't 403.
 */

import { readFileSync, rmSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { TestProject } from 'vitest/node';
import { spawnWranglerDev } from '@lumenize/testing/wrangler';

const WRANGLER_CONFIG = './test/browser/worker/wrangler.jsonc';

// Isolated wrangler-dev state dir for the chromium harness, kept separate from
// the Node-side `browser` project's state (no shared SQLite lock). Lives under
// a `.wrangler/` dir so it's covered by the existing `.gitignore` `.wrangler`
// rule — never committed.
const PERSIST_DIR = './test/chromium/.wrangler';

let cleanupWrangler: (() => Promise<void>) | null = null;

/**
 * Read the email-test deployment's TEST_TOKEN from the root .dev.vars so the
 * browser tests can subscribe to the email-test WS for the magic-link flow.
 */
function readTestToken(): string {
  const path = resolvePath(process.cwd(), '.dev.vars');
  const contents = readFileSync(path, 'utf8');
  const match = contents.match(/^TEST_TOKEN=(.*)$/m);
  if (!match) {
    throw new Error(`TEST_TOKEN not found in ${path}. Required for the chromium harness's real-email flow.`);
  }
  return match[1].trim();
}

export default async function setup(project: TestProject) {
  const testToken = readTestToken();

  // CRITICAL: wrangler-dev state SURVIVES across runs (unlike vitest-pool-workers'
  // fresh-per-run miniflare). Wipe it at the start of every run so each run is
  // clean — no Stars / NebulaAuthRegistry rows / founders accumulated from prior
  // runs. Tests use unique universes (`acme-<uuid>.app.tenant-a`) so stale state
  // isn't a correctness hazard, but this keeps the dir bounded + the run
  // reproducible, and matches pool-workers semantics.
  rmSync(resolvePath(process.cwd(), PERSIST_DIR), { recursive: true, force: true });

  const { baseUrl: wranglerUrl, cleanup } = await spawnWranglerDev({
    configPath: WRANGLER_CONFIG,
    extraArgs: [
      // Isolate state from the Node-side `browser` project's wrangler-dev so
      // the two never share/lock the same SQLite state dir under `npm test`.
      '--persist-to', `${PERSIST_DIR}/state`,
      '--var', 'NEBULA_AUTH_BOOTSTRAP_EMAIL:test@lumenize.io',
      '--var', 'PRIMARY_JWT_KEY:BLUE',
      '--var', 'NEBULA_AUTH_REDIRECT:/app',
      // Surface auth/email-send failures in wrangler-dev stdout (otherwise
      // swallowed by LumenizeAuth's #sendEmail try/catch).
      '--var', 'DEBUG:auth,nebula-auth,nebula',
      '--log-level', 'info',
    ],
  });
  cleanupWrangler = cleanup;

  // The vite proxy plugin re-reads this env var per request, so setting it
  // after wrangler-dev is up is enough — no plugin reconfiguration needed.
  process.env.WRANGLER_PROXY_TARGET = wranglerUrl;

  // Tests use the proxy path as a relative URL prefix. `${baseUrl}/auth/...`
  // resolves to `${test-page-origin}/worker/auth/...` → vite proxies to
  // wrangler-dev → same-origin from chromium's POV → cookies flow.
  project.provide('wranglerBaseUrl', '/worker');
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
