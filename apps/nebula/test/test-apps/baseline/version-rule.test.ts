/**
 * One version rule for every host (the plane's `#gateClientOp` and `#gateServer`), and every op on
 * an empty host takes the same path.
 *
 * Each host keeps only where its ontology comes from. The Star asks its Galaxy and is answered by
 * fire-back, so an op on an empty Star is told `checking`; the Galaxy's source is the platform
 * seed, which answers at once. The rule is the plane's: ask the source only on a mismatch, and only
 * once while an answer is outstanding, install a row that differs, and answer the op for what it
 * pinned.
 *
 *   - a Galaxy whose source answers a newer seed drains the old subscribers, then serves the client
 *     that pinned the new version — the Galaxy half, which nothing else exercises until the chat
 *     label is first bumped — and installs a second bump the same way;
 *   - what is installed survives a re-initialized DO, host × {upgrade, revert} — the rule's old
 *     failure was cold ("after eviction every operation threw index/row drift");
 *   - the source is asked only on a mismatch, and an op with no version is answered stale;
 *   - one ask per version change: every answer ends the ask, and an unanswered one expires;
 *   - each op's FIRST answer on an empty Star is `checking`, and on an empty Galaxy it is not;
 *   - the client's retries land each kind of subscribe, and when they run out it ends at the stale
 *     signal and reloads nothing, since the Star names no version.
 *
 * In-lane rather than `/live`: the source-ask count is a DO-internal marker, the first answer of a
 * raw op is hidden by the client's own retry, and a re-initialized DO is a state no client can make.
 * `star-serves-current-ontology` and `node-invite-roundtrip` witness the Star's pull live.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import git from 'isomorphic-git';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { ROOT_NODE_ID, canonicalQueryHash } from '@lumenize/resources';
import { CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_MESSAGE_TYPES, DEFAULT_CHAT_ID } from '@lumenize/nebula';
import type { Galaxy, Star } from '@lumenize/nebula';
import type { QueryDescriptor, TransactionResult } from '@lumenize/resources';
import { adminClientAt, universeAdminClient, addressOfClient } from '../../test-helpers';
import { NebulaClientTest } from './index';
import type { GalaxyTest, StarTest } from './index';

const uuid = () => crypto.randomUUID();
const TYPES_V1 = 'interface TestResource { title: string }\ninterface Parent { name: string }\ninterface Child { parent: Parent; label: string }';
const TYPES_V2 = 'interface TestResource { title: string; note?: string }\ninterface Parent { name: string }\ninterface Child { parent: Parent; label: string }';
const CHAT_V2 = { version: 'chat-v2', types: `${CHAT_MESSAGE_TYPES}\ninterface Extra { note: string }` };
const GALAXY_PAIR = (scope: string) => ({ resourceHostBinding: 'GALAXY' });
const CHAT_QUERY: QueryDescriptor = { queryType: 'parentChild', typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };
/** The Galaxy's install and the faked build's compile run in place (typia); a hang still reds. */
const COMPILE_TIMEOUT_MS = 60_000;

type SinkEntry = { namespace: string; level: string; message: string; data?: Record<string, any> };
let sink: SinkEntry[] = [];
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e as unknown as SinkEntry)); });
afterEach(() => clearDebugSink());

/** The source asks the plane made on `instanceName`, counted from the marker it stamps. */
const asks = (instanceName: string) =>
  sink.filter((e) => e.namespace === 'nebula.Resources.source' && e.message === 'ask' && e.data?.instanceName === instanceName).length;

/** The error a raw call answered with, or `null` when it resolved without one. */
async function answer(p: Promise<unknown>): Promise<Error | null> {
  try { const v = await p; return v instanceof Error ? v : null; } catch (e) { return e as Error; }
}

const door = (c: NebulaClientTest) => (c.ctn() as any).resources;

