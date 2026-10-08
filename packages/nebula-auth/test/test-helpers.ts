/**
 * Shared test helpers for nebula-auth — the login flows through the Worker (SELF.fetch) over the
 * registry + KV, per the dissolved-DO model (tasks/nebula-auth-surrogate-sub.md).
 *
 * Grounding: rung 2 (test-mode server issuance) — the registry echoes the raw magic/invite link in the
 * response ONLY when `AUTH_TEST_MODE` is set (miniflare.bindings), so no email round-trip is
 * needed but the real issuance + consume + KV + JWT-mint code paths are exercised end-to-end.
 *
 * Two ways to establish an identity (login verify NEVER mints — a raw email can't just self-join):
 *  - `foundUniverse` — self-signup mints the admin identity at claim, then logs in (admin).
 *  - `inviteAndLogin` — an admin mints an invitee identity, then the invitee accepts + logs in (member).
 */
import { expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { NEBULA_AUTH_PREFIX, PLATFORM_SCOPE, REGISTRY_INSTANCE_NAME, SIGNUP_TICKET_COOKIE } from '../src/types';
import { verifyNebulaAccessToken } from '../src/verify';
import { deploymentOrigin, hostOrigin, platformOrigin } from '../src/hosts';
import { isPlatformScope } from '../src/parse-id';
import { REFRESH_COOKIE_PREFIX } from '../src/worker-token';
import type { InviteMintResult, InviteeRequest, NebulaJwtPayload } from '../src/types';

export const PREFIX = NEBULA_AUTH_PREFIX; // '/auth'

/** The test Worker's own issuer — what a token must carry to verify here. */
export const TEST_ISSUER = platformOrigin(deploymentOrigin(env));

/** The platform host, where every `/auth/` route answers: `http://platform.lumenize.localhost`. */
export const PLATFORM = hostOrigin({ kind: 'platform' }, deploymentOrigin(env));

/** A scope's own host, where its pages live and whose `Origin` the refresh reads. */
export function scopeOrigin(scope: string): string {
  return hostOrigin({ kind: 'scope', scope }, deploymentOrigin(env));
}

/**
 * The universe page a superuser opens when a test needs their token and names no page. A page loads
 * without asking the Registry whether its scope exists, and so does the refresh, so nothing here is
 * claimed; it is only the host the token's `aud` names. The platform host's own pages get no token.
 */
export const SUPERUSER_PAGE_SCOPE = 'support-desk';

/** A minimal fetcher — `SELF` from `cloudflare:test`, or a `Browser` from `@lumenize/testing`. */
export interface Fetcher { fetch(request: Request): Promise<Response>; }

/** Full URL for a route on the platform host (`/auth/{endpoint}`). */
export function authUrl(endpoint: string): string {
  return `${PLATFORM}${PREFIX}/${endpoint}`;
}

/** One membership's refresh cookie as a browser presents it: `__Host-refresh-token.{scope}={token}`. */
export function refreshCookie(scope: string, token: string): string {
  return `${REFRESH_COOKIE_PREFIX}${scope}=${token}`;
}

/**
 * Claim a Universe with its first app (self-signup — MINTS the admin identity, and writes the
 * universe, `{slug}.{appSlug}` and its `.dev` Star). Returns the test-mode magic-link URL.
 */
export async function claimUniverse(self: Fetcher, slug: string, email: string, appSlug = 'first'): Promise<string> {
  const resp = await self.fetch(new Request(authUrl('claim-universe'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, appSlug, email }),
  }));
  expect(resp.status).toBe(200);
  const body = await resp.json() as { magicLinkUrl?: string };
  expect(body.magicLinkUrl).toBeDefined();
  return body.magicLinkUrl!;
}

/**
 * Claim a Star (OPEN self-signup — mints the exact-star admin). Returns the whole response so
 * callers can assert the reject codes; on success the test-mode body carries `magicLinkUrl`.
 */
export async function claimStar(self: Fetcher, universeGalaxyStarId: string, email: string): Promise<Response> {
  return self.fetch(new Request(authUrl('claim-star'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ universeGalaxyStarId, email }),
  }));
}

/**
 * The verified claims of `accessToken`, as a facade method receives them in `originAuth`. Fails the
 * test on a token that does not verify, so a helper built on it cannot pass a forged claims object.
 */
export async function verifiedClaims(accessToken: string): Promise<NebulaJwtPayload> {
  const claims = await verifyNebulaAccessToken(accessToken, env as Env);
  expect(claims, 'the access token did not verify').not.toBeNull();
  return claims!;
}

/** The Registry stub, for the methods only the facade reaches in production. */
export function registryStub(): any {
  return (env as any).AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
}

