/**
 * @lumenize/nebula-auth - Multi-tenant authentication for Nebula
 *
 * Magic link login, JWT access tokens, and admin roles scoped to
 * a three-tier hierarchy: Universe > Galaxy > Star.
 *
 * @see tasks/nebula-auth.md for architecture details
 */

// Main DO class
export { NebulaAuth } from './nebula-auth';

// SQL schemas
export { ALL_SCHEMAS } from './schemas';

// universeGalaxyStarId parsing and access matching
export {
  parseId,
  isValidSlug,
  isPlatformInstance,
  getParentId,
  buildAccessId,
  matchAccess,
} from './parse-id';

// Types and constants
export type {
  Tier,
  ParsedId,
  AccessEntry,
  NebulaJwtPayload,
  Subject,
  MagicLink,
  InviteToken,
  RefreshToken,
  RegistryInstance,
  RegistryEmail,
  DiscoveryEntry,
} from './types';

export {
  PLATFORM_INSTANCE_NAME,
  REGISTRY_INSTANCE_NAME,
  NEBULA_AUTH_PREFIX,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  MAGIC_LINK_TTL,
  INVITE_TTL,
  NEBULA_AUTH_ISSUER,
  NEBULA_AUTH_AUDIENCE,
} from './types';
