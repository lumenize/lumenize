/**
 * The door: each host's one `@mesh() get resources` hands the wire the plane's request surface,
 * and the surface derives what a caller may not state.
 *
 * Each limb runs on both hosts, because each host is one door onto the same plane:
 *   - the per-op entries are gone — refused as ABSENT — while the same caller's chain through the
 *     door succeeds, which shows the refusal was not for passage;
 *   - each host's own `@mesh()` surface, read off its prototype the way the entry rule reads it;
 *   - `requests` exposes exactly its members, and none of them leads back to the plane;
 *   - a trailing `clientId` or binding a caller appends is ignored: it drops no one else's row,
 *     writes no row under another client's id, and stores no binding the caller chose;
 *   - a chain no client originated is refused and writes nothing;
 *   - a transaction cannot carry an `actor`, so a client cannot forge Nebula's authorship;
 *   - on the Galaxy, a Star-tier caller with no grant is told `permission` as a resolved result,
 *     and a grant opens the same method;
 *   - the response leg: each host's `resourcesResults` is an undecorated getter, no reaper or forward
 *     is left on the host, `results` exposes exactly its members, and from the wire the old reaper
 *     address is refused as absent and `resourcesResults` as not mesh-callable. That the reapers and
 *     the invite answer still RUN through it is shown where each lands: a reap on the local path
 *     in `reaper-wiring.test.ts`, the invite's grant on the fire-back path in `node-invite.test.ts`.
 *
 * In-lane rather than `/live` because every limb asserts a server-side row, a prototype, or a
 * surface object no client can see; the admitted/refused pair also runs live, as a limb of
 * `passage-not-dominion`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { preprocess } from '@lumenize/structured-clone';
import { isMeshCallable } from '@lumenize/mesh';
import {
  Star, Galaxy, Resources, ROOT_NODE_ID, CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, DEFAULT_CHAT_ID,
  canonicalQueryHash,
} from '@lumenize/nebula';
import { NEBULA_SUB } from '@lumenize/nebula-auth';
import type { QueryDescriptor, Snapshot, TransactionResult } from '@lumenize/nebula';
import { adminClientAt, universeAdminClient, createSubject, createInvitedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const uuid = () => crypto.randomUUID();
const TYPES = 'interface TestResource { title: string }\ninterface Parent { name: string }\ninterface Child { parent: Parent; label: string }';
const GALAXY_PAIR = (scope: string) => ({ resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope });
const CHAT_QUERY: QueryDescriptor = { queryType: 'parentChild', typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };

type SinkEntry = { namespace: string; level: string; message: string; data?: Record<string, unknown> };
let sink: SinkEntry[] = [];
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e as unknown as SinkEntry)); });
afterEach(() => clearDebugSink());

/** The message a mesh call was refused with, or `null` when it succeeded. */
async function refusal(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/** One host under test: where it lives, the version it serves, a resource and a query on it, and
 *  a way to mint another client of the same identity (a fresh tab). */
interface Host {
  binding: 'STAR' | 'GALAXY';
  scope: string;
  version: string;
  client(): Promise<NebulaClientTest>;
  /** A `create` op the admin identity is allowed to commit. */
  createOp(): Record<string, any>;
  /** A `put` that changes the resource `rid`. */
  putOp(rid: string, eTag: string): Record<string, any>;
  query: QueryDescriptor;
  resourceType: string;
}

async function starHost(): Promise<Host> {
  const scope = `door-${uuid().slice(0, 8)}.app.tenant-a`;
  const client = () => adminClientAt(NebulaClientTest, new Browser(), scope, scope, 'admin@example.com').then((r) => r.client);
  const admin = await client();
  admin.callStarInstallOntology(scope, { version: 'v1', types: TYPES });
  await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
  expect(admin.lastError).toBeUndefined();
  admin[Symbol.dispose]();
  return {
    binding: 'STAR', scope, version: 'v1', client, resourceType: 'TestResource',
    createOp: () => ({ op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'made' } }),
    putOp: (_rid, eTag) => ({ op: 'put', eTag, value: { title: `edit-${uuid().slice(0, 4)}` } }),
    query: { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: uuid() },
  };
}