/**
 * Create a Galaxy and its `.dev` Star — the Registry's own method, handed the verified claims of the
 * admin's token, as `NebulaAuthFacade.createGalaxy` hands them once its pre-check passes. This lane
 * holds no Gateway to reach the facade through; the facade itself is driven in `apps/nebula`'s
 * baseline lane. Throws the Registry's refusal; {@link ensureGalaxy} tolerates an existing one.
 */
export async function createGalaxy(universeGalaxyId: string, adminToken: string): Promise<void> {
  await registryStub().createGalaxy(universeGalaxyId, await verifiedClaims(adminToken));
}

/** {@link createGalaxy}, treating an already-claimed galaxy as success — for provisioning. */
export async function ensureGalaxy(universeGalaxyId: string, adminToken: string): Promise<void> {
  try { await createGalaxy(universeGalaxyId, adminToken); }
  catch (e) { if ((e as { errorCode?: string }).errorCode !== 'slug_taken') throw e; }
}

/**
 * Request a LOGIN magic link. Returns the whole response so callers can assert status; in test mode a
 * 200 body carries `magicLinkUrl`.
 *
 * ⚠️ **SCOPE-LESS, and it takes no scope to pass.** The `/auth/{scope}/email-magic-link` sibling is
 * retired: naming a scope up front is what forced a caller to KNOW their scope before proving
 * anything, which is the enumeration the prove-then-choose design deletes. A request mints nothing
 * and answers identically whatever address it names; the consume hands back every membership the
 * address holds.
 */
export async function requestMagicLink(self: Fetcher, email: string): Promise<Response> {
  return self.fetch(new Request(authUrl('email-magic-link'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }));
}

/** The link page's `POST /auth/magic-link` — its Continue or Accept — for the token a link URL carries. */
export function consumeRequest(linkUrl: string, body: Record<string, unknown> = {}): Request {
  const token = new URL(linkUrl).searchParams.get('token');
  expect(token, `no token in "${new URL(linkUrl).pathname}"`).toBeTruthy();
  return new Request(authUrl('magic-link'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, ...body }),
  });
}

/** The link page's lookup, `POST /auth/magic-link/lookup`, which writes nothing — what loading a link does. */
export function lookupLink(self: Fetcher, linkUrl: string): Promise<Response> {
  const token = new URL(linkUrl).searchParams.get('token');
  return self.fetch(new Request(authUrl('magic-link/lookup'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  }));
}

/** {@link consumeRequest}, sent. */
export function consumeLink(self: Fetcher, linkUrl: string, body: Record<string, unknown> = {}): Promise<Response> {
  return self.fetch(consumeRequest(linkUrl, body));
}

/** Every refresh cookie a response sets, by scope. */
export function refreshCookiesSet(resp: Response): Map<string, string> {
  const all = (resp.headers as any).getSetCookie?.() as string[] | undefined
    ?? [resp.headers.get('Set-Cookie') ?? ''];
  const byScope = new Map<string, string>();
  for (const c of all) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    if (name.startsWith(REFRESH_COOKIE_PREFIX)) byScope.set(name.slice(REFRESH_COOKIE_PREFIX.length), pair.slice(eq + 1));
  }
  return byScope;
}

/**
 * Open a magic/invite link's page and press its button → the cookie set it produced.
 *
 * The page's `POST` consumes the link: it sets one cookie PER MEMBERSHIP of the address (mint-all),
 * and accepts the pending membership at the link's own scope, a claim's or an invite's, so a helper
 * that clicks one needs no separate Accept. The link's scope is minted first
 * (`selectSessionsToMint`), so `landedAt` is it when the link named one. Callers say which scope's
 * cookie they want through `tokenFor`.
 */
export async function clickLink(
  self: Fetcher, linkUrl: string, body: Record<string, unknown> = {},
): Promise<{
  setCookie: string; refreshToken: string; tokenFor: (scope: string) => string; landedAt: string;
  redirect: string; cookies: Map<string, string>;
}> {
  const resp = await consumeLink(self, linkUrl, body);
  expect(resp.status).toBe(200);
  const { redirect } = await resp.json() as { redirect: string };
  const cookies = refreshCookiesSet(resp);
  expect(cookies.size, 'the consume set no refresh cookie').toBeGreaterThan(0);
  const tokenFor = (scope: string) => {
    const tok = cookies.get(scope);
    expect(tok, `no cookie was set for "${scope}" (got: ${[...cookies.keys()].join(', ')})`).toBeDefined();
    return tok!;
  };
  const landedAt = [...cookies.keys()][0];
  return {
    setCookie: refreshCookie(landedAt, cookies.get(landedAt)!), refreshToken: tokenFor(landedAt),
    tokenFor, landedAt, redirect, cookies,
  };
}

