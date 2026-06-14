/**
 * @lumenize/nebula-frontend — public API.
 *
 * Scaffold surface. The v3 port grows this to the full contract in
 * website/docs/nebula/api-reference.md (NebulaClient, the conflict-outcome
 * types, orgTree exports, makeLongformResolver, etc.).
 */
export { createNebulaClient } from './create-nebula-client';
export type { CreateNebulaClientConfig, FactoryResult } from './create-nebula-client';
export type { Middleware, WriteContext } from './types';
export { textMerge, makeLongformResolver } from './text-merge';
export type { ConflictResolverVerdict } from './text-merge';
export type {
  TransactionOutcome,
  TransactionResourceResolution,
  ResourceHandler,
  Snapshot,
} from './conflict-outcome';
