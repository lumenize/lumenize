/**
 * Worker token layer — the auth flows that used to live in the per-scope `NebulaAuth` DO, now handled
 * in the default Worker (composed via `routeNebulaAuthRequest`) over Workers KV + registry RPC:
 *
 *  - `email-magic-link` (request)  → registry creates the hashed `MagicLinks` row + sends the email.
 *  - `magic-link` / `accept-invite` (click) → Worker generates the raw refresh token, registry
 *    validates the login channel + find-and-flips the identity + writes the index (sync) then the KV
 *    record; Worker sets the refresh cookie + redirects.
 *  - `refresh-token` → **pure KV read**, then mint the JWT here. The registry is NEVER on this path.
 *  - `logout` → registry deletes the KV record + index entry.
 *  - `invite` (admin) → registry mints invitee identities + invite tokens + sends the emails.
 *  - `mint-narrower-token` (admin) → mint a scope-bounded narrower token here.
 *
 * The JWT is minted HERE (the Worker holds the signing keys); `email` never enters it. All bearer
 * tokens (magic-link/invite/refresh) are stored HASHED — the Worker hashes the raw refresh token and
 * passes only the hash to the registry.
 *
 * @see tasks/nebula-auth-surrogate-sub.md § The seam
 */
import { debug } from '@lumenize/debug';
import { signJwt, importPrivateKey, generateRandomString, hashString } from '@lumenize/crypto';
import { buildNebulaJwtPayload } from './access-claims';
import { buildAuthScopePattern, hasAdminOverScope, matchAccess, parseId } from './parse-id';
import { verifyNebulaAccessToken } from './verify';
import {
  NEBULA_AUTH_PREFIX, REGISTRY_INSTANCE_NAME,
  ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, MAGIC_LINK_TTL, RECOMMENDED_MIN_TTL_SECONDS,
} from './types';
import type { NebulaJwtPayload, RefreshTokenKV } from './types';

// ── error helpers ──────────────────────────────────────────────────────────────────────────────

