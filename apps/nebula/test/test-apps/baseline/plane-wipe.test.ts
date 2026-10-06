/**
 * The plane's wipe erases what the plane owns and rebuilds it, and runs only on the `.dev` Star.
 *
 * Two paths reach it: an install whose row carries `wipeOnInstall`, replacing an installed version,
 * and Studio's Wipe (`resetDevData`). Each limb below is one property of that:
 *   - an install-triggered wipe completes, sends its notice, and leaves no plane row but the root;
 *   - every kind of subscriber hears the notice;
 *   - its ADR-016 record names who triggered it, and on Studio's path who pressed Wipe;
 *   - a grant the wipe erased stops authorizing at once, on a warm isolate;
 *   - a first install never wipes;
 *   - off `.dev`, a replacing row changes nothing, on a Star and on a Galaxy;
 *   - a transaction or invite held at the validator's await across a wipe writes nothing;
 *   - Studio's Wipe records no ontology, so the next op installs once and wipes nothing;
 *   - a second answer for the installed row, or an answer that is no row, changes nothing.
 *
 * In-lane rather than `/live`: every limb reads server-internal state — plane tables, the install
 * record, a DO-side debug marker — or holds a transaction at an await no running stack exposes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import {
  ROOT_NODE_ID, CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_MESSAGE_TYPES, DEFAULT_CHAT_ID,
} from '@lumenize/nebula';
import type { Galaxy, QueryDescriptor, Snapshot, TransactionResult, OntologyVersionConfig } from '@lumenize/nebula';
import {
  adminClientAt, universeAdminClient, foundAndLogin, createSubject, createInvitedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';
import type { GalaxyTest, StarTest } from './index';

const uuid = () => crypto.randomUUID();
const V1 = 'interface TestResource { title: string }\ninterface Parent { name: string }\ninterface Child { parent: Parent; label: string }';
const V2 = 'interface TestResource { title: string; note?: string }\ninterface Parent { name: string }\ninterface Child { parent: Parent; label: string }';
const GALAXY_PAIR = (scope: string) => ({ resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope });
const COMPILE_TIMEOUT_MS = 60_000;

type SinkEntry = { namespace: string; level: string; message: string; data?: Record<string, any> };
let sink: SinkEntry[] = [];
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e as unknown as SinkEntry)); });
afterEach(() => clearDebugSink());
const marks = (namespace: string, message: string) => sink.filter((e) => e.namespace === namespace && e.message === message);
const wipes = (instanceName: string) => marks('nebula.Resources.wipe', 'wipe').filter((e) => e.data?.instanceName === instanceName);

/** The error a raw call answered with, or `null` when it resolved without one. */
async function answer(p: Promise<unknown>): Promise<Error | null> {
  try { const v = await p; return v instanceof Error ? v : null; } catch (e) { return e as Error; }
}
const door = (c: NebulaClientTest) => (c.ctn() as any).resources;

