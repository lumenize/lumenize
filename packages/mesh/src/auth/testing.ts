/**
 * @lumenize/mesh/auth/testing — Node.js-safe test/harness entry point.
 *
 * The main `@lumenize/mesh/auth` barrel re-exports `AuthRegistry` (a DurableObject) which
 * transitively imports `cloudflare:workers` and fails to resolve outside Workers. This subpath exposes
 * only the parts a Node harness needs to mint + reason about Nebula tokens — all
 * `cloudflare:workers`-free — so it can be imported from a standalone `tsx` driver
 * (`tasks/archive/claude-live-verification.md`).
 *
 * A split by intent, not by runtime. (It used to mirror auth's Node-safe subpath; that subpath is
 * gone — its primitives are now the whole of `@lumenize/crypto`, which needs no split.)
 */

// The local-mint identity path (Phase 1).
export { createTestToken } from './create-test-token';
export type { CreateTestTokenOptions } from './create-test-token';

// The shared access-claim builder (single source of the JWT `access` shape).
export { buildAuthClaims, buildAccessEntry } from './access-claims';
export type { AccessClaimInput } from './access-claims';

// Pure scope-parsing + containment helpers a harness uses to derive + assert scopes.
// Both verdicts are exported here too — a Node harness reasoning about dominion or passage must
// never re-inline the `scopeAdmin && isAtOrAbove(...)` conjunction, nor passage's two-arm union,
// which the shared predicates collapse (ADR-007, one guard path / one place to audit).
export {
  parseId, isValidSlug, isPlatformScope, getParentId, isAtOrAbove, isAtOrBelow,
  hasDominionOver, hasPassageInto,
} from './parse-id';

// Types + constants needed to build/inspect tokens, plus the invite wire shapes (a Node harness
// drives `NebulaClient.invite` and asserts on its summary).
export type {
  AccessEntry, AuthClaims, Tier, ParsedId,
  InviteeRequest, InviteOutcome, InviteeSummary, InviteeError, InviteSummary,
} from './types';
export { ACCESS_TOKEN_TTL, AUTH_PREFIX, PLATFORM_SCOPE } from './types';
export { parseHost, platformOrigin, deploymentOrigin, type HostTarget } from './hosts';
