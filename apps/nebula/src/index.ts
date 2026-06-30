/**
 * @lumenize/nebula — public exports
 */

// DO classes
export { NebulaDO, requireAdmin, enforceScopeReach } from './nebula-do';
export { NebulaContainer } from './nebula-container';
export { DevContainer } from './dev-container';
export type { SourceFile } from './dev-container';
export { DevStudio } from './dev-studio';
export { Universe } from './universe';
export { Galaxy } from './galaxy';
export { Star } from './star';

// Ontology
export type { OntologyVersionConfig, OntologyVersionRow, OntologyState } from './galaxy';
// Pure compile fn (`.d.ts` → validator row). Used by DevStudio (dev apply) + test
// helpers that apply an ontology via `Star.setOntology` without a Galaxy round-trip.
export { compileOntologyVersion } from './galaxy';

// Resources
export { Resources, END_OF_TIME } from './resources';
export type { SnapshotMeta, Snapshot, TransactionResult, TransactionError } from './resources';
// The server-internal wire op shape (eTag-required put/move/delete, no typeName
// on those — the server reads it from the current snapshot). Distinct from the
// public client `OperationDescriptor` (typeName on every op, eTag auto-derived).
// Exposed for harnesses/tests that drive `Star.transaction` directly.
export type { OperationDescriptor as WireOperationDescriptor } from './resources';

// Subscriptions
export { Subscriptions } from './subscriptions';
export type { SubscriberRow } from './subscriptions';

// Query subscriptions (Child 2)
export { QuerySubs } from './query-subscriptions';
export type { QuerySubscriberRow } from './query-subscriptions';
export { canonicalQueryHash } from './query-hash';
export type { QueryDescriptor, QueryUpdatePayload, QueryType, OnPartial, OrderBy } from './query-hash';

// Resource data-plane capability (Child 1) — the composable host for Resources,
// shared by Star + DevStudio (ADR-007).
export { ResourceDataPlane } from './resource-data-plane';
export type { OntologyProvider, ResourceHostBridge, BroadcastTarget } from './resource-data-plane';

// DevStudio's platform-fixed Session/Turn ontology + its getOntology() provider.
export {
  SESSION_TURN_TYPES,
  SESSION_TURN_ONTOLOGY_VERSION,
  SESSION_TURN_BUNDLE_ID,
  createResourceOntologyProvider,
} from './devstudio-resource-ontology';

// Errors
export {
  OntologyStaleError, isOntologyStaleError,
  PermissionDeniedError, isPermissionDeniedError,
  NodeNotFoundError, isNodeNotFoundError,
} from './errors';

// DAG tree
export { DagTree } from './dag-tree';
export type { PermissionTier, DagTreeState, DagTreeView, DagTreeNodeData, EdgeKey } from './dag-ops';
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

// Gateway
export { NebulaClientGateway } from './nebula-client-gateway';

// Client
export { NebulaClient } from './nebula-client';
export type {
  NebulaClientConfig,
  OntologyStaleInfo,
  TransactionOptions,
  ReadOptions,
  OperationDescriptor,
  NebulaStoreAdapter,
  TransactionOutcome,
  TransactionResourceResolution,
  ResourceHandler,
  ConflictResolverVerdict,
  ResourceSubscription,
  QuerySubscription,
  SubscribeQueryOptions,
} from './nebula-client';

// Entrypoint
export { default as entrypoint } from './entrypoint';
