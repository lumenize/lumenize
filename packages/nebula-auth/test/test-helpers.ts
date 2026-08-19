/**
 * Shared test helpers for nebula-auth — the login flows through the Worker (SELF.fetch) over the
 * registry + KV, per the dissolved-DO model (tasks/nebula-auth-surrogate-sub.md).
 *
 * Grounding: rung 2 (test-mode server issuance) — the registry echoes the raw magic/invite link in the
 * response ONLY when `NEBULA_AUTH_TEST_MODE` is set (miniflare.bindings), so no email round-trip is
 * needed but the real issuance + consume + KV + JWT-mint code paths are exercised end-to-end.
 *
 * Two ways to establish an identity (login verify NEVER mints — a raw email can't just self-join):
 *  - `foundUniverse` — self-signup mints the admin identity at claim, then logs in (admin).
 *  - `inviteAndLogin` — an admin mints an invitee identity, then the invitee accepts + logs in (member).
 */
import { expect } from 'vitest';
import { env } from 'cloudflare:test';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { NEBULA_AUTH_PREFIX, PLATFORM_SCOPE, REGISTRY_INSTANCE_NAME } from '../src/types';
import type { InviteMintResult, InviteeRequest, NebulaJwtPayload } from '../src/types';

export const PREFIX = NEBULA_AUTH_PREFIX; // '/auth'
const ORIGIN = 'http://localhost';

/** A minimal fetcher — `SELF` from `cloudflare:test`, or a `Browser` from `@lumenize/testing`. */
export interface Fetcher { fetch(request: Request): Promise<Response>; }

/** Full URL for an instance + endpoint (`/auth/{instanceName}/{endpoint}`). */
export function url(instanceName: string, endpoint: string, query = ''): string {
  return `${ORIGIN}${PREFIX}/${instanceName}/${endpoint}${query}`;
}

/** Full URL for a registry endpoint (`/auth/{endpoint}`). */
export function registryUrl(endpoint: string): string {
  return `${ORIGIN}${PREFIX}/${endpoint}`;
}

/** Claim a Universe (self-signup — MINTS the admin identity). Returns the test-mode magic-link URL. */
export async function claimUniverse(self: Fetcher, slug: string, email: string): Promise<string> {
  const resp = await self.fetch(new Request(registryUrl('claim-universe'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, email }),
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
  return self.fetch(new Request(registryUrl('claim-star'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ universeGalaxyStarId, email }),
  }));
}

/** Create a Galaxy (admin-gated, `Scopes` row only, NO admin identity). */
export async function createGalaxy(self: Fetcher, universeGalaxyId: string, adminToken: string): Promise<Response> {
  return self.fetch(new Request(registryUrl('create-galaxy'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ universeGalaxyId }),
  }));
}

/**
 * Request a LOGIN magic link (`email-magic-link`) for an existing identity. Returns the whole response
 * so callers can assert status; in test mode a 200 body carries `magicLinkUrl` (find-and-flip still
 * rejects at CONSUME if no identity exists — a request never mints).
 */
export async function requestMagicLink(self: Fetcher, instanceName: string, email: string): Promise<Response> {
  return self.fetch(new Request(url(instanceName, 'email-magic-link'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }));
}

/** Click a magic/invite link → `{ setCookie, refreshToken }`. Asserts the success redirect + cookie. */
export async function clickLink(self: Fetcher, linkUrl: string): Promise<{ setCookie: string; refreshToken: string }> {
  const resp = await self.fetch(new Request(linkUrl, { redirect: 'manual' }));
  expect(resp.status).toBe(302);
  expect(resp.headers.get('Location')).toMatch(/^\/app(\/|$)/); // login success → /app/{scope}
  const setCookie = resp.headers.get('Set-Cookie')!;
  expect(setCookie).toContain('refresh-token=');
  const refreshToken = setCookie.split(';')[0].split('=')[1];
  return { setCookie, refreshToken };
}
/** Alias kept for call-site familiarity. */
export const clickMagicLink = clickLink;

