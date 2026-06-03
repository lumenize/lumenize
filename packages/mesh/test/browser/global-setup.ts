/**
 * Vitest globalSetup for the mesh browser e2e project — auto-spawns
 * `wrangler dev` against the getting-started worker and exposes its URL
 * + the `email-test` Worker's TEST_TOKEN to browser tests via
 * `project.provide()`.
 *
 * Same-origin via Vite proxy. The test page is served on vite-browser's
 * port and the worker runs on a different localhost port. LumenizeAuth's
 * `SameSite=Strict` refresh-token cookie would never reach the worker on
 * cross-origin POST, so we proxy `/worker/*` through vite (proxy config in
 * `vitest.config.js`). This setup spawns wrangler dev, then writes its URL
 * to `process.env.WRANGLER_PROXY_TARGET` so the proxy can resolve it
 * dynamically. Tests use `/worker` as their relative baseUrl prefix.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { TestProject } from 'vitest/node';
import { spawnWranglerDev } from '@lumenize/testing/wrangler';

const WRANGLER_CONFIG = './test/browser/worker/wrangler.jsonc';

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

  const { baseUrl: wranglerUrl, cleanup } = await spawnWranglerDev({
    configPath: WRANGLER_CONFIG,
  });
  cleanupWrangler = cleanup;

  // The vite proxy plugin (vitest.config.js → dynamicEnvProxyPlugin)
  // re-reads this env var on every request, so setting it after
  // wrangler-dev is up is enough — no plugin reconfiguration needed.
  process.env.WRANGLER_PROXY_TARGET = wranglerUrl;

  // Tests use the proxy path as a relative URL prefix. `${baseUrl}/auth/...`
  // resolves to `${test-page-origin}/worker/auth/...` → vite proxies to
  // wrangler-dev → same-origin from chromium's perspective → cookies flow.
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
