import type { EffectScope } from '@vue/reactivity';

/**
 * Middleware fires on every write through the Proxy `set` trap (regardless of
 * write origin: x-model, @click, internal code, RPC fanout). Return a value to
 * substitute for `newValue`; return `undefined` to leave `newValue` unchanged;
 * throw to abort the write entirely.
 */
export type Middleware = (args: {
  path: string;
  oldValue: unknown;
  newValue: unknown;
  context: WriteContext;
}) => unknown;

/**
 * Write-context discriminator. `'local'` is the default (user-driven write);
 * `'remote'` / `'rollback'` / `'computed'` bypass synced-state middleware (the
 * source has already authoritatively decided the value).
 */
export type WriteContext = { source: 'local' | 'remote' | 'rollback' | 'computed' };

/**
 * Minimal client interface the factory wires the store to. Phase 0a uses a
 * mock implementation; Phase 0b plugs in a reshaped NebulaClient.
 */
export interface ClientLike {
  /** Submit a transaction; resolves with outcome. */
  transaction(args: {
    rt: string;
    rid: string;
    eTag: string;
    value: unknown;
    newETag: string;
  }): Promise<TransactionOutcome>;

  /** Subscribe to a resource; resolves with initial snapshot. */
  subscribe(rt: string, rid: string): Promise<{ value: unknown; meta: { eTag: string } } | null>;

  /** Unsubscribe from a resource. Fire-and-forget. */
  unsubscribe(rt: string, rid: string): void;

  /** Register a handler for server fanout. The factory wires this to its
   *  internal write-path. */
  onResourceUpdate(handler: (rt: string, rid: string, snapshot: { value: unknown; meta: { eTag: string } } | null) => void): void;

  /** Register a connection-state observer. The factory writes to store.lmz.connection.*. */
  onConnectionStateChange(handler: (state: string) => void): void;
}

export type TransactionOutcome =
  | { resolution: 'committed'; eTag: string }
  | { resolution: 'use-server'; snapshot: { value: unknown; meta: { eTag: string } } }
  | { resolution: 'validation-failed'; errors: unknown }
  | { resolution: 'timeout' };

/**
 * Factory output. `store` is the Vue-reactive Proxy with middleware; users
 * (or Alpine) read/write properties on it. `client` is the lower-level API
 * (the reshaped NebulaClient in Phase 0b).
 */
export interface FactoryResult {
  store: Record<string, any>;
  client: ClientLike;
  /** Test/observability: register an additional middleware. User middlewares
   *  run in registration order; the built-in synced-state middleware always
   *  runs after them (an abort therefore also aborts the submission). */
  use(middleware: Middleware): () => void;
  /** Flush pending writes, wait for open submissions; nothing submits after. */
  dispose(): Promise<void>;
  /** External flush trigger (unmount / blur). No args flushes everything. */
  flush(rt?: string, rid?: string): void;
  /** Per-resource-type debounce config. */
  transactionDebounce(rt: string, opts: { quietMs?: number; maxWaitMs?: number }): void;
}

export interface ResourceReadEvent {
  rt: string;
  rid: string;
  scope: EffectScope;
}
