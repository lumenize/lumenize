/**
 * @lumenize/nebula/client — Node.js / browser-safe entry point
 *
 * Mirrors `@lumenize/mesh/client` — exposes only the parts of
 * `@lumenize/nebula` that don't require the Cloudflare Workers runtime.
 * Use this from Node.js test harnesses and unbundled browsers.
 *
 * The main `@lumenize/nebula` entry re-exports `Universe`, `Galaxy`, `Star`,
 * and the entrypoint — all of which transitively import
 * `cloudflare:workers` and fail outside Workers. This file leaves them out and
 * exports only the client-side surface.
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
// Studio's own Client: NebulaClient plus chat posts, picture uploads and the build reply.
export { StudioClient } from './studio-client';
export type { StudioClientConfig } from './studio-client';

// Scope-deletion wire types — re-exported so a frontend (which depends on `@lumenize/nebula`, not on
// `@lumenize/nebula-auth`) can type the confirm screen against the SHARED shape instead of hand-copying
// it. A hand-copy silently rots: `nebula-studio-ui` has no `vue-tsc` and is the sole `SKIP_PACKAGES`
// entry, so a field rename there surfaces only as a runtime TypeError.
export type {
  AffectedScope, ScopeDeletionBlocker, ScopeDeletionAffectedUsers, ScopeDeletionPlan,
} from '@lumenize/nebula-auth';

// Resource types and the END_OF_TIME constant — used when constructing
// transactions and reading snapshots. These types reference @lumenize/mesh
// and @lumenize/crypto via type-only imports (erased at compile time), so
// they're safe to re-export here.
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

// Ontology config types — shape contract for the test lanes' Star apply initiators
// (callStarInstallOntology / StarTest.applyOntologyForTest).
export type { OntologyVersionConfig, OntologyVersionRow } from './galaxy';

// Chat identity + the platform chat-ontology version label (pure strings — the value a
// chat client sends as its `ontologyVersion`).
export { DEFAULT_CHAT_ID, CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION } from './chat-constants';

// Participant derivation — display identity from the stamped `meta.actingToken`
// (author from `sub`, kind from the outermost act?.sub === NEBULA_SUB). Pure.
export { deriveKind, deriveParticipants } from './participants';
export {
  startTurn, signalTurn, settleTurn, evaluateTurn, deriveTurnDisplay, TURN_IDLE_MS, TURN_HEARTBEAT_MS,
  type TurnLiveness, type TurnPhase, type TurnDisplay,
} from './turn-liveness';
export type { ParticipantKind, ParticipantRef } from './participants';