function errorResponse(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function extractCookie(cookieHeader: string, name: string): string | null {
  for (const cookie of cookieHeader.split(';')) {
    const [cookieName, ...rest] = cookie.trim().split('=');
    if (cookieName === name) return rest.join('=');
  }
  return null;
}

/** Basic email format validation: non-empty local part, @, non-empty domain. */
function isValidEmail(email: string): boolean {
  const atIdx = email.indexOf('@');
  return atIdx > 0 && atIdx < email.length - 1;
}

/** The registry stub (raw Workers RPC — nebula-auth is raw-DO infrastructure). */
function registry(env: Env): any {
  return (env as any).NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
}

function redirectUrl(env: Env): string { return (env as any).NEBULA_AUTH_REDIRECT; }

/**
 * The built-app surface a **star**-tier login lands on. Hardcoded, not an env var: `/app` is where a
 * tenant's instance of the user-developer's app is served, and that is fixed by the routing scheme
 * (`run_worker_first: ["/app/*", …]`), not by deployment.
 */
const STAR_LANDING_PREFIX = '/app';

/**
 * Where a login for `universeGalaxyStarId` lands, split by TIER.
 *
 * A **star** is an end user arriving at the app they signed up for. Every other tier is a
 * user-developer arriving at their own control plane, and rides `NEBULA_AUTH_REDIRECT` — which stays
 * `/app` today and becomes `/studio` when the Galaxy collapse flips that env value. So the non-star
 * branch is not new behavior; it is the existing one, named.
 *
 * ⚠️ **Derive the tier from a SERVER-TRUSTED id.** On the success path that is the scope the consumed
 * token resolved to, never the URL's `instanceName`: `handleInstancePath` only *format*-validates that
 * segment and never cross-checks it against the token (the registry keys on `tokenHash` alone), so
 * keying off it would let a caller pick another tier's landing surface. The error path has no token to
 * resolve, so it necessarily falls back to the URL segment — which is safe there precisely because it
 * grants nothing: the response is a bare `?error=` redirect either way.
 */
function landingBase(env: Env, universeGalaxyStarId: string | undefined): string {
  let tier: string | undefined;
  if (universeGalaxyStarId) {
    try { tier = parseId(universeGalaxyStarId).tier; } catch { /* unparseable → treat as non-star */ }
  }
  return tier === 'star' ? STAR_LANDING_PREFIX : redirectUrl(env).replace(/\/$/, '');
}

/** Path-scoped refresh cookie: `Path={prefix}/{scope}`, `Max-Age` = the FIXED refresh TTL (no slide). */
function refreshCookie(scope: string, token: string): string {
  return `refresh-token=${token}; Path=${NEBULA_AUTH_PREFIX}/${scope}; HttpOnly; Secure; SameSite=Strict; Max-Age=${REFRESH_TOKEN_TTL}`;
}

/**
 * A failed login redirect, tier-split like the success path.
 *
 * ⚠️ The split matters most HERE. An **expired** claim link is the exact case the resumable claim
 * exists for, and once the collapse flips `NEBULA_AUTH_REDIRECT` to `/studio`, an unsplit error branch
 * lands a Star admin identity in the user-developer's control plane — the outcome the split prevents.
 */
function redirectWithError(env: Env, error: string, universeGalaxyStarId?: string): Response {
  const redirect = landingBase(env, universeGalaxyStarId);
  const separator = redirect.includes('?') ? '&' : '?';
  return new Response(null, { status: 302, headers: { Location: `${redirect}${separator}error=${error}` } });
}

// ── JWT mint ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Validate a caller-supplied `ttlSeconds`. Returns `{ ok: true }` when absent (use the default) or
 * acceptable, and `{ error }` naming what is wrong otherwise — callers narrow with `'error' in …`
 * and turn it into `400 invalid_request`. ⚠️ Both branches are truthy objects, so a truthiness test
 * would reject every request.
 *
 * ⚠️ **An ACCEPT-LIST over type AND range, not a rejection of the obvious bad case, and that is
 * load-bearing.** `buildNebulaJwtPayload` computes `exp: now + (ttlSeconds ?? ACCESS_TOKEN_TTL)`, so
 * a non-numeric value yields `exp: NaN` — which slips through *both* naive guards, since `NaN <= 0`
 * is `false` and `Math.min(NaN, ceiling)` is `NaN`. `signJwt` serializes with `JSON.stringify`,
 * which writes `NaN` as `null`; `verifyJwt`'s check is `if (payload.exp && payload.exp < now)`, and
 * a null `exp` is FALSY — so the token skips expiry and verifies **forever**. The client never
 * refreshes it either (`typeof exp !== 'number'`). A short access-TTL is what bounds a revoked or
 * demoted token while KV propagates (`security.md`), so an `exp`-less token deletes that bound.
 */
export function validateTtlSeconds(value: unknown): { error: string } | { ok: true } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { error: '"ttlSeconds" must be an integer' };
  }
  if (value < 1) return { error: '"ttlSeconds" must be at least 1' };
  // ⚠️ NO upper bound here — the ceiling is CLAMPED, not rejected. Asking for more than
  // `ACCESS_TOKEN_TTL` is a preference the server shortens, and `expires_in` then reports what was
  // actually minted, which is what that field means. Only shapes that could produce an unbounded or
  // absent `exp` are refusals.
  return { ok: true };
}

/**
 * The ONE clamp, so the two mint endpoints cannot diverge on the ceiling or on the advisory warn.
 * Returns the EFFECTIVE lifetime, which is what a caller reports as `expires_in` — a handler that
 * re-derived the clamp itself would be the divergence this exists to prevent.
 *
 * ⚠️ **Non-integers fall back to the default rather than being clamped**, which makes the `exp: NaN`
 * class structurally impossible here rather than merely guarded elsewhere: `Math.min(NaN, ceiling)`
 * is `NaN`, so a future third mint site that skipped {@link validateTtlSeconds} would otherwise mint
 * a token that never expires. The 400 still belongs at the request boundary — a throw from in here
 * would surface as a 500 through the router's catch — but the value that reaches the payload builder
 * is now safe on every path.
 */
