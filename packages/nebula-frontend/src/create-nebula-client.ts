import type { Middleware } from './types';

/**
 * Configuration for {@link createNebulaClient}. Only `appVersion` is required;
 * every other field auto-detects from the deployment URL / defaults at runtime
 * (finalized in the v3 port — api-reference § createNebulaClient).
 *
 * Scaffold skeleton — the canonical config + result shapes land with the factory
 * port in Phase 5.3.7-v3.
 */
export interface CreateNebulaClientConfig {
  /** App/ontology version. The one field Studio's bootstrap substitutes at deploy time. Auto-attached to every `client.resources.*` op. */
  appVersion: string;
  /** API origin. Defaults to `window.location.origin`. */
  baseUrl?: string;
  /** Cookie-path auth scope. Defaults from the deployment URL. */
  authScope?: string;
  /** JWT `aud` active scope. Defaults to `authScope`. */
  activeScope?: string;
  /** Called on `ontology-stale`. `undefined`/`null` → default `window.location.reload()`; pass `() => {}` to opt out. */
  onShouldRefreshUI?: ((info: { clientVersion: string; currentVersion: string; reason: string }) => void) | null;
}

/**
 * What {@link createNebulaClient} returns. `store` is the Vue-reactive,
 * path-aware Proxy; `client` exposes the NebulaClient surface; `ready` resolves
 * after the first successful connection (claims populated).
 */
export interface FactoryResult {
  client: unknown;
  store: Record<string, unknown>;
  ready: Promise<void>;
  use(middleware: Middleware): void;
  dispose(): void;
}

/**
 * Integration entry point — wraps a NebulaClient in a Vue-reactive store with
 * optimistic writes, debounced transactions, conflict resolution, and
 * effect-scope-tied auto-subscribe.
 *
 * Scaffold skeleton — ported in Phase 5.3.7-v3 from
 * apps/nebula/spike/vue-factory/src/create-nebula-client.ts.
 *
 * @see https://lumenize.com/docs/nebula/api-reference#createnebulaclient
 */
export function createNebulaClient(_config: CreateNebulaClientConfig): FactoryResult {
  throw new Error(
    'createNebulaClient: not yet ported (nebula-frontend v3 — see tasks/nebula-frontend.md § Phase 5.3.7-v3)',
  );
}
