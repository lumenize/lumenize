/**
 * Profile DO (tasks/archive/nebula-profile-store.md): the client subscribe path (binding-agnostic,
 * instance = profileId ≠ activeScope), cross-scope delivery past the host node's passage check, and the
 * `lmz.broadcast` fan-out + dead-subscriber-row drop. Every test is capable-of-failing; the delivery
 * is mutation-checked (see the mutation note in the headline test).
 *
 * ⚠️ **Rung 3 is LOAD-BEARING here** (ADR-009 in-place justification): the assertions read Profile-DO
 * subscriber rows for a SPECIFIC `profileId` and drive clients that must share or differ on it. Real
 * issuance assigns `profileId` server-side, so the identities under test are unreachable through it.
 *
 * Harness: mesh clients with `refresh: createTestToken(...)` in DISTINCT scopes so the subscriber
 * (X) and the writer (Y) sit in different universes, so neither has passage into the other's scope (rung-2/3;
 * ADR-009). A `SubscriberProbe` (a `MeshClient` capturing the dedicated `@mesh handleProfileUpdate`
 * channel) is the receive side; a `NebulaClient` exercises the real `subscribeProfile` client API.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { deploymentOrigin, platformOrigin } from '@lumenize/mesh/client';
import { MeshClient, mesh, type CallEnvelope, type OriginAuth } from '@lumenize/mesh';
import { preprocess } from '@lumenize/structured-clone';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { Browser } from '@lumenize/testing';
import { createTestToken } from '@lumenize/mesh/auth/testing';
import { rawRpcStub } from '@lumenize/mesh/raw-rpc';
import { NEVER_WRITTEN_ETAG, type ProfileChannelSnapshot } from '@lumenize/mesh/client';
import type { Profile, ProfileSnapshot } from '@lumenize/mesh/auth/profile';
import { NebulaClientTest } from './index';
import { ORIGIN, pageOf } from '../../test-helpers';

function uuid(): string { return crypto.randomUUID(); }

/** Receive side: captures pushes on the DEDICATED global-Profile channel (`handleProfileUpdate`, the
 *  production path); ALSO captures `handleResourceUpdate`. Profiles ride their own channel now
 *  (tasks/archive/nebula-subscriber-lists.md). */
class SubscriberProbe extends MeshClient {
  /** Each push on the profile channel, with the `originAuth` it arrived carrying. */
  profileUpdates: Array<{ profileId: string; snapshot: ProfileSnapshot; originAuth?: OriginAuth }> = [];
  updates: Array<{ resourceType: string; resourceId: string; snapshot: ProfileSnapshot }> = [];
  // No onBeforeCall override — the DEFAULT MeshClient guard accepts the fanned-out UPDATE because
  // its immediate caller is the PROFILE DO (not another client); the Profile starts each update's
  // chain afresh, so it is the origin too. The host node's onBeforeCallToClient lets it through because
  // a Profile's name is no scope.
  @mesh()
  handleProfileUpdate(profileId: string, snapshot: ProfileSnapshot): void {
    this.profileUpdates.push({ profileId, snapshot, originAuth: this.lmz.callContext.originAuth });
  }
  @mesh()
  handleResourceUpdate(resourceType: string, resourceId: string, snapshot: ProfileSnapshot): void {
    this.updates.push({ resourceType, resourceId, snapshot });
  }
}