function clampTtlSeconds(requested: number | undefined, context: Record<string, unknown>): number {
  const effective = Number.isInteger(requested)
    ? Math.min(requested as number, ACCESS_TOKEN_TTL)
    : ACCESS_TOKEN_TTL;
  if (effective < RECOMMENDED_MIN_TTL_SECONDS) {
    debug('nebula-auth.worker.ttl.short').warn(
      'Requested token TTL is below the recommended minimum — honoured, but read both hazards', {
        ...context,
        requestedTtlSeconds: requested,
        effectiveTtlSeconds: effective,
        recommendedMinTtlSeconds: RECOMMENDED_MIN_TTL_SECONDS,
        hazards: [
          'a TTL at or below the client refresh-ahead window (30s) is born already due, so it re-mints continuously',
          'a shorter TTL bounds the SUBJECT side only — a demoted caller is still bounded by their own token lifetime plus KV propagation',
        ],
      });
  }
  return effective;
}

/**
 * Mint a Nebula access token (the JWT). Resolves BLUE/GREEN from env and composes the shared
 * {@link buildNebulaJwtPayload} claim-builder so this Worker mint and the Node test-util mint can
 * never drift. `email` is not a claim.
 *
 * Returns the token **and its effective lifetime** — the latter because the clamp lives here and a
 * handler needs the post-clamp value for `expires_in`.
 */
export async function mintAccessToken(
  env: Env,
  opts: {
    sub: string;
    universeGalaxyStarId: string;
    isAdmin: boolean;
    activeScope: string;
    /** The bearer's PUBLIC profile address → the bare `profileId` claim (omitted when absent). */
    profileId?: string;
    /** RFC 8693 delegation actor pair → the `act` claim (omitted when absent). */
    actor?: { sub: string; profileId?: string };
    /** Override the derived pattern (the narrower mint binds to the requested scope). */
    authScopePattern?: string;
    /**
     * Requested token lifetime. Clamped to {@link ACCESS_TOKEN_TTL} (it can only ever SHORTEN) and
     * warned about below {@link RECOMMENDED_MIN_TTL_SECONDS}. Validate with
     * {@link validateTtlSeconds} at the request boundary first — see its warning about `NaN`.
     */
    ttlSeconds?: number;
  },
): Promise<{ accessToken: string; effectiveTtlSeconds: number }> {
  const activeKey = ((env as any).PRIMARY_JWT_KEY || 'BLUE') as 'BLUE' | 'GREEN';
  const privateKeyPem = activeKey === 'GREEN'
    ? (env as any).JWT_PRIVATE_KEY_GREEN
    : (env as any).JWT_PRIVATE_KEY_BLUE;
  if (!privateKeyPem) throw new Error(`JWT private key not configured for ${activeKey}`);

  const privateKey = await importPrivateKey(privateKeyPem);
  const effectiveTtlSeconds = clampTtlSeconds(opts.ttlSeconds, {
    sub: opts.sub, activeScope: opts.activeScope,
  });
  const payload = buildNebulaJwtPayload({
    sub: opts.sub,
    instanceName: opts.universeGalaxyStarId,
    activeScope: opts.activeScope,
    isAdmin: opts.isAdmin,
    profileId: opts.profileId,
    actor: opts.actor,
    authScopePattern: opts.authScopePattern,
    ttlSeconds: effectiveTtlSeconds,
  });
  return { accessToken: await signJwt(payload, privateKey, activeKey), effectiveTtlSeconds };
}

// ── email-magic-link (request) ─────────────────────────────────────────────────────────────────

/**
 * Request a login magic link. Turnstile is gated by the router. The registry inserts the hashed
 * `MagicLinks` row + sends the email (or, in test mode, returns the raw URL). **No identity is minted**
 * — the login-request path must never create membership.
 */
