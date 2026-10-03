/**
 * Worker token layer — the session lifecycle, on the platform host, over Workers KV + registry RPC
 * (composed via `routeNebulaAuthRequest`):
 *
 *  - `email-magic-link` (request) → registry creates the hashed `MagicLinks` row + sends the email.
 *  - `magic-link/lookup` and `magic-link` (the link's page) → a lookup that writes nothing, then the
 *    page's `POST`, which proves the mailbox, records the sessions, sets one refresh cookie per
 *    membership and accepts the link's pending membership through the one acceptance helper.
 *  - `refresh-token` → the one route a page on a scope host calls: `Origin` names the host's scope,
 *    the cookies at or above it are read broadest first, and the JWT is minted here.
 *  - `home-summary`, `pending-membership`, `accept-membership` → Home, by cookie.
 *  - `logout` → expires every refresh cookie the request carries and revokes the records behind them.
 *  - impersonation → {@link mintImpersonationToken}, reached from `NebulaAuthFacade.impersonate`.
 *
 * Invites are NOT here: every invite enters mesh-side through `NebulaAuthFacade`
 * (`@lumenize/nebula-auth/facade`); the invite's link is a magic link like any other.
 *
 * The JWT is minted HERE (the Worker holds the signing keys); `email` never enters it. All bearer
 * tokens (magic-link and refresh) are stored HASHED — the Worker hashes the raw refresh token and
 * passes only the hash to the registry.
 */
import { debug } from '@lumenize/debug';
import { signJwt, importPrivateKey, generateRandomString, hashString } from '@lumenize/crypto';
import { buildNebulaJwtPayload, projectActingToken } from './access-claims';
import { hasDominionOver, isAtOrAbove, isPlatformScope, parseId } from './parse-id';
import { verifyNebulaAccessToken } from './verify';
import {
  NEBULA_AUTH_PREFIX, REGISTRY_INSTANCE_NAME, MINT_ALL_COOKIE_CAP,
  ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL, MAGIC_LINK_TTL, RECOMMENDED_MIN_TTL_SECONDS,
  SIGNUP_TICKET_TTL, SIGNUP_TICKET_COOKIE, COMING_SOON_TAGS, kvTtlSeconds, sameRefreshRecord,
} from './types';
import type {
  AcceptanceCredential, AcceptanceOutcome, ComingSoonTag, ConsumeMembership, ConsumePlan, LinkLookup,
  NebulaJwtPayload, RefreshPut, RefreshTokenKV, ScopeLifecycleHooks,
} from './types';
import type { NebulaAuthRegistry, TicketClaimResult } from './nebula-auth-registry';
import { checkedReturnTo, deploymentOrigin, parseHost, personaId, platformOrigin } from './hosts';
import type { HostTarget } from './hosts';
import { rawRpcStub } from '@lumenize/mesh/raw-rpc';

// ── error helpers ──────────────────────────────────────────────────────────────────────────────

function errorResponse(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
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

/**
 * The two identity reads, typed against the Registry class itself. `registry(env)` is `any`, so a
 * hand-written cast at the call site is all the compiler ever sees — and a cast cannot fail: rename
 * `profileId` on the returned row and the read is `undefined`, which is falsy and errors nowhere.
 * Naming the methods on the class puts a rename back in front of `tsc`, on the one method whose
 * acceptance conjunct decides whether the mint refuses.
 *
 * `getIdentityScope` is the ACCEPTED-only read and the mint's; `getIdentityScopeIncludingPending`
 * resolves a membership still pending, which is what the consent screen's name prefill reads. Both are
 * synchronous on the class and arrive as promises over RPC, which `await` resolves either way.
 */
function identityReads(env: Env):
  Pick<NebulaAuthRegistry, 'getIdentityScope' | 'getIdentityScopeIncludingPending'> {
  return registry(env);
}

/**
 * This person's Profile, through the `@rawRpc()` bridge (ADR-023), resolved from a `sub` the caller
 * has ALREADY verified. The trust model for what may be called on it is stated on
 * `Profile.readDisplayNames`. `null` when the `sub` resolves to no identity.
 *
 * The PENDING-aware read, because the consent screen's name prefill runs before anyone has accepted —
 * a membership still pending is exactly the one it is asking about. Its sibling caller, the accept
 * handler's name write, runs just after the flip and resolves either way.
 *
 * ⚠️ **Both callers are best-effort BY DESIGN, and that is about the CALL failing, not the binding
 * being absent**: every Worker that runs these routes binds `PROFILE`. The consent pre-fill degrades
 * to an empty field, and a failed write degrades to `participantName`'s "Someone". Neither may take
 * down acceptance — being unable to store a display name is not a reason to refuse somebody entry
 * to the account they were invited to.
 */
async function profileForSub(env: Env, sub: string) {
  const identity = await identityReads(env).getIdentityScopeIncludingPending(sub);
  return identity?.profileId ? rawRpcStub('PROFILE', identity.profileId) : null;
}

/**
 * Put each refresh record in Workers KV, then reap any the Registry no longer stands behind.
 *
 * The Worker writes because it is where the person is: KV is read-your-writes at the colo that
 * wrote, and the next read is that person's refresh. The Registry indexed each hash before it
 * answered, so a put never precedes its row. After each put, the Registry's current record for the
 * hash is read back; if the row is gone, or any value differs, the put is deleted, so a revoke or a
 * `setIdentityAdmin` landing between the Registry's answer and the put cannot leave a live record
 * nobody indexes. A reap logs `orphan-reaped` with the `sub` it put. There is no acting token: the
 * reap rolls back only its own request's write, and the revoke recorded its own principal.
 *
 * Returns the record each hash now stands for — the put's when it survived, else the Registry's
 * current one or `null` — so a caller that mints from it never mints from a reaped write.
 */
async function putRefreshRecords(env: Env, puts: RefreshPut[]): Promise<Array<RefreshTokenKV | null>> {
  const kv = (env as any).REFRESH_TOKEN_KV as KVNamespace;
  return Promise.all(puts.map(async ({ tokenHash, record }) => {
    await kv.put(`refresh:${tokenHash}`, JSON.stringify(record), { expirationTtl: kvTtlSeconds(record.expiresAt) });
    const current = await registry(env).getRefreshRecord(tokenHash) as RefreshTokenKV | null;
    if (sameRefreshRecord(current, record)) return record;
    await kv.delete(`refresh:${tokenHash}`);
    debug('nebula-auth.worker.token').warn('orphan-reaped', { sub: record.sub });
    return current;
  }));
}

/** Longest display name we store. A handle, not prose — the cap is what stops a byline becoming one. */
const DISPLAY_NAME_MAX = 64;

/**
 * Trim and bound a submitted display name; `undefined` for anything not worth storing.
 *
 * ⚠️ **The nickname is optional on the wire and required in the UI, and that asymmetry is
 * deliberate.** The consent screen will not enable Accept without one, which is where the
 * requirement belongs — a person is being asked how they wish to appear. Making it a 400 here would
 * instead break every programmatic accepter (the harness, personas, the test helpers) to re-state a
 * rule the screen already enforces, and an identity that somehow arrives without one degrades to the
 * existing "Someone" fallback rather than to a broken account. The full `name` is optional in BOTH
 * places — it has no display surface of its own yet.
 */
function normalizeDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().slice(0, DISPLAY_NAME_MAX);
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The whole JSON body, or `{}` when it is absent, empty, or not JSON at all. */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return ((await request.json()) as Record<string, unknown> | null) ?? {};
  } catch {
    return {};
  }
}

