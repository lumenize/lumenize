/**
 * Profile DO — Phase 3 (tasks/nebula-profile-store.md): the client subscribe path (binding-agnostic,
 * instance = profileId ≠ activeScope), the Gateway PROFILE-fence (cross-scope delivery), and the
 * hand-rolled fanout + dead-subscriber-row drop. Every test is capable-of-failing; the fence is
 * mutation-checked (see the mutation note in the headline test).
 *
 * ⚠️ **Rung 3 is LOAD-BEARING here** (ADR-009 in-place justification): the assertions read Profile-DO
 * subscriber rows for a SPECIFIC `profileId` and drive clients that must share or differ on it. Real
 * issuance assigns `profileId` server-side, so the identities under test are unreachable through it.
 *
 * Harness: mesh clients with `refresh: createNebulaTestToken(...)` in DISTINCT scopes so the subscriber
 * (X) and the writer (Y) carry genuinely different `aud`s — the lever the fence gates on (rung-2/3;
 * ADR-009). A `SubscriberProbe` (a `LumenizeClient` capturing the dedicated `@mesh handleProfileUpdate`
 * channel) is the receive side; a `NebulaClient` exercises the real `subscribeProfile` client API.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { LumenizeClient, mesh } from '@lumenize/mesh';
import { Browser } from '@lumenize/testing';
import { createNebulaTestToken } from '@lumenize/nebula-auth/testing';
import type { Profile, ProfileSnapshot } from '@lumenize/nebula-auth/profile';
import { NebulaClientTest } from './index';

const ORIGIN = 'http://localhost';
function uuid(): string { return crypto.randomUUID(); }

/** Receive side: captures pushes on the DEDICATED global-Profile channel (`handleProfileUpdate`, the
 *  production path); ALSO captures `handleResourceUpdate` solely for the STAR-origin negative-control push
 *  in the fence test. Profiles ride their own channel now (tasks/nebula-subscriber-lists.md). */
class SubscriberProbe extends LumenizeClient {
  profileUpdates: Array<{ profileId: string; snapshot: ProfileSnapshot }> = [];
  updates: Array<{ resourceType: string; resourceId: string; snapshot: ProfileSnapshot }> = [];
  // No onBeforeCall override — the DEFAULT LumenizeClient guard accepts the fanned-out UPDATE because
  // its immediate caller is the PROFILE DO (not another client), even though the UPDATE ORIGINATES in
  // the writer's chain. The cross-scope boundary remains the Gateway's onBeforeCallToClient (PROFILE-fence).
  @mesh()
  handleProfileUpdate(profileId: string, snapshot: ProfileSnapshot): void {
    this.profileUpdates.push({ profileId, snapshot });
  }
  @mesh()
  handleResourceUpdate(resourceType: string, resourceId: string, snapshot: ProfileSnapshot): void {
    this.updates.push({ resourceType, resourceId, snapshot });
  }
}