export async function handleEmailMagicLink(request: Request, env: Env, instanceName: string): Promise<Response> {
  let email: string;
  try {
    const body = await request.json() as { email?: string };
    email = body.email?.toLowerCase().trim() || '';
  } catch {
    return errorResponse(400, 'invalid_request', 'Invalid JSON body');
  }
  // Validate the email HERE (the Worker is the client-error gate) — the registry RPC then never throws
  // a RegistryError for it (Workers RPC drops the custom `status` prop, so RPC methods stay throw-free
  // for expected client errors; only the fetch-forwarded registry endpoints throw+catch RegistryError).
  if (!isValidEmail(email)) return errorResponse(400, 'invalid_request', 'Valid email required');

  const origin = new URL(request.url).origin;
  const result = await registry(env).requestMagicLink(email, instanceName, origin) as
    { message: string; magicLinkUrl?: string };
  return Response.json({ ...result, expires_in: MAGIC_LINK_TTL });
}

// ── magic-link / accept-invite (click) ───────────────────────────────────────────────────────────

/** Shared consume: generate the raw refresh token, call the registry consume RPC, set cookie + redirect. */
async function consumeAndLogin(
  env: Env,
  rawLoginToken: string,
  consume: 'consumeMagicLink' | 'consumeInvite',
  urlInstanceName?: string,
): Promise<Response> {
  const loginTokenHash = await hashString(rawLoginToken);
  const rawRefreshToken = generateRandomString(32);
  const refreshTokenHash = await hashString(rawRefreshToken);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString();

  const result = await registry(env)[consume](loginTokenHash, refreshTokenHash, refreshExpiresAt) as
    { sub: string; universeGalaxyStarId: string } | null;
  // No token resolved, so there is no server-trusted scope — fall back to the URL segment purely to
  // pick a landing surface for the error page (it grants nothing; see `landingBase`).
  if (!result) return redirectWithError(env, 'invalid_token', urlInstanceName);

  // Carry the scope on the redirect as a PATH segment (`/app/{scope}`) so the landing SPA auto-connects
  // with no local state (the magic link opens a fresh tab; localStorage can't be relied on). The base
  // is tier-split off the TOKEN's scope, never the URL's.
  const redirect = landingBase(env, result.universeGalaxyStarId);
  const location = `${redirect}/${encodeURIComponent(result.universeGalaxyStarId)}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Set-Cookie': refreshCookie(result.universeGalaxyStarId, rawRefreshToken),
    },
  });
}

export async function handleMagicLinkClick(request: Request, env: Env, instanceName?: string): Promise<Response> {
  const token = new URL(request.url).searchParams.get('one_time_token');
  if (!token) return errorResponse(400, 'invalid_request', 'Missing one_time_token');
  return consumeAndLogin(env, token, 'consumeMagicLink', instanceName);
}

export async function handleAcceptInvite(request: Request, env: Env, instanceName?: string): Promise<Response> {
  const token = new URL(request.url).searchParams.get('invite_token');
  if (!token) return errorResponse(400, 'invalid_request', 'Missing invite_token');
  return consumeAndLogin(env, token, 'consumeInvite', instanceName);
}

// ── refresh-token (pure KV read → mint JWT) ──────────────────────────────────────────────────────

/**
 * Exchange the refresh cookie for an access token — a **pure KV read**, no registry, no writes on the
 * hot path. ⚠️ M1: `activeScope` is validated against the KV record's server-trusted
 * `universeGalaxyStarId`, NOT the request path or body — deriving the pattern from client input would
 * let a caller mint a token for any scope they name. `isAdmin` comes from the KV record.
 */
export async function handleRefreshToken(request: Request, env: Env): Promise<Response> {
  const refreshToken = extractCookie(request.headers.get('Cookie') || '', 'refresh-token');
  if (!refreshToken) return errorResponse(401, 'invalid_token', 'No refresh token provided');

  const tokenHash = await hashString(refreshToken);
  const raw = await (env as any).REFRESH_TOKEN_KV.get(`refresh:${tokenHash}`);
  let record: RefreshTokenKV | null;
  if (raw) {
    record = JSON.parse(raw) as RefreshTokenKV;
  } else {
    // KV miss. Almost always a genuinely-invalid/revoked token — but it can also be a login→first-refresh
    // cross-colo propagation gap (KV is eventually consistent, ~edge cacheTtl). Fall back ONCE to the
    // registry's strongly-consistent index, which reconstructs + self-heals the KV record; a genuinely-
    // invalid token isn't there → still 401. Defensive: in practice the user's edge PoP usually serves
    // both the login write + the refresh read, so this rarely fires.
    record = await registry(env).getRefreshRecord(tokenHash) as RefreshTokenKV | null;
    if (!record) return errorResponse(401, 'invalid_token', 'Invalid refresh token');
  }
  // Belt-and-suspenders: KV TTL already drops expired records, but a clock-skewed edge could serve one.
  if (new Date().toISOString() > record.expiresAt) return errorResponse(401, 'token_expired', 'Refresh token expired');

  const contentType = request.headers.get('Content-Type');
  if (!contentType?.includes('application/json')) {
    return errorResponse(400, 'invalid_request', 'Content-Type must be application/json');
  }
  let body: { activeScope?: string; ttlSeconds?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return errorResponse(400, 'invalid_request', 'Invalid JSON body'); }
  if (!body.activeScope) return errorResponse(400, 'invalid_request', 'Missing required "activeScope" field');
  // ⚠️ Validate BEFORE the mint, and by accept-list — a truthiness check (the shape of the
  // `activeScope` guard above) would pass `'abc'` straight through to an `exp: NaN`, which verifies
  // forever. This endpoint is gated by the refresh cookie ALONE, so it is the reachable one.
  const ttlCheck = validateTtlSeconds(body.ttlSeconds);
  if ('error' in ttlCheck) return errorResponse(400, 'invalid_request', ttlCheck.error);

  // M1: derive the pattern from the KV record's scope (server-trusted), never the client body/path.
  const authScopePattern = buildAuthScopePattern(record.universeGalaxyStarId);
  if (!matchAccess(authScopePattern, body.activeScope)) {
    return errorResponse(403, 'insufficient_scope',
      `Requested scope "${body.activeScope}" not covered by access pattern "${authScopePattern}"`);
  }

  const { accessToken, effectiveTtlSeconds } = await mintAccessToken(env, {
    sub: record.sub,
    universeGalaxyStarId: record.universeGalaxyStarId,
    isAdmin: record.isAdmin,
    profileId: record.profileId,
    activeScope: body.activeScope,
    ttlSeconds: body.ttlSeconds as number | undefined,
  });

  // No rotation, no slide (security.md): the refresh token keeps its fixed TTL from login. We do NOT
  // re-set the cookie — refresh is a pure read.
  return Response.json({
    access_token: accessToken,
    token_type: 'Bearer',
    // The EFFECTIVE (post-clamp) lifetime, not the constant — a client that trusted a constant here
    // while the JWT carried a shorter `exp` would mis-schedule its own refresh.
    expires_in: effectiveTtlSeconds,
    sub: record.sub,
  });
}

// ── logout ───────────────────────────────────────────────────────────────────────────────────────

export async function handleLogout(request: Request, env: Env, instanceName: string): Promise<Response> {
  const refreshToken = extractCookie(request.headers.get('Cookie') || '', 'refresh-token');
  if (refreshToken) {
    const tokenHash = await hashString(refreshToken);
    try { await registry(env).revokeRefreshToken(tokenHash); }
    catch (err) {
      debug('nebula-auth.worker.logout').warn('revoke failed (continuing)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const cookiePath = `${NEBULA_AUTH_PREFIX}/${instanceName}`;
  return new Response(JSON.stringify({ message: 'Logged out' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `refresh-token=; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    },
  });
}

