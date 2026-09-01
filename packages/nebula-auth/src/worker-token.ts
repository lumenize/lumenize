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
  NEBULA_AUTH_PREFIX, REGISTRY_INSTANCE_NAME, PLATFORM_SCOPE, MINT_ALL_COOKIE_CAP,
  ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, MAGIC_LINK_TTL, RECOMMENDED_MIN_TTL_SECONDS,
  SIGNUP_TICKET_TTL, SIGNUP_TICKET_COOKIE, COMING_SOON_TAGS,
} from './types';
import type { ComingSoonTag, ConsumeMembership, ConsumePlan, NebulaJwtPayload, RefreshTokenKV } from './types';
import type { TicketClaimResult } from './nebula-auth-registry';
import { landingBase, homePath, SIGNUP_PATH } from './landing';

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
 * The signup ticket's cookie — `Path=/auth`, because there is no scope yet.
 *
 * Same hardening as the refresh cookie (`HttpOnly; Secure; SameSite=Strict`), so the slug screen's
 * own JavaScript cannot read it and the browser presents it only on a same-site navigation to the
 * claim. Short-lived by {@link SIGNUP_TICKET_TTL}.
 */
function signupTicketCookie(rawTicket: string): string {
  return `${SIGNUP_TICKET_COOKIE}=${rawTicket}; Path=${NEBULA_AUTH_PREFIX}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SIGNUP_TICKET_TTL}`;
}

