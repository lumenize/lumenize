/**
 * The session a `MeshClient` holds: the token its platform host mints for its page, the scope its
 * page acts in, the address its host names it by, impersonation, logout, and the Profile channel.
 *
 * vitest-plugin, on a Client with no Resources at all, logged in through Mesh's own Registry in test
 * mode (ADR-009 rung 2) against the test Worker's `ClientHostDO`, `PROFILE` and `AUTH_FACADE`.
 * Nebula's lane drives the same members on `NebulaClient` (`impersonate.test.ts`,
 * `client-logout.test.ts`), and `/live` drives them end to end through Nebula's pages
 * (`impersonation-lifecycle`, `resubscribe-when-lost`). The logout limbs stub `window`, since a
 * Client's only observable act there is the navigation, which no Worker sees.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { MeshClient, type MeshClientConfig, type ProfileChannelSnapshot } from '../src/mesh-client';
import { mesh } from '../src/mesh-decorator';
import { isTornDown } from '../src/impersonation';
import type { NodeIdentity } from '../src/types';
import type { ClientHostDO } from './test-worker-and-dos';
import { PLATFORM } from './auth/test-helpers';
import { connectClient, loginAt, loginOf, uniqueScope, type Login } from './support/login';

/** A Client whose one `@mesh()` method reports the context it ran under. */
class SessionClient extends MeshClient {
  @mesh()
  whoAmI(): { callee?: NodeIdentity; caller?: NodeIdentity } {
    const { callee, callChain } = this.lmz.callContext;
    return { callee, caller: callChain.at(-1) };
  }
}