/** A connected mesh client (probe or writer) with a fully-controlled Nebula JWT. */
async function meshClient(opts: {
  profileId?: string; scopeAdmin?: boolean; instanceName?: string; activeScope?: string;
}): Promise<SubscriberProbe> {
  const activeScope = opts.activeScope ?? 'acme.app.tenant';
  const browser = new Browser();
  // On the page of the scope its token names, as a client on any page connects.
  const ctx = browser.context(pageOf(activeScope));
  const client = new SubscriberProbe({
    baseUrl: pageOf(activeScope),
    refresh: createTestToken({
      issuer: platformOrigin(deploymentOrigin(env)),
      privateKey: (env as any).JWT_PRIVATE_KEY_BLUE,
      activeScope, instanceName: opts.instanceName ?? activeScope,
      scopeAdmin: opts.scopeAdmin ?? false, profileId: opts.profileId ?? uuid(), sub: uuid(),
    }),
    fetch: ctx.fetch, WebSocket: ctx.WebSocket,
    sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'));
  return client;
}

/** A Client with no override of the Profile channel, so the base's own bookkeeping runs. */
class PlainClient extends MeshClient {}

/** A connected {@link PlainClient}, renewing its token by a fresh `createTestToken` mint. */
async function healingClient(opts: { activeScope: string }): Promise<PlainClient> {
  const browser = new Browser();
  const ctx = browser.context(pageOf(opts.activeScope));
  const client = new PlainClient({
    baseUrl: pageOf(opts.activeScope),
    refresh: createTestToken({
      issuer: platformOrigin(deploymentOrigin(env)),
      privateKey: (env as any).JWT_PRIVATE_KEY_BLUE,
      activeScope: opts.activeScope, instanceName: opts.activeScope,
      scopeAdmin: false, profileId: uuid(), sub: uuid(),
    }),
    fetch: ctx.fetch, WebSocket: ctx.WebSocket,
    sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'));
  return client;
}

/**
 * A connected REAL `NebulaClient` (via `NebulaClientTest`, which inherits the corrected caller-based
 * default `onBeforeCall` + captures `handleResourceUpdate`) using a PRE-MINTED accessToken (skips the
 * baked cookie refresh). This is the production receive-side — NOT a hand-rolled probe.
 */
async function nebulaClient(opts: { activeScope: string; profileId?: string }): Promise<NebulaClientTest> {
  const { access_token, sub } = await createTestToken({
    issuer: platformOrigin(deploymentOrigin(env)),
    privateKey: (env as any).JWT_PRIVATE_KEY_BLUE,
    activeScope: opts.activeScope, instanceName: opts.activeScope, scopeAdmin: false, ttlSeconds: 3600,
    profileId: opts.profileId ?? uuid(),
  })();
  const browser = new Browser();
  const ctx = browser.context(pageOf(opts.activeScope));
  const client = new NebulaClientTest({
    baseUrl: pageOf(opts.activeScope), platformOrigin: ORIGIN, ontologyVersion: 'v1',
    resourceHostBinding: 'STAR', accessToken: access_token,
    instanceName: `${sub}.${uuid().slice(0, 8)}`,
    fetch: ctx.fetch, WebSocket: ctx.WebSocket,
    sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'));
  return client;
}

/** Subscriber rows currently held by the Profile DO instance `profileId`. */
async function subscriberCount(profileId: string): Promise<number> {
  const stub: any = (env as any).PROFILE.getByName(profileId);
  return (runInDurableObject as any)(stub, (_i: any, c: any) =>
    (c.storage.sql.exec('SELECT COUNT(*) AS n FROM Subscribers').toArray()[0].n as number));
}

const subscribe = (c: SubscriberProbe, pid: string) =>
  c.lmz.callAsync('PROFILE', pid, c.ctn<Profile>().subscribe());
const writeProfile = (c: SubscriberProbe, pid: string, f: { name?: string }) =>
  c.lmz.callAsync('PROFILE', pid, c.ctn<Profile>().writeProfile(f));

describe('Profile DO — subscribe + cross-scope delivery + fanout', () => {
  it('HEADLINE — a subscriber in another universe receives the UPDATE; the initial snapshot answers its own call (#2)', async () => {
    const pid = uuid();
    // Y owns the profile and lives in scope Y; X subscribes from a DISTINCT scope X (neither an admin).
    const owner = await meshClient({ profileId: pid, activeScope: 'universe-y.app.tenant' });
    const x = await meshClient({ activeScope: 'universe-x.app.tenant' });
    // Written first: a Profile nobody has written registers no subscriber for the update to reach.
    await writeProfile(owner, pid, { name: 'Ada' });

    // X subscribes → the INITIAL snapshot is delivered inside X's own subscribe call, carrying X's
    // own claims (asserted here as the open-read demonstration).
    await subscribe(x, pid);
    await vi.waitFor(() => expect(x.profileUpdates.length).toBe(1));
    expect(x.profileUpdates[0]).toMatchObject({ profileId: pid });

    // Y mutates → the UPDATE starts a fresh chain at the Profile and carries no claims. X has no
    // passage into Y's universe, so it is delivered to X ONLY because a Profile's name is no scope.
    // ⚠️ MUTATION-CHECK: in the host node's `requirePassageIntoSender`, refuse a node sender whose name
    // is no scope, and nothing from the Profile arrives — the initial snapshot is the Profile's call
    // to X too, so profileUpdates stays empty.
    await writeProfile(owner, pid, { name: 'Grace' });
    await vi.waitFor(() => expect(x.profileUpdates.length).toBe(2));
    expect(x.profileUpdates[1].snapshot.value).toEqual({ name: 'Grace' });
  });

  it('the fanned-out UPDATE snapshot carries PUBLIC fields only — no privateNotes on the push leg (#①)', async () => {
    const pid = uuid();
    const SENTINEL = `SECRET-${uuid()}`;
    const owner = await meshClient({ profileId: pid, activeScope: 'universe-y.app.tenant' });
    const x = await meshClient({ activeScope: 'universe-x.app.tenant' });
    await owner.lmz.callAsync('PROFILE', pid, owner.ctn<Profile>().writePrivateNotes(SENTINEL));

    await subscribe(x, pid);
    await writeProfile(owner, pid, { name: 'Grace' });
    await vi.waitFor(() => expect(x.profileUpdates.length).toBe(2));
    expect(JSON.stringify(x.profileUpdates)).not.toContain(SENTINEL); // the blob never rides a pushed snapshot
  });

  it('a disconnected subscriber row is DROPPED after a failed fanout push (self-healing) (#3)', async () => {
    const pid = uuid();
    const owner = await meshClient({ profileId: pid, activeScope: 'universe-y.app.tenant' });
    const x = await meshClient({ activeScope: 'universe-x.app.tenant' });
    await writeProfile(owner, pid, { name: 'Ada' });         // created, so a subscribe stores a row
    await subscribe(x, pid);
    await vi.waitFor(async () => expect(await subscriberCount(pid)).toBe(1)); // row present

    x[Symbol.dispose]();                                     // X disconnects
    await writeProfile(owner, pid, { name: 'Grace' });       // fanout push to X fails → ClientDisconnectedError
    await vi.waitFor(async () => expect(await subscriberCount(pid)).toBe(0)); // onProfileBroadcastResult dropped it
  });

  it('client subscribeProfile routes to PROFILE/profileId (≠ activeScope) and resolves with the snapshot (#1/#5)', async () => {
    const pid = uuid();
    const owner = await meshClient({ profileId: pid, activeScope: 'universe-y.app.tenant' });
    await writeProfile(owner, pid, { name: 'Ada' });

    // A real NebulaClient in a DIFFERENT scope subscribes by profileId (instance ≠ its activeScope).
    const client = await nebulaClient({ activeScope: 'universe-x.app.tenant' });
    const snap = await client.subscribeProfile(pid).snapshot;
    expect(snap?.value).toEqual({ name: 'Ada' });           // cross-scope initial snapshot via the client API
  });

  it('a REAL NebulaClient receives a cross-scope profile UPDATE via subscribeProfile — production receive path (#5)', async () => {
    // The whole point of the subscribe path, on the REAL client. The fanned-out update's immediate
    // CALLER is the PROFILE DO, so the corrected caller-based default onBeforeCall accepts it (no
    // override needed); the host node's passage check is the cross-scope boundary.
    const pid = uuid();
    const owner = await meshClient({ profileId: pid, activeScope: 'universe-y.app.tenant' });
    await writeProfile(owner, pid, { name: 'Ada' });

    const client = await nebulaClient({ activeScope: 'universe-x.app.tenant' });
    expect((await client.subscribeProfile(pid).snapshot)?.value).toEqual({ name: 'Ada' });
    const baseline = client.profileUpdateCount;

    await writeProfile(owner, pid, { name: 'Grace' });      // cross-scope UPDATE (owner in scope Y)
    await vi.waitFor(() => expect(client.profileUpdateCount).toBeGreaterThan(baseline));
    expect(client.lastProfileUpdate).toMatchObject({ profileId: pid });
    expect((client.lastProfileUpdate?.snapshot as ProfileSnapshot | null)?.value).toEqual({ name: 'Grace' });
  });

  it('the re-subscribe walk sends a Profile entry to PROFILE, not STAR — the binding-agnostic branch (#5)', async () => {
    const pid = uuid();
    const owner = await meshClient({ profileId: pid, activeScope: 'universe-y.app.tenant' });
    await writeProfile(owner, pid, { name: 'Ada' });
    const client = await nebulaClient({ activeScope: 'universe-x.app.tenant' });
    await client.subscribeProfile(pid).snapshot;
    await vi.waitFor(async () => expect(await subscriberCount(pid)).toBe(1));

    // Drop the DO's subscriber row so ONLY a correct re-subscribe can restore it.
    const stub: any = (env as any).PROFILE.getByName(pid);
    await (runInDurableObject as any)(stub, (_i: any, c: any) => c.storage.sql.exec('DELETE FROM Subscribers'));
    expect(await subscriberCount(pid)).toBe(0);

    // The restore the host's loss report triggers must re-fire the subscribe to PROFILE/pid: the
    // Profile channel is the session's, so `MeshClient.onSubscriptionRequired` restores it. A regression
    // routing it to STAR/pid instead would throw (pid is not a parseId-valid scope) and never re-add the row.
    client.onSubscriptionRequired();
    await vi.waitFor(async () => expect(await subscriberCount(pid)).toBe(1));
  });

  it('subscribeProfile is refcounted — 2 handles share ONE server sub; Profile.unsubscribe fires only on the LAST dispose', async () => {
    const pid = uuid();
    const owner = await meshClient({ profileId: pid, activeScope: 'universe-y.app.tenant' });
    await writeProfile(owner, pid, { name: 'Ada' });
    const client = await nebulaClient({ activeScope: 'universe-x.app.tenant' });

    // Two handles for the same profile — the 2nd coalesces (refcount++), NOT a duplicate server sub.
    const h1 = client.subscribeProfile(pid);
    const h2 = client.subscribeProfile(pid);
    await Promise.all([h1.snapshot, h2.snapshot]);
    await vi.waitFor(async () => expect(await subscriberCount(pid)).toBe(1)); // one DO subscriber row

    // Release ONE handle — the other still holds it open, so NO Profile.unsubscribe fires. Positive
    // signal: a subsequent write still fans out to this client (proves the subscriber row survived).
    h1[Symbol.dispose]();
    const baseline = client.profileUpdateCount;
    await writeProfile(owner, pid, { name: 'Grace' });
    await vi.waitFor(() => expect(client.profileUpdateCount).toBeGreaterThan(baseline)); // reds if h1 dispose unsubscribed early

    // Release the LAST handle → Profile.unsubscribe fires (refcount 0) → the DO row drops.
    h2[Symbol.dispose]();
    await vi.waitFor(async () => expect(await subscriberCount(pid)).toBe(0));
  });

  it('updateMyProfile writes MY profile, and a subscriber answered never-written hears it on its next socket — the back-fill leg', async () => {
    const pid = uuid();
    // The thread-rendering side: a client holding the per-author Profile subscription the byline
    // rides, subscribed before the author has written anything. The Profile answers never-written and
    // registers nothing, so the author's write reaches no one. A person reaches that state when the
    // harness's or a persona's login writes no name; the pre-alpha no-name prompt closes it for people.
    const x = await healingClient({ activeScope: 'universe-x.app.tenant' });
    const heard: ProfileChannelSnapshot[] = [];
    x.onProfileUpdate((id, snapshot) => { if (id === pid) heard.push(snapshot); });
    let required = 0;
    const restore = x.onSubscriptionRequired.bind(x);
    x.onSubscriptionRequired = () => { required += 1; restore(); };
    using handle = x.subscribeProfile(pid);
    expect((await handle.snapshot).meta.eTag).toBe(NEVER_WRITTEN_ETAG);

    // The completing owner: a REAL NebulaClient whose claims carry profileId = pid.
    // ⚠️ `updateMyProfile` routes on the CLAIM, not a parameter, which is what makes it safe to
    // expose to a client at all — a caller cannot name someone else's profile. MUTATION-CHECKED:
    // route updateMyProfile at `this.#activeScope` instead of the profileId claim → the write lands
    // on the wrong Profile instance and the heal below never brings the name.
    const owner = await nebulaClient({ activeScope: 'universe-y.app.tenant', profileId: pid });
    await owner.updateMyProfile({ name: 'Sydney' });

    // A token rotation opens a new socket that supersedes the old one, which its host reports as
    // nothing lost. The re-send of the never-written subscribe there is what heals the byline.
    // MUTATION: drop that re-send in `#handleConnectionStatus`, and the name never arrives.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      await x.lmz.callAsync('PROFILE', pid, x.ctn<Profile>().read());
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(heard.map((s) => (s.value as { name?: string }).name)).toContain('Sydney'));
    expect(required).toBe(0);
  });

  it('an UPDATE carries none of the writer\'s claims — the Profile starts each push\'s chain afresh', async () => {
    const pid = uuid();
    const owner = await meshClient({ profileId: pid, activeScope: 'universe-y.app.tenant' });
    const x = await meshClient({ activeScope: 'universe-x.app.tenant' });
    await writeProfile(owner, pid, { name: 'Ada' });         // created, so a subscribe stores a row

    // POSITIVE CONTROL: the initial snapshot rides X's OWN subscribe call, so X's own claims arrive on
    // it — which shows the probe records `originAuth` at all.
    await subscribe(x, pid);
    await vi.waitFor(() => expect(x.profileUpdates.length).toBe(1));
    expect(x.profileUpdates[0].originAuth?.sub).toBe(x.claims?.sub);

    // The update is a Profile push, not the writer's call, so the writer's `sub`, `aud` and `access`
    // stop at the Profile. MUTATION: pass `newChain: false` in `Profile.#fanout` and the owner's
    // claims arrive here.
    await writeProfile(owner, pid, { name: 'Grace' });
    await vi.waitFor(() => expect(x.profileUpdates.length).toBe(2));
    expect(x.profileUpdates[1].originAuth).toBeUndefined();
  });

  it('subscribe stores the binding from callChain[0] — the element the host node stamps — not the last one', async () => {
    // ⓘ Below the host node on purpose (`testing.md` § *Philosophy*): a client's server-side half
    // builds its call's chain from the verified origin alone (the `/live` scenario `gateway-stamps-the-chain`),
    // so on a client's own call both ends are one element and no client can build this shape. A
    // chain that reaches the Profile through a relaying node can, and this hands the Profile one.
    const pid = uuid();
    const clientId = `${uuid()}.tab1`;
    // Created first, through the consent route's own write, so the subscribe stores a row.
    await rawRpcStub('PROFILE', pid).setDisplayNames({ nickname: 'Ada' });
    const stub: any = (env as any).PROFILE.getByName(pid);
    const envelope: CallEnvelope = {
      version: 1,
      chain: preprocess([{ type: 'get', key: 'subscribe' }, { type: 'apply', args: [] }]),
      callContext: {
        callChain: [
          // Hosted by the Galaxy, so its binding differs from the relaying Star's.
          { type: 'LumenizeClient', bindingName: 'GALAXY', instanceName: `acme.app/${clientId}` },
          { type: 'LumenizeDO', bindingName: 'STAR', instanceName: 'acme.app.tenant' },
        ],
      },
      metadata: {
        caller: { type: 'LumenizeDO', bindingName: 'STAR', instanceName: 'acme.app.tenant' },
        callee: { type: 'LumenizeDO', bindingName: 'PROFILE', instanceName: pid },
      },
    };
    // The row is read off the marker its write logs, never off the table: this subscriber has no
    // socket, so its first snapshot fails and the reaper deletes the row, sometimes before a read.
    const stored: Array<Record<string, unknown>> = [];
    setDebugSink((e) => { if (e.namespace === 'nebula-auth.Profile.subscribe') stored.push(e.data as Record<string, unknown>); });
    try {
      expect(await stub.__executeOperation(envelope)).toEqual({ $ack: true });
      // MUTATION: read `callChain.at(-1)` again and the row stores the relay's `STAR` instead.
      await vi.waitFor(() => expect(stored).toEqual([{ profileId: pid, clientAddress: `GALAXY/acme.app/${clientId}` }]));
    } finally {
      clearDebugSink();
    }
  });
});