/** Every refresh cookie's name: the prefix, then the membership's scope — `__Host-refresh-token.acme.crm`. */
export const REFRESH_COOKIE_PREFIX = '__Host-refresh-token.';

/**
 * A refresh cookie on the platform host, one per membership (ADR-022 § *The cookie rules*). `__Host-`
 * keeps it to `Secure`, `Path=/` and no `Domain`, so no other host can plant or overwrite it, and
 * `SameSite=Lax` lets a person arriving from an email or another site be recognised. `Max-Age` is the
 * FIXED refresh TTL; nothing slides it.
 */
function refreshCookie(scope: string, token: string): string {
  return `${REFRESH_COOKIE_PREFIX}${scope}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${REFRESH_TOKEN_TTL}`;
}

/** The same cookie, expired. The attributes are the set-side ones: a browser discards a `__Host-`
 *  header without `Secure`, so an expiry without it would expire nothing. */
function expiredRefreshCookie(scope: string): string {
  return `${REFRESH_COOKIE_PREFIX}${scope}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * The signup ticket's cookie, short-lived by {@link SIGNUP_TICKET_TTL}. `HttpOnly` and `Strict`: the
 * signup page's own script cannot read it, and the browser presents it only to the claim on this host.
 */
function signupTicketCookie(rawTicket: string): string {
  return `${SIGNUP_TICKET_COOKIE}=${rawTicket}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SIGNUP_TICKET_TTL}`;
}

/** The ticket cookie, expired — set once it is spent so a stale one cannot linger for the next visit. */
function expiredSignupTicketCookie(): string {
  return `${SIGNUP_TICKET_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** Every cookie in a `Cookie` header, as name and value. */
function cookiesOf(cookieHeader: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const cookie of cookieHeader.split(';')) {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) out.push({ name, value: rest.join('=') });
  }
  return out;
}

/**
 * The refresh cookies a request carries whose names parse as a scope, the platform root included,
 * broadest first. A name that parses as no scope is dropped unread. The name only NOMINATES: a
 * browser never sends a cookie whose record disagrees with its name, since the consume names each
 * from its record, but a client that is not a browser can send any `Cookie` header, so every reader
 * checks the record's own scope against the name before it trusts either.
 */
export function refreshCookies(cookieHeader: string): Array<{ scope: string; token: string }> {
  const out: Array<{ scope: string; token: string }> = [];
  for (const { name, value } of cookiesOf(cookieHeader)) {
    if (!name.startsWith(REFRESH_COOKIE_PREFIX) || !value) continue;
    const scope = name.slice(REFRESH_COOKIE_PREFIX.length);
    if (!isPlatformScope(scope)) {
      try { parseId(scope); } catch { continue; }
    }
    out.push({ scope, token: value });
  }
  const depth = (s: string) => (isPlatformScope(s) ? 0 : s.split('.').length);
  return out.sort((a, b) => depth(a.scope) - depth(b.scope));
}

/** Where a person with nowhere else to go lands: Home, at the platform host's root. */
export const HOME_PATH = '/';

/** Where a proved address with no memberships lands: the signup page, on the platform host. */
export const SIGNUP_PATH = `${NEBULA_AUTH_PREFIX}/signup`;

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
    /** The bearer's PUBLIC profile address → the bare `profileId` claim. */
    profileId: string;
    /** RFC 8693 delegation actor pair → the `act` claim (omitted when absent). */
    actor?: { sub: string; profileId: string };
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
    issuer: platformOrigin(deploymentOrigin(env)),
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
 *
 * `return_to` is checked here, where it is stored, and never only in the login page: it must carry
 * the deployment's scheme and name a host the parse turns into a scope or the platform host, or the
 * request is refused with 400 and no record is written. The consume sends the person there.
 */
export async function handleEmailMagicLink(request: Request, env: Env): Promise<Response> {
  let email: string;
  let rawReturnTo: unknown;
  try {
    const body = await request.json() as { email?: string; return_to?: unknown };
    email = body.email?.toLowerCase().trim() || '';
    rawReturnTo = body.return_to;
  } catch {
    return errorResponse(400, 'invalid_request', 'Invalid JSON body');
  }
  // Validate the email HERE — a check that needs no registry data, so a malformed address never costs
  // the singleton a hop (ADR-018), and the registry RPC has no refusal to return for it.
  if (!isValidEmail(email)) return errorResponse(400, 'invalid_request', 'Valid email required');
  let returnTo: string | undefined;
  if (rawReturnTo !== undefined && rawReturnTo !== null && rawReturnTo !== '') {
    returnTo = checkedReturnTo(rawReturnTo, deploymentOrigin(env)) ?? undefined;
    if (!returnTo) return errorResponse(400, 'invalid_return_to', 'return_to must name a page on this site');
  }

  const origin = new URL(request.url).origin;
  // The link names no scope. The prover chooses among whatever memberships the address holds once
  // the link's page lands them on Home, or follows `return_to`.
  const result = await registry(env).requestMagicLink(email, origin, returnTo) as
    { message: string; magicLinkUrl?: string };
  return Response.json({ ...result, expires_in: MAGIC_LINK_TTL });
}

