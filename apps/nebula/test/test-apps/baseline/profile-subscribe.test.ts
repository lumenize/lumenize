/**
 * Profile DO — Phase 3 (tasks/nebula-profile-store.md): the client subscribe path (binding-agnostic,
 * instance = profileId ≠ activeScope), the Gateway PROFILE-fence (cross-scope delivery), and the
 * hand-rolled fanout + dead-subscriber-row drop. Every test is capable-of-failing; the fence is
 * mutation-checked (see the mutation note in the headline test).
 *
 * Harness: mesh clients with `refresh: createNebulaTestToken(...)` in DISTINCT scopes so the subscriber
 * (X) and the writer (Y) carry genuinely different `aud`s — the lever the fence gates on (rung-2/3;
 * ADR-009). A `SubscriberProbe` (a `LumenizeClient` with a capturing `@mesh handleResourceUpdate`) is
 * the receive side; a `NebulaClient` exercises the real `subscribeProfile` client API.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { LumenizeClient, mesh } from '@lumenize/mesh';
import { Browser } from '@lumenize/testing';
import { NebulaClient } from '@lumenize/nebula';
import { createNebulaTestToken } from '@lumenize/nebula-auth/testing';
import type { Profile, ProfileSnapshot } from '@lumenize/nebula-auth/profile';

const ORIGIN = 'http://localhost';
function uuid(): string { return crypto.randomUUID(); }

/** Receive side: captures every pushed `handleResourceUpdate` (the client-facing continuation target). */
class SubscriberProbe extends LumenizeClient {
  updates: Array<{ resourceType: string; resourceId: string; snapshot: ProfileSnapshot }> = [];
  // Permissive onBeforeCall — accept unsolicited peer-to-peer pushes (the fanned-out UPDATE originates
  // in the WRITER's chain, not this client's). The real NebulaClient does the same, delegating the
  // boundary to the Gateway's onBeforeCallToClient (the PROFILE-fence). Without this, the default
  // rejects the update with "Peer-to-peer client calls are disabled by default".
  override onBeforeCall(): void {}
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

/** A connected real `NebulaClient` via a PRE-MINTED accessToken (skips the baked cookie refresh). */
async function nebulaClient(opts: { activeScope: string }): Promise<NebulaClient> {
  const { access_token, sub } = await createNebulaTestToken({
    privateKey: (env as any).JWT_PRIVATE_KEY_BLUE,
    activeScope: opts.activeScope, instanceName: opts.activeScope, isAdmin: false, ttlSeconds: 3600,
  })();
  const browser = new Browser();
  const ctx = browser.context(ORIGIN);
  const client = new NebulaClient({
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
    await vi.waitFor(() => expect(x.updates.length).toBe(1));
    expect(x.updates[0]).toMatchObject({ resourceType: 'Profile', resourceId: pid });

    // Y mutates → the UPDATE fanout originates in Y's scope (aud Y ≠ X's connection aud), so it is
    // delivered to X ONLY because the PROFILE-fence skips the same-aud check. ⚠️ MUTATION-CHECK: remove
    // the `bindingName === 'PROFILE'` early-return in NebulaClientGateway.onBeforeCallToClient and this
    // second update never arrives (updates stays length 1) while the initial snapshot above still does —
    // exactly isolating the fence to the update leg.
    await writeProfile(owner, pid, { name: 'Grace' });
    await vi.waitFor(() => expect(x.updates.length).toBe(2));
    expect(x.updates[1].snapshot.value).toEqual({ name: 'Grace' });
  });

  it('the fanned-out UPDATE snapshot carries PUBLIC fields only — no privateNotes on the push leg (#①)', async () => {
    const pid = uuid();
    const SENTINEL = `SECRET-${uuid()}`;
    const owner = await meshClient({ profileId: pid, activeScope: 'universe-y.app.tenant' });
    const x = await meshClient({ activeScope: 'universe-x.app.tenant' });
    await owner.lmz.callAsync('PROFILE', pid, owner.ctn<Profile>().writePrivateNotes(SENTINEL));

    await subscribe(x, pid);
    await writeProfile(owner, pid, { name: 'Grace' });
    await vi.waitFor(() => expect(x.updates.length).toBe(2));
    expect(JSON.stringify(x.updates)).not.toContain(SENTINEL); // the blob never rides a pushed snapshot
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
    const snap = await client.subscribeProfile(pid);
    expect(snap?.value).toEqual({ name: 'Ada' });           // cross-scope initial snapshot via the client API
  });
});
