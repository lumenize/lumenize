/**
 * What Mesh's two Durable Object bases guarantee whatever a subclass overrides: a scoped node checks
 * passage on every call in a step ahead of `onBeforeCall`, and an unscoped node refuses to run under
 * a name that parses as a scope. Then the two members that moved into Mesh with the scoped base,
 * `requireDominionHere` and `teardown`, on a test node.
 *
 * vitest-plugin, because the nodes under test are Mesh's own test nodes, which no running Nebula
 * hosts: `ClientHostDO`, whose `onBeforeCall` never calls `super`, and `RoomDO`, an unscoped node
 * whose override does the same. Every Client logs in through Mesh's Registry (ADR-009 rung 2).
 * `apps/nebula`'s scope-isolation suite and its `/live` scenarios drive the same steps on Nebula's
 * own nodes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink, type DebugLogOutput } from '@lumenize/debug';
import { LumenizeClient } from '../src/lumenize-client';
import { mesh } from '../src/mesh-decorator';
import { rawRpcStub } from '../src/raw-rpc';
import type { AuthFacade } from '../src/auth/auth-facade';
import type { ClientHostDO, RoomDO } from './test-worker-and-dos';
import { connectClient, loginAt, loginOf, uniqueScope } from './support/login';

/** `LumenizeClient` is abstract; this one adds nothing. */
class PlainClient extends LumenizeClient {}

let entries: DebugLogOutput[] = [];
beforeEach(() => {
  entries = [];
  setDebugSink((e) => entries.push(e));
});
afterEach(() => clearDebugSink());

describe('a scoped node checks passage in a step no override removes', { timeout: 20000 }, () => {
  // MUTATION: move the passage step back into `ScopedMeshDO.onBeforeCall`, and `ClientHostDO`, whose
  // override never calls `super`, runs the call from another universe.
  it('refuses a caller with no passage, though onBeforeCall never calls super, and runs one with it', async () => {
    const mine = uniqueScope('h');
    const theirs = uniqueScope('h');
    using client = await connectClient(PlainClient, mine);
    const host = client.ctn<ClientHostDO>();

    await expect(client.lmz.callAsync('CLIENT_HOST_DO', theirs, host.echo('lateral')))
      .rejects.toThrow(`No passage from "${mine}" into "${theirs}"`);
    // Refused in the step, before the subclass's own hook ran.
    expect(entries.filter((e) => e.namespace === 'lmz.mesh.ScopedMeshDO.passage' && e.data?.instanceName === theirs))
      .toHaveLength(1);
    expect(entries.filter((e) => e.message === 'host admitted a call' && e.data?.instanceName === theirs))
      .toHaveLength(0);

    expect(await client.lmz.callAsync('CLIENT_HOST_DO', mine, host.echo('own'))).toBe('own');
  });
});

describe('a claimless chain is held to the scope of the node that started it', { timeout: 20000 }, () => {
  const answerAt = (host: string, tag: string) => vi.waitFor(async () => {
    const kept = await (env.CLIENT_HOST_DO.getByName(host) as unknown as { answerFor(t: string): Promise<unknown> }).answerFor(tag);
    expect(kept).toBeDefined();
    return kept;
  }, { timeout: 5000 });

  // The rule `claimsForPassage` states: a chain a node started acts from that node's scope, as a
  // plain member. MUTATION: give such a chain no scope, and the upward call is refused.
  it('passes upward from a scoped starter, and is refused sideways', async () => {
    const universe = uniqueScope('h');
    const app = `${universe}.first`;
    const sibling = uniqueScope('h');
    await rawRpcStub('CLIENT_HOST_DO', app).startChainTo(universe, 'up');
    expect(await answerAt(app, 'up')).toBe('up');
    await rawRpcStub('CLIENT_HOST_DO', app).startChainTo(sibling, 'side');
    expect(await answerAt(app, 'side')).toBe(`Error: No passage from "${app}" into "${sibling}"`);
  });

  it('is refused from an unscoped starter, whose name gives it no scope', async () => {
    const host = uniqueScope('h');
    const name = `starter_${crypto.randomUUID()}`;
    const node = env.TEST_DO.getByName(name);
    await node.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: name });
    await node.callForOutcome('CLIENT_HOST_DO', host, 'echo', ['x']);
    await vi.waitFor(async () => expect(await node.getLastCallError()).toBe(`No passage from "(no scope)" into "${host}"`), { timeout: 5000 });
  });
});

