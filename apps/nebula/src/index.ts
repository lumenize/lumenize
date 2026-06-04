/**
 * @lumenize/nebula — public exports
 */

// DO classes
export { NebulaDO, requireAdmin } from './nebula-do';
export { Universe } from './universe';
export { Galaxy } from './galaxy';
export { Star } from './star';
export { ResourceHistory } from './resource-history';

// Ontology
export type { OntologyVersionConfig, OntologyVersionRow, OntologyState } from './galaxy';

// Resources
export { Resources, END_OF_TIME } from './resources';
export type { SnapshotMeta, Snapshot, OperationDescriptor, TransactionResult, TransactionError } from './resources';

// Subscriptions
export { Subscriptions } from './subscriptions';
export type { SubscriberRow } from './subscriptions';

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
  TransactionResolution,
  TransactionOptions,
  ReadOptions,
  ConflictResolver,
  ConflictResolution,
  ETagConflictOptions,
} from './nebula-client';

// Entrypoint
export { default as entrypoint } from './entrypoint';
