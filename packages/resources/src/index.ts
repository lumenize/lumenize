/**
 * @lumenize/resources — the Resources plane, server side: what a node composes to hold an app's
 * resources, their history, their subscribers and the org tree that permits them (ADR-004,
 * ADR-007). A node exposes it through one `@mesh()`-decorated `get resources()`.
 *
 * Private and UNLICENSED: Nebula's, built on `@lumenize/mesh`, which never imports it.
 * `/client` is the vue-free client surface and `/frontend` the Vue-reactive one.
 */

// The plane a node composes, and the two surfaces it hands the wire
export { Resources } from './resources';
export type {
  OntologySource, InstalledOntology, ResourcesHost, ResourcesRequests, ResourcesResults, NodeInvitee, NodeInviteAck,
} from './resources';

// The ontology a plane installs — TYPES only; the compiler stays out of every Worker's graph
export type { OntologyVersionConfig, OntologyVersionRow } from './ontology-version';

// Snapshots — the temporal storage engine
export { Snapshots, END_OF_TIME } from './snapshots';
export type { SnapshotMeta, Snapshot, WireActingToken, TransactionResult, TransactionError } from './snapshots';
// The server-internal wire op shape (eTag-required put/move/delete, no typeName on those — the
// server reads it from the current snapshot). Distinct from the public client
// `OperationDescriptor` (typeName on every op, eTag auto-derived). Exposed for harnesses and tests
// that drive a host's `resources.transaction` directly.
export type { OperationDescriptor as WireOperationDescriptor } from './snapshots';

// Subscriptions — every kind a host holds, in one registry
export { Subscriptions } from './subscriptions';
export type {
  SubscriptionKind, SubscriberRow, QuerySubscriberRow, AddressRow, DroppedAddress, ResourceSubscribeOutcome,
} from './subscriptions';
export { canonicalQueryHash } from './query-hash';
export type { QueryDescriptor, QueryUpdatePayload, QueryType, OrderBy, SubscriberEntry, SubscriberRosterPayload } from './query-hash';

// Errors
export {
  OntologyStaleError, isOntologyStaleError,
  WipedMidTransactionError,
  PermissionDeniedError, isPermissionDeniedError,
  NodeNotFoundError, isNodeNotFoundError,
  NodeIdCollisionError,
  NoOntologyInstalledError, isNoOntologyInstalledError,
} from './errors';

// The org tree
export { OrgTree } from './org-tree';
export type { PermissionTier, OrgTreeState, OrgTreeView, OrgTreeNodeData, EdgeKey } from './org-ops';
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

// The client, for a node's continuation types and a test's construction
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
  ResourceDenied,
  ResourceStoreEntry,
  QuerySubscription,
  SubscribeQueryOptions,
} from './nebula-client';
