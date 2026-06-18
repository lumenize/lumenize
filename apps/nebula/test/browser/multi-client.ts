/**
 * Multi-client harness for the gateway-hop benchmark's Phase 4/5 work.
 *
 * Spins up M `HarnessNebulaClient` instances against the same Worker, each
 * with its own `tabId` (so each lands on its own `NebulaClientGateway` DO
 * via `instanceName = {sub}.{tabId}`), all sharing one authenticated
 * identity.
 *
 * **Why one shared JWT, not M independent refreshes**: NebulaAuth's
 * `/auth/<scope>/refresh-token` endpoint **rotates** the refresh-token
 * cookie on each call (see `packages/auth/src/lumenize-auth.ts:345`). If
 * M clients refresh in parallel from the same cookie, the first invalidates
 * it and the rest fail. Production-shaped users with multiple tabs hit the
 * refresh endpoint sequentially (browser tab opens → refresh → done). For
 * the bench, sequentializing M=64 refreshes adds ~6–32 s of setup time and
 * doesn't affect what we're measuring (per-call infrastructure cost), so we
 * mint one JWT upfront and pass it explicitly to each client. Each client
 * still gets a unique `instanceName` (different tabId) so they land on
 * distinct Gateway DOs — exactly what Phase 5's Shape A test requires.
 *
 * See `tasks/gateway-hop-benchmark.md` Phase 4.
 */

import { Browser, type Context } from '@lumenize/testing';
import { HarnessNebulaClient } from './harness-client';
import { bootstrapAdmin } from './auth-bootstrap';

export interface MultiClientSetupArgs {
  browser: Browser;
  baseUrl: string;
  testToken: string;
  /** The galaxy-level scope the admin logs in at (the cookie `authScope`). */
  galaxyScope: string;
  /**
   * The (star-level) `activeScope` the clients operate in — the `aud` minted into
   * their JWT. Under the structural `onBeforeCall` guard a Star requires the caller's
   * `aud` to EQUAL the star (a galaxy-level `aud` is rejected — see scope-isolation T6),
   * so this MUST be the star the clients will call, not the galaxy.
   */
  activeScope: string;
  email: string;
  /** Number of clients to spin up. */
  M: number;
  /** Per-client WS connection timeout. Default 15s. */
  wsTimeoutMs?: number;
}

export interface MultiClientHarness {
  clients: HarnessNebulaClient[];
  contexts: Context[];
  /** The shared `sub` extracted from the bootstrapped JWT. */
  sub: string;
  /** Disposes all clients + contexts. */
  dispose(): void;
}

/**
 * One-shot setup: bootstrap admin once, mint one access JWT, then create M
 * independent clients in parallel each with its own tabId. All clients are
 * connected and ready to dispatch calls when this resolves.
 */
export async function setupMultiClient(args: MultiClientSetupArgs): Promise<MultiClientHarness> {
  const { browser, baseUrl, testToken, galaxyScope, activeScope, email, M } = args;
  const wsTimeoutMs = args.wsTimeoutMs ?? 15_000;

  if (M < 1) throw new Error(`setupMultiClient: M must be ≥ 1, got ${M}`);

  // Step 1: Bootstrap auth once. Cookies land on the Browser.
  await bootstrapAdmin({ browser, baseUrl, scope: galaxyScope, email, testToken });

  // Step 2: Mint one access JWT via the same refresh endpoint NebulaClient
  // uses internally. We extract `sub` from the JWT payload so we can build
  // explicit instanceNames for each client.
  const refreshResponse = await browser.fetch(
    `${baseUrl}/auth/${galaxyScope}/refresh-token`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeScope }),
    },
  );
  if (!refreshResponse.ok) {
    throw new Error(`setupMultiClient: refresh-token failed ${refreshResponse.status} ${await refreshResponse.text()}`);
  }
  const { access_token: accessToken, sub } = await refreshResponse.json() as { access_token: string; sub: string };
  if (!accessToken || !sub) {
    throw new Error('setupMultiClient: refresh-token response missing access_token or sub');
  }

  // Step 3: Create M clients with distinct tabIds. Passing both `accessToken`
  // and `instanceName` makes the LumenizeClient constructor skip its own
  // refresh + tabId generation (see lumenize-client.ts:540), so each client
  // connects with the shared JWT against its own Gateway DO.
  const contexts: Context[] = [];
  const clients: HarnessNebulaClient[] = [];
  for (let i = 0; i < M; i++) {
    const ctx = browser.context(baseUrl);
    const tabId = crypto.randomUUID().slice(0, 8);
    const client = new HarnessNebulaClient({
      baseUrl,
      authScope: galaxyScope,
      activeScope,
      appVersion: 'v1',
      fetch: browser.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
      accessToken,
      instanceName: `${sub}.${tabId}`,
    });
    contexts.push(ctx);
    clients.push(client);
  }

  // Step 4: Wait for all M WS connections in parallel.
  await Promise.all(clients.map((client, idx) => waitForConnection(client, idx, wsTimeoutMs)));

  return {
    clients,
    contexts,
    sub,
    dispose() {
      for (const c of clients) (c as any)[Symbol.dispose]?.();
      for (const ctx of contexts) ctx.close();
    },
  };
}

async function waitForConnection(client: HarnessNebulaClient, idx: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (client.connectionState !== 'connected') {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `[multi-client] client ${idx} did not connect within ${timeoutMs}ms (state=${client.connectionState})`,
      );
    }
    await new Promise((r) => globalThis.setTimeout(r, 25));
  }
}
