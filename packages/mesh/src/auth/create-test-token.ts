/**
 * `createTestToken` — mint a correct-shape access token locally, with no magic-link email loop:
 * ADR-009 rung 3, the last resort, justified at each call site.
 *
 * Its callers are vitest-plugin fixtures that need a token no real login produces, most as a
 * plain `MeshClient`'s `refresh` (`apps/nebula/test/test-apps/baseline/profile-do.test.ts`'s
 * `makeClient`). The `/live` harness has no mint entry; `connectDriver`'s JSDoc says why. It
 * composes the shared {@link buildAuthClaims} claim-builder, so the token carries the
 * `access: { authScope, scopeAdmin? }` shape a server-minted token would, which verification
 * requires (`router.verifyAccessToken`, the `access.authScope` gate) — verified normally against
 * the corresponding public key, no test-mode, all production verification paths exercised.
 *
 * NOT a login: the token carries only a `sub` (identity is the surrogate `sub`, never email —
 * `email` is no longer a JWT claim), and no email is sent and no identity is DB-minted. Prod
 * tokens must still come via audited login / stored-refresh — never this local mint (security
 * invariant).
 *
 * Node-safe by construction: imports only `./access-claims` (pure) and `@lumenize/crypto`'s
 * signing primitives — that package has no `cloudflare:workers` anywhere in its graph.
 *
 * @example
 * new MeshClient({ baseUrl, refresh: createTestToken({ privateKey, issuer, activeScope, profileId }) });
 */
import { signJwt, importPrivateKey } from '@lumenize/crypto';
import { buildAuthClaims } from './access-claims';

/** Options for {@link createTestToken}. */
export interface CreateTestTokenOptions {
  /**
   * Private key PEM used to sign — the prod Ed25519 signing key, read from `.dev.vars`
   * (`JWT_PRIVATE_KEY_${activeKey}`). NEVER hardcode; NEVER log (security.md).
   */
  privateKey: string;
  /**
   * The BLUE/GREEN key selector — becomes the JWT `kid`, and MUST match a public key the
   * verifying Worker holds (`JWT_PUBLIC_KEY_${activeKey}`). Default `'BLUE'`. Do not assume
   * BLUE for a Worker whose `PRIMARY_JWT_KEY` is GREEN — sign with the matching key.
   */
  activeKey?: 'BLUE' | 'GREEN';
  /**
   * The verifying deployment's issuer, `platformOrigin` of its `LUMENIZE_ORIGIN` — a token signed
   * for any other deployment fails verification there, whatever key signed it.
   */
  issuer: string;
  /** JWT `aud` — the active scope this token is bound to. Must sit at or below `access.authScope`. */
  activeScope: string;
  /**
   * Issuing DO instance name (universeGalaxyStarId) — becomes the minted `access.authScope`.
   * Default: `activeScope` (a scope admin minting for its own scope).
   */
  instanceName?: string;
  /** Subject UUID. Default: a stable `crypto.randomUUID()` generated once per factory call. */
  sub?: string;
  /**
   * Mint an admin token (sets `access.scopeAdmin`). Default `true`.
   *
   * ⚠️ **The bit alone no longer enables the scope-admin bypass** — the guards confine it to the
   * callee node via `hasDominionOver`, which reads the token's `aud`, its `activeScope` here: what
   * decides is whether `activeScope` is at or above the node being called (the host rule). A token
   * minted with `scopeAdmin: true` and a STAR `activeScope` is therefore NOT an admin on that star's
   * Galaxy or Universe. Set `activeScope` to the scope whose dominion you actually want, and
   * `instanceName`, the membership's scope, at or above it; a plain token needs the two equal.
   */
  scopeAdmin?: boolean;
  /**
   * The bearer's PUBLIC profile address → the bare `profileId` claim. Required with no default, like
   * every mint's, and it should differ from `sub`: a roster that carried the `sub` where the
   * `profileId` belongs would otherwise still pass. Seed a known one to exercise the Profile owner
   * short-circuit (`claims.profileId === instanceName`) from a rung-3 mint. ADR-012.
   */
  profileId: string;
  /**
   * RFC 8693 delegation **actor pair** → the `act` claim. Mirrors the claim shape the production
   * impersonation mint emits: `{ sub, profileId }`, where `profileId` is the ACTOR's.
   */
  actor?: { sub: string; profileId: string };
  /** Token TTL in seconds. Default: the auth layer's `ACCESS_TOKEN_TTL`. */
  ttlSeconds?: number;
}

/**
 * Returns a `refresh` callback for a plain `MeshClient` that mints a fresh
 * correct-shape Nebula access token on each call (fresh `exp`/`iat`/`jti`; stable `sub`).
 * Shape matches {@link CreateTestTokenOptions}'s MeshClient `refresh` contract:
 * `() => Promise<{ access_token, sub }>`.
 */
export function createTestToken(
  options: CreateTestTokenOptions,
): () => Promise<{ access_token: string; sub: string }> {
  const {
    privateKey: privateKeyPem,
    activeKey = 'BLUE',
    issuer,
    activeScope,
    instanceName = activeScope,
    sub = crypto.randomUUID(),
    scopeAdmin = true,
    profileId,
    actor,
    ttlSeconds,
  } = options;

  return async () => {
    const privateKey = await importPrivateKey(privateKeyPem);
    const payload = buildAuthClaims({
      issuer,
      sub,
      instanceName,
      activeScope,
      scopeAdmin,
      profileId,
      actor,
      ttlSeconds,
    });
    const access_token = await signJwt(payload as any, privateKey, activeKey);
    return { access_token, sub };
  };
}