async function galaxyHost(): Promise<Host> {
  const scope = `door-${uuid().slice(0, 8)}.app`;
  const client = () => universeAdminClient(
    NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, GALAXY_PAIR(scope),
  ).then((r) => r.client);
  return {
    binding: 'GALAXY', scope, version: CHAT_MESSAGE_ONTOLOGY_VERSION, client, resourceType: 'Message',
    createOp: () => ({ op: 'create', typeName: 'Message', nodeId: CHAT_NODE_ID, value: { chat: DEFAULT_CHAT_ID, content: 'made' } }),
    putOp: (_rid, eTag) => ({ op: 'put', eTag, value: { chat: DEFAULT_CHAT_ID, content: `edit-${uuid().slice(0, 4)}` } }),
    query: CHAT_QUERY,
  };
}

const HOSTS = [
  { name: 'Star', make: starHost },
  { name: 'Galaxy', make: galaxyHost },
] as const;

/** The resource plane's rows of one kind held by `clientId` on a host, with the binding each stores. */
async function rowsOf(host: Host, kind: string, clientId: string): Promise<Array<{ subscriberBinding: string }>> {
  const stub = (env as any)[host.binding].getByName(host.scope);
  return (runInDurableObject as any)(stub, (_i: any, c: any) =>
    c.storage.sql.exec('SELECT subscriberBinding FROM Subscriptions WHERE kind = ? AND clientId = ?', kind, clientId)
      .toArray());
}

/** Commit through the door and return the result. */
async function commit(client: NebulaClientTest, host: Host, ops: Record<string, any>): Promise<TransactionResult> {
  return await client.lmz.callAsync(host.binding, host.scope,
    (client.ctn() as any).resources.transaction(host.version, uuid(), ops)) as TransactionResult;
}

/** The mesh-callable members a host class declares itself, found the way the entry rule finds them. */
function meshSurface(ctor: { prototype: object }): string[] {
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(ctor.prototype)) {
    if (name === 'constructor') continue;
    const d = Object.getOwnPropertyDescriptor(ctor.prototype, name)!;
    const fn = d.get ?? d.value;
    if (typeof fn === 'function' && isMeshCallable(fn)) out.push(name);
  }
  return out.sort();
}

describe('each host has one door, and the per-op entries are gone', () => {
  it.each(HOSTS)('$name: `transaction` is refused as ABSENT, and the same caller\'s `resources.transaction` commits', async ({ make }) => {
    const host = await make();
    const client = await host.client();
    // Matched on the entry rule's ABSENT message — a passage refusal, or "not mesh-callable", would
    // mean the entry survived in some form.
    const absent = await refusal(client.lmz.callAsync(host.binding, host.scope,
      (client.ctn() as any).transaction(host.version, uuid(), { [uuid()]: host.createOp() })));
    expect(absent).toMatch(/No member named 'transaction' exists on this node/);
    // Positive control: the same caller, the same op, through the door.
    const result = await commit(client, host, { [uuid()]: host.createOp() });
    expect(result.ok).toBe(true);
    client[Symbol.dispose]();
  });

  it('each host\'s own @mesh surface is exactly its inventory — the door, and what is not a resource op', () => {
    // A getter carries `@mesh()` on its `get` function, which a `descriptor.value` walk misses — so
    // `resources` appearing here is the proof the walk reads getters. The two lists differ, so
    // neither is written as one: the Galaxy's source entries and registry reads are its own. No
    // reaper is left on either host; they answer through `resourcesResults`.
    expect(meshSurface(Galaxy)).toEqual([
      'applyOntology', 'buildNow', 'getCurrentOntology', 'getGalaxyConfig', 'getOntologyVersion',
      'readSource', 'resources', 'setGalaxyConfig', 'writeSource',
    ]);
    expect(meshSurface(Star)).toEqual(['getStarConfig', 'resetDevData', 'resources', 'setStarConfig']);
  });

  it.each(HOSTS)('$name: `requests` exposes exactly its members, and none of them leads back to the plane', async ({ make }) => {
    const host = await make();
    const { names, toPlane } = await surfaceOf(host, 'resources');
    // Equality, not a subset: no member beyond the row is what the check exists for.
    expect(names).toEqual([
      'invite', 'orgTree', 'read', 'subscribe', 'subscribeQuery', 'subscribeQuerySubscribers', 'subscribeTree',
      'transaction', 'unsubscribe', 'unsubscribeQuery', 'unsubscribeQuerySubscribers',
    ]);
    expect(toPlane).toEqual([]);
  });
});

/**
 * The member names a host's surface object exposes — its own names AND every prototype above them,
 * stopping BEFORE Object.prototype and skipping `constructor` — and which of them resolve to the
 * plane. Own names alone read nothing on a class instance holding a `#` field, and including
 * Object.prototype would make equality fail on correct code.
 */
