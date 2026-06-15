/**
 * Core factory types for `@lumenize/nebula/frontend`.
 */
import type { ConnectionState } from '@lumenize/mesh/client';
import type { NebulaStoreAdapter } from '../nebula-client';

/**
 * Middleware fires on every write through the Proxy `set` trap (and wrapped
 * Map/Set mutators), regardless of write origin: v-model, @click, internal
 * code, server fanout. Return a value to substitute for `newValue`; return
 * `undefined` to leave `newValue` unchanged; throw to abort the write entirely
 * (which also aborts the synced-state submission, since synced-state runs
 * after the user chain).
 */
export type Middleware = (args: {
  path: string;
  oldValue: unknown;
  newValue: unknown;
  context: WriteContext;
}) => unknown;

/**
 * Write-context discriminator. `'local'` is the default (user-driven write);
 * `'remote'` / `'rollback'` / `'computed'` bypass the synced-state middleware
 * (the source — server fanout, engine rollback, or vivification — has already
 * authoritatively decided the value, so it must not re-enqueue a transaction).
 */
export type WriteContext = { source: 'local' | 'remote' | 'rollback' | 'computed' };

/**
 * The subset of `NebulaClient` the factory's store layer drives. The real
 * NebulaClient satisfies this structurally; tests pass a lightweight mock that
 * runs the same conflict-outcome engine over a recording mesh transport.
 *
 * The factory does NOT instantiate the engine or debounce queue — NebulaClient
 * owns them. The factory injects a {@link NebulaStoreAdapter} via
 * `bindStore(...)`, drives the debounced v-model path via `resources.write`,
 * manages auto-subscribe via `resources.{subscribe,unsubscribe}`, and surfaces
 * connection state via `onConnectionStateChange` + `connectionState`.
 */
export interface StoreClient {
  /** Inject the Vue-reactive adapter the engine writes optimistic state through. */
  bindStore(adapter: NebulaStoreAdapter): void;
  /** Current connection state — read once at factory creation to replay it. */
  readonly connectionState: ConnectionState;
  /** Register the factory's connection-state listener (mirrors to lmz.connection.*). */
  onConnectionStateChange(handler: (state: ConnectionState) => void): void;
  /** Flush pending debounced writes (no args = all). */
  flush(resourceType?: string, resourceId?: string): void;
  /** Flush + settle open submissions + tear down the debounce queue. */
  dispose(): Promise<void>;
  resources: {
    /** Enqueue a debounced put of the resource's current optimistic store value. */
    write(
      resourceType: string,
      resourceId: string,
      opts?: { quietMs?: number; preWriteValue?: unknown },
    ): void;
    /** Subscribe to a resource (auto-subscribe 0→1). Fanout arrives via the adapter. */
    subscribe(resourceType: string, resourceId: string): Promise<unknown>;
    /** Release a subscription (auto-subscribe 1→0 after grace). */
    unsubscribe(resourceType: string, resourceId: string): void;
  };
}