/**
 * Sign in through a plain magic link, which accepts nothing: every membership the address holds gets
 * its cookie, a pending one included — the state of someone who closed an invite's consent screen
 * and signed in later, which is what Home's Accept serves.
 */
export async function plainLogin(self: Fetcher, email: string): ReturnType<typeof clickLink> {
  const resp = await requestMagicLink(self, email);
  expect(resp.status).toBe(200);
  const { magicLinkUrl } = await resp.json() as { magicLinkUrl?: string };
  expect(magicLinkUrl).toBeDefined();
  return clickLink(self, magicLinkUrl!);
}

/**
 * Take up a membership the way its holder does on Home — `accept-membership`, naming the scope whose
 * cookie it presents. A plain login link places a pending membership's cookie without accepting it,
 * which is what this is for; a claim's or an invite's own link accepts as it consumes.
 */
export async function acceptMembership(
  self: Fetcher, instanceName: string, refreshToken: string, body: Record<string, unknown> = {},
): Promise<void> {
  const resp = await self.fetch(new Request(authUrl('accept-membership'), {
    method: 'POST',
    headers: { Cookie: refreshCookie(instanceName, refreshToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: instanceName, ...body }),
  }));
  expect(resp.status).toBe(200);
}

/** Alias kept for call-site familiarity. */
export const clickMagicLink = clickLink;

/** `POST /auth/logout` presenting `cookies`, with `everywhere` when asked. */
export function logoutRequest(cookies: string[], everywhere?: boolean): Request {
  return new Request(authUrl('logout'), {
    method: 'POST',
    headers: { Cookie: cookies.join('; '), 'Content-Type': 'application/json' },
    body: JSON.stringify(everywhere === undefined ? {} : { everywhere }),
  });
}

/**
 * `POST /auth/refresh-token` as a page on `hostScope`'s host sends it: `Origin` names the page, the
 * cookies ride, and there is no body.
 */
export function refresh(self: Fetcher, hostScope: string, cookieHeader: string): Promise<Response> {
  return self.fetch(new Request(authUrl('refresh-token'), {
    method: 'POST', headers: { Origin: scopeOrigin(hostScope), Cookie: cookieHeader },
  }));
}

/**
 * Exchange one membership's refresh cookie for an access token from a page on `activeScope`'s host,
 * the membership's own by default; returns the body + parsed JWT payload. The platform membership's
 * default page is {@link SUPERUSER_PAGE_SCOPE}, since the platform host's pages get no token.
 */
export async function refreshAndParse(
  self: Fetcher, instanceName: string, refreshToken: string, activeScope?: string,
): Promise<any> {
  const host = activeScope ?? (isPlatformScope(instanceName) ? SUPERUSER_PAGE_SCOPE : instanceName);
  const resp = await refresh(self, host, refreshCookie(instanceName, refreshToken));
  expect(resp.status).toBe(200);
  const body = await resp.json() as any;
  expect(body.access_token).toBeDefined();
  return { ...body, parsed: parseJwtUnsafe(body.access_token)!.payload };
}

/**
 * Found a Universe end-to-end: claim (mint the admin, write the first app) → the link page's Accept
 * → refresh. Returns an ADMIN token.
 */
export async function foundUniverse(self: Fetcher, slug: string, email: string, appSlug = 'first') {
  const magicLink = await claimUniverse(self, slug, email, appSlug);
  // The claim's link page is its consent screen, so its Accept consumes and accepts in one click.
  const { refreshToken, setCookie } = await clickLink(self, magicLink);
  const { parsed, access_token } = await refreshAndParse(self, slug, refreshToken);
  return { magicLink, refreshToken, setCookie, parsed, access_token };
}

/**
 * Issue invites straight at the Registry (test-as-caller RPC), the way the mesh facade does in
 * production: `callerClaims` are parsed off a REAL server-minted token, so the ADR-016 projection
 * and the in-method cap re-assertion see genuine claims. This package has no mesh stack — the
 * facade's own guards are covered in apps/nebula's baseline lane (`invite-facade.test.ts`); here
 * the Registry primitive is the unit.
 */
export async function issueInvitesAs(
  callerToken: string, scope: string, invitees: InviteeRequest[], inviterName?: string,
): Promise<InviteMintResult> {
  const claims = parseJwtUnsafe(callerToken)!.payload as unknown as NebulaJwtPayload;
  const registry = (env as any).AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
  // ⚠️ Straight to the registry, so `inviterName` arrives UNSANITIZED — the facade is what caps and
  // strips it, and a test asserting that sanitization must drive the facade instead.
  return await registry.issueInvites(scope, invitees, PLATFORM, claims, inviterName) as InviteMintResult;
}

