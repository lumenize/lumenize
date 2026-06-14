/**
 * Core factory types for @lumenize/nebula-frontend.
 *
 * Scaffold skeleton — the full, canonical shapes (WriteContext fields, the
 * synced-state/collection-mutator middleware contract, ClientLike) land with the
 * factory port in Phase 5.3.7-v3 (ported from apps/nebula/spike/vue-factory/src/types.ts).
 */

/**
 * A single write flowing through the factory's outer Proxy `set` trap (property
 * assignment) or a wrapped Map/Set mutator. Middleware may substitute `value`
 * (by writing through) or abort (by throwing).
 */
export interface WriteContext {
  /** Full write path, e.g. ['resources', 'todo', 't1', 'value', 'title']. */
  path: string[];
  /** Value being written (after any upstream middleware substitution). */
  value: unknown;
  /** Previous value at this path (pre-mutation snapshot for collection mutators). */
  oldValue: unknown;
  /** Origin of the write: 'local' (user/app) or 'remote' (server fanout). */
  source: 'local' | 'remote';
}

/**
 * A middleware in the factory's write chain. User middlewares run first; the
 * built-in synced-state middleware runs LAST (so a user abort also aborts the
 * submission). Call `next()` to continue; throw to abort the whole write.
 */
export type Middleware = (ctx: WriteContext, next: () => void) => void;