/** Exchange a refresh cookie for an access token; returns the body + parsed JWT payload. */
export async function refreshAndParse(
  self: Fetcher, instanceName: string, refreshToken: string, activeScope?: string,
): Promise<any> {
  const resp = await self.fetch(new Request(url(instanceName, 'refresh-token'), {
    method: 'POST',
    headers: { Cookie: `refresh-token=${refreshToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeScope: activeScope ?? instanceName }),
  }));
  expect(resp.status).toBe(200);
  const body = await resp.json() as any;
  expect(body.access_token).toBeDefined();
  return { ...body, parsed: parseJwtUnsafe(body.access_token)!.payload };
}

/** Found a Universe end-to-end: claim (mint the admin) → click → refresh. Returns an ADMIN token. */
export async function foundUniverse(self: Fetcher, slug: string, email: string) {
  const magicLink = await claimUniverse(self, slug, email);
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
  callerToken: string, scope: string, invitees: InviteeRequest[],
): Promise<InviteMintResult> {
  const claims = parseJwtUnsafe(callerToken)!.payload as unknown as NebulaJwtPayload;
  const registry = (env as any).NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
  return await registry.issueInvites(scope, invitees, 'http://localhost', claims) as InviteMintResult;
}

/**
 * Invite `email` into `scope` (as the admin whose token is passed) and log them in: issue (mints
 * the invitee identity + token) → accept (find-and-flip) → refresh. Returns a MEMBER token
 * (non-admin). Issuance is the registry RPC above; the CLICK stays HTTP — the session lifecycle
 * kept its routes when the issuing side moved to the mesh facade.
 */
export async function inviteAndLogin(self: Fetcher, scope: string, adminToken: string, email: string) {
  const mint = await issueInvitesAs(adminToken, scope, [{ email }]);
  expect(mint.errors).toHaveLength(0);
  const link = mint.results[0]?.inviteUrl;
  expect(link).toBeDefined();
  const { refreshToken, setCookie } = await clickLink(self, link!);
  const { parsed, access_token } = await refreshAndParse(self, scope, refreshToken);
  return { link, refreshToken, setCookie, parsed, access_token };
}

/**
 * Found a Star end-to-end **as its own star-scoped admin** → an `scopeAdmin=1` identity at the full 3-segment id
 * with an EXACT-STAR `authScope` (`claimStar` stamps it — `nebula-auth-registry.ts`).
 *
 * This is the only real (ADR-009 rung 1) path to a **sub-universe admin** identity, which is what any
 * test needing a token that actually carries `access.scopeAdmin` under the `mint-narrower-token` `admin`
 * mirror requires. `inviteAndLogin` yields `scopeAdmin=0`, so it cannot stand in.
 *
 * ⚠️ **Non-obvious prerequisite: the parent galaxy must exist first** or `claim-star` 400s
 * `parent_not_found` — hence the `createGalaxy` hop, which needs the universe admin's token.
 */
export async function foundStarAndLogin(
  self: Fetcher, star: string, email: string, universeAdminToken: string, activeScope?: string,
) {
  const [universe, galaxySlug] = star.split('.');
  const galaxyResp = await createGalaxy(self, `${universe}.${galaxySlug}`, universeAdminToken);
  expect([201, 409]).toContain(galaxyResp.status); // 409 = already exists, fine for provisioning

  const resp = await claimStar(self, star, email);
  expect(resp.status).toBe(200);
  const { magicLinkUrl } = await resp.json() as { magicLinkUrl?: string };
  expect(magicLinkUrl).toBeDefined();
  const { refreshToken, setCookie } = await clickLink(self, magicLinkUrl!);
  const { parsed, access_token } = await refreshAndParse(self, star, refreshToken, activeScope);
  return { refreshToken, setCookie, parsed, access_token };
}

/**
 * Log in the configured **platform bootstrap admin** at `nebula-platform` → an `authScope: 'nebula-platform'`
 * identity, the widest principal there is.
 *
 * The bootstrap mint at `nebula-platform` is the ONLY email-magic-link mint, so this is a real rung-1
 * login. Keyed to an email bound in `vitest.config.js`'s `NEBULA_AUTH_BOOTSTRAP_EMAIL`; passing an
 * unlisted address mints nothing and the login is rejected.
 */
export async function platformLogin(self: Fetcher, email = BOOTSTRAP_EMAIL, activeScope?: string) {
  const ml = await requestMagicLink(self, PLATFORM_SCOPE, email);
  expect(ml.status).toBe(200);
  const { magicLinkUrl } = await ml.json() as { magicLinkUrl?: string };
  expect(magicLinkUrl).toBeDefined();
  const { refreshToken } = await clickLink(self, magicLinkUrl!);
  return refreshAndParse(self, PLATFORM_SCOPE, refreshToken, activeScope);
}

/** The first entry of `vitest.config.js`'s `NEBULA_AUTH_BOOTSTRAP_EMAIL` list. */
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
  const galaxyResp = await createGalaxy(self, galaxy, universeAdminToken);
  expect([201, 409]).toContain(galaxyResp.status);
  return inviteAndLogin(self, galaxy, universeAdminToken, email);
}

/**
 * POST the SCOPE-LESS `/auth/mint-narrower-token`. The route carries no scope segment — the mint's
 * whole authorization is the server-side `canMintFor` against the SUBJECT's scope — so unlike
 * {@link adminRequest} there is no instance in the URL to vary.
 */
export async function mintNarrowerRequest(
  self: Fetcher, accessToken: string, body: Record<string, unknown>,
): Promise<Response> {
  return self.fetch(new Request(registryUrl('mint-narrower-token'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

/** Make an authenticated request to an instance endpoint. Returns the Response. */
export async function adminRequest(
  self: Fetcher, instanceName: string, endpoint: string, accessToken: string,
  options: { method?: string; body?: any } = {},
): Promise<Response> {
  const { method = 'GET', body } = options;
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return self.fetch(new Request(url(instanceName, endpoint), {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}
