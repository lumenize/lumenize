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
 *  - `mint-narrower-token` (admin) → mint a scope-bounded narrower token here.
 *
 * Invites are NOT here: every invite enters mesh-side through `NebulaAuthFacade`
 * (`@lumenize/nebula-auth/facade`); only the accept-invite CLICK (session lifecycle) stays HTTP.
 *
 * The JWT is minted HERE (the Worker holds the signing keys); `email` never enters it. All bearer
 * tokens (magic-link/invite/refresh) are stored HASHED — the Worker hashes the raw refresh token and
 * passes only the hash to the registry.
 *
 * @see tasks/archive/nebula-auth-surrogate-sub.md § The seam
 */
import { debug } from '@lumenize/debug';
import { signJwt, importPrivateKey, generateRandomString, hashString } from '@lumenize/crypto';
import { buildNebulaJwtPayload } from './access-claims';
import { hasDominionOver, isAtOrAbove, parseId } from './parse-id';
import { verifyNebulaAccessToken } from './verify';
import {
  NEBULA_AUTH_PREFIX, REGISTRY_INSTANCE_NAME,
  ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, MAGIC_LINK_TTL, RECOMMENDED_MIN_TTL_SECONDS,
} from './types';
import type { NebulaJwtPayload, RefreshTokenKV } from './types';
import { landingBase } from './landing';

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

/** Path-scoped refresh cookie: `Path={prefix}/{scope}`, `Max-Age` = the FIXED refresh TTL (no slide). */
function refreshCookie(scope: string, token: string): string {
  return `refresh-token=${token}; Path=${NEBULA_AUTH_PREFIX}/${scope}; HttpOnly; Secure; SameSite=Strict; Max-Age=${REFRESH_TOKEN_TTL}`;
}

/**
 * A failed login redirect, tier-split like the success path.
 *
 * ⚠️ The split matters most HERE. An **expired** claim link is the exact case the resumable claim
 * exists for, and with `NEBULA_AUTH_REDIRECT` at `/studio` (the Galaxy collapse), an unsplit error
 * branch lands a Star admin identity in the user-developer's control plane — the outcome the split
 * prevents.
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
    scopeAdmin: boolean;
    activeScope: string;
    /** The bearer's PUBLIC profile address → the bare `profileId` claim (omitted when absent). */
    profileId?: string;
    /** RFC 8693 delegation actor pair → the `act` claim (omitted when absent). */
    actor?: { sub: string; profileId?: string };
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
    scopeAdmin: opts.scopeAdmin,
    profileId: opts.profileId,
    actor: opts.actor,
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