async function surfaceOf(host: Host, getter: 'resources' | 'resourcesResults'): Promise<{ names: string[]; toPlane: string[] }> {
  const stub = (env as any)[host.binding].getByName(host.scope);
  return (runInDurableObject as any)(stub, (inst: any) => {
    const surface = inst[getter];
    const seen = new Set<string>();
    for (let o = surface; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const n of Object.getOwnPropertyNames(o)) if (n !== 'constructor') seen.add(n);
    }
    const all = [...seen].sort();
    return { names: all, toPlane: all.filter((n) => surface[n] instanceof Resources) };
  });
}

describe('the response leg reaches `results`, and the wire does not', () => {
  const REAPERS = ['onBroadcastResult', 'onQueryBroadcastResult', 'onQuerySubscriberListBroadcastResult', 'onTreeBroadcastResult'];

  it.each([{ name: 'Star', ctor: Star }, { name: 'Galaxy', ctor: Galaxy }])('$name: `resourcesResults` is an UNDECORATED getter, read as the entry rule looks for `@mesh()`', ({ ctor }) => {
    const d = Object.getOwnPropertyDescriptor(ctor.prototype, 'resourcesResults');
    // Positive control: it exists, and as a getter — or the absence below would prove nothing.
    expect(d).toBeDefined();
    expect(typeof d!.get).toBe('function');
    expect(d!.value).toBeUndefined();
    // `getMeshGuard` cannot say this: it reads falsy for a bare `@mesh()` and no `@mesh()` alike.
    expect(isMeshCallable((d!.get ?? d!.value) as (...a: unknown[]) => unknown)).toBe(false);
  });

  it.each([{ name: 'Star', ctor: Star }, { name: 'Galaxy', ctor: Galaxy }])('$name: no reaper and no forward is left on the host', ({ ctor }) => {
    // Undecorated members fall out of every `@mesh()` inventory, so each is asserted absent by name —
    // anywhere on the chain, which is where dispatch would find it.
    for (const name of [...REAPERS, 'onInviteResult', 'onOntologyPulled', 'onPushUndelivered']) {
      expect(name in ctor.prototype, name).toBe(false);
    }
  });

  it.each(HOSTS)('$name: `results` exposes exactly its members, and none of them leads back to the plane', async ({ make }) => {
    const host = await make();
    const { names, toPlane } = await surfaceOf(host, 'resourcesResults');
    expect(names).toEqual(['onInviteResult', 'onOntologyPulled', 'onPushUndelivered', ...REAPERS].sort());
    expect(toPlane).toEqual([]);
  });

  it.each(HOSTS)('$name: the old reaper address is refused as ABSENT, and `resourcesResults` as not mesh-callable, while the same caller\'s `resources` still works', async ({ make }) => {
    const host = await make();
    const client = await host.client();
    const err = Object.assign(new Error('gone'), { name: 'ClientDisconnectedError' });
    const absent = await refusal(client.lmz.callAsync(host.binding, host.scope,
      (client.ctn() as any).onQueryBroadcastResult('some-hash', err)));
    expect(absent).toMatch(/No member named 'onQueryBroadcastResult' exists on this node/);
    const undecorated = await refusal(client.lmz.callAsync(host.binding, host.scope,
      (client.ctn() as any).resourcesResults.onOntologyPulled(null)));
    expect(undecorated).toMatch(/Member 'resourcesResults' is not mesh-callable/);
    // The positive control: the same caller reaches the door.
    expect((await commit(client, host, { [uuid()]: host.createOp() })).ok).toBe(true);
    client[Symbol.dispose]();
  });
});