describe('a node\'s push to a Client checks passage into the node that sent it', { timeout: 20000 }, () => {
  /** A Client whose push handler answers. */
  class ReceivingClient extends LumenizeClient {
    @mesh()
    receive(value: string): string {
      return `${value}!`;
    }
  }
  const answerAt = (host: string, tag: string) => vi.waitFor(async () => {
    const kept = await (env.CLIENT_HOST_DO.getByName(host) as unknown as { answerFor(t: string): Promise<unknown> }).answerFor(tag);
    expect(kept).toBeDefined();
    return kept;
  }, { timeout: 5000 });

  // `requirePassageIntoSender`: the sibling's push is lateral to the Client's page. MUTATION: skip
  // it in `ScopedMeshDO.onBeforeCallToClient`, and the push is delivered.
  it('refuses a push from a sibling scope\'s node, and delivers its own host\'s', async () => {
    const mine = uniqueScope('h');
    const sibling = uniqueScope('h');
    using client = await connectClient(ReceivingClient, mine);
    const address = `${mine}/${client.lmz.instanceName}`;

    await rawRpcStub('CLIENT_HOST_DO', sibling).pushFromHere(address, 'lateral', 'lateral');
    expect(await answerAt(sibling, 'lateral')).toBe(`Error: No passage from "${mine}" into "${sibling}"`);

    await rawRpcStub('CLIENT_HOST_DO', mine).pushFromHere(address, 'own', 'own');
    expect(await answerAt(mine, 'own')).toBe('own!');
  });

  it('answers a path its HTTP_PREFIXES does not register with 404', async () => {
    const res = await env.CLIENT_HOST_DO.getByName(uniqueScope('h')).fetch('https://example.com/elsewhere');
    expect(res.status).toBe(404);
  });
});

describe('an unscoped node refuses a scope-shaped name at the identity stamp', { timeout: 20000 }, () => {
  // `room-1` parses as the Universe `room-1`; a UUID is past the 30-character slug cap.
  const refusal = /"room-1" parses as a scope, and an UnscopedMeshDO never runs under a scope's name/;

  // MUTATION: move the check into `UnscopedMeshDO.onBeforeCall`, and `RoomDO`, whose override never
  // calls `super`, runs as `room-1`.
  it('refuses a mesh call to a subclass whose onBeforeCall skips super, and runs it as a UUID', async () => {
    using client = await connectClient(PlainClient);
    const room = client.ctn<RoomDO>();
    await expect(client.lmz.callAsync('ROOM_DO', 'room-1', room.whoAmI())).rejects.toThrow(refusal);

    const id = crypto.randomUUID();
    expect(await client.lmz.callAsync('ROOM_DO', id, room.whoAmI())).toBe(id);
  });

  // The `@rawRpc()` entry runs no `onBeforeCall` at all, so only the stamp can refuse it.
  // MUTATION: the same move, and the first touch through `rawRpcStub` names the object `room-1`.
  it('refuses a first touch through rawRpcStub, and runs one under a UUID', async () => {
    await expect(rawRpcStub('ROOM_DO', 'room-1').rawWhoAmI()).rejects.toThrow(refusal);

    const id = crypto.randomUUID();
    expect(await rawRpcStub('ROOM_DO', id).rawWhoAmI()).toBe(id);
  });
});

