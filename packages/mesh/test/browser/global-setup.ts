/**
 * Vitest globalSetup for the mesh browser e2e project — auto-spawns `wrangler dev` against the
 * getting-started worker, claims a fresh universe there through real mail, and exposes what the
 * browser tests need via `project.provide()`.
 *
 * Same-origin via Vite proxy. The test page is served on vite-browser's port and the worker runs on
 * a different localhost port. Vite proxies `/worker/*` to the universe's own host on wrangler-dev
 * (proxy config in `vitest.config.js`), so a Client's upgrade carries the host its token's `aud`
 * names. This setup spawns wrangler dev, claims the universe, then writes that host to
 * `process.env.WRANGLER_PROXY_TARGET` so the proxy can resolve it dynamically. Tests use `/worker`
 * as their relative baseUrl prefix.
 */

import { readFileSync, rmSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { TestProject } from 'vitest/node';
import { spawnWranglerDev } from '@lumenize/testing/wrangler';
import { claimAndGetAccessToken } from './auth-bootstrap';
import { installLocalhostLookup } from './localhost-lookup';

const WRANGLER_CONFIG = './test/browser/worker/wrangler.jsonc';

// Under a `.wrangler/` dir, so the existing `.gitignore` rule covers it — never committed.
const PERSIST_DIR = './test/browser/.wrangler';

let cleanupWrangler: (() => Promise<void>) | null = null;

/**
 * Read the email-test deployment's TEST_TOKEN from the root .dev.vars so
 * the browser test can subscribe to the email-test WS.
 */
function readTestToken(): string {
  const path = resolvePath(process.cwd(), '.dev.vars');
  const contents = readFileSync(path, 'utf8');
  const match = contents.match(/^TEST_TOKEN=(.*)$/m);
  if (!match) {
    throw new Error(`TEST_TOKEN not found in ${path}. Required for the browser e2e's real-email flow.`);
  }
  return match[1].trim();
}

export default async function setup(project: TestProject) {
  const testToken = readTestToken();
  installLocalhostLookup();

  // wrangler-dev state survives across runs; start each run clean.
  rmSync(resolvePath(process.cwd(), PERSIST_DIR), { recursive: true, force: true });
  const { baseUrl: wranglerUrl, cleanup } = await spawnWranglerDev({
    configPath: WRANGLER_CONFIG,
    extraArgs: ['--persist-to', `${PERSIST_DIR}/state`],
  });
  cleanupWrangler = cleanup;

  // ONE real magic-link login for the whole project, as a fresh universe's founder. Node-side,
  // against the hosts the Worker spells: nothing here runs in the browser.
  const port = new URL(wranglerUrl).port;
  const scope = `mesh-browser-${crypto.randomUUID().slice(0, 8)}`;
  project.provide('adminAccessToken', await claimAndGetAccessToken({ port, scope, testToken }));
  project.provide('pageScope', scope);

  // The vite proxy plugin (vitest.config.js → dynamicEnvProxyPlugin) re-reads this env var on every
  // request, so setting it after wrangler-dev is up is enough. The universe's own host, so the
  // proxied upgrade names the scope its token's `aud` names.
  process.env.WRANGLER_PROXY_TARGET = `http://${scope}.lumenize.localhost:${port}`;

  // Tests use the proxy path as a relative URL prefix: `${test-page-origin}/worker/gateway/...`
  // → vite proxies to the universe's host on wrangler-dev.
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
    /** A real magic-link login's access token, minted once for the whole project. */
    adminAccessToken: string;
    /** The universe that login founded, whose host every test's Client connects to. */
    pageScope: string;
  }
}
