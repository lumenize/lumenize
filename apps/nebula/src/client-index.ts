/**
 * @lumenize/nebula/client — Node.js / browser-safe entry point
 *
 * Mirrors `@lumenize/mesh/client` — exposes only the parts of
 * `@lumenize/nebula` that don't require the Cloudflare Workers runtime.
 * Use this from Node.js test harnesses and unbundled browsers.
 *
 * The main `@lumenize/nebula` entry re-exports `Universe`, `Galaxy`, `Star`,
 * `ResourceHistory`, `NebulaClientGateway`, and the entrypoint — all of
 * which transitively import `cloudflare:workers` and fail outside Workers.
 * This file leaves them out and exports only the client-side surface.
 *
 * @example
 * ```typescript
 * import { NebulaClient, ROOT_NODE_ID } from '@lumenize/nebula/client';
 * import type { OperationDescriptor, TransactionResult } from '@lumenize/nebula/client';
 *
 * const client = new NebulaClient({
 *   baseUrl: 'https://my-app.example.com',
 *   authScope: 'acme.app.tenant-a',
 *   activeScope: 'acme.app.tenant-a',
 * });
 * ```
 */

// Client class + config
export { NebulaClient } from './nebula-client';
export type { NebulaClientConfig } from './nebula-client';

// Resource types and the END_OF_TIME constant — used when constructing
// transactions and reading snapshots. These types reference @lumenize/mesh
// and @lumenize/auth via type-only imports (erased at compile time), so
// they're safe to re-export here.
export { END_OF_TIME } from './resources';
export type {
  Snapshot,
  SnapshotMeta,
  OperationDescriptor,
  TransactionResult,
  TransactionError,
} from './resources';

// DAG ontology types and constants. dag-ops.ts is pure logic with no
// runtime dependencies on the Cloudflare Workers runtime.
export {
  ROOT_NODE_ID,
  validateSlug,
  checkSlugUniqueness,
  detectCycle,
  resolvePermission,
  getEffectivePermission,
  getNodeAncestors,
  getNodeDescendants,
  buildDagTreeView,
  makeEdgeKey,
} from './dag-ops';
export type { PermissionTier, DagTreeState, DagTreeView, DagTreeNodeData, EdgeKey } from './dag-ops';

// Ontology config types — shape contract for callGalaxyAppendOntologyVersion.
export type { OntologyVersionConfig, OntologyVersionRow, OntologyState } from './galaxy';