async function starAdmin(star: string, ontologyVersion = 'v1', extra?: Record<string, unknown>) {
  return (await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com', ontologyVersion, extra)).client;
}
async function install(admin: NebulaClientTest, star: string, version: string, types: string) {
  admin.callStarInstallOntology(star, { version, types });
  await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
  expect(admin.lastError).toBeUndefined();
}
async function galaxyOwner(scope: string, ontologyVersion = CHAT_MESSAGE_ONTOLOGY_VERSION) {
  return (await universeAdminClient(
    NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', ontologyVersion, GALAXY_PAIR(scope),
  )).client;
}
const newGalaxy = () => `vr-${uuid().slice(0, 8)}.app`;
const newStar = () => `vr-${uuid().slice(0, 8)}.app.tenant-a`;

describe('a Galaxy serves a newer seed its source answers', () => {
  it('drains the old version\'s subscribers, then serves the client that pinned the new one', async () => {
    const scope = newGalaxy();
    const owner = await galaxyOwner(scope);
    // A subscriber on the platform seed's version holds a query row.
    const old = await galaxyOwner(scope);
    const sub = old.resources.subscribeQuery(CHAT_QUERY);
    await sub.ready;
    await owner.lmz.callAsync('GALAXY', scope, owner.ctn<GalaxyTest>().setChatSourceForTest(CHAT_V2), { timeoutMs: COMPILE_TIMEOUT_MS });

    // The client pinned to the new version posts; its op finds the mismatch, the source answers the
    // newer row, the plane installs it and serves this op.
    const posted = await owner.lmz.callAsync('GALAXY', scope, door(owner).transaction('chat-v2', uuid(), {
      [uuid()]: { op: 'create', typeName: 'Message', nodeId: CHAT_NODE_ID, value: { chat: DEFAULT_CHAT_ID, content: 'on v2' } },
    }), { timeoutMs: COMPILE_TIMEOUT_MS }) as TransactionResult;
    expect(posted.ok).toBe(true);
    expect(await owner.lmz.callAsync('GALAXY', scope, owner.ctn<GalaxyTest>().installedChatVersionForTest())).toBe('chat-v2');

    // The drain came first: the old subscriber was told once, naming the new version, and its row went.
    await vi.waitFor(() => {
      expect(old.lastErrorObject?.name).toBe('OntologyStaleError');
      expect((old.lastErrorObject as any).currentVersion).toBe('chat-v2');
    });
    // The old subscriber's query row went with the drain.
    const oldRows = await (runInDurableObject as any)((env as any).GALAXY.getByName(scope), (_i: any, c: any) =>
      c.storage.sql.exec(`SELECT COUNT(*) AS n FROM Subscriptions WHERE kind = 'query' AND clientAddress = ?`, addressOfClient(old))
        .toArray()[0].n);
    expect(oldRows).toBe(0);
    owner[Symbol.dispose](); old[Symbol.dispose]();
  });

  // A source that answers at once leaves no ask outstanding, so a second bump is asked about and
  // installed like the first. Mutation: remember every ask, not only one answered later.
  it('installs a second newer seed too', async () => {
    const scope = newGalaxy();
    const owner = await galaxyOwner(scope);
    for (const next of [CHAT_V2, { version: 'chat-v3', types: `${CHAT_V2.types}\ninterface More { n: number }` }]) {
      await owner.lmz.callAsync('GALAXY', scope, owner.ctn<GalaxyTest>().setChatSourceForTest(next), { timeoutMs: COMPILE_TIMEOUT_MS });
      const posted = await owner.lmz.callAsync('GALAXY', scope, door(owner).transaction(next.version, uuid(), {
        [uuid()]: { op: 'create', typeName: 'Message', nodeId: CHAT_NODE_ID, value: { chat: DEFAULT_CHAT_ID, content: `on ${next.version}` } },
      }), { timeoutMs: COMPILE_TIMEOUT_MS }) as TransactionResult;
      expect(posted.ok).toBe(true);
      expect(await owner.lmz.callAsync('GALAXY', scope, owner.ctn<GalaxyTest>().installedChatVersionForTest())).toBe(next.version);
    }
    owner[Symbol.dispose]();
  });
});

describe('what is installed survives a re-initialized DO', () => {
  // The rule's old failure split on warm versus cold: a plane that caches what it installed without
  // recording it passes every warm check. Each case installs warm, asserts the pinned client's
  // answer, re-initializes the DO, and asserts the same version is served.
  const cases = [
    {
      host: 'Star', move: 'upgrade', expect: 'v2',
      async run() {
        const star = newStar();
        const admin = await starAdmin(star);
        await install(admin, star, 'v1', TYPES_V1);
        await install(admin, star, 'v2', TYPES_V2);
        return { client: admin, binding: 'STAR' as const, scope: star, reInit: () => admin.lmz.callAsync('STAR', star, admin.ctn<StarTest>().reInitForTest()) };
      },
    },
    {
      host: 'Star', move: 'revert', expect: 'v1',
      async run() {
        const star = newStar();
        const admin = await starAdmin(star);
        await install(admin, star, 'v1', TYPES_V1);
        await install(admin, star, 'v2', TYPES_V2);
        await install(admin, star, 'v1', TYPES_V1);
        return { client: admin, binding: 'STAR' as const, scope: star, reInit: () => admin.lmz.callAsync('STAR', star, admin.ctn<StarTest>().reInitForTest()) };
      },
    },
    {
      host: 'Galaxy', move: 'upgrade', expect: 'chat-v2',
      async run() {
        const scope = newGalaxy();
        const owner = await galaxyOwner(scope);
        // Install the platform seed first, so the next install REPLACES it — without this the only
        // install is a first install, which a plane that forgets replacements would still record.
        await answer(owner.lmz.callAsync('GALAXY', scope, door(owner).read(CHAT_MESSAGE_ONTOLOGY_VERSION, uuid())));
        await owner.lmz.callAsync('GALAXY', scope, owner.ctn<GalaxyTest>().setChatSourceForTest(CHAT_V2), { timeoutMs: COMPILE_TIMEOUT_MS });
        await answer(owner.lmz.callAsync('GALAXY', scope, door(owner).read('chat-v2', uuid()), { timeoutMs: COMPILE_TIMEOUT_MS }));
        return { client: owner, binding: 'GALAXY' as const, scope, reInit: () => owner.lmz.callAsync('GALAXY', scope, owner.ctn<GalaxyTest>().reInitForTest()) };
      },
    },
    {
      host: 'Galaxy', move: 'revert', expect: CHAT_MESSAGE_ONTOLOGY_VERSION,
      async run() {
        const scope = newGalaxy();
        const owner = await galaxyOwner(scope);
        await owner.lmz.callAsync('GALAXY', scope, owner.ctn<GalaxyTest>().setChatSourceForTest(CHAT_V2), { timeoutMs: COMPILE_TIMEOUT_MS });
        await answer(owner.lmz.callAsync('GALAXY', scope, door(owner).read('chat-v2', uuid()), { timeoutMs: COMPILE_TIMEOUT_MS }));
        await owner.lmz.callAsync('GALAXY', scope, owner.ctn<GalaxyTest>().setChatSourceForTest());
        await answer(owner.lmz.callAsync('GALAXY', scope, door(owner).read(CHAT_MESSAGE_ONTOLOGY_VERSION, uuid())));
        return { client: owner, binding: 'GALAXY' as const, scope, reInit: () => owner.lmz.callAsync('GALAXY', scope, owner.ctn<GalaxyTest>().reInitForTest()) };
      },
    },
  ];

  it.each(cases)('$host $move: the version served warm is the version served after re-init', async (c) => {
    const { client, binding, scope, reInit } = await c.run();
    const served = () => answer(client.lmz.callAsync(binding, scope, door(client).read(c.expect, uuid())));
    expect(await served()).toBeNull(); // warm
    sink = [];
    await reInit();
    expect(await served()).toBeNull(); // cold: served from what was recorded, with no source ask
    expect(asks(scope)).toBe(0);
    client[Symbol.dispose]();
  });
});

describe('the source is asked only on a mismatch', () => {
  it('a pinned op matching the installed version asks zero times; a mismatched one asks exactly once', async () => {
    const star = newStar();
    const admin = await starAdmin(star);
    await install(admin, star, 'v1', TYPES_V1);
    sink = [];
    await answer(admin.lmz.callAsync('STAR', star, door(admin).read('v1', uuid())));
    expect(asks(star)).toBe(0);
    await answer(admin.lmz.callAsync('STAR', star, door(admin).read('v-other', uuid())));
    expect(asks(star)).toBe(1);
    // A subscribe pinned to the installed version proceeds: no ask either.
    await admin.lmz.callAsync('STAR', star, door(admin).subscribeQuery('v1', { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: uuid() }));
    expect(asks(star)).toBe(1);
    admin[Symbol.dispose]();
  });

  // The version is required in TypeScript, but mesh arguments are typed and not checked on the
  // wire, so a raw caller can still send none. Mutations: let `#gateClientOp` treat a missing
  // version as the installed one, as the old optional parameter did; or check a list or roster
  // subscription through `#gateServer`, which runs it at whatever is installed.
  it('an op arriving with no version, on a Star with an ontology, is answered stale without asking', async () => {
    const star = newStar();
    const admin = await starAdmin(star);
    await install(admin, star, 'v1', TYPES_V1);
    sink = [];
    const read = await answer(admin.lmz.callAsync('STAR', star, door(admin).read(undefined, uuid())));
    const invite = await answer(admin.lmz.callAsync('STAR', star, door(admin).invite(undefined, ROOT_NODE_ID, [{ email: 'x@example.com', tier: 'read' }])));
    for (const e of [read, invite]) {
      expect(e?.name).toBe('OntologyStaleError');
      expect((e as any).checking).toBeFalsy();
    }
    // The two subscriptions answer by push, so the Star's own line says whether it refused them.
    const query = { queryType: 'parentChild' as const, typeName: 'Child', field: 'parent', value: uuid() };
    await admin.lmz.callAsync('STAR', star, door(admin).subscribeQuery(undefined, query));
    await admin.lmz.callAsync('STAR', star, door(admin).subscribeQuerySubscribers(undefined, query));
    const arrived = (kind: string) => sink.filter((e) =>
      e.namespace === 'nebula.Resources.subscribe' && e.message === 'arrived'
      && e.data?.instanceName === star && e.data?.kind === kind).map((e) => e.data?.stale);
    expect(arrived('query')).toEqual([true]);
    expect(arrived('roster')).toEqual([true]);
    expect(asks(star)).toBe(0);
    admin[Symbol.dispose]();
  });
});

describe('the Star asks its Galaxy once per version change', () => {
  // In the vitest-plugin lane because only here can an answer be held until every op has arrived:
  // live, the Galaxy answers in tens of milliseconds and the count would depend on timing.
  const holdAnswers = (c: NebulaClientTest, star: string, hold: boolean) =>
    c.lmz.callAsync('STAR', star, c.ctn<StarTest>().holdOntologyAnswersForTest(hold));
  const galaxyAsks = (star: string) => sink.filter((e) =>
    e.namespace === 'nebula.Galaxy.ontology' && e.message === 'current asked' && e.data?.caller === star).length;

  // Mutation: let `#settle` ask on every mismatch, as it did before the memory.
  it('ten mismatched ops while an answer is outstanding make one ask of the Galaxy', async () => {
    const galaxy = newGalaxy();
    const owner = await galaxyOwner(galaxy);
    const v1 = await build(owner, galaxy, TYPES_V1);
    const dev = `${galaxy}.dev`;
    const client = (await universeAdminClient(NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com', v1)).client;
    try {
      await holdAnswers(client, dev, true);
      sink = [];
      for (let i = 0; i < 10; i++) {
        const e = await answer(client.lmz.callAsync('STAR', dev, door(client).read(v1, uuid())));
        expect((e as any)?.checking).toBe(true);
      }
      expect(galaxyAsks(dev)).toBe(1);
      expect(asks(dev)).toBe(1);
      // Released, the one answer installs, and the next op runs.
      await holdAnswers(client, dev, false);
      expect(await answer(client.lmz.callAsync('STAR', dev, door(client).read(v1, uuid())))).toBeNull();
    } finally { owner[Symbol.dispose](); client[Symbol.dispose](); }
  }, 60_000);

  // Mutation: clear the memory only when a row installs.
  it('an answer of none ends the ask, so the next mismatched op asks again', async () => {
    const star = newStar();
    const admin = await starAdmin(star);
    sink = [];
    await answer(admin.lmz.callAsync('STAR', star, door(admin).read('v1', uuid())));
    expect(asks(star)).toBe(1);
    await vi.waitFor(() => expect(sink.some((e) => e.message === 'ontology pull returned no row' && e.data?.instanceName === star)).toBe(true));
    await answer(admin.lmz.callAsync('STAR', star, door(admin).read('v1', uuid())));
    expect(asks(star)).toBe(2);
    admin[Symbol.dispose]();
  });

  // Mutation: clear the memory only for a row or none, never for an Error.
  it('an Error answer ends the ask too', async () => {
    const star = newStar();
    const admin = await starAdmin(star);
    await holdAnswers(admin, star, true);
    sink = [];
    await answer(admin.lmz.callAsync('STAR', star, door(admin).read('v1', uuid())));
    await answer(admin.lmz.callAsync('STAR', star, door(admin).read('v1', uuid())));
    expect(asks(star)).toBe(1); // the second op waited on the first ask
    await admin.lmz.callAsync('STAR', star, admin.ctn<StarTest>().deliverOntologyAnswerForTest('error'));
    await answer(admin.lmz.callAsync('STAR', star, door(admin).read('v1', uuid())));
    expect(asks(star)).toBe(2);
    await holdAnswers(admin, star, false);
    admin[Symbol.dispose]();
  });

  // Mutation: drop the age check in `#askPending`.
  it('an ask whose answer never comes is made again once it is too old', async () => {
    const star = newStar();
    const admin = await starAdmin(star);
    await holdAnswers(admin, star, true);
    sink = [];
    await answer(admin.lmz.callAsync('STAR', star, door(admin).read('v1', uuid())));
    await answer(admin.lmz.callAsync('STAR', star, door(admin).read('v1', uuid())));
    expect(asks(star)).toBe(1);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + 11_000);
      await answer(admin.lmz.callAsync('STAR', star, door(admin).read('v1', uuid())));
    } finally { vi.useRealTimers(); }
    expect(asks(star)).toBe(2);
    await holdAnswers(admin, star, false);
    admin[Symbol.dispose]();
  });
});

describe('every op on an empty host takes the same path', () => {
  // The FIRST answer of a raw op, because the client's own retry repairs the end state. The Star's
  // Galaxy answers a tenant Star no row until something is published, so the Star stays empty and
  // every op keeps being told `checking`. How many asks they cost is the describe above's.
  it('each op on an empty Star is first told `checking`', async () => {
    const star = newStar();
    const admin = await starAdmin(star);
    const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: uuid() };
    const hash = canonicalQueryHash(query);

    const txn = await answer(admin.lmz.callAsync('STAR', star, door(admin).transaction('v1', uuid(), {
      [uuid()]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'x' } },
    })));
    const read = await answer(admin.lmz.callAsync('STAR', star, door(admin).read('v1', uuid())));
    const invite = await answer(admin.lmz.callAsync('STAR', star, door(admin).invite('v1', ROOT_NODE_ID, [{ email: 'x@example.com', tier: 'read' }])));
    for (const e of [txn, read, invite]) {
      expect(e?.name).toBe('OntologyStaleError');
      expect((e as any).checking).toBe(true);
    }

    const rid = uuid();
    admin.callStarSubscribe(star, 'v1', 'TestResource', rid);
    await vi.waitFor(() => expect((admin.lastErrorObject as any)?.checking).toBe(true));
    admin.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect((admin.lastQueryError as any)?.checking).toBe(true));
    await admin.lmz.callAsync('STAR', star, door(admin).subscribeQuerySubscribers('v1', query));
    await vi.waitFor(() => {
      expect(admin.lastQuerySubscribersUpdate?.queryHash).toBe(hash);
      expect((admin.lastQuerySubscribersUpdate?.error as any)?.checking).toBe(true);
    });
    admin[Symbol.dispose]();
  });

  it('no op on an empty Galaxy is told `checking` — its source answers at once', async () => {
    const scope = newGalaxy();
    const owner = await galaxyOwner(scope);
    const txn = await owner.lmz.callAsync('GALAXY', scope, door(owner).transaction(CHAT_MESSAGE_ONTOLOGY_VERSION, uuid(), {
      [uuid()]: { op: 'create', typeName: 'Message', nodeId: CHAT_NODE_ID, value: { chat: DEFAULT_CHAT_ID, content: 'first' } },
    })) as TransactionResult;
    expect(txn.ok).toBe(true);
    // A second fresh Galaxy, so each first answer is taken on an empty host.
    const scope2 = newGalaxy();
    const owner2 = await galaxyOwner(scope2);
    expect(await answer(owner2.lmz.callAsync('GALAXY', scope2, door(owner2).read(CHAT_MESSAGE_ONTOLOGY_VERSION, uuid())))).toBeNull();
    owner[Symbol.dispose](); owner2[Symbol.dispose]();
  });
});

