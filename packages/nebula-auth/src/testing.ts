/**
 * @lumenize/nebula-auth/testing — Node.js-safe test/harness entry point.
 *
 * The main `@lumenize/nebula-auth` barrel re-exports `NebulaAuthRegistry` (a DurableObject) which
 * transitively imports `cloudflare:workers` and fails to resolve outside Workers. This subpath exposes
 * only the parts a Node harness needs to mint + reason about Nebula tokens — all
 * `cloudflare:workers`-free — so it can be imported from a standalone `tsx` driver
 * (`tasks/archive/claude-live-verification.md`).
 *
 * Mirrors the `@lumenize/auth/client` split: by intent, not by runtime.
 */

// The local-mint identity path (Phase 1).
export { createNebulaTestToken } from './create-nebula-test-token';
export type { CreateNebulaTestTokenOptions } from './create-nebula-test-token';

// The shared access-claim builder (single source of the JWT `access` shape).
export { buildNebulaJwtPayload, buildNebulaAccessEntry } from './access-claims';
export type { NebulaAccessClaimInput } from './access-claims';

// Pure scope-parsing / access-matching helpers a harness uses to derive + assert scopes.
export { parseId, isValidSlug, isPlatformInstance, getParentId, buildAuthScopePattern, matchAccess } from './parse-id';

// Types + constants needed to build/inspect tokens.
export type { AccessEntry, NebulaJwtPayload, Tier, ParsedId } from './types';
export { ACCESS_TOKEN_TTL, NEBULA_AUTH_ISSUER, NEBULA_AUTH_PREFIX, PLATFORM_INSTANCE_NAME } from './types';
