/**
 * @lumenize/mesh/auth — multi-tenant authentication for a Mesh app
 *
 * Magic link login, JWT access tokens, and admin roles scoped to
 * a three-tier hierarchy: Universe > Galaxy > Star. The scope grammar, the passage and dominion
 * predicates and the host grammar are also on Mesh's root and `/client`, where a Client reads them.
 *
 * The per-scope `NebulaAuth` DO was dissolved (tasks/archive/nebula-auth-surrogate-sub.md): the singleton
 * `AuthRegistry` owns all durable state, token/login flows run in the Worker (`router.ts` +
 * `worker-token.ts`) over Workers KV, and identity is keyed by a registry-minted surrogate `sub`.
 *
 * @see tasks/archive/nebula-auth-surrogate-sub.md for architecture details
 */

// The singleton registry DO (needed for wrangler bindings in consuming projects).
export { AuthRegistry } from './auth-registry';

// NOTE: the `Profile` DO is deliberately NOT re-exported here — it composes `@lumenize/mesh`, and
// pulling that whole chain through this (widely-imported) index breaks the transform of pure-unit
// consumers that import only light utilities (e.g. parse-id). Import it from the dedicated subpath
// instead: `import { Profile } from '@lumenize/mesh/auth/profile'` (tasks/archive/nebula-profile-store.md).
// The same rule keeps `AuthFacade` (a mesh-composing LumenizeWorker) out of this barrel —
// import it from `@lumenize/mesh/auth/facade`.

// Scope-hierarchy shapes — the client (NebulaClient.scopes) returns these to the UI.
export type {
  AffectedScope, ScopeDeletionBlocker, ScopeDeletionAffectedUsers, ScopeDeletionPlan,
} from './auth-registry';
// The Home screen's tree shapes live in `types` with the rest of the wire vocabulary.
export type { ScopeNode, EmailScopes, ScopeSummary } from './types';
// The seam a consumer's `AuthFacade` subclass fills, to wipe Durable Objects only it can name.
export type { ScopeLifecycleHooks, ScopeTarget } from './types';
// The impersonation mint's typed refusal, detected by name across a mesh hop.
export { ImpersonationRefusedError, isImpersonationRefused } from './types';

// Email sender (WorkerEntrypoint for service binding)
export { AuthEmailSender } from './auth-email-sender';

// Router entry point — the primary export for composing into a parent Worker
export { routeAuthRequest } from './router';

// JWT verification — primary export for consuming packages
export { verifyAccessToken } from './router';

// universeGalaxyStarId parsing, plus the two structural containment predicates the
// coarse-grained verdicts are built from (ADR-015 § *Predicate pair*).
export {
  parseId,
  isValidSlug,
  isPlatformScope,
  getParentId,
  isAtOrAbove,
  isAtOrBelow,
  hasDominionOver,
  hasPassageInto,
  noPassageMessage,
} from './parse-id';
export type { VerdictClaims } from './parse-id';

// ADR-016's acting-principal projection — the ONE shared shape every record site uses.
// ⚠️ Exported deliberately: `apps/nebula` records the identical shape (the `Snapshots` engine's `actingToken`
// column), and a second hand-rolled projection there is the divergence ADR-016 calls unrecoverable
// history. (`Snapshots` itself imports it from the Node-safe `./claims` subpath, not this barrel —
// this module is in its client value graph and the barrel exports the Registry DO.)
export { projectActingToken } from './access-claims';
export type { ActingTokenRecord } from './access-claims';

// Types needed by consuming packages
export type {
  Tier,
  ParsedId,
  AccessEntry,
  AuthClaims,
  InviteeRequest,
  InviteOutcome,
  InviteeSummary,
  InviteeError,
  InviteSummary,
  InviteeMintResult,
  InviteMintResult,
  AcceptanceOutcome,
  AcceptanceCredential,
  RefreshPut,
} from './types';

// Constants needed externally
export {
  PLATFORM_SCOPE,
  RESERVED_STAR_SLUGS,
  REGISTRY_INSTANCE_NAME,
  AUTH_PREFIX,
  ACCESS_TOKEN_TTL,
  NEBULA_SUB,
  MAX_GALAXIES_PER_OWNER,
  GALAXY_CAP_MESSAGE,
} from './types';
