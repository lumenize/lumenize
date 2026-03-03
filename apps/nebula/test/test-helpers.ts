/**
 * Shared test helpers for Nebula test files.
 *
 * Composes nebula-auth test mode login with NebulaClient creation.
 */
import { expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { parseJwtUnsafe } from '@lumenize/auth';
import { NEBULA_AUTH_PREFIX } from '@lumenize/nebula-auth';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';
import { NebulaClientTest } from './test-worker-and-dos.js';

const PREFIX = NEBULA_AUTH_PREFIX; // '/auth'
const ORIGIN = 'http://localhost';

function authUrl(path: string): string {
  return `${ORIGIN}${PREFIX}/${path}`;
}

/**
 * Bootstrap an admin at the given auth scope.
 * Creates a NebulaAuth instance with the bootstrap admin as first subject.
 */
export async function bootstrapAdmin(
  browser: Browser,
  authScope: string,
  email: string,
): Promise<void> {
  // Request magic link in test mode
  const mlResp = await browser.fetch(authUrl(`${authScope}/email-magic-link?_test=true`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(mlResp.status).toBe(200);
  const { magic_link } = await mlResp.json() as any;
  expect(magic_link).toBeDefined();

  // Click magic link — browser captures Set-Cookie with path scope
  await browser.fetch(magic_link);
}

/**
 * Create a subject via admin invite + magic link flow.
 * Uses NebulaAuth's POST /invite endpoint with { emails: [...] } body.
 */
export async function createSubject(
  browser: Browser,
  authScope: string,
  adminAccessToken: string,
  email: string,
  options: { isAdmin?: boolean } = {},
): Promise<void> {
  // Admin invites the user via POST /auth/{scope}/invite?_test=true
  const inviteResp = await browser.fetch(authUrl(`${authScope}/invite?_test=true`), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ emails: [email] }),
  });
  expect(inviteResp.status).toBe(200);

  // User clicks magic link (the invite already created the subject,
  // but the user still needs to verify via magic link)
  const mlResp = await browser.fetch(authUrl(`${authScope}/email-magic-link?_test=true`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(mlResp.status).toBe(200);
  const { magic_link } = await mlResp.json() as any;
  await browser.fetch(magic_link);
}

/**
 * Refresh to get an access token for a given auth scope and active scope.
 * Requires a valid refresh cookie in the browser for that auth scope.
 */
export async function refreshToken(
  browser: Browser,
  authScope: string,
  activeScope: string,
): Promise<{ accessToken: string; payload: NebulaJwtPayload }> {
  const refreshResp = await browser.fetch(authUrl(`${authScope}/refresh-token`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeScope }),
  });
  expect(refreshResp.status).toBe(200);
  const { access_token, sub } = await refreshResp.json() as any;
  expect(access_token).toBeDefined();

  const { payload } = parseJwtUnsafe(access_token)!;
  return { accessToken: access_token, payload: payload as unknown as NebulaJwtPayload };
}

/**
 * Full browser-based login: bootstrap (or login existing) + refresh → access token.
 */
export async function browserLogin(
  browser: Browser,
  authScope: string,
  email: string,
  activeScope?: string,
): Promise<{ accessToken: string; payload: NebulaJwtPayload }> {
  // Request magic link in test mode
  const mlResp = await browser.fetch(authUrl(`${authScope}/email-magic-link?_test=true`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(mlResp.status).toBe(200);
  const { magic_link } = await mlResp.json() as any;
  expect(magic_link).toBeDefined();

  // Click magic link — browser captures Set-Cookie with path scope
  await browser.fetch(magic_link);

  // Refresh to get JWT
  return refreshToken(browser, authScope, activeScope ?? authScope);
}

/**
 * Create an authenticated NebulaClientTest and wait for it to connect.
 */
export async function createAuthenticatedClient(
  browser: Browser,
  authScope: string,
  activeScope: string,
  email: string,
): Promise<{ client: NebulaClientTest; payload: NebulaJwtPayload; accessToken: string }> {
  // Login and get access token
  const { accessToken, payload } = await browserLogin(browser, authScope, email, activeScope);

  // Create a browser context for this client
  const ctx = browser.context(ORIGIN);

  // Create the NebulaClientTest
  const client = new NebulaClientTest({
    baseUrl: ORIGIN,
    authScope,
    activeScope,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
  });

  // Wait for connection
  await vi.waitFor(() => {
    expect(client.connectionState).toBe('connected');
  });

  return { client, payload, accessToken };
}
