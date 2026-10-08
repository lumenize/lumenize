/**
 * @lumenize/nebula — public exports
 */

// DO classes
export { NebulaDO, requireDominionHere, requirePassage } from './nebula-do';
export { Universe } from './universe';
export { Galaxy, requireChatWrite, assertModelPath, LOOP_TOOL_ENTRIES } from './galaxy';
export { Star } from './star';
// The session entry, with the hooks that wipe this Worker's Durable Objects on a deletion or creation.
export { NebulaAuthFacade } from './nebula-auth-facade';
export type { NodeInvitee, NodeInviteAck } from './resources';

// Ontology — TYPES only. The compile fn is deliberately NOT re-exported: this barrel
// reaches `src/worker.ts`, and the compiler must stay out of the deployed Worker's
// import graph (tasks/archive/nebula-move-compilers-out-of-the-worker.md;
// scripts/check-worker-graph.mjs is the tripwire). A test lane that genuinely
// compiles imports `./ontology-compile` directly.
export type { OntologyVersionConfig, OntologyVersionRow } from './galaxy';

// Snapshots — the temporal storage engine
export { Snapshots, END_OF_TIME } from './snapshots';
export type { SnapshotMeta, Snapshot, WireActingToken, TransactionResult, TransactionError } from './snapshots';
// The server-internal wire op shape (eTag-required put/move/delete, no typeName
// on those — the server reads it from the current snapshot). Distinct from the
// public client `OperationDescriptor` (typeName on every op, eTag auto-derived).
// Exposed for harnesses/tests that drive `Star.resources.transaction` directly.
export type { OperationDescriptor as WireOperationDescriptor } from './snapshots';

// Subscriptions — every kind a host holds, in one registry
export { Subscriptions } from './subscriptions';
export type {
  SubscriptionKind, SubscriberRow, QuerySubscriberRow, AddressRow, DroppedAddress, ResourceSubscribeOutcome,
} from './subscriptions';
export { canonicalQueryHash } from './query-hash';
export type { QueryDescriptor, QueryUpdatePayload, QueryType, OrderBy, SubscriberEntry, SubscriberRosterPayload } from './query-hash';

// The resources plane — composed by the Star and the Galaxy alike (ADR-007).
export { Resources } from './resources';
export type { OntologySource, InstalledOntology, ResourcesHost, ResourcesRequests, ResourcesResults } from './resources';

// The platform chat ontology: pure strings from the client-safe leaf; the compiled
// seed row from the server-only module.
export {
  DEFAULT_CHAT_ID,
  CHAT_NODE_ID,
  CHAT_MESSAGE_ONTOLOGY_VERSION,
  CHAT_MESSAGE_TYPES,
} from './chat-constants';
export { chatOntologySeedRow } from './chat-ontology';
// Participant derivation — display identity from the stamped actingToken (client-safe).
export { deriveKind, deriveParticipants } from './participants';
export {
  startTurn, signalTurn, settleTurn, evaluateTurn, deriveTurnDisplay, TURN_IDLE_MS, TURN_HEARTBEAT_MS,
  type TurnLiveness, type TurnPhase, type TurnDisplay,
} from './turn-liveness';
export type { ParticipantKind, ParticipantRef } from './participants';

// Errors
export {
  OntologyStaleError, isOntologyStaleError,
  PermissionDeniedError, isPermissionDeniedError,
  NodeNotFoundError, isNodeNotFoundError,
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

// Client
export { NebulaClient } from './nebula-client';
export { StudioClient } from './studio-client';
export type { StudioClientConfig } from './studio-client';
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

// Entrypoint
export { default as entrypoint } from './entrypoint';
// The platform host's own routes — every Worker that runs the entrypoint binds it as `PLATFORM_HOST`.
export { PlatformHost } from './platform-host';