/** Shared consume: generate the raw refresh token, call the registry consume RPC, set cookie + redirect.
 *
 * ⚠️ Placement invariant: this request touches only the PRE-PLACED Registry singleton (+ KV) and
 * 302s to static assets — it first-touches no per-user DO. That is load-bearing because corporate
 * email scanners fetch these links and follow the redirect (why they are multi-use within TTL),
 * and a Durable Object is permanently placed near its FIRST request — so a per-user DO created
 * here would live near the scanner's datacenter, not the user, forever. Per-user placement
 * happens at WebSocket connect (per-tab Gateway instance — self-correcting) and at provisioning
 * (Turnstile-gated, real browser). If this path ever gains a per-user DO first-touch, it inherits
 * the scanner-placement problem; the known remedy is an interstitial POST-on-click form (rendering
 * scanners follow GET links but do not submit forms). */
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
  // The invite path may seed a SECOND session (the co-minted `.dev` workspace membership):
  // generate its token up-front; the registry records it only when that membership exists,
  // and the cookie is set only when the registry says it did.
  const rawDevRefreshToken = generateRandomString(32);
  const devRefreshTokenHash = consume === 'consumeInvite' ? await hashString(rawDevRefreshToken) : undefined;

  const result = await registry(env)[consume](loginTokenHash, refreshTokenHash, refreshExpiresAt, devRefreshTokenHash) as
    { sub: string; universeGalaxyStarId: string; devSession?: { universeGalaxyStarId: string } } | null;
  // No token resolved, so there is no server-trusted scope — fall back to the URL segment purely to
  // pick a landing surface for the error page (it grants nothing; see `landingBase`).
  if (!result) return redirectWithError(env, 'invalid_token', urlInstanceName);

  // Carry the scope on the redirect as a PATH segment (`/studio/{scope}`) so the landing SPA
  // auto-connects with no local state (the magic link opens a fresh tab; localStorage can't be
  // relied on). The base is tier-split off the TOKEN's scope, never the URL's.
  const redirect = landingBase(env, result.universeGalaxyStarId);
  const location = `${redirect}/${encodeURIComponent(result.universeGalaxyStarId)}`;
  const headers = new Headers({ Location: location });
  headers.append('Set-Cookie', refreshCookie(result.universeGalaxyStarId, rawRefreshToken));
  // Two cookies with DIFFERENT Path scopes never collide — the browser holds one session
  // per enrolled scope, which is exactly what the workspace preview's data plane needs.
  if (result.devSession) {
    headers.append('Set-Cookie', refreshCookie(result.devSession.universeGalaxyStarId, rawDevRefreshToken));
  }
  return new Response(null, { status: 302, headers });
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
 * `universeGalaxyStarId`, NOT the request path or body — bounding it by client input would let a
 * caller mint a token for any scope they name. `scopeAdmin` comes from the KV record.
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
  // The scope grammar is enforced HERE, at the request boundary, because `isAtOrAbove` below is
  // deliberately grammar-free — it compares two strings and knows nothing about the 1–3-segment
  // tier tree. Without this a four-segment `activeScope` would sit "beneath" the record's scope and
  // mint a token naming a scope no grammar can produce. Explicit 400 rather than a bare throw:
  // `router.ts` wraps this handler in a blanket 500.
  try { parseId(body.activeScope); }
  catch (e) { return errorResponse(400, 'invalid_request', (e as Error).message); }

  // M1: compare against the KV record's scope (server-trusted), never the client body/path.
  if (!isAtOrAbove(record.universeGalaxyStarId, body.activeScope)) {
    return errorResponse(403, 'insufficient_scope',
      `Requested scope "${body.activeScope}" is not at or below "${record.universeGalaxyStarId}"`);
  }

  const { accessToken, effectiveTtlSeconds } = await mintAccessToken(env, {
    sub: record.sub,
    universeGalaxyStarId: record.universeGalaxyStarId,
    scopeAdmin: record.scopeAdmin,
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

// ── (there is no invite handler here: every invite enters mesh-side through NebulaAuthFacade —
//     `@lumenize/nebula-auth/facade` — which owns the eligibility verdicts, the bit cap, and the
//     post-return send dispatch through `invite-entry.ts`) ─────────────────────────────────────────

// ── mint-narrower-token (admin branch) ───────────────────────────────────────────────────────────

/**
 * May `callerClaims` mint a token wearing this subject's identity? — dominion over the SUBJECT's
 * scope (`security.md` § Delegation, mint-side).
 *
 * Deliberately thin, and it exists for ONE reason: naming which scope goes in. The live
 * substitution risk is any scope reachable at the call site other than the subject's — and with a
 * scope-less route the nearest wrong argument is the CALLER's own `access.authScope`, which makes
 * the predicate reflexively true and therefore silent: a check that can never refuse, which
 * mutation testing cannot red. Taking the whole `subject` row (never a bare scope string) is what
 * forecloses writing that.
 *
 * ⚠️ Takes no `activeScope` — `activeScope` is not an authorization input here (it is confined by
 * `authScope` on every verify, so a decision on it is a decision on a derived value). Not exported:
 * `apps/nebula` has no business minting.
 */
function canMintFor(
  callerClaims: NebulaJwtPayload,
  subject: { universeGalaxyStarId: string },
): boolean {
  return hasDominionOver(callerClaims.access, subject.universeGalaxyStarId);
}

/**
 * Mint a scope-bounded narrower token for another person: `sub` = the subject, `act.sub` = the caller.
 * The `AuthorizedActor` non-admin branch is CUT (tasks/archive/nebula-auth-surrogate-sub.md) — only the ADMIN
 * branch survives. The request parameters ARE the token fields the caller is asking for
 * (`subOfNarrowerToken` is the minted `sub`; `activeScope` is its `aud` + its minted `authScope`);
 * the actor is always the caller, taken from the Bearer token, so it is never a parameter.
 *
 * **The authorization is ONE question plus one validation:**
 *
 *  - **authorize:** `¬caller.act` (the root-identity gate, below) ∧ `caller.sub ≠ subject.sub`
 *    (the self-narrow refusal) ∧ {@link canMintFor} — dominion over the SUBJECT's scope.
 *  - **mint:** `{ sub, authScope, scopeAdmin }` ← all the SUBJECT's, verbatim; `aud` ← the
 *    requested `activeScope`; `act` ← the caller.
 *
 * The old `activeScope` bounds are gone as CHECKS because they are now theorems: eligibility places
 * the subject's whole scope inside the caller's dominion, the minted `authScope` IS the subject's
 * scope, and `verify.ts` unconditionally requires `aud ⊆ authScope` — so `aud ⊆ subject ⊆ caller`
 * falls out. The one containment check that remains is the **`aud` validation** (a mirror of what
 * the token could ever verify as, answered early as a 403 instead of late as a dead token), which
 * is a validation, never an authorization. Faithfulness — the subject's own bit and scope, not the
 * caller's — is the property the use case needs: it is what puts `resolvePermission` back in the
 * decision, so an admin can actually observe the denial they came to debug (`dag-tree.ts`'s
 * scope-admin bypass would otherwise fire off the caller's bit and the denial would never happen).
 *
 * @param payload the caller's already-verified access token (the route pipeline verifies the
 *   Bearer; the route is scope-less, so every authorization decision is made HERE).
 */
export async function mintNarrowerToken(
  request: Request, env: Env, payload: NebulaJwtPayload,
): Promise<Response> {
  // Mint from a ROOT identity only (a token carrying no `act` chain) — never re-narrow. The
  // `¬caller.act` conjunct of the authorize line, a licensed mint-side presence gate under
  // `security.md` rule (1). ⚠️ The 403 message is load-bearing — `apps/nebula/src/impersonation.ts`
  // classifies terminal failures by matching /root identity/i against `error_description`, and no
  // test asserts the string, so a reword greens everywhere and breaks the client's classification.
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
  // The scope grammar is enforced HERE, at the request boundary — the ONLY parse this client-supplied
  // value gets. `isAtOrAbove` below is deliberately grammar-free (two strings, no tier tree), and the
  // mint no longer derives anything from `activeScope` that would parse it on the way past. Explicit
  // 400 rather than a bare throw: `router.ts` wraps this handler in a blanket 500.
  try { parseId(body.activeScope); }
  catch (e) { return errorResponse(400, 'invalid_request', (e as Error).message); }

  // Reject SELF-NARROWING, before the registry read. There is no second party, so `act: { sub: X }` on
  // a token whose `sub` is X records nothing: it pollutes attribution, muddies `!claims.act` (the
  // Profile owner guard), and leaves a token re-narrowable past the root-identity gate above.
  // ⚠️ The invariant is *an admin-driven session is never an owner*, NOT "the two subs are different
  // people": `#mintIdentity` keys on (email, scope), so one human legitimately holds several `sub`s.
  if (body.subOfNarrowerToken === payload.sub) {
    return errorResponse(400, 'invalid_request', 'subOfNarrowerToken must be a different sub than the caller');
  }

  // The subject lookup. ⚠️ An absent subject is NOT 404'd here — see the collapsed refusal below.
  const subjectIdentity = await registry(env).getIdentityScope(body.subOfNarrowerToken) as
    { universeGalaxyStarId: string; scopeAdmin: boolean; profileId: string } | null;

  // ── AUTHORIZE — one question, and refusal is indistinguishable from absence ─────────────────────
  // The route is scope-less, so this call is the whole verdict. A `null` subject and a subject the
  // caller may not act for get the SAME 403 with the SAME body: the lookup precedes authorization,
  // so a distinct not-found answer would make this route a `sub`-existence oracle for any
  // authenticated caller — one singleton RPC per probe. (`sub`s are unguessable randoms behind a
  // `sub`-rate-limited path, so the exposure is thin — which is why this is a collapse of two
  // responses, never a reason to reinstate a pre-lookup gate.)
  //
  // ⚠️ **ORDER MATTERS, and it is a disclosure decision.** The `aud` validation below can pass
  // while this refuses, so running it first would tell a caller who is about to be refused WHERE
  // the subject sits in the tree — across a Star boundary ADR-008 bounds visibility to. Neither
  // 403 body may name the subject's scope; this one names the caller's own and nothing else. Do
  // not hoist the validation for "fail-fast on an unverifiable token" — that is the order this
  // comment forbids.
  if (!subjectIdentity || !canMintFor(payload, subjectIdentity)) {
    return errorResponse(403, 'forbidden',
      `Caller scope "${payload.access.authScope}" does not administer this subject`);
  }

  // ── The `aud` VALIDATION — a validation, never an authorization ─────────────────────────────────
  // The requested `activeScope` becomes the token's `aud`, and `verify.ts` unconditionally refuses
  // any token whose `aud` is not inside its `authScope` — which the mint below sets to the
  // SUBJECT's scope. So an `activeScope` outside the subject's scope could only ever mint a token
  // that verifies NOWHERE; this refuses it early, as a 403 the caller can read instead of a dead
  // token they cannot. The 403 names only the caller-supplied `activeScope` (ADR-008 — never the
  // subject's scope, which is exactly what its second operand is).
  if (!isAtOrAbove(subjectIdentity.universeGalaxyStarId, body.activeScope)) {
    return errorResponse(403, 'insufficient_scope',
      `Requested scope "${body.activeScope}" is outside the subject's own scope`);
  }

  // Mint the MIRROR: `sub`, `authScope` and `scopeAdmin` are all the SUBJECT's, verbatim — never
  // the caller's, and never derived from `activeScope`, which only becomes the `aud`. The
  // `profileId` claim is the SUBJECT's — top-level `sub` and top-level `profileId` always describe
  // the same person.
  const { accessToken, effectiveTtlSeconds } = await mintAccessToken(env, {
    sub: body.subOfNarrowerToken,
    universeGalaxyStarId: subjectIdentity.universeGalaxyStarId,
    scopeAdmin: subjectIdentity.scopeAdmin,
    profileId: subjectIdentity.profileId,
    activeScope: body.activeScope,
    // The ACTOR pair — the caller. `profileId` rides alongside `sub` so a consumer never has to
    // resolve it live; it is omitted when the caller's own token carries no `profileId` claim.
    actor: { sub: payload.sub, profileId: payload.profileId },
    ttlSeconds: body.ttlSeconds as number | undefined,
  });

  debug('nebula-auth.worker.narrower.issued').info('Narrower token issued', {
    subOfNarrowerToken: body.subOfNarrowerToken, actorSub: payload.sub,
  });
  return Response.json({ access_token: accessToken, token_type: 'Bearer', expires_in: effectiveTtlSeconds });
}

export { verifyNebulaAccessToken };