// ── the link page: a lookup that writes nothing, and a POST that consumes ──────────────────────────

/**
 * `POST /auth/magic-link/lookup` — what a link's page shows before anything is consumed: the address,
 * whether the link was used, and for a pending membership at the link's scope its card and the
 * display names to pre-fill. Writes no Registry state, so a scanner or a page's own script loading the
 * link proves nothing. Names are read only for an address that already holds an accepted membership,
 * so a lookup never creates a new invitee's Profile near whoever loaded the page.
 */
export async function handleMagicLinkLookup(request: Request, env: Env): Promise<Response> {
  const { token } = await readJsonBody(request);
  if (typeof token !== 'string' || token.length === 0) return errorResponse(400, 'invalid_request', 'Missing token');
  const lookup = await registry(env).lookupLink(await hashString(token)) as LinkLookup | null;
  if (!lookup) return errorResponse(400, 'invalid_token', 'This link is invalid or has expired');
  // Logged after the Registry answered, so a line the lookup caused there precedes this one.
  debug('nebula-auth.worker.lookup').debug('looked up', { email: lookup.email, spent: lookup.spent });
  let names: { nickname?: string; name?: string } = {};
  if (lookup.acceptedSub) {
    try {
      names = (await (await profileForSub(env, lookup.acceptedSub))?.readDisplayNames() ?? {}) as typeof names;
    } catch (e) {
      // Best-effort (see `profileForSub`) — empty fields are a worse consent screen, not a broken one.
      debug('nebula-auth.worker.lookup').warn('display-name read failed (continuing)', {
        email: lookup.email, error: (e as Error).message,
      });
    }
  }
  return Response.json({
    email: lookup.email,
    spent: lookup.spent,
    ...(lookup.pending ? {
      pending: {
        scope: lookup.pending.scope, invited: lookup.pending.invited,
        ...(lookup.pending.invitedByName ? { invitedByName: lookup.pending.invitedByName } : {}),
      },
    } : {}),
    ...(names.nickname ? { nickname: names.nickname } : {}),
    ...(names.name ? { name: names.name } : {}),
  });
}

/** The page's answer when a link was already used, by its page's `POST` or a replay. */
const LINK_USED = 'This link was already used. Sign in again for a new one.';

/**
 * `POST /auth/magic-link` — the link page's Continue, or its consent screen's Accept. Consumes the
 * link: proves the mailbox, sets one refresh cookie per membership, accepts the pending membership at
 * the link's scope through the one acceptance helper, and answers where to go, `return_to` or Home.
 *
 * The link is spent once the sessions are recorded, whatever the acceptance then answers, so a
 * failure before that leaves it live for a retry, and a refused Accept leaves nothing to replay. A
 * spent link is refused here as well as on the page, since a token from browser history or a
 * forwarded mail can be posted without the page. An Accept the cap refuses still sets the cookies a
 * consume sets and answers 403 with the cap's message, leaving the membership pending.
 *
 * Placement: this request is the person's own, from the page their browser rendered, so the first
 * touch of anything it reaches — the Profile behind a display-name write, the scopes a claim's first
 * acceptance wipes — comes from them rather than from a scanner that fetched the link.
 */
export async function handleMagicLinkConsume(
  request: Request, env: Env, hooks: ScopeLifecycleHooks,
): Promise<Response> {
  const body = await readJsonBody(request);
  const token = body.token;
  if (typeof token !== 'string' || token.length === 0) return errorResponse(400, 'invalid_request', 'Missing token');
  const tokenHash = await hashString(token);
  const operationId = crypto.randomUUID();

  const consumed = await registry(env).consumeLink(tokenHash) as ({ spent: false } & ConsumePlan) | { spent: true } | null;
  if (!consumed) return errorResponse(400, 'invalid_token', 'This link is invalid or has expired');
  if (consumed.spent) return errorResponse(409, 'link_used', LINK_USED);
  const plan = consumed;

  const chosen = selectSessionsToMint(plan);

  // A proved address with nothing to enter is a new user: send them to sign up rather than to a Home
  // screen that would render empty. The ticket rides along so that screen's claim can spend the proof
  // THIS click just established instead of mailing a second link; the link is spent with it.
  if (chosen.length === 0) {
    const rawTicket = await registry(env).issueSignupTicket(plan.email, tokenHash);
    return new Response(JSON.stringify({ redirect: SIGNUP_PATH }), {
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json', 'Set-Cookie': signupTicketCookie(rawTicket) }),
    });
  }

  // Mint N raw tokens Worker-side (only this side ever holds them), record their hashes, spend the link.
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString();
  const minted = await Promise.all(chosen.map(async (m) => {
    const rawRefreshToken = generateRandomString(32);
    return { membership: m, rawRefreshToken, tokenHash: await hashString(rawRefreshToken) };
  }));
  const puts = await registry(env).recordSessions(
    minted.map((x) => ({ sub: x.membership.sub, tokenHash: x.tokenHash })), refreshExpiresAt,
    operationId, tokenHash,
  ) as RefreshPut[];
  await putRefreshRecords(env, puts);

  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const x of minted) {
    headers.append('Set-Cookie', refreshCookie(x.membership.universeGalaxyStarId, x.rawRefreshToken));
  }

  // The link's own pending membership is the one its page offered to accept.
  const pending = plan.linkScope === undefined ? undefined
    : plan.memberships.find((m) => m.universeGalaxyStarId === plan.linkScope && !m.accepted);
  if (pending) {
    const outcome = await settleAcceptance(env, hooks, pending.sub, 'link', body);
    if (outcome.outcome === 'refused') {
      return new Response(JSON.stringify({ error: outcome.reason, error_description: outcome.message }), {
        status: 403, headers,
      });
    }
  }
  return new Response(JSON.stringify({ redirect: plan.returnTo ?? HOME_PATH }), { status: 200, headers });
}