/** A connected mesh client (probe or writer) with a fully-controlled Nebula JWT. */
async function meshClient(opts: {
  profileId?: string; isAdmin?: boolean; instanceName?: string; activeScope?: string;
}): Promise<SubscriberProbe> {
  const activeScope = opts.activeScope ?? 'acme.app.tenant';
  const browser = new Browser();
  const ctx = browser.context(ORIGIN);
  const client = new SubscriberProbe({
    baseUrl: ORIGIN,
    gatewayBindingName: 'NEBULA_CLIENT_GATEWAY',
    refresh: createNebulaTestToken({
      privateKey: (env as any).JWT_PRIVATE_KEY_BLUE,
      activeScope, instanceName: opts.instanceName ?? activeScope,
      isAdmin: opts.isAdmin ?? false, profileId: opts.profileId, sub: uuid(),
    }),
    fetch: browser.fetch, WebSocket: browser.WebSocket,
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
async function nebulaClient(opts: { activeScope: string }): Promise<NebulaClientTest> {
  const { access_token, sub } = await createNebulaTestToken({
    privateKey: (env as any).JWT_PRIVATE_KEY_BLUE,
    activeScope: opts.activeScope, instanceName: opts.activeScope, isAdmin: false, ttlSeconds: 3600,
  })();
  const browser = new Browser();
  const ctx = browser.context(ORIGIN);
  const client = new NebulaClientTest({
    baseUrl: ORIGIN, authScope: opts.activeScope, activeScope: opts.activeScope, appVersion: 'v1',
    resourceHostBinding: 'STAR', accessToken: access_token,
    instanceName: `${sub}.${uuid().slice(0, 8)}`,
    fetch: browser.fetch, WebSocket: browser.WebSocket,
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

describe('Profile DO — Phase 3 (subscribe + fence + fanout)', () => {
  it('HEADLINE — a cross-scope subscriber receives the UPDATE via the PROFILE-fence; the initial snapshot rides its own aud (#2)', async () => {
    const pid = uuid();
    // Y owns the profile and lives in scope Y; X subscribes from a DISTINCT scope X (neither an admin).
    const owner = await meshClient({ profileId: pid, activeScope: 'universe-y.app.tenant' });
    const x = await meshClient({ activeScope: 'universe-x.app.tenant' });

    // X subscribes → the INITIAL snapshot is delivered inside X's own subscribe call (inherits X's aud),
    // so it arrives EVEN WITHOUT the fence (asserted here as the open-read demonstration).
    await subscribe(x, pid);
    await vi.waitFor(() => expect(x.profileUpdates.length).toBe(1));
    expect(x.profileUpdates[0]).toMatchObject({ profileId: pid });

    // Y mutates → the UPDATE fanout originates in Y's scope (aud Y ≠ X's connection aud), so it is
    // delivered to X ONLY because the PROFILE-fence skips the same-aud check. ⚠️ MUTATION-CHECK: remove
    // the `bindingName === 'PROFILE'` early-return in NebulaClientGateway.onBeforeCallToClient and this
    // second update never arrives (profileUpdates stays length 1) while the initial snapshot above still
    // does — exactly isolating the fence to the update leg.
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
    // The whole point of Phase 3, on the REAL client. The fanned-out update rides the WRITER's chain,
    // but its immediate CALLER is the PROFILE DO, so the corrected caller-based default onBeforeCall
    // accepts it (no override needed); the Gateway fence remains the real cross-scope boundary.
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

  it('reconnect re-subscribes a Profile entry to PROFILE, not STAR — the binding-agnostic reconnect branch (#5)', async () => {
    const pid = uuid();
    const owner = await meshClient({ profileId: pid, activeScope: 'universe-y.app.tenant' });
    await writeProfile(owner, pid, { name: 'Ada' });
    const client = await nebulaClient({ activeScope: 'universe-x.app.tenant' });
    await client.subscribeProfile(pid).snapshot;
    await vi.waitFor(async () => expect(await subscriberCount(pid)).toBe(1));

    // Drop the DO's subscriber row so ONLY a correct reconnect re-subscribe can restore it.
    const stub: any = (env as any).PROFILE.getByName(pid);
    await (runInDurableObject as any)(stub, (_i: any, c: any) => c.storage.sql.exec('DELETE FROM Subscribers'));
    expect(await subscriberCount(pid)).toBe(0);

    // The reconnect walk must re-fire the subscribe to PROFILE/pid. A regression routing it to
    // STAR/pid instead would throw (pid is not a parseId-valid scope) and never re-add the row.
    (client as any)._resubscribeAllForTest();
    await vi.waitFor(async () => expect(await subscriberCount(pid)).toBe(1));
  });

  it('the fence is PROFILE-scoped — a cross-scope STAR-origin push is REJECTED while cross-scope PROFILE pushes are allowed (#6)', async () => {
    const pid = uuid();
    const yScope = 'universe-y.app.tenant';
    // One client is BOTH the profile owner AND a STAR admin in scope Y; the subscriber X is cross-scope.
    const owner = await meshClient({ profileId: pid, isAdmin: true, activeScope: yScope, instanceName: yScope });
    const x = await meshClient({ activeScope: 'universe-x.app.tenant' });

    await subscribe(x, pid);
    await vi.waitFor(() => expect(x.profileUpdates.length).toBe(1));  // initial PROFILE snapshot (cross-scope, fence-allowed)

    // Fire a STAR-origin cross-scope push to X FIRST (bindingName='STAR' ≠ 'PROFILE', aud Y ≠ X → the
    // untouched aud check must reject it at the Gateway, so it never reaches X). It targets the RESOURCE
    // channel (`handleResourceUpdate`), distinct from the profile channel — the negative control.
    await owner.lmz.callAsync('STAR', yScope,
      (owner.ctn() as any).callClient(x.lmz.instanceName, 'handleResourceUpdate', 'StarPush', 'star-probe', { value: {}, meta: { eTag: '0' } }));
    // ...then a PROFILE update, which IS delivered (fence skips) — a same-connection barrier: once THIS
    // lands on X (on the profile channel), the earlier STAR push would have too if the fence had let it through.
    await writeProfile(owner, pid, { name: 'Grace' });
    await vi.waitFor(() => expect(x.profileUpdates.some((u) => u.profileId === pid && u.snapshot.value?.name === 'Grace')).toBe(true));

    expect(x.updates.some((u) => u.resourceId === 'star-probe')).toBe(false); // the STAR-origin push was gated
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
});
