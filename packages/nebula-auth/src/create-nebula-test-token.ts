/**
 * `createNebulaTestToken` — mint a correct-shape Nebula access token locally, with no
 * magic-link email loop, for driving a running Nebula from a Node harness.
 *
 * This is the **local** identity path of the live self-verification harness
 * (`tasks/archive/claude-live-verification.md` Phase 1). It is the Nebula analogue of mesh's
 * `createTestRefreshFunction`, with the critical difference the task turns on: the base
 * util signs a **flat `isAdmin`** payload with **no `access` claim** — the *base* mesh/auth
 * shape — which Nebula's gateway rejects (`router.verifyNebulaAccessToken`, the
 * `access.authScopePattern` gate). This util instead composes the shared
 * {@link buildNebulaJwtPayload} claim-builder, so the token carries the real
 * `access: { authScopePattern, admin? }` shape a scope admin's server-minted token would —
 * verified normally against the corresponding public key, no test-mode, all production
 * verification paths exercised.
 *
 * NOT a login: the token carries only a `sub` (identity is the surrogate `sub`, never email —
 * `email` is no longer a JWT claim), and no email is sent and no identity is DB-minted. For local
 * `wrangler dev` an admin token for one's own sandbox scope needs neither (scope-admin-equivalent by
 * construction). Prod tokens must still come via audited login / stored-refresh — never this
 * local mint (security invariant).
 *
 * Node-safe by construction: imports only `./access-claims` (pure) and `@lumenize/crypto`'s
 * signing primitives — that package has no `cloudflare:workers` anywhere in its graph — so it
 * runs under plain Node (tsx) against a real `wrangler dev`.
 *
 * @example
 * ```typescript
 * const refresh = createNebulaTestToken({
 *   privateKey: readDevVar('JWT_PRIVATE_KEY_BLUE'),   // the .dev.vars signing key
 *   activeScope: 'claude.sandbox.dev',                 // own sandbox star scope
 * });
 * const client = new NebulaClient({ baseUrl, authScope, activeScope, refresh, ... });
 * ```
 */
import { signJwt, importPrivateKey } from '@lumenize/crypto';
import { buildNebulaJwtPayload } from './access-claims';

/** Options for {@link createNebulaTestToken}. */
export interface CreateNebulaTestTokenOptions {
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
  /** JWT `aud` — the active scope this token is bound to. Must be covered by the pattern. */
  activeScope: string;
  /**
   * Issuing DO instance name (universeGalaxyStarId) — drives the `authScopePattern`.
   * Default: `activeScope` (a scope admin minting for its own scope).
   */
  instanceName?: string;
  /** Subject UUID. Default: a stable `crypto.randomUUID()` generated once per factory call. */
  sub?: string;
  /**
   * Mint an admin token (sets `access.admin`). Default `true`.
   *
   * ⚠️ **The bit alone no longer enables the scope-admin bypass** — the guards confine it to the
   * callee node via `hasAdminOverScope`, so what actually decides is whether `authScopePattern`
   * — which this factory always derives from `instanceName`, exposing no override — covers the node
   * being called. A token minted with
   * `isAdmin: true` at a STAR `instanceName` gets an exact-star pattern and is therefore NOT an
   * admin on that star's Galaxy or Universe. Set `instanceName` to the scope whose authority you
   * actually want. See tasks/nebula-confine-admin-bypass.md.
   */
  isAdmin?: boolean;
  /**
   * The bearer's PUBLIC profile address → the bare `profileId` claim. Omitted when absent (a token
   * with no `profileId` claim). Seed it explicitly to exercise the Profile owner short-circuit
   * (`claims.profileId === instanceName`) from a rung-3 mint. tasks/nebula-profile-store.md.
   */
  profileId?: string;
  /**
   * RFC 8693 delegation **actor pair** → the `act` claim. Mirrors the claim shape the production
   * `/mint-narrower-token` emits: `{ sub, profileId? }`, where `profileId` is the ACTOR's.
   */
  actor?: { sub: string; profileId?: string };
  /** Token TTL in seconds. Default: nebula-auth's `ACCESS_TOKEN_TTL`. */
  ttlSeconds?: number;
}

/**
 * Returns a `refresh` callback for `LumenizeClient`/`NebulaClient` that mints a fresh
 * correct-shape Nebula access token on each call (fresh `exp`/`iat`/`jti`; stable `sub`).
 * Shape matches {@link CreateNebulaTestTokenOptions}'s LumenizeClient `refresh` contract:
 * `() => Promise<{ access_token, sub }>`.
 */
export function createNebulaTestToken(
  options: CreateNebulaTestTokenOptions,
): () => Promise<{ access_token: string; sub: string }> {
  const {
    privateKey: privateKeyPem,
    activeKey = 'BLUE',
    activeScope,
    instanceName = activeScope,
    sub = crypto.randomUUID(),
    isAdmin = true,
    profileId,
    actor,
    ttlSeconds,
  } = options;

  return async () => {
    const privateKey = await importPrivateKey(privateKeyPem);
    const payload = buildNebulaJwtPayload({
      sub,
      instanceName,
      activeScope,
      isAdmin,
      profileId,
      actor,
      ttlSeconds,
    });
    const access_token = await signJwt(payload as any, privateKey, activeKey);
    return { access_token, sub };
  };
}