/**
 * A Galaxy whose build landed `types` when given, and its fresh, empty `.dev` Star, whose admin
 * pins that version — so the admin's first subscribe is told `checking` while the Star pulls.
 * The `.dev` Star, because it is the one Star a build's row reaches before anything is published.
 */
async function emptyStarUnderGalaxy(types?: string) {
  const galaxy = newGalaxy();
  const owner = await galaxyOwner(galaxy);
  const version = types ? await build(owner, galaxy, types) : 'never-built';
  const star = `${galaxy}.dev`;
  const onShouldRefreshUI = vi.fn();
  const client = (await universeAdminClient(
    NebulaClientTest, new Browser(), galaxy, star, 'admin@example.com', version, { onShouldRefreshUI },
  )).client;
  return { galaxy, owner, client, star, onShouldRefreshUI };
}

/** Write `types` as the Galaxy's ontology source and build, over the faked job, so the row lands
 *  as the `.dev` Star's current one; returns its version. */
async function build(owner: NebulaClientTest, galaxy: string, types: string): Promise<string> {
  await owner.lmz.callAsync('GALAXY', galaxy, owner.ctn<Galaxy>().writeSource('src/ontology.d.ts', types));
  await owner.lmz.callAsync('GALAXY', galaxy, owner.ctn<Galaxy>().buildNow({}), { timeoutMs: COMPILE_TIMEOUT_MS });
  return (await git.hashBlob({ object: types })).oid;
}

