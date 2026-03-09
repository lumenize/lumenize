/**
 * @lumenize/nebula — public exports
 */

// DO classes
export { NebulaDO, requireAdmin } from './nebula-do';
export { Universe } from './universe';
export { Galaxy } from './galaxy';
export { Star } from './star';
export { ResourceHistory } from './resource-history';

// Resources
export { Resources, END_OF_TIME } from './resources';
export type { SnapshotMeta, Snapshot, OperationDescriptor, TransactionResult } from './resources';

// DAG tree
export { DagTree } from './dag-tree';
export type { PermissionTier, DagTreeState } from './dag-ops';
export {
  ROOT_NODE_ID,
  validateSlug,
  checkSlugUniqueness,
  detectCycle,
  resolvePermission,
  getEffectivePermission,
  getNodeAncestors,
  getNodeDescendants,
} from './dag-ops';

// Gateway
export { NebulaClientGateway } from './nebula-client-gateway';

// Client
export { NebulaClient } from './nebula-client';
export type { NebulaClientConfig } from './nebula-client';

// Entrypoint
export { default as entrypoint } from './entrypoint';
