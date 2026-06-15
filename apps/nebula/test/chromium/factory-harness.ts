/**
 * Shared real-chromium factory harness — bootstraps a real magic-link login
 * then constructs the `createNebulaClient` factory at a unique scope, against
 * the real wrangler-dev Star reached same-origin through the vite proxy.
 *
 * Mirrors the connection config of the Node-side baseline e2e
 * (`create-nebula-client-ready.test.ts`) but with chromium natives — `fetch`,
 * `WebSocket`, `sessionStorage`, `BroadcastChannel` default to the real browser
 * globals, so callers pass only the overrides a probe needs (a recording
 * `WebSocket`, a faulty `fetch`, an `onLoginRequired`/`onConnectionStateChange`).
 */
import { inject } from 'vitest';
import { createNebulaClient } from '@lumenize/nebula/frontend';
import type { CreateNebulaClientConfig, FactoryResult } from '@lumenize/nebula/frontend';
import { bootstrapAdmin } from './auth-bootstrap';

export const ADMIN_EMAIL = 'test@lumenize.io';

/** Unique scope per test — Star DO state persists in .wrangler across runs. */
export function uniqueStar(): string {
  return `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;
}

/** The same-origin proxy base URL resolved against the test page origin. */
export function proxyBaseUrl(): string {
  return globalThis.location!.origin + inject('wranglerBaseUrl');
}

export interface BootstrapFactoryResult extends FactoryResult {
  scope: string;
  baseUrl: string;
}

/**
 * Real magic-link login + factory construction at `scope` (auto-generated if
 * omitted). Does NOT await `ready` — the caller decides (some probes assert on
 * the pre-connect/terminal phases). `extra` overrides/augments the factory
 * config (e.g. `{ WebSocket, fetch, onLoginRequired }`).
 */
export async function bootstrapFactory(
  extra: Partial<CreateNebulaClientConfig> = {},
  scopeOverride?: string,
): Promise<BootstrapFactoryResult> {
  const scope = scopeOverride ?? uniqueStar();
  const baseUrl = proxyBaseUrl();
  const testToken = inject('emailTestToken');
  await bootstrapAdmin({ baseUrl, scope, email: ADMIN_EMAIL, testToken });

  const result = createNebulaClient({
    baseUrl,
    authScope: scope,
    activeScope: scope,
    appVersion: 'v1',
    onShouldRefreshUI: () => {},
    ...extra,
  });
  return { scope, baseUrl, ...result };
}