function newDev() {
  const galaxy = `pw-${uuid().slice(0, 8)}.app`;
  return { galaxy, dev: `${galaxy}.dev` };
}
/** A universe admin, active at `scope` — dominion over the `.dev` Star, and passage into it. */
async function admin(galaxy: string, scope: string, ontologyVersion = 'v1', extra?: Record<string, unknown>) {
  return (await universeAdminClient(NebulaClientTest, new Browser(), galaxy, scope, 'admin@example.com', ontologyVersion, extra)).client;
}
/** A plain member OF the `.dev` Star — passage into it, no admin bit anywhere. */
async function devMember(galaxy: string, dev: string, email: string, ontologyVersion = 'v1') {
  const adminBrowser = new Browser();
  // `admin()` founded the universe as this address, so it is the universe's admin here.
  const { accessToken } = await foundAndLogin(adminBrowser, galaxy, 'admin@example.com', galaxy);
  await createSubject(adminBrowser, dev, accessToken, email);
  return createInvitedClient(NebulaClientTest, new Browser(), dev, dev, email, ontologyVersion);
}
/** Hand the Star a compiled row the way its Galaxy's answer arrives. */
async function install(c: NebulaClientTest, star: string, config: OntologyVersionConfig, holdParseMs?: number) {
  await c.lmz.callAsync('STAR', star, c.ctn<StarTest>().applyOntologyForTest(config, holdParseMs), { timeoutMs: COMPILE_TIMEOUT_MS });
}
async function ontologyKv(c: NebulaClientTest, star: string) {
  return c.lmz.callAsync('STAR', star, c.ctn<StarTest>().inspectOntologyKv()) as Promise<{ index: string[]; rowVersions: string[] }>;
}
async function create(c: NebulaClientTest, star: string, version: string, nodeId = ROOT_NODE_ID) {
  const rid = uuid();
  const out = await c.lmz.callAsync('STAR', star, door(c).transaction(version, uuid(), {
    [rid]: { op: 'create', typeName: 'TestResource', nodeId, value: { title: 'x' } },
  })) as TransactionResult;
  return { rid, out };
}
/** Rows in every table outside mesh's and the platform's own (`__…`, `_cf_…`, `sqlite_…`). */
async function planeRows(binding: 'STAR' | 'GALAXY', instance: string): Promise<Record<string, number>> {
  return (runInDurableObject as any)((env as any)[binding].getByName(instance), (_i: any, c: any) => {
    const out: Record<string, number> = {};
    const tables = c.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray() as Array<{ name: string }>;
    for (const { name } of tables) {
      if (/^(__|_cf_|sqlite_)/.test(name)) continue;
      out[name] = (c.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${name}`).toArray()[0] as { n: number }).n;
    }
    return out;
  });
}
const heardNotice = (c: NebulaClientTest) => c.lastErrorObject?.name === 'OntologyStaleError';

describe('an install-triggered wipe on the .dev Star', () => {
  it('completes, sends its notice, and leaves no plane row but the org tree\'s root', async () => {
    const { galaxy, dev } = newDev();
    const a = await admin(galaxy, dev);
    await install(a, dev, { version: 'v1', types: V1 });
    // A row in every plane table first — a node and its edge, a grant, a snapshot, a subscription —
    // so leaving any one table out of the drop leaves a row behind.
    const gone = await a.orgTree.createNode(uuid(), ROOT_NODE_ID, 'gone', 'Gone');
    await a.orgTree.setPermission(gone, 'grantee-sub', 'read');
    const { out } = await create(a, dev, 'v1');
    expect(out.ok).toBe(true);
    const listener = await admin(galaxy, dev);
    await listener.lmz.callAsync('STAR', dev, door(listener).subscribeTree());

    await install(a, dev, { version: 'v2', types: V2, wipeOnInstall: true });

    expect(marks('nebula.Resources.ontology', 'installed').some((e) => e.data?.version === 'v2' && e.data?.wiped === true)).toBe(true);
    expect(marks('nebula.Resources.ontology', 'ontology pull handling failed')).toEqual([]);
    // A send straight after the wipe goes through: the tree subscriber hears the notice.
    await vi.waitFor(() => expect(heardNotice(listener)).toBe(true));
    // Nothing the plane owned survives but the root the rebuilt tree seeds.
    expect(await planeRows('STAR', dev)).toEqual({ Nodes: 1, Edges: 0, Permissions: 0, Snapshots: 0, Subscriptions: 0 });
    a[Symbol.dispose](); listener[Symbol.dispose]();
  });

  it('every kind of subscriber hears the notice', async () => {
    const { galaxy, dev } = newDev();
    const a = await admin(galaxy, dev);
    await install(a, dev, { version: 'v1', types: V1 });
    const { rid } = await create(a, dev, 'v1');
    const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: uuid() };
    // One client per kind, each subscribed to that kind only: the capture dedups by client, so one
    // client holding several kinds would hide a kind the capture dropped.
    const resource = await admin(galaxy, dev);
    const q = await admin(galaxy, dev);
    const roster = await admin(galaxy, dev);
    const tree = await admin(galaxy, dev);
    await resource.lmz.callAsync('STAR', dev, door(resource).subscribe('v1', 'TestResource', rid));
    await q.lmz.callAsync('STAR', dev, door(q).subscribeQuery(query));
    await roster.lmz.callAsync('STAR', dev, door(roster).subscribeQuerySubscribers(query));
    await tree.lmz.callAsync('STAR', dev, door(tree).subscribeTree());

    await install(a, dev, { version: 'v2', types: V2, wipeOnInstall: true });
    await vi.waitFor(() => expect({
      resource: heardNotice(resource), query: heardNotice(q), roster: heardNotice(roster), tree: heardNotice(tree),
    }).toEqual({ resource: true, query: true, roster: true, tree: true }));
    for (const c of [a, resource, q, roster, tree]) c[Symbol.dispose]();
  });

  it('its ADR-016 record names who triggered the install, with the Apply\'s version; Studio\'s names who pressed Wipe', async () => {
    const { galaxy, dev } = newDev();
    const owner = await admin(galaxy, galaxy, CHAT_MESSAGE_ONTOLOGY_VERSION, GALAXY_PAIR(galaxy));
    const writeAndApply = async (types: string, wipe: boolean) => {
      await owner.lmz.callAsync('GALAXY', galaxy, owner.ctn<Galaxy>().writeSource('src/ontology.d.ts', types));
      return (await owner.lmz.callAsync('GALAXY', galaxy, owner.ctn<Galaxy>().applyOntology({ wipe }),
        { timeoutMs: COMPILE_TIMEOUT_MS }) as { version: string }).version;
    };
    const v1 = await writeAndApply(V1, false);
    // B, a plain member of the `.dev` Star, triggers every pull.
    const { client: b, payload: bClaims } = await devMember(galaxy, dev, 'member@example.com', v1);
    const inspector = await admin(galaxy, dev);
    const index = async () => (await ontologyKv(inspector, dev)).index;
    await answer(b.lmz.callAsync('STAR', dev, door(b).read(v1, uuid())));
    await vi.waitFor(async () => expect(await index()).toEqual([v1]));

    const v2 = await writeAndApply(V2, true);
    const applied = marks('nebula.Galaxy.applyOntology', 'wipe on install decided').at(-1)!;
    await answer(b.lmz.callAsync('STAR', dev, door(b).read(v2, uuid())));
    await vi.waitFor(() => expect(wipes(dev)).toHaveLength(1));
    const record = wipes(dev)[0].data!;
    expect(record.cause).toBe('install');
    expect(record.version).toBe(applied.data!.version);
    expect(record.actingToken).toEqual({
      sub: bClaims.sub, act: undefined, profileId: bClaims.profileId, access: bClaims.access, aud: bClaims.aud,
    });

    // Studio's path: whoever pressed Wipe.
    const presser = await admin(galaxy, dev);
    presser.callStarResetDevData(dev);
    await vi.waitFor(() => expect(presser.callCompleted).toBe(true));
    expect(presser.lastError).toBeUndefined();
    const reset = wipes(dev).at(-1)!.data!;
    expect(reset.cause).toBe('reset');
    expect(reset.actingToken.sub).toBe(presser.claims.sub);
    for (const c of [owner, b, inspector, presser]) c[Symbol.dispose]();
  }, 120_000);

  it('a grant the wipe erased stops authorizing at once, on a warm isolate', async () => {
    const { galaxy, dev } = newDev();
    const a = await admin(galaxy, dev);
    await install(a, dev, { version: 'v1', types: V1 });
    const { client: b, payload } = await devMember(galaxy, dev, 'writer@example.com');
    await a.orgTree.setPermission(ROOT_NODE_ID, payload.sub, 'write');
    expect((await create(b, dev, 'v1')).out.ok).toBe(true); // the positive control

    await install(a, dev, { version: 'v2', types: V2, wipeOnInstall: true });
    const { rid, out } = await create(b, dev, 'v2');
    expect(out).toEqual({ ok: false, errors: { [rid]: { type: 'permission', requiredTier: 'write', nodeId: ROOT_NODE_ID } } });
    const state = await a.lmz.callAsync('STAR', dev, door(a).orgTree.getState()) as { nodes: Map<string, unknown>; permissions: Map<string, unknown> };
    expect([...state.nodes.keys()]).toEqual([ROOT_NODE_ID]);
    expect(state.permissions.size).toBe(0);
    a[Symbol.dispose](); b[Symbol.dispose]();
  });
});

describe('a first install never wipes', () => {
  it('a fresh non-.dev Star installs a `wipeOnInstall` row and the op proceeds', async () => {
    const star = `pw-${uuid().slice(0, 8)}.app.tenant-a`;
    const { client: a } = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    await install(a, star, { version: 'v1', types: V1, wipeOnInstall: true });
    expect(await answer(a.lmz.callAsync('STAR', star, door(a).read('v1', uuid())))).toBeNull();
    expect(wipes(star)).toEqual([]);
    a[Symbol.dispose]();
  });

  it('a fresh .dev Star keeps an org tree built before its first install', async () => {
    const { galaxy, dev } = newDev();
    const a = await admin(galaxy, dev);
    const kept = await a.orgTree.createNode(uuid(), ROOT_NODE_ID, 'kept', 'Kept');
    await install(a, dev, { version: 'v1', types: V1, wipeOnInstall: true });
    const state = await a.lmz.callAsync('STAR', dev, door(a).orgTree.getState()) as { nodes: Map<string, unknown> };
    expect(state.nodes.has(kept)).toBe(true);
    expect(wipes(dev)).toEqual([]);
    a[Symbol.dispose]();
  });
});

describe('off the .dev Star, a replacing `wipeOnInstall` row changes nothing', () => {
  it('a Star: the version, the index and a committed Resource are unchanged, no wipe is recorded, and a client pinned to the row ends at the stale signal', async () => {
    const galaxy = `pw-${uuid().slice(0, 8)}.app`;
    const star = `${galaxy}.tenant-a`;
    const owner = await admin(galaxy, galaxy, CHAT_MESSAGE_ONTOLOGY_VERSION, GALAXY_PAIR(galaxy));
    const writeAndApply = async (types: string, wipe: boolean) => {
      await owner.lmz.callAsync('GALAXY', galaxy, owner.ctn<Galaxy>().writeSource('src/ontology.d.ts', types));
      return (await owner.lmz.callAsync('GALAXY', galaxy, owner.ctn<Galaxy>().applyOntology({ wipe }),
        { timeoutMs: COMPILE_TIMEOUT_MS }) as { version: string }).version;
    };
    const v1 = await writeAndApply(V1, false);
    const { client: a } = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com', v1);
    const kept = uuid();
    const created = await a.resources.transaction({
      [kept]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'kept' } } as any,
    });
    expect(created.kind).toBe('committed');

    const v2 = await writeAndApply(V2, true);
    const onShouldRefreshUI = vi.fn();
    const { client: pinned } = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com', v2, { onShouldRefreshUI });
    try {
      await expect(pinned.resources.read('TestResource', kept)).rejects.toMatchObject({ name: 'OntologyStaleError' });
      expect(onShouldRefreshUI).toHaveBeenCalled();
      expect(marks('nebula.Resources.ontology', 'ontology pull handling failed').length).toBeGreaterThan(0);
      expect(wipes(star)).toEqual([]);
      expect(await ontologyKv(a, star)).toEqual({ index: [v1], rowVersions: [v1] });
      expect(((await a.resources.read('TestResource', kept)) as Snapshot).value).toEqual({ title: 'kept' });
    } finally { for (const c of [owner, a, pinned]) c[Symbol.dispose](); }
  }, 120_000);

  it('a Galaxy — including one whose slug is `dev`: the version, a committed Message and an org-tree grant all survive', async () => {
    // `dev` is a legal galaxy slug, so the check has to be segment-precise: `{u}.dev` is a Galaxy.
    const scope = `pw-${uuid().slice(0, 8)}.dev`;
    const owner = await admin(scope, scope, CHAT_MESSAGE_ONTOLOGY_VERSION, GALAXY_PAIR(scope));
    const posted = await owner.postUserMessage('kept');
    await owner.lmz.callAsync('GALAXY', scope, door(owner).orgTree.setPermission(CHAT_NODE_ID, 'grantee-sub', 'write'));
    await owner.lmz.callAsync('GALAXY', scope, owner.ctn<GalaxyTest>().setChatSourceForTest({
      version: 'chat-w2', types: `${CHAT_MESSAGE_TYPES}\ninterface Extra { note: string }`, wipeOnInstall: true,
    }), { timeoutMs: COMPILE_TIMEOUT_MS });

    // The op pinned to the refused row is told stale — not `installing`, since the source answered.
    const refused = await answer(owner.lmz.callAsync('GALAXY', scope, door(owner).read('chat-w2', uuid()), { timeoutMs: COMPILE_TIMEOUT_MS }));
    expect(refused?.name).toBe('OntologyStaleError');
    expect((refused as any).installing).toBeFalsy();
    expect(await owner.lmz.callAsync('GALAXY', scope, owner.ctn<GalaxyTest>().installedChatVersionForTest())).toBe(CHAT_MESSAGE_ONTOLOGY_VERSION);
    expect(((await owner.resources.read('Message', posted)) as Snapshot).value).toMatchObject({ content: 'kept' });
    expect(await owner.lmz.callAsync('GALAXY', scope, door(owner).orgTree.getEffectivePermission(CHAT_NODE_ID, 'grantee-sub'))).toBe('write');
    expect(wipes(scope)).toEqual([]);
    owner[Symbol.dispose]();
  }, 120_000);
});

describe('a transaction or invite held at the validator across a wipe writes nothing', () => {
  // The seam: a row whose validator holds `parseBatch`, and the plane's own cold-load marker, which
  // fires exactly when the first op reaches that validator — so the wipe lands inside the await.
  const HOLD_MS = 3000;
  const paths = [
    { path: 'resetDevData', wipe: (a: NebulaClientTest, dev: string) => a.lmz.callAsync('STAR', dev, a.ctn<StarTest>().resetDevData()) },
    { path: 'an install', wipe: (a: NebulaClientTest, dev: string) => install(a, dev, { version: `v2-${uuid().slice(0, 4)}`, types: V2, wipeOnInstall: true }) },
  ];

  it.each(paths)('a transaction held across $path answers stale, and no snapshot lands', async ({ wipe }) => {
    const { galaxy, dev } = newDev();
    const a = await admin(galaxy, dev);
    const held = `held-${uuid().slice(0, 6)}`;
    await install(a, dev, { version: held, types: V1 }, HOLD_MS);
    const holder = await admin(galaxy, dev);
    const pending = answer(holder.lmz.callAsync('STAR', dev, door(holder).transaction(held, uuid(), {
      [uuid()]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'held' } },
    }), { timeoutMs: 30_000 }));
    await vi.waitFor(() => expect(marks('nebula.Resources.ontology', 'facet cold load').some((e) => e.data?.version === held)).toBe(true));
    await wipe(a, dev);
    expect((await pending)?.name).toBe('OntologyStaleError');
    expect((await planeRows('STAR', dev)).Snapshots).toBe(0);
    a[Symbol.dispose](); holder[Symbol.dispose]();
  }, 60_000);

  it('an invite held across a wipe answers stale too, and writes no invite row', async () => {
    const { galaxy, dev } = newDev();
    const a = await admin(galaxy, dev);
    const held = `held-${uuid().slice(0, 6)}`;
    await install(a, dev, { version: held, types: V1 }, HOLD_MS);
    const holder = await admin(galaxy, dev);
    const pending = answer(holder.lmz.callAsync('STAR', dev, door(holder).invite(ROOT_NODE_ID, [{ email: 'held@example.com', tier: 'read' }]),
      { timeoutMs: 30_000 }));
    await vi.waitFor(() => expect(marks('nebula.Resources.ontology', 'facet cold load').some((e) => e.data?.version === held)).toBe(true));
    await a.lmz.callAsync('STAR', dev, a.ctn<StarTest>().resetDevData());
    expect((await pending)?.name).toBe('OntologyStaleError');
    expect((await planeRows('STAR', dev)).Snapshots).toBe(0);
    a[Symbol.dispose](); holder[Symbol.dispose]();
  }, 60_000);
});

describe('Studio\'s Wipe records no ontology, so the next op installs once and wipes nothing', () => {
  it('the index is empty, the next op is first told `installing`, it installs without a second wipe, and a tree row made after the reset survives', async () => {
    const { galaxy, dev } = newDev();
    const owner = await admin(galaxy, galaxy, CHAT_MESSAGE_ONTOLOGY_VERSION, GALAXY_PAIR(galaxy));
    await owner.lmz.callAsync('GALAXY', galaxy, owner.ctn<Galaxy>().writeSource('src/ontology.d.ts', V1));
    const { version } = await owner.lmz.callAsync('GALAXY', galaxy, owner.ctn<Galaxy>().applyOntology({}),
      { timeoutMs: COMPILE_TIMEOUT_MS }) as { version: string };
    const a = await admin(galaxy, dev, version);
    await answer(a.lmz.callAsync('STAR', dev, door(a).read(version, uuid())));
    await vi.waitFor(async () => expect((await ontologyKv(a, dev)).index).toEqual([version]));

    await a.lmz.callAsync('STAR', dev, a.ctn<StarTest>().resetDevData());
    expect(await ontologyKv(a, dev)).toEqual({ index: [], rowVersions: [] });
    const watcher = await admin(galaxy, dev, version);
    await watcher.lmz.callAsync('STAR', dev, door(watcher).subscribeTree());

    const first = await answer(a.lmz.callAsync('STAR', dev, door(a).read(version, uuid())));
    expect((first as any)?.installing).toBe(true);
    await vi.waitFor(async () => expect((await ontologyKv(a, dev)).index).toEqual([version]));
    expect(wipes(dev).map((e) => e.data!.cause)).toEqual(['reset']);
    const treeRows = await (runInDurableObject as any)((env as any).STAR.getByName(dev), (_i: any, c: any) =>
      c.storage.sql.exec(`SELECT COUNT(*) AS n FROM Subscriptions WHERE kind = 'tree' AND clientId = ?`, watcher.lmz.instanceName).toArray()[0].n);
    expect(treeRows).toBe(1);
    for (const c of [owner, a, watcher]) c[Symbol.dispose]();
  }, 120_000);
});

describe('an answer that installs nothing new changes nothing', () => {
  it('a second answer for the installed row: the Resource survives, and the version and index are unchanged', async () => {
    const { galaxy, dev } = newDev();
    const a = await admin(galaxy, dev);
    await install(a, dev, { version: 'v1', types: V1 });
    const current = { version: 'v2', types: V2, wipeOnInstall: true };
    await install(a, dev, current);
    const { rid, out } = await create(a, dev, 'v2');
    expect(out.ok).toBe(true);

    await install(a, dev, current); // the same row, answered again
    expect(await ontologyKv(a, dev)).toEqual({ index: ['v2'], rowVersions: ['v2'] });
    expect(await answer(a.lmz.callAsync('STAR', dev, door(a).read('v2', rid)))).toBeNull();
    expect(((await a.lmz.callAsync('STAR', dev, door(a).read('v2', rid))) as Snapshot).value).toEqual({ title: 'x' });
    expect(wipes(dev)).toHaveLength(1);
    a[Symbol.dispose]();
  });

  it.each(['null', 'error'] as const)('a source answer of %s: the version is unchanged, and both subscribers hear the next commit', async (kind) => {
    const star = `pw-${uuid().slice(0, 8)}.app.tenant-a`;
    const { client: a } = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    await install(a, star, { version: 'v1', types: V1 });
    const { rid } = await create(a, star, 'v1');
    const { client: listener } = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const resource = listener.resources.subscribe('TestResource', rid);
    await resource.snapshot;
    const parent = uuid();
    const query = listener.resources.subscribeQuery({ queryType: 'parentChild', typeName: 'Child', field: 'parent', value: parent });
    await query.ready;

    await a.lmz.callAsync('STAR', star, a.ctn<StarTest>().deliverOntologyAnswerForTest(kind));
    expect(await ontologyKv(a, star)).toEqual({ index: ['v1'], rowVersions: ['v1'] });

    const [resourceBefore, queryBefore] = [listener.resourceUpdateCount, listener.queryUpdateCount];
    const snap = await a.lmz.callAsync('STAR', star, door(a).read('v1', rid)) as Snapshot;
    // One commit that changes the watched resource and adds a member to the watched query.
    const next = await a.lmz.callAsync('STAR', star, door(a).transaction('v1', uuid(), {
      [rid]: { op: 'put', eTag: snap.meta.eTag, value: { title: 'next' } },
      [parent]: { op: 'create', typeName: 'Parent', nodeId: ROOT_NODE_ID, value: { name: 'p' } },
      [uuid()]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent, label: 'c' } },
    })) as TransactionResult;
    expect(next.ok).toBe(true);
    await vi.waitFor(() => expect(listener.resourceUpdateCount).toBeGreaterThan(resourceBefore));
    await vi.waitFor(() => expect(listener.queryUpdateCount).toBeGreaterThan(queryBefore));
    a[Symbol.dispose](); listener[Symbol.dispose]();
  });
});
