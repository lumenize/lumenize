/**
 * Shared test helpers for nebula-auth test files.
 *
 * Avoids duplicating magic-link / login / JWT helpers across test files.
 */
import { expect } from 'vitest';
import { parseJwtUnsafe } from '@lumenize/auth';
import { NEBULA_AUTH_PREFIX } from '../src/types';

export const PREFIX = NEBULA_AUTH_PREFIX; // '/auth'

/** Build full URL for a given instance + endpoint */
export function url(instanceName: string, endpoint: string, query = ''): string {
  return `http://localhost${PREFIX}/${instanceName}/${endpoint}${query}`;
}

/** Request magic link in test mode, return the magic_link URL */
export async function requestMagicLink(stub: any, instanceName: string, email: string): Promise<string> {
  const resp = await stub.fetch(new Request(url(instanceName, 'email-magic-link?_test=true'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }));
  expect(resp.status).toBe(200);
  const body = await resp.json() as any;
  expect(body.magic_link).toBeDefined();
  return body.magic_link;
}

/** Complete magic link login, return { setCookie, refreshToken } */
export async function clickMagicLink(stub: any, magicLinkUrl: string): Promise<{ setCookie: string; refreshToken: string }> {
  const resp = await stub.fetch(new Request(magicLinkUrl, { redirect: 'manual' }));
  expect(resp.status).toBe(302);
  expect(resp.headers.get('Location')).toBe('/app');
  const setCookie = resp.headers.get('Set-Cookie')!;
  expect(setCookie).toContain('refresh-token=');
  const refreshToken = setCookie.split(';')[0].split('=')[1];
  return { setCookie, refreshToken };
}

/** Exchange refresh token for access token, return parsed JWT payload */
export async function refreshAndParse(stub: any, instanceName: string, refreshToken: string, activeScope?: string): Promise<any> {
  const resp = await stub.fetch(new Request(url(instanceName, 'refresh-token'), {
    method: 'POST',
    headers: {
      'Cookie': `refresh-token=${refreshToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ activeScope: activeScope ?? instanceName }),
  }));
  expect(resp.status).toBe(200);
  const body = await resp.json() as any;
  expect(body.access_token).toBeDefined();
  return { ...body, parsed: parseJwtUnsafe(body.access_token)!.payload };
}

/** Full login flow — request magic link, click it, refresh to get JWT */
export async function fullLogin(stub: any, instanceName: string, email: string) {
  const magicLink = await requestMagicLink(stub, instanceName, email);
  const { refreshToken, setCookie } = await clickMagicLink(stub, magicLink);
  const { parsed, access_token } = await refreshAndParse(stub, instanceName, refreshToken);
  return { magicLink, refreshToken, setCookie, parsed, access_token };
}

/**
 * Make an admin-authenticated request to an endpoint.
 * Returns the Response object.
 */
export async function adminRequest(
  stub: any,
  instanceName: string,
  endpoint: string,
  accessToken: string,
  options: { method?: string; body?: any } = {},
): Promise<Response> {
  const { method = 'GET', body } = options;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return stub.fetch(new Request(url(instanceName, endpoint), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}