/**
 * Invite `email` into `scope` (as the admin whose token is passed) and log them in: issue (mints
 * the invitee identity + token) → the invite page's Accept → refresh. Returns a MEMBER token
 * (non-admin). Issuance is the registry RPC above; the CLICK stays HTTP — the session lifecycle
 * kept its routes when the issuing side moved to the mesh facade.
 */
export async function inviteAndLogin(self: Fetcher, scope: string, adminToken: string, email: string) {
  const mint = await issueInvitesAs(adminToken, scope, [{ email }]);
  expect(mint.errors).toHaveLength(0);
  const link = mint.results[0]?.inviteUrl;
  expect(link).toBeDefined();
  const { refreshToken, setCookie } = await clickLink(self, link!); // the invite page's Accept
  const { parsed, access_token } = await refreshAndParse(self, scope, refreshToken);
  return { link, refreshToken, setCookie, parsed, access_token };
}

/**
 * Found a Star end-to-end **as its own star-scoped admin** → an `scopeAdmin=1` identity at the full 3-segment id
 * with an EXACT-STAR `authScope` (`claimStar` stamps it — `nebula-auth-registry.ts`).
 *
 * This is the only real (ADR-009 rung 1) path to a **sub-universe admin** identity, which is what any
 * test needing a token that actually carries `access.scopeAdmin` under the impersonation mint's
 * mirror requires. `inviteAndLogin` yields `scopeAdmin=0`, so it cannot stand in.
 *
 * ⚠️ **Non-obvious prerequisite: the parent galaxy must exist first** or `claim-star` 400s
 * `parent_not_found` — hence the `createGalaxy` hop, which needs the universe admin's token.
 */
export async function foundStarAndLogin(
  self: Fetcher, star: string, email: string, universeAdminToken: string, activeScope?: string,
) {
  const [universe, galaxySlug] = star.split('.');
  await ensureGalaxy(`${universe}.${galaxySlug}`, universeAdminToken);

  const resp = await claimStar(self, star, email);
  expect(resp.status).toBe(200);
  const { magicLinkUrl } = await resp.json() as { magicLinkUrl?: string };
  expect(magicLinkUrl).toBeDefined();
  const { refreshToken, setCookie } = await clickLink(self, magicLinkUrl!); // the claim page's Accept
  const { parsed, access_token } = await refreshAndParse(self, star, refreshToken, activeScope);
  return { refreshToken, setCookie, parsed, access_token };
}

/**
 * Log in the configured **platform bootstrap admin** at `_platform` → an `authScope: '_platform'`
 * identity, the widest principal there is, refreshed from a page on `activeScope`'s host
 * ({@link SUPERUSER_PAGE_SCOPE} when absent).
 *
 * A configured bootstrap address is minted its platform membership at CONSUME (the shared registry
 * consume ensures it, behind mailbox proof), so this is a real rung-1
 * login. Keyed to an email bound in `vitest.config.js`'s `AUTH_BOOTSTRAP_EMAIL`; passing an
 * unlisted address mints nothing and the login is rejected.
 */
export async function platformLogin(self: Fetcher, email = BOOTSTRAP_EMAIL, activeScope?: string) {
  // A plain login link accepts nothing, so the superuser consents on Home like anyone else.
  const { tokenFor } = await plainLogin(self, email);
  const refreshToken = tokenFor(PLATFORM_SCOPE);
  await acceptMembership(self, PLATFORM_SCOPE, refreshToken);
  return { ...await refreshAndParse(self, PLATFORM_SCOPE, refreshToken, activeScope), refreshToken };
}

/** The first entry of `vitest.config.js`'s `AUTH_BOOTSTRAP_EMAIL` list. */
export const BOOTSTRAP_EMAIL = 'bootstrap-admin@example.com';

/** The SECOND entry of that list (config spells it mixed-case with a leading space; the registry
 *  normalizes per element). Two platform identities are what make a platform caller impersonating a
 *  platform SUBJECT constructible — the self-narrow guard refuses one `sub` acting for itself. */
export const SECOND_BOOTSTRAP_EMAIL = 'second-bootstrap@example.com';

/**
 * Invite `email` into `scope` and log them in **at a galaxy-tier scope**, returning a subject whose
 * own scope is `{u}.{g}`. Thin wrapper over {@link inviteAndLogin} that first ensures the galaxy row
 * exists — `issueInvites` targets an instance path, so the scope must be registered.
 */