/** The ticket cookie, expired — set once it is spent so a stale one cannot linger for the next visit. */
function expiredSignupTicketCookie(): string {
  return `${SIGNUP_TICKET_COOKIE}=; Path=${NEBULA_AUTH_PREFIX}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** The same cookie, expired — what a logout sets so the browser drops it. */
function expiredRefreshCookie(scope: string): string {
  return `refresh-token=; Path=${NEBULA_AUTH_PREFIX}/${scope}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/**
 * A failed login redirect, tier-split like the success path.
 *
 * ⚠️ The split matters most HERE. An **expired** claim link is the exact case the resumable claim
 * exists for: with the control plane at `/studio`, an unsplit error
 * branch lands a Star admin identity in the user-developer's control plane — the outcome the split
 * prevents.
 */
function redirectWithError(_env: Env, error: string, universeGalaxyStarId?: string): Response {
  const redirect = landingBase(universeGalaxyStarId);
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
export async function handleEmailMagicLink(
  request: Request, env: Env, instanceName?: string,
): Promise<Response> {
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
  // `instanceName` is absent on the scope-less row — the link then names no scope, and the prover
  // chooses among whatever memberships the address holds once the click lands them on Home.
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
  kind: 'magic-link' | 'invite',
  urlInstanceName?: string,
): Promise<Response> {
  const loginTokenHash = await hashString(rawLoginToken);

  // ── RPC 1: validate the link, prove the mailbox, learn what this address reaches. ─────────────
  const plan = await registry(env).resolveConsume(kind, loginTokenHash) as ConsumePlan | null;
  // No token resolved, so there is no server-trusted scope — fall back to the URL segment purely to
  // pick a landing surface for the error page (it grants nothing; see `landingBase`).
  if (!plan) return redirectWithError(env, 'invalid_token', urlInstanceName);

  // ── Choose which memberships get a cookie. ────────────────────────────────────────────────────
  const chosen = selectSessionsToMint(plan);

  // A proved address with nothing to enter is a new user: send them to sign up rather than to a
  // Home screen that would render empty. The ticket rides along so that screen's claim can spend
  // the proof THIS click just established instead of mailing a second link.
  if (chosen.length === 0) {
    const rawTicket = await registry(env).issueSignupTicket(plan.email);
    return new Response(null, {
      status: 302,
      headers: new Headers({ Location: SIGNUP_PATH, 'Set-Cookie': signupTicketCookie(rawTicket) }),
    });
  }

  // ── Mint N raw tokens Worker-side (only this side ever holds them), then RPC 2 records hashes. ─
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString();
  const minted = await Promise.all(chosen.map(async (m) => {
    const rawRefreshToken = generateRandomString(32);
    return { membership: m, rawRefreshToken, tokenHash: await hashString(rawRefreshToken) };
  }));
  await registry(env).recordSessions(
    minted.map((x) => ({ sub: x.membership.sub, tokenHash: x.tokenHash })), refreshExpiresAt,
  );

  // ── One 302, one Set-Cookie per membership. Different `Path`s never collide, so the browser
  // holds one session per enrolled scope — and an UNACCEPTED one mints nothing until its consent
  // modal flips it, so placing the cookie grants no access on its own.
  const headers = new Headers({ Location: landingFor(plan, chosen) });
  for (const x of minted) {
    headers.append('Set-Cookie', refreshCookie(x.membership.universeGalaxyStarId, x.rawRefreshToken));
  }
  return new Response(null, { status: 302, headers });
}

/**
 * Which of an address's memberships get a cookie on this click, in priority order.
 *
 * ⚠️ **The platform membership is NOT special-cased, and that reversal is deliberate (2026-09-01).**
 * An earlier cut excluded the `nebula-platform` cookie unless the consumed link itself named that
 * scope, to keep an unsolicited peer invite from leaving an ambient superuser cookie in a bootstrap
 * address's browser. Two things retired it. First, the carve-out and the front door were in direct
 * conflict: the scope-less login is the ONLY door now, so a superuser could see their platform row on
 * Home and never accept it — the accept endpoint authenticates by the very cookie the carve-out
 * refused to set. Second, the risk it was written against was answered by a sibling decision in the
 * same build: **a cookie is inert until its membership is accepted**, so an ambient one grants
 * nothing, and taking it up requires clicking Accept past a modal that says "Only accept if you
 * initiated this signup." The consent modal is the control; the carve-out was a second guard on a
 * mechanism that no longer needs one.
 *
 * ⚠️ **The set is capped**, because a third party can grow it: `claimStar` is open self-signup and
 * `issueInvites` is peer-reachable, so an unbounded fan-out is an unbounded `Set-Cookie` list that a
 * browser would silently start evicting — deadening a membership whose accept endpoint authenticates
 * by the very cookie the jar dropped.
 *
 * ⚠️ **The scope THIS LINK NAMED is minted first, ahead of even an accepted membership**, and that
 * ordering is load-bearing rather than a preference: it is the membership the click is *about*, and
 * it is typically the one that has never been entered — so ranking acceptance above it means an
 * address holding a capful of older memberships cannot complete a fresh claim or invite at all,
 * because the one cookie the next step needs is the one that got dropped. Accepted memberships come
 * next (a live session someone is using outranks one they have never opened), then most-recent.
 */
export function selectSessionsToMint(plan: ConsumePlan): ConsumeMembership[] {
  const eligible = plan.memberships;
  const rank = (m: ConsumeMembership) =>
    (m.universeGalaxyStarId === plan.linkScope ? 0 : 2) + (m.accepted ? 0 : 1);
  return [...eligible].sort((a, b) => rank(a) - rank(b)).slice(0, MINT_ALL_COOKIE_CAP);
}

/**
 * Where the 302 lands — decided by the link's PURPOSE, never inferred from the scope column.
 *
 * Every arrival goes to Home: a claim and an invite land there with their consent modal front and
 * center, and a bare login lands there to choose. The scope segment is what Home bootstraps its
 * session at, so it names a membership this click actually minted a cookie for.
 */
function landingFor(plan: ConsumePlan, chosen: ConsumeMembership[]): string {
  const named = chosen.find((m) => m.universeGalaxyStarId === plan.linkScope);
  return homePath((named ?? chosen[0]).universeGalaxyStarId);
}

export async function handleMagicLinkClick(request: Request, env: Env, instanceName?: string): Promise<Response> {
  const token = new URL(request.url).searchParams.get('one_time_token');
  if (!token) return errorResponse(400, 'invalid_request', 'Missing one_time_token');
  return consumeAndLogin(env, token, 'magic-link', instanceName);
}

export async function handleAcceptInvite(request: Request, env: Env, instanceName?: string): Promise<Response> {
  const token = new URL(request.url).searchParams.get('invite_token');
  if (!token) return errorResponse(400, 'invalid_request', 'Missing invite_token');
  return consumeAndLogin(env, token, 'invite', instanceName);
}

/**
 * `POST /auth/{scope}/logout-all` — end every session this ADDRESS holds, in one response.
 *
 * Credentialed by the calling scope's own path-scoped cookie, which is the only shape available:
 * cookies are `Path={prefix}/{scope}`, so a scope-less route would receive none and would have to
 * take the address from the client — precisely what must not decide whose sessions end. The sibling
 * scopes come back from the registry and each gets a `Max-Age=0` cookie at its own `Path`.
 *
 * ⚠️ **A DERIVED session must never reach here.** An impersonated client holds no refresh cookie of
 * its own, so this call would spend the ORIGINATOR's — `security.md` § *A DERIVED session MUST NOT
 * revoke…*. The client-side guard is `NebulaClient.logout()`'s `#mintedFrom` branch, which ends an
 * impersonation by teardown alone; this endpoint is unreachable from that path by construction.
 */
export async function handleLogoutAll(request: Request, env: Env): Promise<Response> {
  const refreshToken = extractCookie(request.headers.get('Cookie') || '', 'refresh-token');
  if (!refreshToken) return errorResponse(401, 'invalid_token', 'No refresh token provided');
  const tokenHash = await hashString(refreshToken);
  const record = await registry(env).getRefreshRecord(tokenHash) as RefreshTokenKV | null;
  if (!record) return errorResponse(401, 'invalid_token', 'Invalid refresh token');

  const { scopes } = await registry(env).revokeAllForAddress(record.sub) as { scopes: string[] };
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const scope of scopes) headers.append('Set-Cookie', expiredRefreshCookie(scope));
  return new Response(JSON.stringify({ scopes }), { status: 200, headers });
}

/**
 * `POST /auth/{scope}/accept-membership` — the ONE writer of acceptance, behind the consent modal.
 *
 * Credentialed by that membership's OWN path-scoped refresh cookie, which is self-carrying proof:
 * the browser only sends it to this scope's auth routes, so no cross-membership authorization rule
 * exists to get wrong. The cookie is the same one the consume placed and left inert — accepting is
 * what makes it mint.
 */
export async function handleAcceptMembership(request: Request, env: Env): Promise<Response> {
  const refreshToken = extractCookie(request.headers.get('Cookie') || '', 'refresh-token');
  if (!refreshToken) return errorResponse(401, 'invalid_token', 'No refresh token provided');
  const tokenHash = await hashString(refreshToken);
  // Resolve through the registry rather than the KV record: an UNACCEPTED session is exactly the
  // case this endpoint exists for, and the KV read path refuses those by design.
  const record = await registry(env).getRefreshRecord(tokenHash) as RefreshTokenKV | null;
  if (!record) return errorResponse(401, 'invalid_token', 'Invalid refresh token');
  const result = await registry(env).acceptMembership(record.sub) as { accepted: string[] };
  return Response.json({ accepted: result.accepted.length > 0, scope: record.universeGalaxyStarId });
}

// ── pending-membership (the consent modal's inputs, before any session exists) ────────────────────

/**
 * What the consent modal needs, for the membership this cookie names.
 *
 * ⚠️ **This exists because a refresh REFUSES an unaccepted membership**, which is exactly the
 * membership Home renders a modal for. A claim or invite 302 lands there holding one inert cookie
 * and no token, so the screen that takes consent had no way to learn what it was taking consent for.
 * Same credential and same resolution as {@link handleAcceptMembership} — the cookie is resolved to
 * ITS OWN membership through the registry, never to the scope named in the URL.
 *
 * Narrow on purpose: acceptance state, and the sender-supplied name when the membership was
 * invite-minted. Nothing about any other membership, and nothing a holder is not about to be shown.
 */
export async function handlePendingMembership(request: Request, env: Env): Promise<Response> {
  const refreshToken = extractCookie(request.headers.get('Cookie') || '', 'refresh-token');
  if (!refreshToken) return errorResponse(401, 'invalid_token', 'No refresh token provided');
  const tokenHash = await hashString(refreshToken);
  // Through the registry rather than the KV record: an UNACCEPTED session is the case this serves,
  // and the KV read path refuses those.
  const record = await registry(env).getRefreshRecord(tokenHash) as RefreshTokenKV | null;
  if (!record) return errorResponse(401, 'invalid_token', 'Invalid refresh token');
  const card = await registry(env).getMembershipCard(record.sub) as
    { universeGalaxyStarId: string; accepted: boolean; invited?: boolean; invitedByName?: string } | null;
  if (!card) return errorResponse(404, 'not_found', 'No such membership');
  return Response.json(card);
}

// ── signup (spend the ticket, claim, log in) ─────────────────────────────────────────────────────

/** What each ticket-claim refusal tells the person, kept beside the mapping that uses it. */
const SIGNUP_REFUSALS: Record<Exclude<TicketClaimResult, { ok: true }>['reason'], string> = {
  invalid_ticket: 'Signup ticket is missing or expired',
  invalid_slug: 'Invalid universe slug format',
  reserved_slug: 'That name is reserved',
  slug_taken: 'That name is already claimed',
};

/**
 * The fallback slug screen's claim: spend the signup ticket, claim the universe, mint the session.
 *
 * ⚠️ **No link is sent and no address is read from the body.** The ticket the browser presents was
 * issued minutes ago to a click on mail that reached this address, so the mailbox is already proved
 * and the registry derives the claimer from the ticket row. `slug` is the only thing the caller
 * supplies, and it is the only thing they are entitled to choose.
 *
 * The membership is minted UNACCEPTED like every other one — the Home screen's self-flavor modal is
 * what takes it up — so the cookie set here grants nothing until its holder consents.
 */
export async function handleSignupClaim(request: Request, env: Env): Promise<Response> {
  const rawTicket = extractCookie(request.headers.get('Cookie') || '', SIGNUP_TICKET_COOKIE);
  if (!rawTicket) return errorResponse(401, 'invalid_ticket', 'No signup ticket provided');

  let slug: unknown;
  try { ({ slug } = await request.json() as { slug?: unknown }); } catch { /* handled below */ }
  if (typeof slug !== 'string' || slug.length === 0) {
    return errorResponse(400, 'invalid_request', 'Missing slug');
  }

  const ticketHash = await hashString(rawTicket);
  const claimed = await registry(env).claimUniverseWithTicket(ticketHash, slug) as TicketClaimResult;
  if (!claimed.ok) {
    // The registry answers with a REASON, not a status — an HTTP code is this side's business, and
    // a thrown status would not survive the RPC hop anyway (`raw-comm.md`).
    const status = claimed.reason === 'slug_taken' ? 409
      : claimed.reason === 'invalid_ticket' ? 403
        : 400;
    return errorResponse(status, claimed.reason, SIGNUP_REFUSALS[claimed.reason]);
  }

  const rawRefreshToken = generateRandomString(32);
  await registry(env).recordSessions(
    [{ sub: claimed.sub, tokenHash: await hashString(rawRefreshToken) }],
    new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString(),
  );

  const headers = new Headers();
  headers.append('Set-Cookie', refreshCookie(claimed.universeGalaxyStarId, rawRefreshToken));
  // The ticket is spent server-side; expire the browser's copy too so a stale one cannot ride along
  // to a later visit and read as live.
  headers.append('Set-Cookie', expiredSignupTicketCookie());
  headers.set('Content-Type', 'application/json');
  return new Response(
    JSON.stringify({ scope: claimed.universeGalaxyStarId, home: homePath(claimed.universeGalaxyStarId) }),
    { status: 200, headers },
  );
}

// ── coming-soon (demand signal for an unbuilt surface) ───────────────────────────────────────────

/**
 * Record that someone reached for a surface that does not exist yet, and answer 204.
 *
 * ⚠️ **The `@lumenize/debug` write is a PLACEHOLDER, not the design.** A log line is not queryable,
 * not aggregatable, and is dropped whenever `DEBUG` is off, so this records demand only in the loose
 * sense that someone could grep for it later. The durable sink this wants is tracked in
 * `tasks/backlog.md` § *Nebula*, row *"Coming-soon demand log needs a durable sink"* — cited by name
 * because line numbers move. Until that lands, treat the counts here as anecdotes.
 *
 * ⚠️ **The tag is validated against a closed server-side set** ({@link COMING_SOON_TAGS}). This route
 * is unauthenticated, so free text would make it a log-injection faucet with unbounded cardinality;
 * an unrecognised tag is a client bug and is refused rather than written.
 */
export async function handleComingSoon(request: Request, _env: Env): Promise<Response> {
  let tag: unknown;
  try { ({ tag } = await request.json() as { tag?: unknown }); } catch { /* handled below */ }
  if (typeof tag !== 'string' || !(COMING_SOON_TAGS as readonly string[]).includes(tag)) {
    return errorResponse(400, 'invalid_request', 'Unrecognised coming-soon tag');
  }
  debug('nebula-auth.comingSoon').info('Coming-soon surface requested', { tag: tag as ComingSoonTag });
  return new Response(null, { status: 204 });
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

  // ⚠️ **An unaccepted membership's cookie mints NOTHING.** Mint-all places a cookie for every
  // membership the address holds, so a person can hold a session at a scope they have never agreed
  // to enter — an invitation from a stranger, most importantly. Refusing here is what keeps the
  // consent modal load-bearing rather than decorative: without it, a direct link to that scope's
  // surface would connect and ADR-012's accepted-membership gate would be the only thing standing.
  // The refusal is temporary by design — the accept endpoint converges this flag, and the same
  // cookie then works.
  if (!record.accepted) {
    return errorResponse(401, 'membership_not_accepted', 'This membership has not been accepted yet');
  }

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