const CHILD = () => ({ queryType: 'parentChild' as const, typeName: 'Child', field: 'parent', value: uuid() });
const EMPTY_STAR_KINDS = [
  { kind: 'query', land: (c: NebulaClientTest) => c.resources.subscribeQuery(CHILD()).ready },
  { kind: 'roster', land: (c: NebulaClientTest) => c.subscribeQuerySubscribers(CHILD()).ready },
] as const;

describe('the client retries each kind of subscribe while its host installs', () => {
  it.each(EMPTY_STAR_KINDS)('$kind: lands after `checking` without firing the refresh signal', async ({ land }) => {
    const { owner, client, star, onShouldRefreshUI } = await emptyStarUnderGalaxy(TYPES_V1);
    try {
      sink = [];
      await land(client);
      expect(asks(star)).toBeGreaterThanOrEqual(1); // the first answer WAS `checking`
      expect(onShouldRefreshUI).not.toHaveBeenCalled();
    } finally { owner[Symbol.dispose](); client[Symbol.dispose](); }
  }, 30_000);

  // Mutation: let a refusal naming no version reload (`decideStale`), and the hook is called.
  it.each(EMPTY_STAR_KINDS)('$kind: when the retries run out it ends at the stale signal, and reloads nothing', async ({ land }) => {
    // No build has landed, so every answer stays `checking` and names no version: a reload would
    // serve the same page, so the op ends stale and the hook is never called.
    const { owner, client, onShouldRefreshUI } = await emptyStarUnderGalaxy();
    try {
      await expect(land(client)).rejects.toMatchObject({ name: 'OntologyStaleError', currentVersion: '' });
      expect(onShouldRefreshUI).not.toHaveBeenCalled();
    } finally { owner[Symbol.dispose](); client[Symbol.dispose](); }
  }, 30_000);

  // A resource subscribe needs a resource that exists, so its `checking` arises on an UPGRADE: the
  // Star serves V1 and holds a resource, a build lands V2, and a client pinned to V2 subscribes.
  async function starHoldingAResource() {
    const { galaxy, owner, client: v1Admin, star } = await emptyStarUnderGalaxy(TYPES_V1);
    const rid = uuid();
    const created = await v1Admin.resources.transaction({
      [rid]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'held' } } as any,
    });
    expect(created.kind).toBe('committed');
    return { galaxy, owner, v1Admin, star, rid };
  }

  it('resource: lands after `checking` without firing the refresh signal', async () => {
    const { galaxy, owner, v1Admin, star, rid } = await starHoldingAResource();
    const v2 = await build(owner, galaxy, TYPES_V2);
    const onShouldRefreshUI = vi.fn();
    const client = (await universeAdminClient(
      NebulaClientTest, new Browser(), galaxy, star, 'admin@example.com', v2, { onShouldRefreshUI },
    )).client;
    try {
      sink = [];
      const snap = await client.resources.subscribe('TestResource', rid).snapshot;
      expect(snap?.value).toEqual({ title: 'held' });
      expect(asks(star)).toBeGreaterThanOrEqual(1);
      expect(onShouldRefreshUI).not.toHaveBeenCalled();
    } finally { for (const c of [owner, v1Admin, client]) c[Symbol.dispose](); }
  }, 60_000);

  it('resource: when the retries run out it ends at the stale signal', async () => {
    const { galaxy, owner, v1Admin, star, rid } = await starHoldingAResource();
    const onShouldRefreshUI = vi.fn();
    const client = (await universeAdminClient(
      NebulaClientTest, new Browser(), galaxy, star, 'admin@example.com', 'never-built', { onShouldRefreshUI },
    )).client;
    try {
      await expect(client.resources.subscribe('TestResource', rid).snapshot).rejects.toMatchObject({ name: 'OntologyStaleError' });
      expect(onShouldRefreshUI).toHaveBeenCalled();
    } finally { for (const c of [owner, v1Admin, client]) c[Symbol.dispose](); }
  }, 60_000);
});