/**
 * Which of an address's memberships get a cookie on this click, in priority order.
 *
 * ⚠️ **The platform membership is NOT special-cased, and that reversal is deliberate (2026-09-01).**
 * A cookie is inert until its membership is accepted, so an ambient one grants nothing, and taking it
 * up requires an Accept past a screen that says "Only accept if you initiated this signup." The
 * consent screen is the control.
 *
 * ⚠️ **The set is capped**, because a third party can grow it: `claimStar` is open self-signup and
 * `issueInvites` is peer-reachable, so an unbounded fan-out is an unbounded `Set-Cookie` list that a
 * browser would silently start evicting — deadening a membership whose accept endpoint authenticates
 * by the very cookie the jar dropped.
 *
 * ⚠️ **The scope THIS LINK NAMED is minted first, ahead of even an accepted membership**: it is the
 * membership the click is *about*, typically never entered, so ranking acceptance above it would let
 * an address holding a capful of older memberships never complete a fresh claim or invite. Accepted
 * memberships come next (a live session someone is using outranks one never opened), then most-recent.
 */
export function selectSessionsToMint(plan: ConsumePlan): ConsumeMembership[] {
  const eligible = plan.memberships;
  const rank = (m: ConsumeMembership) =>
    (m.universeGalaxyStarId === plan.linkScope ? 0 : 2) + (m.accepted ? 0 : 1);
  return [...eligible].sort((a, b) => rank(a) - rank(b)).slice(0, MINT_ALL_COOKIE_CAP);
}

// ── certificates: wake, then reap ───────────────────────────────────────────────────────────────

/**
 * Wake each galaxy's certificate order, then re-read its `Scopes` row and tear it down again if a
 * deletion landed in between. Without the re-read, a deletion between the Registry's answer and the
 * wake would leave a fresh Galaxy, its tearing-down flag lost with the abort, ordering a pack for a
 * galaxy with no row, outside the owner cap and past every later teardown. It is the write-then-reap
 * shape the refresh records use, at one indexed Registry read per wake. The create and both
 * acceptance writers call it. Never rejects, like the hooks it calls: by the time it runs the create
 * or acceptance has landed, so a re-read that fails is logged at error, naming the galaxy, and the
 * caller answers as it would have.
 */
export async function wakeCertificates(
  registryStub: { checkSlugAvailable(id: string): unknown },
  hooks: ScopeLifecycleHooks, galaxies: readonly string[], operationId: string,
): Promise<void> {
  for (const galaxy of galaxies) {
    await hooks.orderCertificate(galaxy, operationId);
    let deleted: unknown;
    try {
      deleted = await registryStub.checkSlugAvailable(galaxy);
    } catch (e) {
      debug('nebula-auth.certificate').error('could not re-read a woken galaxy; not reaped', { galaxy, operationId, error: (e as Error).message });
      continue;
    }
    if (deleted) {
      debug('nebula-auth.certificate').warn('woken galaxy was deleted meanwhile; tearing it down again', { galaxy, operationId });
      await hooks.teardown([{ instanceName: galaxy, tier: 'galaxy' }, { instanceName: `${galaxy}.dev`, tier: 'star' }], 'deletion', operationId);
    }
  }
}

// ── acceptance: one helper, two writers ─────────────────────────────────────────────────────────

/**
 * Accept a membership and carry out what the Registry answered — the one helper both acceptance
 * writers call, the link page's `POST` and Home's `accept-membership`. On `accepted` it re-puts every
 * session's KV record with the reap, then wipes the scopes a claim's first acceptance names through
 * `hooks.teardown` before it returns: the request is the person's own, so that teardown is the first
 * call to reach those Durable Objects and places them near them, which is why it must never move into
 * the Registry or anything placed beside it. Then it wakes the certificate order of every galaxy the
 * Registry names, accepted or already ({@link wakeCertificates}). Display names are written on any
 * acceptance that landed.
 * The completion line is logged last, so a reader counts what this acceptance caused by its id.
 */
async function settleAcceptance(
  env: Env, hooks: ScopeLifecycleHooks, sub: string, credential: AcceptanceCredential,
  body: Record<string, unknown>,
): Promise<AcceptanceOutcome> {
  const operationId = crypto.randomUUID();
  const log = debug('nebula-auth.worker.acceptMembership');
  const result = await registry(env).acceptMembership(sub, { credential, operationId }) as AcceptanceOutcome;
  if (result.outcome === 'accepted') {
    await putRefreshRecords(env, result.sessions);
    if (result.teardown.length > 0) await hooks.teardown(result.teardown, 'creation', operationId);
  }
  // Already accepted orders too: ordering is idempotent, and a Worker that died before the wake
  // leaves nothing else to retry it. The Registry names only galaxies whose rows stand.
  if (result.outcome === 'accepted' || result.outcome === 'already-accepted') {
    await wakeCertificates(registry(env), hooks, result.galaxies, operationId);
  }
  const nickname = normalizeDisplayName(body.nickname);
  const name = normalizeDisplayName(body.name);
  if (nickname && (result.outcome === 'accepted' || result.outcome === 'already-accepted')) {
    try {
      await (await profileForSub(env, sub))?.setDisplayNames({ nickname, ...(name ? { name } : {}) });
    } catch (e) {
      // Best-effort (see `profileForSub`): the membership is already accepted and refusing now would
      // strand the person outside an account they agreed to join. Loud in the log, silent to them.
      log.warn('display-name write failed (continuing)', { sub, error: (e as Error).message });
    }
  }
  log.info('accepted', {
    operationId, outcome: result.outcome,
    ...(result.outcome === 'accepted' || result.outcome === 'already-accepted' ? { scope: result.scope } : {}),
  });
  return result;
}

/** The refresh cookie a body's `scope` names, resolved to its record and checked against the name. */
async function membershipCookie(
  request: Request, env: Env, scope: unknown,
): Promise<{ record: RefreshTokenKV } | Response> {
  if (typeof scope !== 'string') return errorResponse(400, 'invalid_request', 'Missing scope');
  const cookie = refreshCookies(request.headers.get('Cookie') || '').find((c) => c.scope === scope);
  if (!cookie) return errorResponse(401, 'invalid_token', 'No refresh cookie for that scope');
  // Through the registry rather than the KV record: an UNACCEPTED session is the case these routes
  // serve, and the KV read path refuses those.
  const record = await registry(env).getRefreshRecord(await hashString(cookie.token)) as RefreshTokenKV | null;
  if (!record || record.universeGalaxyStarId !== scope) return errorResponse(401, 'invalid_token', 'Invalid refresh token');
  return { record };
}