describe('the door derives the caller\'s own address — a trailing one is ignored', () => {
  it.each(HOSTS)('$name: an unsubscribe with another client\'s id appended drops only the caller\'s own rows', async ({ make }) => {
    const host = await make();
    const a = await host.client();
    const b = await host.client();
    const created = await commit(a, host, { [uuid()]: host.createOp() }) as { ok: true; eTags: Record<string, string> };
    const rid = Object.keys(created.eTags)[0];
    const hash = canonicalQueryHash(host.query);

    // A and B each hold a resource, query and roster row, through the public API. The handles are
    // never disposed: disposing would unsubscribe for real.
    for (const c of [a, b]) {
      await c.resources.subscribe(host.resourceType, rid).snapshot;
      await c.resources.subscribeQuery(host.query).ready;
      await c.subscribeQuerySubscribers(host.query).ready;
    }
    const idA = a.lmz.instanceName!;
    const idB = b.lmz.instanceName!;
    for (const kind of ['resource', 'query', 'roster']) {
      expect(await rowsOf(host, kind, idA)).toHaveLength(1);
      expect(await rowsOf(host, kind, idB)).toHaveLength(1);
    }

    // A appends B's id to every unsubscribe. `execute.ts` passes apply arguments straight through,
    // so the id does arrive; the door must not honour it.
    const door = () => (a.ctn() as any).resources;
    await a.lmz.callAsync(host.binding, host.scope, door().unsubscribe(host.resourceType, rid, idB));
    await a.lmz.callAsync(host.binding, host.scope, door().unsubscribeQuery(hash, idB));
    await a.lmz.callAsync(host.binding, host.scope, door().unsubscribeQuerySubscribers(hash, idB));

    for (const kind of ['resource', 'query', 'roster']) {
      expect(await rowsOf(host, kind, idB)).toHaveLength(1); // B's rows survive
      expect(await rowsOf(host, kind, idA)).toHaveLength(0); // A's go
    }
    a[Symbol.dispose](); b[Symbol.dispose]();
  });

  it.each(HOSTS)('$name: a subscribe with another client\'s id and an undeclared binding appended stores the caller\'s own address', async ({ make }) => {
    const host = await make();
    const a = await host.client();
    const b = await host.client();
    const c = await host.client();
    const bystander = await host.client();
    const created = await commit(a, host, { [uuid()]: host.createOp() }) as { ok: true; eTags: Record<string, string> };
    const rid = Object.keys(created.eTags)[0];
    using heard = bystander.resources.subscribe(host.resourceType, rid);
    await heard.snapshot;

    const idA = a.lmz.instanceName!;
    const idB = b.lmz.instanceName!;
    const forged = [idB, 'NO_SUCH_BINDING'];
    const door = () => (a.ctn() as any).resources;
    await a.lmz.callAsync(host.binding, host.scope, door().subscribe(host.version, host.resourceType, rid, ...forged));
    await a.lmz.callAsync(host.binding, host.scope, door().subscribeQuery(host.query, ...forged));
    await a.lmz.callAsync(host.binding, host.scope, door().subscribeQuerySubscribers(host.query, ...forged));
    await a.lmz.callAsync(host.binding, host.scope, door().subscribeTree(...forged));

    // Every kind's row carries A's id and the binding the Gateway stamped — never the forged pair.
    for (const kind of ['resource', 'query', 'roster', 'tree']) {
      expect(await rowsOf(host, kind, idA)).toEqual([{ subscriberBinding: 'NEBULA_CLIENT_GATEWAY' }]);
      expect(await rowsOf(host, kind, idB)).toEqual([]);
    }
    // A's own initial answers arrive, which is the barrier for B's silence.
    await vi.waitFor(() => expect(a.resourceUpdateCount).toBeGreaterThan(0));
    await vi.waitFor(() => expect(a.orgTreeUpdateCount).toBeGreaterThan(0));
    expect(b.resourceUpdateCount).toBe(0);
    expect(b.orgTreeUpdateCount).toBe(0);
    expect(b.queryUpdateCount).toBe(0);
    expect(b.querySubscribersUpdateCount).toBe(0);

    // A third client's next commit resolves `ok` — a stored unroutable binding would have failed it
    // in the fan-out after the write landed — and the bystander hears it.
    const before = bystander.resourceUpdateCount;
    const next = await commit(c, host, { [rid]: host.putOp(rid, created.eTags[rid]) });
    expect(next.ok).toBe(true);
    await vi.waitFor(() => expect(bystander.resourceUpdateCount).toBeGreaterThan(before));
    for (const x of [a, b, c, bystander]) x[Symbol.dispose]();
  });

  it('a chain no client originated is refused, by message, and writes no row', async () => {
    const host = await starHost();
    // A DO-originated chain: the origin is a Galaxy, not a LumenizeClient. The claims pass the
    // Star's passage check, so the door's own refusal is what stops it.
    const claims = { aud: host.scope, sub: 'door-admin', profileId: 'p-door-admin', access: { authScope: host.scope, scopeAdmin: true } };
    const stub = (env as any).STAR.getByName(host.scope);
    await stub.__executeOperation({
      version: 1,
      chain: preprocess([
        { type: 'get', key: 'resources' }, { type: 'get', key: 'subscribeTree' }, { type: 'apply', args: [] },
      ]),
      callContext: {
        callChain: [{ type: 'LumenizeDO', bindingName: 'GALAXY', instanceName: host.scope.split('.').slice(0, 2).join('.') }],
        originAuth: { sub: 'door-admin', claims },
      },
      metadata: { callee: { type: 'LumenizeDO', bindingName: 'STAR', instanceName: host.scope } },
    });
    await vi.waitFor(() => expect(sink.some((e) => String(e.data?.error)
      .includes('Resources requests need a client origin: callChain[0] must be a LumenizeClient'))).toBe(true));
    const rows = await (runInDurableObject as any)(stub, (_i: any, c: any) =>
      c.storage.sql.exec(`SELECT COUNT(*) AS n FROM Subscriptions WHERE kind = 'tree'`).toArray()[0].n);
    expect(rows).toBe(0);
  });

  it('a transaction carrying an `actor` commits under the caller\'s own claims — no forged `act`', async () => {
    // The door's `transaction` takes three arguments and the plane's op takes no options, so a
    // fourth argument naming Nebula as the actor reaches nothing. Driven on the Galaxy, where a
    // Message whose token carries `act: NEBULA_SUB` would be labelled the agent's own turn.
    const host = await galaxyHost();
    const client = await host.client();
    const mid = uuid();
    const out = await client.lmz.callAsync(host.binding, host.scope,
      (client.ctn() as any).resources.transaction(host.version, uuid(), { [mid]: host.createOp() },
        { actor: { sub: NEBULA_SUB, profileId: NEBULA_SUB }, pinnedAtPost: true })) as TransactionResult;
    expect(out.ok).toBe(true);
    const snap = await client.resources.read('Message', mid) as Snapshot;
    expect(snap.meta.actingToken.sub).toBe(client.claims.sub);
    expect(snap.meta.actingToken.act).toBeUndefined();
    client[Symbol.dispose]();
  });
});

