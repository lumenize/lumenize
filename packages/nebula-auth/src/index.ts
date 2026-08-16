/**
 * @lumenize/nebula-auth - Multi-tenant authentication for Nebula
 *
 * Magic link login, JWT access tokens, and admin roles scoped to
 * a three-tier hierarchy: Universe > Galaxy > Star.
 *
 * The per-scope `NebulaAuth` DO was dissolved (tasks/nebula-auth-surrogate-sub.md): the singleton
 * `NebulaAuthRegistry` owns all durable state, token/login flows run in the Worker (`router.ts` +
 * `worker-token.ts`) over Workers KV, and identity is keyed by a registry-minted surrogate `sub`.
 *
 * @see tasks/nebula-auth-surrogate-sub.md for architecture details
 */

// The singleton registry DO (needed for wrangler bindings in consuming projects).
export { NebulaAuthRegistry } from './nebula-auth-registry';

// NOTE: the `Profile` DO is deliberately NOT re-exported here — it composes `@lumenize/mesh`, and
// pulling that whole chain through this (widely-imported) index breaks the transform of pure-unit
// consumers that import only light utilities (e.g. parse-id). Import it from the dedicated subpath
// instead: `import { Profile } from '@lumenize/nebula-auth/profile'` (tasks/nebula-profile-store.md).

// Scope-hierarchy shapes — the client (NebulaClient.scopes) returns these to the UI.
export type {
  AffectedScope, ScopeDeletionBlocker, ScopeDeletionAffectedUsers, ScopeDeletionPlan,
} from './nebula-auth-registry';

// Email sender (WorkerEntrypoint for service binding)
export { NebulaEmailSender } from './nebula-email-sender';

// Router entry point — the primary export for composing into a parent Worker
export { routeNebulaAuthRequest } from './router';

// JWT verification — primary export for consuming packages (Phase 2 entrypoint)
export { verifyNebulaAccessToken } from './router';

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
} from './parse-id';

// ADR-016's acting-principal projection — the ONE shared shape every record site uses.
// ⚠️ Exported deliberately: `apps/nebula` needs the identical record for Resources' `changedBy`, and
// a second hand-rolled projection there is the divergence ADR-016 calls unrecoverable history.
export { projectActingToken } from './access-claims';
export type { ActingTokenRecord } from './access-claims';

// Types needed by consuming packages
export type {
  Tier,
  ParsedId,
  AccessEntry,
  NebulaJwtPayload,
  DiscoveryEntry,
} from './types';

// Constants needed externally
export {
  PLATFORM_SCOPE,
  REGISTRY_INSTANCE_NAME,
  NEBULA_AUTH_PREFIX,
  ACCESS_TOKEN_TTL,
  NEBULA_AUTH_ISSUER,
} from './types';
