/**
 * @lumenize/resources/client — the vue-free client surface: `NebulaClient` and the resource and
 * org-tree types an app reads. Node.js- and browser-safe: nothing here reaches
 * `cloudflare:workers`. `/frontend` re-exports all of it, beside the Vue-reactive factory.
 */

// Client class + config
export { NebulaClient } from './nebula-client';
export type { NebulaClientConfig } from './nebula-client';
// What `impersonate()` throws, for a caller that tells its refusals apart.
export { ImpersonationChainError, ImpersonationAlreadyOpenError, ImpersonationMintError } from './impersonation';

// Resource types and the END_OF_TIME constant — used when constructing transactions and reading
// snapshots. These types reference @lumenize/mesh and @lumenize/crypto through type-only imports,
// erased at compile time, so they are safe to re-export here.
export { END_OF_TIME } from './snapshots';
export type {
  Snapshot,
  SnapshotMeta,
  WireActingToken,
  OperationDescriptor,
  TransactionResult,
  TransactionError,
} from './snapshots';

// Org/permission-tree types + helpers — the same `OrgTree*` names the server entry exports. The
// underlying structure is a DAG (hence `detectCycle`), but no `dag`-flavored name is exported.
// org-ops.ts is pure logic with no Cloudflare Workers runtime dependency. `PermissionTier` and
// `EdgeKey` take an `OrgTree` prefix here, since a client imports them beside its own types.
export {
  ROOT_NODE_ID,
  validateSlug,
  checkSlugUniqueness,
  detectCycle,
  resolvePermission,
  getEffectivePermission,
  getNodeAncestors,
  getNodeDescendants,
  buildOrgTreeView,
  makeEdgeKey,
} from './org-ops';
export type {
  PermissionTier as OrgTreePermissionTier,
  OrgTreeState,
  OrgTreeView,
  OrgTreeNodeData,
  EdgeKey as OrgTreeEdgeKey,
} from './org-ops';

// Ontology config types — the shape contract for a test lane's Star apply initiators.
export type { OntologyVersionConfig, OntologyVersionRow } from './ontology-version';
