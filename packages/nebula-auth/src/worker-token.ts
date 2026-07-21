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
 *  - `delegated-token` (admin) → mint a scope-bounded delegated token here.
 *
 * The JWT is minted HERE (the Worker holds the signing keys); `email` never enters it. All bearer
 * tokens (magic-link/invite/refresh) are stored HASHED — the Worker hashes the raw refresh token and
 * passes only the hash to the registry.
 *
 * @see tasks/nebula-auth-surrogate-sub.md § The seam
 */
import { debug } from '@lumenize/debug';
import {
  signJwt,
  importPrivateKey,
  generateRandomString,
  hashString,
} from '@lumenize/auth';
import { buildNebulaJwtPayload } from './access-claims';
import { buildAuthScopePattern, matchAccess } from './parse-id';
import { verifyNebulaAccessToken } from './verify';
import {
  NEBULA_AUTH_PREFIX, REGISTRY_INSTANCE_NAME,
  ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, MAGIC_LINK_TTL,
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

/** Path-scoped refresh cookie: `Path={prefix}/{scope}`, `Max-Age` = the FIXED refresh TTL (no slide). */
function refreshCookie(scope: string, token: string): string {
  return `refresh-token=${token}; Path=${NEBULA_AUTH_PREFIX}/${scope}; HttpOnly; Secure; SameSite=Strict; Max-Age=${REFRESH_TOKEN_TTL}`;
}

function redirectWithError(env: Env, error: string): Response {
  const redirect = redirectUrl(env);
  const separator = redirect.includes('?') ? '&' : '?';
  return new Response(null, { status: 302, headers: { Location: `${redirect}${separator}error=${error}` } });
}

// ── JWT mint ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Mint a Nebula access token (the JWT). Resolves BLUE/GREEN from env and composes the shared
 * {@link buildNebulaJwtPayload} claim-builder so this Worker mint and the Node test-util mint can
 * never drift. `email` is not a claim.
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
    actorSub?: string;
    /** Override the derived pattern (delegated mint binds to the caller's covered scope). */
    authScopePattern?: string;
  },
): Promise<string> {
  const activeKey = ((env as any).PRIMARY_JWT_KEY || 'BLUE') as 'BLUE' | 'GREEN';
  const privateKeyPem = activeKey === 'GREEN'
    ? (env as any).JWT_PRIVATE_KEY_GREEN
    : (env as any).JWT_PRIVATE_KEY_BLUE;
  if (!privateKeyPem) throw new Error(`JWT private key not configured for ${activeKey}`);

  const privateKey = await importPrivateKey(privateKeyPem);
  const payload = buildNebulaJwtPayload({
    sub: opts.sub,
    instanceName: opts.universeGalaxyStarId,
    activeScope: opts.activeScope,
    isAdmin: opts.isAdmin,
    profileId: opts.profileId,
    actorSub: opts.actorSub,
    authScopePattern: opts.authScopePattern,
  });
  return signJwt(payload as any, privateKey, activeKey);
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
): Promise<Response> {
  const loginTokenHash = await hashString(rawLoginToken);
  const rawRefreshToken = generateRandomString(32);
  const refreshTokenHash = await hashString(rawRefreshToken);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString();

  const result = await registry(env)[consume](loginTokenHash, refreshTokenHash, refreshExpiresAt) as
    { sub: string; universeGalaxyStarId: string } | null;
  if (!result) return redirectWithError(env, 'invalid_token');

  // Carry the scope on the redirect as a PATH segment (`/app/{scope}`) so the landing SPA auto-connects
  // with no local state (the magic link opens a fresh tab; localStorage can't be relied on).
  const redirect = redirectUrl(env).replace(/\/$/, '');
  const location = `${redirect}/${encodeURIComponent(result.universeGalaxyStarId)}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Set-Cookie': refreshCookie(result.universeGalaxyStarId, rawRefreshToken),
    },
  });
}

export async function handleMagicLinkClick(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get('one_time_token');
  if (!token) return errorResponse(400, 'invalid_request', 'Missing one_time_token');
  return consumeAndLogin(env, token, 'consumeMagicLink');
}

export async function handleAcceptInvite(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get('invite_token');
  if (!token) return errorResponse(400, 'invalid_request', 'Missing invite_token');
  return consumeAndLogin(env, token, 'consumeInvite');
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
  let body: { activeScope?: string };
  try { body = await request.json() as typeof body; }
  catch { return errorResponse(400, 'invalid_request', 'Invalid JSON body'); }
  if (!body.activeScope) return errorResponse(400, 'invalid_request', 'Missing required "activeScope" field');

  // M1: derive the pattern from the KV record's scope (server-trusted), never the client body/path.
  const authScopePattern = buildAuthScopePattern(record.universeGalaxyStarId);
  if (!matchAccess(authScopePattern, body.activeScope)) {
    return errorResponse(403, 'insufficient_scope',
      `Requested scope "${body.activeScope}" not covered by access pattern "${authScopePattern}"`);
  }

  const accessToken = await mintAccessToken(env, {
    sub: record.sub,
    universeGalaxyStarId: record.universeGalaxyStarId,
    isAdmin: record.isAdmin,
    profileId: record.profileId,
    activeScope: body.activeScope,
  });

  // No rotation, no slide (security.md): the refresh token keeps its fixed TTL from login. We do NOT
  // re-set the cookie — refresh is a pure read.
  return Response.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL,
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
  request: Request, env: Env, instanceName: string, verifiedAccess: NebulaJwtPayload['access'],
): Promise<Response> {
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
  const result = await registry(env).issueInvites(instanceName, body.emails, origin);
  return Response.json(result);
}

// ── delegated-token (admin branch) ───────────────────────────────────────────────────────────────

/**
 * Mint a scope-bounded delegated (act-for) token. The `AuthorizedActor` non-admin branch is CUT
 * (tasks/nebula-auth-surrogate-sub.md) — only the ADMIN branch survives: a root-identity admin caller
 * mints a token for `actFor`, bound to the CALLER's covered scope + the CALLER's admin bit (never the
 * target's `isAdmin` nor the issuing scope's pattern — security.md § Delegation, mint-side).
 *
 * @param payload the caller's already-verified access token (router verifies the Bearer + scope).
 */
export async function handleDelegatedToken(
  request: Request, env: Env, payload: NebulaJwtPayload,
): Promise<Response> {
  // Delegate from a ROOT identity only (a token carrying no `act` chain) — never re-delegate.
  if (payload.act) {
    return errorResponse(403, 'forbidden', '/delegated-token requires a root identity (a token carrying no `act` chain)');
  }
  const contentType = request.headers.get('Content-Type');
  if (!contentType?.includes('application/json')) {
    return errorResponse(400, 'invalid_request', 'Content-Type must be application/json');
  }
  let body: { actFor?: string; activeScope?: string };
  try { body = await request.json() as typeof body; }
  catch { return errorResponse(400, 'invalid_request', 'Invalid JSON body'); }
  if (!body.actFor) return errorResponse(400, 'invalid_request', 'actFor required');
  if (!body.activeScope) return errorResponse(400, 'invalid_request', 'Missing required "activeScope" field');

  // activeScope must be within the CALLER's own verified reach (the escalation fix — never derive the
  // grant from the acted-for target or the issuing scope).
  if (!matchAccess(payload.access.authScopePattern, body.activeScope)) {
    return errorResponse(403, 'insufficient_scope',
      `Requested scope "${body.activeScope}" exceeds the caller's reach "${payload.access.authScopePattern}"`);
  }

  // The ADMIN branch is the only surviving delegation path (the AuthorizedActor path is cut).
  if (!payload.access.admin) {
    debug('nebula-auth.worker.delegated.denied').warn('Non-admin delegation attempt', {
      sub: payload.sub, targetSub: body.actFor,
    });
    return errorResponse(403, 'forbidden', 'Not authorized to act for this subject');
  }

  // The principal (actFor) must be a real identity — 404 otherwise (parity + traceability).
  const principal = await registry(env).getIdentityScope(body.actFor) as
    { universeGalaxyStarId: string; isAdmin: boolean; profileId: string } | null;
  if (!principal) return errorResponse(404, 'not_found', 'Subject not found');

  // Bind the minted token to the CALLER's covered scope + the CALLER's admin bit. The `profileId` claim
  // is the acted-for TARGET's (the token acts AS them — owner-authz on their own profile is correct).
  const accessToken = await mintAccessToken(env, {
    sub: body.actFor,
    universeGalaxyStarId: body.activeScope,
    isAdmin: payload.access.admin === true,
    profileId: principal.profileId,
    activeScope: body.activeScope,
    actorSub: payload.sub,
    authScopePattern: buildAuthScopePattern(body.activeScope),
  });

  debug('nebula-auth.worker.delegated.issued').info('Delegated token issued', {
    targetSub: body.actFor, actorSub: payload.sub,
  });
  return Response.json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL });
}

export { verifyNebulaAccessToken };
