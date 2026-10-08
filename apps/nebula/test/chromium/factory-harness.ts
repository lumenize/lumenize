/**
 * Shared real-chromium factory harness — constructs the `createNebulaClient` factory on this page's
 * own host, `tenant-a.crm.acme.lumenize.localhost`, against a real wrangler-dev Star.
 *
 * The page is already signed in: the lane's global setup claimed {@link PAGE_STAR} as its own
 * admin, followed the emailed link in Chromium, and every test's browser context starts from that
 * browser's cookies. A client here names no scope. Its socket goes to this Star's host on Studio's
 * vite port, which proxies `/gateway` to the Worker, and its refresh goes to the platform host
 * there, carrying this page's `Origin` — so its token's `aud` is this page's Star, as in production.
 *
 * `fetch`, `WebSocket`, `sessionStorage` and `BroadcastChannel` default to the real browser
 * globals, so callers pass only the overrides a probe needs (a recording `WebSocket`, a faulty
 * `fetch`, an `onLoginRequired`/`onConnectionStateChange`).
 */
import { inject } from 'vitest';
import { createNebulaClient } from '@lumenize/resources/frontend';
import type { CreateNebulaClientConfig, FactoryResult } from '@lumenize/resources/frontend';
import { PAGE_STAR } from './page-star';

export { PAGE_STAR };

/** Where a client on this page reaches the Worker: its own host's socket, and the platform host. */
export function pageEndpoints(): { baseUrl: string; platformOrigin: string } {
  return { baseUrl: inject('pageBaseUrl'), platformOrigin: inject('platformOrigin') };
}

/**
 * Construct the factory on this page. Does NOT await `ready` — the caller decides (some probes
 * assert on the pre-connect/terminal phases). `extra` overrides/augments the factory config (e.g.
 * `{ WebSocket, fetch, onLoginRequired }`).
 */
export function bootstrapFactory(extra: Partial<CreateNebulaClientConfig> = {}): FactoryResult & { scope: string } {
  const result = createNebulaClient({
    ...pageEndpoints(),
    ontologyVersion: 'v1',
    onShouldRefreshUI: () => {},
    ...extra,
  });
  return { scope: PAGE_STAR, ...result };
}