// ── invite (admin) ───────────────────────────────────────────────────────────────────────────────

/**
 * Issue invites into an existing scope. The router has verified the caller's JWT + scope match; the
 * registry enforces admin-over-scope and mints the invitee identities + tokens. `email` is not needed
 * from the JWT — the registry owns identity.
 */
export async function handleInvite(
  request: Request, env: Env, instanceName: string, callerClaims: NebulaJwtPayload,
): Promise<Response> {
  // ⚠️ Takes the WHOLE verified payload, not just `access`. The gate below needs only the admin bit,
  // but issuing an invite mints a membership — an authority change — so ADR-016 requires a record of
  // the full acting token, `act` chain included. Narrowing to `access` here would make that record
  // unbuildable downstream without re-verifying, and a `sub`-only record names the person acted upon
  // as the person who acted.
  const verifiedAccess = callerClaims.access;
  // Admin gate HERE (the Worker is the trusted gate): the router already verified the JWT + scope
  // match (matchAccess(pattern, instanceName)); `admin === true` completes admin-over-scope. Gating
  // here keeps the registry RPC throw-free for this expected client error (RPC drops custom Error props).
  //
  // ✅ CONFINED — but by the ROUTER, not by this line. The invariant: `router.ts` runs
  // `matchAccess(access.authScopePattern, instanceName)` before dispatching here, so by the time
  // this executes, "covers this scope" is already proven and the bare bit legitimately completes
  // the conjunction. That split is the whole reason this read is safe, and it is why this line
  // must never be copied to a site that lacks the router's check.
  // ⚠️ This gate is about to matter far more: nebula-auth-identity-mint.md Phase 1 turns
  // `issueInvites` from member-minting into ADMIN-minting, and that task's §2 requires the safety
  // not rest on a single Worker line — it adds an in-method re-assertion in `issueInvites`,
  // matching `createGalaxy`/`createStar`. Do not treat this line as sufficient after that lands.
  if (verifiedAccess.admin !== true) return errorResponse(403, 'forbidden', 'Admin access required');

  let body: { emails?: string[] };
  try { body = await request.json() as typeof body; }
  catch { return errorResponse(400, 'invalid_request', 'Invalid JSON body'); }
  if (!Array.isArray(body.emails)) return errorResponse(400, 'invalid_request', 'emails array required');

  const origin = new URL(request.url).origin;
  const result = await registry(env).issueInvites(instanceName, body.emails, origin, callerClaims);
  return Response.json(result);
}