/** A second tab on `login`'s page, `{sub}.{tab}`, connected through its own browser. */
async function anotherTab(login: Login, tab: string, extra: Partial<MeshClientConfig> = {}): Promise<SessionClient> {
  const browser = new Browser();
  const client = new SessionClient({
    instanceName: `${login.sub}.${tab}`, baseUrl: login.baseUrl, refresh: login.refresh,
    fetch: browser.fetch, WebSocket: browser.WebSocket, ...extra,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}

/** A page `window` whose navigation and posts are recorded; framed when `parent` is given. */
function stubWindow(parent?: { postMessage: ReturnType<typeof vi.fn> }) {
  const assign = vi.fn();
  const page: Record<string, unknown> = { location: { assign, href: 'http://page.lumenize.localhost/' } };
  page.self = page;
  page.top = parent ? {} : page;
  if (parent) page.parent = parent;
  vi.stubGlobal('window', page);
  return { assign };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('a Client\'s token comes from its platform host', { timeout: 20000 }, () => {
  // MUTATION: drop `platformOrigin` from the default `refresh`, and the post goes to the page's own
  // host, which a Node fetch cannot even resolve, so the Client never connects.
  it('refreshes off the platform host\'s cookie with no refresh of its own, and acts in the scope its token names', async () => {
    const universe = uniqueScope('s');
    const login = await loginAt(universe);
    const browser = new Browser();
    browser.setCookie(login.cookie.name, login.cookie.value, { domain: new URL(PLATFORM).hostname, path: '/' });
    const page = browser.context(login.baseUrl);
    using client = new SessionClient({
      instanceName: `${login.sub}.tab1`, baseUrl: login.baseUrl, platformOrigin: PLATFORM,
      fetch: page.fetch, WebSocket: page.WebSocket,
    });
    expect(client.activeScope).toBeUndefined();
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
    expect(client.claims?.sub).toBe(login.sub);
    expect(client.activeScope).toBe(universe);
    expect(await client.activeScopeKnown).toBe(universe);
  });
});

describe('a hosted Client knows the address its host holds it under', { timeout: 20000 }, () => {
  // MUTATIONS: don't record the address `connection_status` carries, and the binding is unknown and
  // the Client refuses its own call as a peer's; compare only a caller's host part in
  // `onBeforeCall`, and the second tab below gets in.
  it('sees that address as callee, and calls itself through its host', async () => {
    const host = uniqueScope('s');
    using client = await connectClient(SessionClient, host);
    const address = `${host}/${client.lmz.instanceName}`;
    expect(client.lmz.bindingName).toBe('CLIENT_HOST_DO');

    const seen = await client.lmz.callAsync('CLIENT_HOST_DO', address, client.ctn<SessionClient>().whoAmI());
    const self = { type: 'LumenizeClient', bindingName: 'CLIENT_HOST_DO', instanceName: address };
    expect(seen).toEqual({ callee: self, caller: self });
  });

  it('still refuses another tab of the same sub on the same host, as a peer', async () => {
    const host = uniqueScope('s');
    using first = await connectClient(SessionClient, host);
    using second = await anotherTab(loginOf(first), 'tab2');
    await expect(second.lmz.callAsync('CLIENT_HOST_DO', `${host}/${first.lmz.instanceName}`,
      second.ctn<SessionClient>().whoAmI())).rejects.toThrow('Direct client-to-client calls are disabled by default');
  });
});

describe('impersonate', { timeout: 30000 }, () => {
  // MUTATION: build the child as a bare `MeshClient` rather than this Client's own class, and it
  // is no `SessionClient`, and has no `whoAmI` to call.
  it('returns a Client of this Client\'s own class acting as the subject, on this Client\'s page', async () => {
    const universe = uniqueScope('s');
    using admin = await connectClient(SessionClient, universe); // the universe's first login, its admin
    const member = await loginAt(universe); // invited and accepted, a plain member
    using child = await admin.impersonate(member.sub);

    expect(child).toBeInstanceOf(SessionClient);
    expect(child.claims?.sub).toBe(member.sub);
    expect(child.claims?.act?.sub).toBe(admin.claims?.sub);
    expect(child.activeScope).toBe(universe);
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'), { timeout: 10000 });
    const seen = await child.lmz.callAsync('CLIENT_HOST_DO', `${universe}/${child.lmz.instanceName}`,
      child.ctn<SessionClient>().whoAmI());
    expect(seen.callee?.instanceName).toBe(`${universe}/${member.sub}.tab1.${universe}`);
    // The child calls its host as the subject.
    expect(await child.lmz.callAsync('CLIENT_HOST_DO', universe, child.ctn<ClientHostDO>().echo('as-member')))
      .toBe('as-member');
  });
});

describe('logout', { timeout: 30000 }, () => {
  // MUTATION: drop `logout()`'s impersonated-child branch, and the child sends the page to the
  // platform host's logout page, which would end the admin's own session.
  it('an impersonated child\'s logout ends the child alone and sends the page nowhere', async () => {
    const universe = uniqueScope('s');
    using admin = await connectClient(SessionClient, universe);
    const member = await loginAt(universe);
    const child = await admin.impersonate(member.sub);
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'), { timeout: 10000 });

    const { assign } = stubWindow();
    await child.logout({ everywhere: true });
    expect(assign).not.toHaveBeenCalled();
    expect(child.connectionState).toBe('disconnected');
    expect(admin.connectionState).toBe('connected');
    expect(admin.claims?.sub).toBeDefined();
    expect(isTornDown(admin)).toBe(false);
  });

  // MUTATIONS: drop `clearAccessToken()` and the claims survive; drop the impersonation teardown and
  // the child stays connected; drop the navigation and the stub sees nothing.
  it('drops the token, disconnects, ends its children, and sends a top-level page to the platform host\'s logout page', async () => {
    const universe = uniqueScope('s');
    const adminLogin = await loginAt(universe);
    const browser = new Browser();
    const admin = new SessionClient({
      instanceName: `${adminLogin.sub}.tab1`, baseUrl: adminLogin.baseUrl, refresh: adminLogin.refresh,
      platformOrigin: PLATFORM, fetch: browser.fetch, WebSocket: browser.WebSocket,
    });
    await vi.waitFor(() => expect(admin.connectionState).toBe('connected'), { timeout: 10000 });
    const member = await loginAt(universe);
    const child = await admin.impersonate(member.sub);
    await vi.waitFor(() => expect(child.connectionState).toBe('connected'), { timeout: 10000 });

    const { assign } = stubWindow();
    await admin.logout({ everywhere: true });
    expect(admin.claims).toBeNull();
    expect(admin.connectionState).toBe('disconnected');
    expect(child.connectionState).toBe('disconnected');
    expect(isTornDown(admin)).toBe(true);
    expect(assign).toHaveBeenCalledWith(`${PLATFORM}/auth/logout?everywhere=1`);
  });

  // MUTATION: drop the post to `parentOrigin`, and the parent never hears.
  it('a framed page tells the origin that frames it, and posts nothing without one', async () => {
    const universe = uniqueScope('s');
    const login = await loginAt(universe);
    const parentOrigin = 'http://studio.lumenize.localhost';
    const told = { postMessage: vi.fn() };
    using framed = await anotherTab(login, 'tab1', { parentOrigin, platformOrigin: PLATFORM });
    const { assign } = stubWindow(told);
    await framed.logout();
    expect(told.postMessage).toHaveBeenCalledWith({ type: 'lumenize:logout' }, parentOrigin);
    expect(assign).not.toHaveBeenCalled();

    const silent = { postMessage: vi.fn() };
    using unframed = await anotherTab(login, 'tab2', { platformOrigin: PLATFORM });
    stubWindow(silent);
    await unframed.logout();
    expect(silent.postMessage).not.toHaveBeenCalled();
  });
});

describe('the Profile channel', { timeout: 30000 }, () => {
  // MUTATION: drop the listener call in `handleProfileUpdate`, and the write's push reaches nothing.
  it('subscribes by profileId, settles on the first push, and hears its own later write', async () => {
    using client = await connectClient(SessionClient, uniqueScope('s'));
    const profileId = client.claims!.profileId;
    const heard: Array<ProfileChannelSnapshot | null> = [];
    client.onProfileUpdate((id, snapshot) => { if (id === profileId) heard.push(snapshot); });

    using handle = client.subscribeProfile(profileId);
    const first = await handle.snapshot;
    expect(first?.meta.eTag).toBeDefined();

    await client.updateMyProfile({ nickname: 'Ada' });
    await vi.waitFor(() => expect(heard.map((s) => (s?.value as { nickname?: string })?.nickname)).toContain('Ada'));
  });

  // The loss is real: aborting the host drops its record of the Client, so the reconnect is told
  // `subscriptionRequired: true`, as an evicted host tells it. What the Profile loses meanwhile, its
  // reaper's work after a failed push, is done here by deleting the row. MUTATION: skip the Profile
  // channel in `MeshClient.onSubscriptionRequired`, and the write after the reconnect reaches nobody.
  it('is subscribed again when the host reports the subscriptions lost', async () => {
    const host = uniqueScope('s');
    using client = await connectClient(SessionClient, host);
    const profileId = client.claims!.profileId;
    const heard: string[] = [];
    client.onProfileUpdate((_id, snapshot) => {
      heard.push((snapshot?.value as { nickname?: string })?.nickname ?? '(none)');
    });
    using handle = client.subscribeProfile(profileId);
    await handle.snapshot;

    await runInDurableObject(env.PROFILE.getByName(profileId), (_i: unknown, ctx: DurableObjectState) => {
      ctx.storage.sql.exec('DELETE FROM Subscribers');
    });
    await runInDurableObject(env.CLIENT_HOST_DO.getByName(host), (_i: unknown, ctx: DurableObjectState) => {
      ctx.abort('a host evicted, in a test');
    }).catch(() => { /* the abort rejects the call that ordered it */ });
    await vi.waitFor(() => expect(client.connectionState).toBe('reconnecting'), { timeout: 5000 });
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });

    await client.updateMyProfile({ nickname: 'after the loss' });
    await vi.waitFor(() => expect(heard).toContain('after the loss'), { timeout: 5000 });
  });
});