export async function inviteIntoGalaxy(
  self: Fetcher, galaxy: string, universeAdminToken: string, email: string,
) {
  await ensureGalaxy(galaxy, universeAdminToken);
  return inviteAndLogin(self, galaxy, universeAdminToken, email);
}

/** Read one cookie's value out of a response's `Set-Cookie` list. */
export function cookieValue(resp: Response, name: string): string | undefined {
  const all = (resp.headers as any).getSetCookie?.() as string[] | undefined
    ?? [resp.headers.get('Set-Cookie') ?? ''];
  for (const c of all) {
    const [pair] = c.split(';');
    const [k, ...rest] = pair.split('=');
    if (k.trim() === name) return rest.join('=');
  }
  return undefined;
}

/**
 * Drive the real front door for a BRAND-NEW address: request a scope-less link, press its page's
 * Continue, and hand back the signup ticket that consume issued. Rung 2 (test-mode issuance) — the point is the ticket the
 * server minted, not the mail transport.
 */
export async function proveNewAddress(self: Fetcher, email: string): Promise<{ ticket: string; location: string }> {
  const req = await requestMagicLink(self, email);
  const { magicLinkUrl } = await req.json() as { magicLinkUrl: string };
  const resp = await consumeLink(self, magicLinkUrl);
  expect(resp.status).toBe(200);
  const ticket = cookieValue(resp, SIGNUP_TICKET_COOKIE);
  expect(ticket, 'the zero-membership consume must issue a signup ticket').toBeDefined();
  return { ticket: ticket!, location: (await resp.json() as { redirect: string }).redirect };
}

/** POST the signup page's claim, presenting a signup ticket when one is given. The form posts the
 *  first app's slug beside the account's, so this does too unless the body names its own. */
export function signupClaim(self: Fetcher, body: Record<string, unknown>, ticket?: string): Promise<Response> {
  return self.fetch(new Request(authUrl('signup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ticket ? { Cookie: `${SIGNUP_TICKET_COOKIE}=${ticket}` } : {}) },
    body: JSON.stringify({ appSlug: 'first', ...body }),
  }));
}

/**
 * No SESSION was minted by this click — the invariant every "not an identity" test asserts.
 *
 * ⚠️ **Not "no `Set-Cookie` at all", which is what these used to check.** A member-less but PROVED
 * address now receives a signup-ticket cookie on its way to the signup page, and that is not a
 * session: it mints no token, reaches no scope, and expires in minutes. Asserting the absence of any
 * cookie conflated "you got nothing" with "you got nowhere to go", and the second is a legitimate
 * outcome of the front door. What must stay true is that no REFRESH cookie was set.
 */
export function expectNoSession(resp: Response): void {
  const all = (resp.headers as any).getSetCookie?.() as string[] | undefined
    ?? [resp.headers.get('Set-Cookie')].filter((c): c is string => c !== null);
  expect(all.filter((c) => c.startsWith(REFRESH_COOKIE_PREFIX))).toEqual([]);
}

/**
 * Which memberships an address holds — the durable successor to the retired `discover` endpoint.
 *
 * `discover` was an unauthenticated endpoint that answered "which scopes does this address belong to,
 * and which does it administer" to anyone who asked, which is the enumeration oracle the
 * prove-then-choose design exists to close. It was also, incidentally, ~21 tests' membership probe.
 * This is that probe without the endpoint: it reads the ROW, which is the persisted effect those
 * tests were really about.
 *
 * ⚠️ **`getScopesForProfile` is NOT the substitute, and swapping it in here would be worse than
 * deleting the assertions.** It filters on acceptance, so a positive assertion moved onto it turns
 * into an all-empty pass the moment a fixture stops accepting — green, and asserting nothing. This
 * reads every membership, accepted or not, exactly as `discover` did.
 *
 * Shape-compatible with what `discover` returned, so the call sites change and the assertions do not.
 */
export async function membershipsOf(
  registry: any, email: string,
): Promise<{ universeGalaxyStarId: string; scopeAdmin: boolean }[]> {
  const lc = email.trim().toLowerCase();
  return (runInDurableObject as any)(registry, (_i: any, c: any) => {
    const rows = [...c.storage.sql.exec(
      `SELECT m.universeGalaxyStarId AS universeGalaxyStarId, m.scopeAdmin AS scopeAdmin
       FROM Emails e JOIN Memberships m ON m.emailId = e.emailId WHERE e.email = ?`, lc)];
    return rows.map((r: any) => ({
      universeGalaxyStarId: r.universeGalaxyStarId as string,
      scopeAdmin: Boolean(r.scopeAdmin),
    }));
  });
}