describe('requireDominionHere on a test node', { timeout: 20000 }, () => {
  // MUTATION: drop `requireDominionHere` from `ClientHostDO.adminOnly`, and the member gets through.
  it('admits an admin of the node, refuses a plain member, and refuses an admin calling from a host below it', async () => {
    const universe = uniqueScope('h');
    using admin = await connectClient(PlainClient, universe); // the universe's first login, its admin
    using member = await connectClient(PlainClient, universe); // invited, a plain member
    expect(await admin.lmz.callAsync('CLIENT_HOST_DO', universe, admin.ctn<ClientHostDO>().adminOnly())).toBe('admin');
    await expect(member.lmz.callAsync('CLIENT_HOST_DO', universe, member.ctn<ClientHostDO>().adminOnly()))
      .rejects.toThrow('Admin access required');

    // The same admin on the page of the universe's app: passage up into the universe, no dominion
    // over it, since dominion reads the calling host's scope (the host rule, ADR-015 and ADR-022).
    const appPage = `${universe}.first`;
    const founder = await loginOf(admin).atPage(appPage);
    const browser = new Browser();
    using onApp = new PlainClient({
      instanceName: `${founder.sub}.tab2`, baseUrl: founder.baseUrl, refresh: founder.refresh,
      fetch: browser.fetch, WebSocket: browser.WebSocket,
    });
    await vi.waitFor(() => expect(onApp.connectionState).toBe('connected'), { timeout: 10000 });
    await expect(onApp.lmz.callAsync('CLIENT_HOST_DO', universe, onApp.ctn<ClientHostDO>().adminOnly()))
      .rejects.toThrow(`Admin access required for ${universe} — the calling host's scope is ${appPage}`);
  });
});

describe('teardown on a test node', { timeout: 30000 }, () => {
  // MUTATIONS: skip `closeAll` in `teardown`, and the Client is never told; skip `deleteAll`, and the
  // node's storage survives its deletion.
  it('a deletion through the facade closes the deleted node\'s Clients with 4410 and wipes its storage', async () => {
    const universe = uniqueScope('h');
    const app = `${universe}.first`;
    // The universe's admin, on its app's page, so the app's node hosts this Client.
    const founder = await loginAt(universe, { page: app });
    const told: string[] = [];
    const browser = new Browser();
    using client = new PlainClient({
      instanceName: `${founder.sub}.tab1`, baseUrl: founder.baseUrl, refresh: founder.refresh,
      fetch: browser.fetch, WebSocket: browser.WebSocket,
      onHostDeleted: (e) => told.push(e.name),
    });
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
    await runInDurableObject(env.CLIENT_HOST_DO.getByName(app), (_i: unknown, ctx: DurableObjectState) => {
      ctx.storage.kv.put('before-the-deletion', 'kept');
    });

    // The deletion's answer goes down the socket the deletion closes, so its Promise rejects; the
    // close is what this waits for.
    void client.lmz.callAsync('AUTH_FACADE', undefined, client.ctn<AuthFacade>().executeScopeDeletion(app))
      .catch(() => {});

    await vi.waitFor(() => expect(told).toEqual(['HostDeletedError']), { timeout: 10000 });
    expect(client.connectionState).toBe('disconnected');
    expect(entries.some((e) => e.namespace === 'nebula.scope.teardown' && e.message === 'tearing down'
      && e.data?.instanceName === app && e.data?.cause === 'deletion')).toBe(true);

    // The 4410 goes out before the wipe, so read the node once the facade has finished the deletion.
    await vi.waitFor(() => expect(entries.some((e) => e.namespace === 'nebula-auth.facade.executeScopeDeletion'
      && e.message === 'deleted' && e.data?.target === app)).toBe(true), { timeout: 10000 });
    const kept = await runInDurableObject(env.CLIENT_HOST_DO.getByName(app), (_i: unknown, ctx: DurableObjectState) =>
      ctx.storage.kv.get('before-the-deletion'));
    expect(kept).toBeUndefined();
  });
});
