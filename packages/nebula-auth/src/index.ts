/**
 * @lumenize/nebula-auth - Multi-tenant authentication for Nebula
 *
 * Magic link login, JWT access tokens, and admin roles scoped to
 * a three-tier hierarchy: Universe > Galaxy > Star.
 *
 * @see tasks/nebula-auth.md for architecture details
 */

// DO classes (needed for wrangler bindings in consuming projects)
export { NebulaAuth } from './nebula-auth';
export { NebulaAuthRegistry } from './nebula-auth-registry';

// Email sender (WorkerEntrypoint for service binding)
export { NebulaEmailSender } from './nebula-email-sender';

// Router entry point — the primary export for composing into a parent Worker
export { routeNebulaAuthRequest } from './router';

// universeGalaxyStarId parsing and access matching
export {
  parseId,
  isValidSlug,
  isPlatformInstance,
  getParentId,
  buildAccessId,
  matchAccess,
} from './parse-id';

// Types needed by consuming packages
export type {
  Tier,
  ParsedId,
  AccessEntry,
  NebulaJwtPayload,
  Subject,
  DiscoveryEntry,
} from './types';

// Constants needed externally
export {
  PLATFORM_INSTANCE_NAME,
  REGISTRY_INSTANCE_NAME,
  NEBULA_AUTH_PREFIX,
  ACCESS_TOKEN_TTL,
  NEBULA_AUTH_ISSUER,
  NEBULA_AUTH_AUDIENCE,
} from './types';