// ── mint-narrower-token (admin branch) ───────────────────────────────────────────────────────────

/**
 * Mint a scope-bounded narrower token for another person: `sub` = the subject, `act.sub` = the caller.
 * The `AuthorizedActor` non-admin branch is CUT (tasks/nebula-auth-surrogate-sub.md) — only the ADMIN
 * branch survives. The request parameters ARE the token fields the caller is asking for
 * (`subOfNarrowerToken` is the minted `sub`; `activeScope` is its `aud` + the source of its pattern);
 * the actor is always the caller, taken from the Bearer token, so it is never a parameter.
 *
 * **Two rules, and a consequence that falls out of them** (tasks/nebula-mint-narrower-token.md):
 *
 *  1. **Eligibility** — you may only impersonate someone you already administer *entirely*:
 *     `hasAdminOverScope(caller.access, subjectIdentity.universeGalaxyStarId)`. A caller narrower than
 *     the subject in *either* scope or the `admin` bit is refused outright, and the subject must be
 *     somebody else.
 *  2. **Faithfulness** — the minted token mirrors THAT PERSON's access, not the caller's: the
 *     subject's `admin` bit, the subject's reach, bounded to the requested `activeScope`.
 *
 *  ⇒ Therefore no minted token can exceed the caller. Eligibility has already placed the subject's
 *  entire scope inside the caller's authority, so the mirror faithfulness produces can only ever be
 *  narrower than the caller's own token. **Escalation-safety is a consequence of the two rules, not a
 *  third property to maintain separately.** Faithfulness is the property the use case needs: mirroring
 *  the subject's `admin` bit is what puts `resolvePermission` back in the decision, so an admin can
 *  actually observe the denial they came to debug (`dag-tree.ts`'s scope-admin bypass would otherwise
 *  fire off the caller's bit and the denial would never happen).
 *
 * @param payload the caller's already-verified access token (router verifies the Bearer + scope).
 */