/**
 * `POST /auth/accept-membership` — Home's Accept for a pending row, the second acceptance writer.
 * The body names the membership's scope, which picks its refresh cookie; the record behind that
 * cookie decides, never the name.
 */
export async function handleAcceptMembership(
  request: Request, env: Env, hooks: ScopeLifecycleHooks,
): Promise<Response> {
  const body = await readJsonBody(request);
  const resolved = await membershipCookie(request, env, body.scope);
  if (resolved instanceof Response) return resolved;
  const result = await settleAcceptance(env, hooks, resolved.record.sub, 'refresh-cookie', body);
  if (result.outcome === 'not-found') return errorResponse(404, 'not_found', 'No such membership');
  if (result.outcome === 'refused') return errorResponse(403, result.reason, result.message);
  return Response.json({ accepted: result.outcome === 'accepted', scope: resolved.record.universeGalaxyStarId });
}

/**
 * `POST /auth/pending-membership` — the consent card for a pending row on Home: its scope, whether it
 * came by invite, the sender-supplied name, and the person's display names to pre-fill. The body
 * names the scope, which picks the cookie; their own public fields, behind their own cookie, so no
 * disclosure question arises (ADR-012).
 */
export async function handlePendingMembership(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  const resolved = await membershipCookie(request, env, body.scope);
  if (resolved instanceof Response) return resolved;
  const card = await registry(env).getMembershipCard(resolved.record.sub) as
    { universeGalaxyStarId: string; accepted: boolean; invited?: boolean; invitedByName?: string } | null;
  if (!card) return errorResponse(404, 'not_found', 'No such membership');
  let names: { nickname?: string; name?: string } = {};
  try {
    names = (await (await profileForSub(env, resolved.record.sub))?.readDisplayNames() ?? {}) as typeof names;
  } catch (e) {
    debug('nebula-auth.worker.pendingMembership').warn('display-name read failed (continuing)', {
      sub: resolved.record.sub, error: (e as Error).message,
    });
  }
  return Response.json({
    ...card,
    ...(names.nickname ? { nickname: names.nickname } : {}),
    ...(names.name ? { name: names.name } : {}),
  });
}

// ── Home's summary, by cookie ───────────────────────────────────────────────────────────────────

/** At most this many cookies one request resolves: the cookie cap, twice, against a forged flood. */
const RESOLVE_BOUND = 2 * MINT_ALL_COOKIE_CAP;

/**
 * `POST /auth/home-summary` — Home's one read. Authenticated by every accepted refresh cookie the
 * request carries, resolved in one batched Registry call bounded at {@link RESOLVE_BOUND}, and grouped
 * by `profileId`, each group answered from `getScopeSummary`, which keys on the person and reads no
 * `access` claim. It is the only route that returns a person's whole summary; no scope host has one.
 * The pending cookies are named beside it, so Home can offer each one's consent, and so are the
 * accepted ones with their admin bit, `held`, so Home can mark a row whose host this browser could
 * not open — the refresh mints only from that membership's own cookie or an admin cookie above it.
 */
export async function handleHomeSummary(request: Request, env: Env): Promise<Response> {
  const operationId = crypto.randomUUID();
  const log = debug('nebula-auth.worker.homeSummary');
  const all = refreshCookies(request.headers.get('Cookie') || '');
  if (all.length > RESOLVE_BOUND) log.warn('truncated', { operationId, received: all.length, bound: RESOLVE_BOUND });
  const cookies = all.slice(0, RESOLVE_BOUND);
  const hashes = await Promise.all(cookies.map((c) => hashString(c.token)));
  for (const c of cookies) log.debug('resolve', { operationId, scope: c.scope });
  const records = hashes.length === 0 ? []
    : await registry(env).currentRefreshRecords(hashes) as Array<RefreshTokenKV | null>;
  const profileIds = new Set<string>();
  const pending: string[] = [];
  const held: Array<{ scope: string; scopeAdmin: boolean }> = [];
  records.forEach((record, i) => {
    if (!record || record.universeGalaxyStarId !== cookies[i].scope) return;
    if (!record.accepted) { pending.push(record.universeGalaxyStarId); return; }
    held.push({ scope: record.universeGalaxyStarId, scopeAdmin: record.scopeAdmin });
    profileIds.add(record.profileId);
  });
  if (profileIds.size === 0 && pending.length === 0) return errorResponse(401, 'invalid_token', 'No live session');
  const summaries = await Promise.all([...profileIds].map(async (profileId) => ({
    profileId, summary: await registry(env).getScopeSummary(profileId),
  })));
  return Response.json({ groups: summaries, pending, held });
}

// ── signup (spend the ticket, claim, log in) ─────────────────────────────────────────────────────

/** What each ticket-claim refusal tells the person, kept beside the mapping that uses it. */
const SIGNUP_REFUSALS: Record<Exclude<TicketClaimResult, { ok: true }>['reason'], string> = {
  invalid_ticket: 'Signup ticket is missing or expired',
  invalid_slug: 'Invalid universe slug format',
  invalid_app_slug: 'Invalid app slug format',
  reserved_slug: 'That name is reserved',
  slug_taken: 'That name is already claimed',
};

/**
 * The fallback signup page's claim: spend the signup ticket, claim the universe and its first app,
 * mint the session.
 *
 * ⚠️ **No link is sent and no address is read from the body.** The ticket the browser presents was
 * issued minutes ago to a click on mail that reached this address, so the mailbox is already proved
 * and the registry derives the claimer from the ticket row. `slug` and `appSlug`, the account and
 * its first app, are the only things the caller supplies, and the only things they may choose.
 *
 * The membership is minted UNACCEPTED like every other one — Home's consent card is what takes it up —
 * so the cookie set here grants nothing until its holder consents.
 */
