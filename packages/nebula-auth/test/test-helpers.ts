/**
 * Shared test helpers for nebula-auth — the login flows through the Worker (SELF.fetch) over the
 * registry + KV, per the dissolved-DO model (tasks/nebula-auth-surrogate-sub.md).
 *
 * Grounding: rung 2 (test-mode server issuance) — the registry echoes the raw magic/invite link in the
 * response ONLY when `NEBULA_AUTH_TEST_MODE` is set (miniflare.bindings), so no email round-trip is
 * needed but the real issuance + consume + KV + JWT-mint code paths are exercised end-to-end.
 *
 * Two ways to establish an identity (login verify NEVER mints — a raw email can't just self-join):
 *  - `foundUniverse` — self-signup mints the founder identity at claim, then logs in (admin).
 *  - `inviteAndLogin` — an admin mints an invitee identity, then the invitee accepts + logs in (member).
 */
import { expect } from 'vitest';
import { parseJwtUnsafe } from '@lumenize/auth';
import { NEBULA_AUTH_PREFIX } from '../src/types';

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

/** Claim a Universe (self-signup — MINTS the founder identity). Returns the test-mode magic-link URL. */
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
 * Claim a Star (OPEN self-signup — mints the exact-star founder). Returns the whole response so
 * callers can assert the reject codes; on success the test-mode body carries `magicLinkUrl`.
 */
export async function claimStar(self: Fetcher, universeGalaxyStarId: string, email: string): Promise<Response> {
  return self.fetch(new Request(registryUrl('claim-star'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ universeGalaxyStarId, email }),
  }));
}

/** Create a Galaxy (admin-gated, `Scopes` row only, NO founder). */
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

/** Found a Universe end-to-end: claim (mint founder) → click → refresh. Returns an ADMIN token. */
export async function foundUniverse(self: Fetcher, slug: string, email: string) {
  const magicLink = await claimUniverse(self, slug, email);
  const { refreshToken, setCookie } = await clickLink(self, magicLink);
  const { parsed, access_token } = await refreshAndParse(self, slug, refreshToken);
  return { magicLink, refreshToken, setCookie, parsed, access_token };
}

/**
 * Invite `email` into `scope` (admin-gated) and log them in: invite (mints the invitee identity +
 * token) → accept (find-and-flip) → refresh. Returns a MEMBER token (non-admin).
 */
export async function inviteAndLogin(self: Fetcher, scope: string, adminToken: string, email: string) {
  const inviteResp = await self.fetch(new Request(url(scope, 'invite'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: [email] }),
  }));
  expect(inviteResp.status).toBe(200);
  const inviteBody = await inviteResp.json() as { links?: Record<string, string> };
  const link = inviteBody.links?.[email.toLowerCase()];
  expect(link).toBeDefined();
  const { refreshToken, setCookie } = await clickLink(self, link!);
  const { parsed, access_token } = await refreshAndParse(self, scope, refreshToken);
  return { link, refreshToken, setCookie, parsed, access_token };
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