export async function mintNarrowerToken(
  request: Request, env: Env, payload: NebulaJwtPayload,
): Promise<Response> {
  // Mint from a ROOT identity only (a token carrying no `act` chain) — never re-narrow.
  if (payload.act) {
    return errorResponse(403, 'forbidden', '/mint-narrower-token requires a root identity (a token carrying no `act` chain)');
  }
  const contentType = request.headers.get('Content-Type');
  if (!contentType?.includes('application/json')) {
    return errorResponse(400, 'invalid_request', 'Content-Type must be application/json');
  }
  let body: { subOfNarrowerToken?: string; activeScope?: string; ttlSeconds?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return errorResponse(400, 'invalid_request', 'Invalid JSON body'); }
  if (!body.subOfNarrowerToken) return errorResponse(400, 'invalid_request', 'subOfNarrowerToken required');
  if (!body.activeScope) return errorResponse(400, 'invalid_request', 'Missing required "activeScope" field');
  // Accept-list, before the mint — see `validateTtlSeconds` on why a non-positive check is not enough.
  const ttlCheck = validateTtlSeconds(body.ttlSeconds);
  if ('error' in ttlCheck) return errorResponse(400, 'invalid_request', ttlCheck.error);

  // Reject SELF-NARROWING, before the registry read. There is no second party, so `act: { sub: X }` on
  // a token whose `sub` is X records nothing: it pollutes attribution, muddies `!claims.act` (the
  // Profile owner guard), and leaves a token re-narrowable past the root-identity gate above.
  // ⚠️ The invariant is *an admin-driven session is never an owner*, NOT "the two subs are different
  // people": `#mintIdentity` keys on (email, scope), so one human legitimately holds several `sub`s.
  if (body.subOfNarrowerToken === payload.sub) {
    return errorResponse(400, 'invalid_request', 'subOfNarrowerToken must be a different sub than the caller');
  }

  // activeScope must be within the CALLER's own verified reach (the escalation fix — never derive the
  // grant from the subject or the issuing scope).
  //
  // ⚠️ **This is an UPPER bound, and that is CORRECT — do not "fix" it.** It stops widening; it
  // deliberately permits NARROWING, which is the endpoint's entire purpose (the mint below binds the
  // new token to the REQUESTED scope, not the caller's — see `authScopePattern` at the mint, and the
  // test "binds the minted token to the REQUESTED scope, not the caller pattern"). Forbidding
  // narrowing would break least-privilege minting; re-checking that the minted pattern is a
  // subset of the caller's would be redundant, since narrowing already implies subset.
  //
  // Narrowing is nevertheless how the `access.admin` escalation was reachable: a `{u}.*` admin can
  // mint `aud={u}.{g}` + pattern `{u}.{g}.*` + admin, which `enforceScopeReach`'s tenant branch then
  // admits to the ANCESTOR `{u}` — where the guards used to trust the bare bit. **The defect was
  // never here; it was downstream, and it is fixed there** (`hasAdminOverScope` in `requireAdmin` /
  // `requirePermission` / the subscribe-time writers). Post-fix the narrower token is denied on the
  // ancestor and nothing is residual. See tasks/nebula-confine-admin-bypass.md § Decisions.
  //
  // ⚠️ **This gate is implied by eligibility + the scope mirror below** (together they bound
  // `activeScope` inside the subject's scope, which eligibility has already placed inside the
  // caller's). It survives for its `insufficient_scope` code and its caller-facing reach message,
  // and because it is the site that implements `security.md` rule (2)'s first invariant.
  if (!matchAccess(payload.access.authScopePattern, body.activeScope)) {
    return errorResponse(403, 'insufficient_scope',
      `Requested scope "${body.activeScope}" exceeds the caller's reach "${payload.access.authScopePattern}"`);
  }

  // The ADMIN branch is the only surviving mint path (the AuthorizedActor path is cut).
  //
  // ⚠️ **This gate is NOT the authority check** — the bare `admin` bit is never authority by itself
  // (ADR-015 §2); eligibility below is. It stays for three narrow reasons, none of them subsumable:
  //   (a) ORDERING — it fires BEFORE the registry read, so a non-admin never reaches the
  //       subject-existence check and cannot probe which `sub`s exist;
  //   (b) its `denied` log line;
  //   (c) its distinct `forbidden` code and caller-facing message.
  // Eligibility strictly subsumes this gate's *verdict*, so do not read a pass here as authority.
  if (!payload.access.admin) {
    debug('nebula-auth.worker.narrower.denied').warn('Non-admin narrower-token attempt', {
      sub: payload.sub, subOfNarrowerToken: body.subOfNarrowerToken,
    });
    return errorResponse(403, 'forbidden', 'Admin access required to mint a narrower token');
  }

  // The subject (`subOfNarrowerToken`) must be a real identity — 404 otherwise (parity + traceability).
  const subjectIdentity = await registry(env).getIdentityScope(body.subOfNarrowerToken) as
    { universeGalaxyStarId: string; isAdmin: boolean; profileId: string } | null;
  if (!subjectIdentity) return errorResponse(404, 'not_found', 'Subject not found');

  // ── (1) ELIGIBILITY — run BEFORE the scope mirror ────────────────────────────────────────────────
  // You may only impersonate someone you already administer ENTIRELY. Its uniquely load-bearing case
  // is UPWARD: caller pattern `{u}.{g}.*`, subject scope `{u}`, `activeScope = {u}.{g}` satisfies every
  // other check, and only this stops a lower admin wearing a superior's identity (ADR-015 §2).
  //
  // ⚠️ **ORDER MATTERS, and it is a disclosure decision.** A faithfulness bound can pass while
  // eligibility fails, so running the mirror first would tell a caller who is about to be refused
  // WHERE the subject sits in the tree — across a Star boundary ADR-008 bounds visibility to. Neither
  // 403 body may name the subject's scope; echo the caller's own pattern or nothing. (Subject
  // EXISTENCE is disclosed either way by the 404 above — pre-existing and unchanged.)
  if (!hasAdminOverScope(payload.access, subjectIdentity.universeGalaxyStarId)) {
    return errorResponse(403, 'forbidden',
      `Caller pattern "${payload.access.authScopePattern}" does not administer this subject`);
  }

  // ── (2) FAITHFULNESS — the scope mirror ──────────────────────────────────────────────────────────
  // `activeScope` must also sit within the SUBJECT's own reach, so the token is a mirror of that
  // person rather than merely something inside the caller's authority. Without it, a subject scoped at
  // `{u}.{g}.{s1}` would get a token admin over all of `{u}.{g}` — not an escalation (eligibility
  // already bounded it), but not that person's access either, which is the property the use case needs.
  const subjectPattern = buildAuthScopePattern(subjectIdentity.universeGalaxyStarId);
  if (!matchAccess(subjectPattern, body.activeScope)) {
    return errorResponse(403, 'insufficient_scope',
      `Requested scope "${body.activeScope}" is outside the subject's own reach`);
  }

  // Bind the minted token to the REQUESTED scope, mirroring the SUBJECT's `admin` bit.
  //
  // ⚠️ `caller.admin && subject.isAdmin` is an INTERSECTION, never either side's copy. Under
  // eligibility the conjunction EQUALS the subject's bit, so the `&&` is belt-and-braces against a
  // future caller reaching this line without eligibility having run (`security.md` rule (2) forbids
  // copying the subject's bit alone, because a bare copy can exceed the caller). The `profileId` claim
  // is the SUBJECT's — top-level `sub` and top-level `profileId` always describe the same person.
  const { accessToken, effectiveTtlSeconds } = await mintAccessToken(env, {
    sub: body.subOfNarrowerToken,
    universeGalaxyStarId: body.activeScope,
    isAdmin: payload.access.admin === true && subjectIdentity.isAdmin,
    profileId: subjectIdentity.profileId,
    activeScope: body.activeScope,
    // The ACTOR pair — the caller. `profileId` rides alongside `sub` so a consumer never has to
    // resolve it live; it is omitted when the caller's own token carries no `profileId` claim.
    actor: { sub: payload.sub, profileId: payload.profileId },
    authScopePattern: buildAuthScopePattern(body.activeScope),
    ttlSeconds: body.ttlSeconds as number | undefined,
  });

  debug('nebula-auth.worker.narrower.issued').info('Narrower token issued', {
    subOfNarrowerToken: body.subOfNarrowerToken, actorSub: payload.sub,
  });
  return Response.json({ access_token: accessToken, token_type: 'Bearer', expires_in: effectiveTtlSeconds });
}

export { verifyNebulaAccessToken };