export async function handleSignupClaim(request: Request, env: Env): Promise<Response> {
  const rawTicket = cookiesOf(request.headers.get('Cookie') || '').find((c) => c.name === SIGNUP_TICKET_COOKIE)?.value;
  if (!rawTicket) return errorResponse(401, 'invalid_ticket', 'No signup ticket provided');

  let slug: unknown;
  let appSlug: unknown;
  try { ({ slug, appSlug } = await request.json() as { slug?: unknown; appSlug?: unknown }); } catch { /* handled below */ }
  if (typeof slug !== 'string' || slug.length === 0) {
    return errorResponse(400, 'invalid_request', 'Missing slug');
  }

  const ticketHash = await hashString(rawTicket);
  // `appSlug` goes through unchecked: the Registry's refusal is the one the direct claim gives too.
  const claimed = await registry(env).claimUniverseWithTicket(ticketHash, slug, appSlug) as TicketClaimResult;
  if (!claimed.ok) {
    // The registry answers with a REASON, not a status — an HTTP code is this side's business, and
    // `SIGNUP_REFUSALS` does not compile without a message for every reason (`raw-comm.md`).
    const status = claimed.reason === 'slug_taken' ? 409
      : claimed.reason === 'invalid_ticket' ? 403
        : 400;
    return errorResponse(status, claimed.reason, SIGNUP_REFUSALS[claimed.reason]);
  }

  const rawRefreshToken = generateRandomString(32);
  const puts = await registry(env).recordSessions(
    [{ sub: claimed.sub, tokenHash: await hashString(rawRefreshToken) }],
    new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString(),
    crypto.randomUUID(),
  ) as RefreshPut[];
  await putRefreshRecords(env, puts);

  const headers = new Headers();
  headers.append('Set-Cookie', refreshCookie(claimed.universeGalaxyStarId, rawRefreshToken));
  // The ticket is spent server-side; expire the browser's copy too so a stale one cannot ride along
  // to a later visit and read as live.
  headers.append('Set-Cookie', expiredSignupTicketCookie());
  headers.set('Content-Type', 'application/json');
  return new Response(
    JSON.stringify({ scope: claimed.universeGalaxyStarId, redirect: HOME_PATH }),
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

// ── refresh-token: the one route a page on another host calls ───────────────────────────────────

/**
 * `POST /auth/refresh-token` — a page on a scope host gets its access token (ADR-022 § *Getting an
 * access token*). It reads no body and no `Content-Type`, so it is a simple request a page's
 * credentialed `fetch` sends without a preflight.
 *
 * 1. **`Origin` decides the host's scope**, through the deployment's parse. A host that names no scope
 *    — the platform host, the apex, one the parse refuses — answers 403 with no CORS headers, so the
 *    asking script cannot read even that.
 * 2. **The candidates are the cookies named at or above that scope**, at most four, broadest first,
 *    since the scope tree caps them. A cookie named for any other scope is never read.
 * 3. **Each candidate's record decides, not its name.** A record whose scope disagrees with the name
 *    is skipped at warn. An unaccepted membership mints nothing. The first accepted `scopeAdmin` one
 *    wins — the broadest dominion — else the membership at the host's own scope, else 401.
 * 4. **A KV miss falls back once to the Registry**, which heals the record through the reap. A miss
 *    on both expires that cookie, so a revoked membership's cookie stops costing a Registry read.
 * 5. **It answers CORS for that origin alone**, with credentials; no other route answers CORS.
 * 6. **A persona's host mints the persona's own plain token**, `manny--dev.crm.acme` answering as
 *    Manny, for a browser whose ACCEPTED admin cookie at or above the Star holds dominion over it —
 *    never a plain one, and only in the `dev` Star (ADR-022 § *A persona's host*). The token carries
 *    no `act`; the opener is recorded instead, from its cookie's record (ADR-016).
 */
export async function handleRefreshToken(request: Request, env: Env): Promise<Response> {
  const log = debug('nebula-auth.worker.refresh');
  const origin = request.headers.get('Origin');
  let target: HostTarget | null = null;
  if (origin) {
    try { target = parseHost(new URL(origin).host, deploymentOrigin(env)); } catch { target = null; }
  }
  if (!origin || !target || (target.kind !== 'scope' && target.kind !== 'persona')) {
    return errorResponse(403, 'invalid_origin', 'The refresh answers a page on a scope host');
  }
  const persona = target.kind === 'persona' ? target.persona : undefined;
  // The refresh serves every page on the site, so `same-site` passes beside `same-origin`; a request
  // with no `Sec-Fetch-Site` is not a browser's, and the `Origin` above already decided it.
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'same-site') {
    return errorResponse(403, 'cross_site', 'The refresh answers only pages on this site');
  }
  const hostScope = target.scope;
  const cors = (response: Response): Response => {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.append('Vary', 'Origin');
    return response;
  };
  const operationId = crypto.randomUUID();
  const expired: string[] = [];
  let pendingSeen = false;
  let picked: RefreshTokenKV | undefined;
  let exact: RefreshTokenKV | undefined;
  const now = new Date().toISOString();

  for (const candidate of refreshCookies(request.headers.get('Cookie') || '')) {
    if (!isAtOrAbove(candidate.scope, hostScope)) continue;
    log.debug('read', { operationId, scope: candidate.scope });
    const tokenHash = await hashString(candidate.token);
    const raw = await (env as any).REFRESH_TOKEN_KV.get(`refresh:${tokenHash}`);
    let record: RefreshTokenKV | null = raw ? JSON.parse(raw) as RefreshTokenKV : null;
    if (!record) {
      // KV miss: a propagation gap, or a revoked record. The Registry's strongly consistent index
      // tells them apart; a healed record is put here, where the person is, and reaped if orphaned.
      const healed = await registry(env).getRefreshRecord(tokenHash) as RefreshTokenKV | null;
      if (healed) [record] = await putRefreshRecords(env, [{ tokenHash, record: healed }]);
      if (!record) { expired.push(candidate.scope); continue; }
    }
    if (now > record.expiresAt) continue;
    if (record.universeGalaxyStarId !== candidate.scope) {
      log.warn('cookie name disagrees with its record', { operationId, name: candidate.scope, sub: record.sub });
      continue;
    }
    if (!record.accepted) { pendingSeen = true; continue; }
    if (record.scopeAdmin) { picked = record; break; }
    if (record.universeGalaxyStarId === hostScope) exact = record;
  }
  // A persona's page opens only for dominion over its Star: a plain member of the Star is no opener.
  if (!persona) picked ??= exact;

  const withExpiries = (response: Response): Response => {
    for (const scope of expired) response.headers.append('Set-Cookie', expiredRefreshCookie(scope));
    return cors(response);
  };
  if (!picked) {
    return withExpiries(pendingSeen
      ? errorResponse(401, 'membership_not_accepted', 'This membership has not been accepted yet')
      : errorResponse(401, 'invalid_token', 'No refresh cookie covers this host'));
  }
  if (persona) {
    // Only the `dev` Star has personas a page may open: an environment beside it, `staging` say,
    // parses as a persona's host and is refused here.
    if (hostScope.split('.')[2] !== 'dev') {
      return withExpiries(errorResponse(401, 'invalid_token', 'A persona page opens only in a dev Star'));
    }
    const id = await personaId(hostScope, persona);
    const minted = await mintAccessToken(env, {
      sub: id, universeGalaxyStarId: hostScope, scopeAdmin: false, profileId: id, activeScope: hostScope,
    });
    // ADR-016: this establishes a session, so it records the opener from its cookie's record. The
    // persona's token carries no `act`, so the record is the only place the opener is named.
    debug('nebula-auth.worker.refresh.persona').info('persona minted', {
      operationId, sub: id, star: hostScope, aud: hostScope,
      opener: { sub: picked.sub, profileId: picked.profileId, scope: picked.universeGalaxyStarId, scopeAdmin: picked.scopeAdmin },
    });
    return withExpiries(Response.json({
      access_token: minted.accessToken, token_type: 'Bearer', expires_in: minted.effectiveTtlSeconds, sub: id,
    }));
  }
  const { accessToken, effectiveTtlSeconds } = await mintAccessToken(env, {
    sub: picked.sub,
    universeGalaxyStarId: picked.universeGalaxyStarId,
    scopeAdmin: picked.scopeAdmin,
    profileId: picked.profileId,
    activeScope: hostScope,
  });
  // The completion line, by which a reader finds this refresh's `read` markers: the host and the
  // `sub` it minted are what a caller holding the answer knows.
  log.debug('minted', { operationId, host: hostScope, sub: picked.sub });
  // No rotation, no slide (security.md): the refresh token keeps its fixed TTL from login.
  return withExpiries(Response.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: effectiveTtlSeconds,
    sub: picked.sub,
  }));
}

