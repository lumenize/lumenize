/**
 * Logging a test's Clients in through Mesh's own Registry, in test mode: the Registry hands the
 * magic link back instead of mailing it, and the helper presses the link page's button and takes
 * the refresh cookie the consume set (ADR-009 rung 2). Every `/auth/*` call goes through the test
 * Worker's `fetch` (`SELF`), so the router, the Registry, Workers KV and the token mint all run as
 * they do for a page.
 *
 * The first login at a universe claims it and is its admin; each later one is invited by that admin
 * and is a plain member. A test names its universe with {@link uniqueScope}, so no two tests claim
 * one.
 */
import { expect, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { Browser } from '@lumenize/testing';
import type { MeshClient, MeshClientConfig } from '../../src/mesh-client';
import { foundUniverse, inviteAndLogin, logoutRequest, refresh, refreshCookie, scopeOrigin } from '../auth/test-helpers';

/** A universe slug no other test claims: `prefix-` and eight random characters, `h-1a2b3c4d`. */
export function uniqueScope(prefix = 'u'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** A logged-in user, with what a `MeshClient` needs to connect on a page of `page`'s host. */
export interface Login {
  sub: string;
  email: string;
  /** The universe whose membership the refresh cookie holds. */
  scope: string;
  /** The scope whose host the page is on, the token's `aud`: `scope` unless a login names another. */
  page: string;
  /** Whether the membership is the universe's admin, which only its first login is. */
  admin: boolean;
  /** An access token for a page on `page`'s host, minted at login. */
  accessToken: string;
  /** The refresh cookie the consume set, for a test that puts it in a `Browser`'s jar. */
  cookie: { name: string; value: string };
  /** What a `MeshClient`'s `refresh` calls: a fresh token, from the refresh route with the cookie. */
  refresh: () => Promise<{ access_token: string; sub: string }>;
  /** The page's origin, a Client's `baseUrl`: `http://{host}.lumenize.localhost`. */
  baseUrl: string;
  /** Log out through the logout route, which revokes the refresh cookie, so the next refresh fails. */
  logout: () => Promise<void>;
  /** The same session on a page of another host, `{scope}.first` say: tokens there carry its `aud`. */
  atPage: (page: string) => Promise<Login>;
}

/** Each universe's admin token, so a later login there is invited by them. Unique scopes keep tests apart. */
const admins = new Map<string, string>();

/**
 * Log in at the universe `scope`, on a page of `page`'s host (`scope` itself unless named; a galaxy
 * the universe holds, such as `{scope}.first`, works too). The first login at `scope` claims it.
 */
export async function loginAt(scope: string, options: { page?: string; email?: string } = {}): Promise<Login> {
  const email = options.email ?? `${crypto.randomUUID()}@example.com`;
  const page = options.page ?? scope;
  const founder = admins.get(scope);
  let refreshToken: string;
  let admin: boolean;
  if (founder === undefined) {
    const founded = await foundUniverse(SELF, scope, email);
    admins.set(scope, founded.access_token);
    ({ refreshToken } = founded);
    admin = true;
  } else {
    ({ refreshToken } = await inviteAndLogin(SELF, scope, founder, email));
    admin = false;
  }
  return sessionOn(scope, refreshCookie(scope, refreshToken), page, email, admin);
}

/** The session a refresh cookie holds, on a page of `page`'s host. */
async function sessionOn(scope: string, cookie: string, page: string, email: string, admin: boolean): Promise<Login> {
  const mint = async () => {
    const resp = await refresh(SELF, page, cookie);
    if (resp.status !== 200) throw new Error(`refresh at ${page} answered ${resp.status}: ${await resp.text()}`);
    const { access_token } = await resp.json() as { access_token: string };
    return { access_token, sub: parseJwtUnsafe(access_token)!.payload.sub as string };
  };
  const { access_token, sub } = await mint();
  const logout = async () => {
    const resp = await SELF.fetch(logoutRequest([cookie]));
    if (resp.status !== 200) throw new Error(`logout answered ${resp.status}: ${await resp.text()}`);
  };
  const eq = cookie.indexOf('=');
  return {
    sub, email, scope, page, admin, accessToken: access_token, refresh: mint, baseUrl: scopeOrigin(page), logout,
    cookie: { name: cookie.slice(0, eq), value: cookie.slice(eq + 1) },
    atPage: (other) => sessionOn(scope, cookie, other, email, admin),
  };
}

/** The login each Client {@link connectClient} made was built from. */
const logins = new WeakMap<MeshClient, Login>();

/** The login a Client from {@link connectClient} rides: its `sub`, its scope, its refresh. */
export function loginOf(client: MeshClient): Login {
  const login = logins.get(client);
  if (!login) throw new Error('loginOf: this Client was not made by connectClient');
  return login;
}

/**
 * A real `Client` on a page of `scope`'s host (a fresh universe by default), logged in there and
 * connected through the test Worker as `{sub}.tab1`; resolves once it is connected.
 */
export async function connectClient<C extends MeshClient>(
  Client: new (config: MeshClientConfig) => C,
  scope: string = uniqueScope('h'),
  extra: Partial<MeshClientConfig> = {},
): Promise<C> {
  const login = await loginAt(scope);
  const browser = new Browser();
  const client = new Client({
    instanceName: `${login.sub}.tab1`,
    baseUrl: login.baseUrl,
    refresh: login.refresh,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    ...extra,
  });
  logins.set(client, login);
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}