describe('the Galaxy tells a Star-tier caller with no grant `permission`, and a grant opens the same method', () => {
  it('a `.dev` admin with no chat-node grant is told `permission` as a RESOLVED result; `write` makes it `ok`', async () => {
    const scope = `door-${uuid().slice(0, 8)}.app`;
    const { client: owner, accessToken } = await universeAdminClient(
      NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, GALAXY_PAIR(scope),
    );
    const posted = await owner.postUserMessage('something to read');
    // A Star-tier caller: the galaxy invite co-mints a `.dev` membership WITH `scopeAdmin`, whose
    // dominion stops at the `.dev` Star — so passage carries it up to the Galaxy and nothing more.
    const adminBrowser = new Browser();
    await createSubject(adminBrowser, scope, accessToken, 'tenant@example.com');
    const { client: tenant, payload } = await createInvitedClient(
      NebulaClientTest, new Browser(), `${scope}.dev`, `${scope}.dev`, 'tenant@example.com',
      CHAT_MESSAGE_ONTOLOGY_VERSION, GALAXY_PAIR(scope),
    );
    expect(payload.access.authScope).toBe(`${scope}.dev`); // the fixture is the Star-tier shape
    let rid = uuid();
    const txn = () => tenant.lmz.callAsync('GALAXY', scope, tenant.ctn<Galaxy>().resources.transaction(
      CHAT_MESSAGE_ONTOLOGY_VERSION, uuid(), { [rid]: { op: 'create', typeName: 'Message', nodeId: CHAT_NODE_ID, value: { chat: DEFAULT_CHAT_ID, content: 'up' } } },
    )) as Promise<TransactionResult>;

    // RESOLVED, not rejected: a passage refusal would reject. The structured error names the tier
    // and the node — a boundary refusal carries neither.
    const denied = await txn();
    expect(denied).toEqual({ ok: false, errors: { [rid]: { type: 'permission', requiredTier: 'write', nodeId: CHAT_NODE_ID } } });
    // The message-matched limb uses `read`, which rejects with the DAG's own message.
    const readRefusal = await refusal(tenant.lmz.callAsync('GALAXY', scope,
      tenant.ctn<Galaxy>().resources.read(CHAT_MESSAGE_ONTOLOGY_VERSION, posted)));
    expect(readRefusal).toMatch(/read permission required on node/);

    await owner.lmz.callAsync('GALAXY', scope,
      owner.ctn<Galaxy>().resources.orgTree.setPermission(CHAT_NODE_ID, payload.sub, 'write'));
    rid = uuid();
    expect((await txn()).ok).toBe(true);
    owner[Symbol.dispose](); tenant[Symbol.dispose]();
  });
});