// ── logout ───────────────────────────────────────────────────────────────────────────────────────

/**
 * `POST /auth/logout` — end every session the browser's cookies name (§ *Logging out* in the task
 * that built it). Every refresh cookie the request carries is expired, which costs no Registry read;
 * the revocations are bounded at {@link RESOLVE_BOUND}, and a truncation is logged at warn. With
 * `everywhere`, every session of each address those cookies name ends, on every device.
 *
 * ⚠️ **A DERIVED session never reaches here.** An impersonated client holds no refresh cookie of its
 * own, so this call would spend the ORIGINATOR's — `security.md`'s derived-session rule. The client's
 * guard is `NebulaClient.logout()`'s `#mintedFrom` branch, which ends an impersonation by teardown.
 */
export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const operationId = crypto.randomUUID();
  const log = debug('nebula-auth.worker.logout');
  const { everywhere } = await readJsonBody(request);
  const cookieHeader = request.headers.get('Cookie') || '';
  const headers = new Headers({ 'Content-Type': 'application/json' });
  // Every refresh cookie received is expired, parsed as a scope or not.
  for (const { name } of cookiesOf(cookieHeader)) {
    if (name.startsWith(REFRESH_COOKIE_PREFIX)) headers.append('Set-Cookie', expiredRefreshCookie(name.slice(REFRESH_COOKIE_PREFIX.length)));
  }
  const all = refreshCookies(cookieHeader);
  if (all.length > RESOLVE_BOUND) log.warn('truncated', { operationId, received: all.length, bound: RESOLVE_BOUND });
  const hashes = await Promise.all(all.slice(0, RESOLVE_BOUND).map((c) => hashString(c.token)));
  let subs: string[] = [];
  try {
    // A request with no refresh cookie has nothing to revoke, so it never wakes the singleton.
    if (hashes.length > 0) {
      ({ subs } = await registry(env).logoutSessions(hashes, everywhere === true, operationId) as { subs: string[] });
    }
  } catch (err) {
    log.warn('revoke failed (continuing)', { operationId, error: err instanceof Error ? err.message : String(err) });
  }
  log.info('logged out', { operationId, ended: subs.length, everywhere: everywhere === true });
  return new Response(JSON.stringify({ ended: subs.length }), { status: 200, headers });
}

// ── (there is no invite handler here: every invite enters mesh-side through NebulaAuthFacade —
//     `@lumenize/nebula-auth/facade` — which owns the eligibility verdicts, the bit cap, and the
//     post-return send dispatch through `invite-entry.ts`) ─────────────────────────────────────────

// ── the impersonation mint ──────────────────────────────────────────────────────────────────────

/**
 * May `callerClaims` mint a token wearing this subject's identity? — dominion over the SUBJECT's
 * scope, read from the caller's own host like every verdict (`security.md` § Delegation,
 * mint-side, and the host rule).
 *
 * Deliberately thin, and it exists for ONE reason: naming which scope goes in. The live
 * substitution risk is any scope reachable at the call site other than the subject's — and the
 * nearest wrong argument is the CALLER's own host scope, `aud`, which makes the predicate
 * reflexively true and therefore silent: a check that can never refuse, which mutation testing
 * cannot red. Taking the whole `subject` row (never a bare scope string) is what forecloses writing
 * that. Not exported: `apps/nebula` has no business minting.
 */
function canMintFor(
  callerClaims: NebulaJwtPayload,
  subject: { universeGalaxyStarId: string },
): boolean {
  return hasDominionOver(callerClaims, subject.universeGalaxyStarId);
}

/** What {@link mintImpersonationToken} answers: a token, or the refusal a caller may read. */
export type ImpersonationMint =
  | { ok: true; accessToken: string; expiresIn: number }
  | { ok: false; message: string };

/**
 * Mint a token that acts as another person: `sub` = the subject, `act` = the caller. Reached from
 * `NebulaAuthFacade.impersonate`, which turns a refusal into its typed terminal error.
 *
 * **The authorization is ONE question plus one validation:**
 *
 *  - **authorize:** `¬caller.act` (the root-identity gate, below) ∧ `caller.sub ≠ subject.sub`
 *    (the self-narrow refusal) ∧ `subject accepted their membership` ∧ {@link canMintFor} —
 *    dominion over the SUBJECT's scope. The acceptance conjunct has no branch of its own: the
 *    registry's `getIdentityScope` answers only for an accepted membership, so an unaccepted
 *    subject arrives as `null` and the collapsed refusal below covers them (ADR-012).
 *  - **mint:** `{ sub, authScope, scopeAdmin }` ← all the SUBJECT's, verbatim; `aud` ← the
 *    CALLER's `aud`, so the child acts on the page its parent is on; `act` ← the caller.
 *
 * No caller names the child's scope: a parameter for it would be a second source for a value the
 * page already fixes. The old bounds on a requested scope are theorems now — eligibility places the
 * subject's whole scope inside the caller's dominion, the minted `authScope` IS the subject's scope,
 * and `verify.ts` requires `aud ⊆ authScope` — so the one containment check left is the **`aud`
 * validation**, which answers a page outside the subject's scope early instead of minting a token
 * that verifies nowhere. Faithfulness — the subject's own bit and scope, not the caller's — is what
 * puts `resolvePermission` back in the decision, so an admin can observe the denial they came to
 * debug.
 */
export async function mintImpersonationToken(
  env: Env, callerClaims: NebulaJwtPayload, sub: unknown, ttlSeconds?: unknown, operationId?: string,
): Promise<ImpersonationMint> {
  // Mint from a ROOT identity only (a token carrying no `act` chain) — never re-narrow. The
  // `¬caller.act` conjunct of the authorize line, a licensed mint-side presence gate under
  // `security.md` rule (1).
  if (callerClaims.act) {
    return { ok: false, message: 'Impersonation requires a root identity (a token carrying no `act` chain)' };
  }
  if (typeof sub !== 'string' || !sub) return { ok: false, message: 'Impersonation needs the subject\'s sub' };
  // Accept-list, before the mint — see `validateTtlSeconds` on why a non-positive check is not enough.
  const ttlCheck = validateTtlSeconds(ttlSeconds);
  if ('error' in ttlCheck) return { ok: false, message: ttlCheck.error };

  // Reject SELF-NARROWING, before the registry read. There is no second party, so an actor pair
  // naming the token's own `sub` records nothing: it pollutes attribution, and it costs that session
  // what an actor chain is refused — re-narrowing past the root-identity gate above — for no second
  // party's sake. ⚠️ The invariant is *a chain must name someone else*, NOT "the two subs are different
  // people": one human legitimately holds several `sub`s.
  if (sub === callerClaims.sub) {
    return { ok: false, message: 'Impersonation needs a different sub than the caller\'s' };
  }

  // The subject lookup — the ACCEPTED-only read, which is what makes the refusal below cover a
  // subject who never took their membership up.
  const subjectIdentity = await identityReads(env).getIdentityScope(sub);

  // ── AUTHORIZE — one question, and refusal is indistinguishable from absence ─────────────────────
  // A `null` subject and a subject the caller may not act for get the SAME refusal: the lookup
  // precedes authorization, so a distinct not-found answer would make this a `sub`-existence oracle
  // for any authenticated caller.
  //
  // ⚠️ **ORDER MATTERS, and it is a disclosure decision.** The `aud` validation below can pass
  // while this refuses, so running it first would tell a caller who is about to be refused WHERE
  // the subject sits in the tree — across a Star boundary ADR-008 bounds visibility to. Neither
  // refusal may name the subject's scope; this one names the caller's own and nothing else.
  if (!subjectIdentity || !canMintFor(callerClaims, subjectIdentity)) {
    return { ok: false, message: `The calling host's scope "${callerClaims.aud}" does not administer this subject` };
  }

  // ── The `aud` VALIDATION — a validation, never an authorization ─────────────────────────────────
  // The child's `aud` is the caller's, and `verify.ts` refuses any token whose `aud` is not inside
  // its `authScope`, the SUBJECT's scope. A host outside it could only mint a token that verifies
  // nowhere. With the authorization above reading dominion from that same host, the two together
  // hold the child's `aud` to exactly the subject's scope: an admin impersonates from the subject's
  // own page. The message names only the caller's own host scope (ADR-008).
  if (!isAtOrAbove(subjectIdentity.universeGalaxyStarId, callerClaims.aud)) {
    return { ok: false, message: `This page's scope "${callerClaims.aud}" is outside the subject's own scope` };
  }

  // Mint the MIRROR: `sub`, `authScope` and `scopeAdmin` are all the SUBJECT's, verbatim — never
  // the caller's. The `profileId` claim is the SUBJECT's — top-level `sub` and top-level `profileId`
  // always describe the same person.
  const { accessToken, effectiveTtlSeconds } = await mintAccessToken(env, {
    sub,
    universeGalaxyStarId: subjectIdentity.universeGalaxyStarId,
    scopeAdmin: subjectIdentity.scopeAdmin,
    profileId: subjectIdentity.profileId,
    activeScope: callerClaims.aud,
    actor: { sub: callerClaims.sub, profileId: callerClaims.profileId },
    ttlSeconds: ttlSeconds as number | undefined,
  });

  // ADR-016: a mint ESTABLISHES a session, so the record names every party through the one shared
  // projection — the subject's `sub` beside the caller's whole projected claims.
  debug('nebula-auth.facade.impersonate').info('Impersonation token issued', {
    subOfNarrowerToken: sub, operationId, actingToken: projectActingToken(callerClaims),
  });
  return { ok: true, accessToken, expiresIn: effectiveTtlSeconds };
}

export { verifyNebulaAccessToken };
