/**
 * The one `Subscriptions` table a host's plane keeps — what its schema refuses, what storage the four
 * registries it replaced left behind does to it, and that each remover takes only its own kind.
 *
 * The schema and old-storage limbs write the table in-DO (`runInDurableObject`) because no client
 * can construct what they test. The table refuses a row that breaks its kind, so the CHECK is the
 * whole control for a resource row missing its `sub`, and no limb could build one through the API.
 * Storage built by the old registries exists only on a DO that ran the code before this table.
 * The remover and audience limbs drive real clients, and read back rows no running stack shows
 * from outside, which is why they are in-lane too.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID, Subscriptions, canonicalQueryHash } from '@lumenize/nebula';
import { ensureSubscribersTable } from '@lumenize/mesh/auth/profile';
import type { QueryDescriptor, SubscriptionKind, TransactionResult } from '@lumenize/nebula';
import { adminClientAt, addressOfClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

/** Each universe's founder has its own address: one address may own at most MAX_GALAXIES_PER_OWNER
 *  galaxies, and every founding's claim writes one, so a shared address hits the cap mid-file. */
const adminOf = (scope: string) => `admin-${scope.split('.')[0]}@example.com`;

const VERSION = 'v1';
const TYPES = [
  'interface Parent { name: string }',
  'interface Child { parent: Parent; label: string }',
].join('\n');
const uuid = () => crypto.randomUUID();
const uniqueStar = () => `subt-${uuid().slice(0, 8)}.app.tenant-a`;

async function starAdmin(star: string): Promise<NebulaClientTest> {
  const { client } = await adminClientAt(NebulaClientTest, new Browser(), star, star, adminOf(star));
  client.callStarInstallOntology(star, { version: VERSION, types: TYPES });
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));
  expect(client.lastError).toBeUndefined();
  return client;
}

async function commit(admin: NebulaClientTest, star: string, ops: Parameters<NebulaClientTest['callStarTransaction']>[2]) {
  admin.callStarTransaction(star, VERSION, ops);
  await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
  expect((admin.lastResult as TransactionResult).ok).toBe(true);
}

const inStar = <T,>(star: string, fn: (inst: any, state: DurableObjectState) => T): Promise<T> =>
  (runInDurableObject as any)((env as any).STAR.getByName(star), fn);

const rows = (star: string, kind: SubscriptionKind, clientAddress: string) => inStar(star, (_i, s) =>
  s.storage.sql.exec('SELECT COUNT(*) AS n FROM Subscriptions WHERE kind = ? AND clientAddress = ?', kind, clientAddress)
    .toArray()[0].n as number);

// ── The schema ─────────────────────────────────────────────────────────────────────────────────

type Row = {
  kind: string; topic: string; sub: string | null; profileId: string | null;
  dominionOverHostAtSubscribe: number | null; query: string | null;
};
/** A well-formed row of each kind; every refused case below is one of these with one column changed. */
const WELL_FORMED: Record<SubscriptionKind, Row> = {
  resource: { kind: 'resource', topic: 'r1', sub: 's', profileId: 'p', dominionOverHostAtSubscribe: 0, query: null },
  query: { kind: 'query', topic: 'h1', sub: 's', profileId: 'p', dominionOverHostAtSubscribe: 1, query: '{}' },
  roster: { kind: 'roster', topic: 'h1', sub: null, profileId: null, dominionOverHostAtSubscribe: null, query: null },
  tree: { kind: 'tree', topic: '', sub: null, profileId: null, dominionOverHostAtSubscribe: null, query: null },
};

function insert(state: DurableObjectState, row: Row, clientAddress: string): void {
  state.storage.sql.exec(
    `INSERT INTO Subscriptions (kind, topic, clientAddress, subscribedAt, sub, profileId, dominionOverHostAtSubscribe, query)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    row.kind, row.topic, clientAddress, new Date().toISOString(), row.sub, row.profileId, row.dominionOverHostAtSubscribe, row.query,
  );
}

describe('the Subscriptions table refuses a row that breaks its kind', () => {
  it('a well-formed row of each kind inserts', async () => {
    const star = uniqueStar();
    await starAdmin(star);
    const written = await inStar(star, (_i, s) => {
      for (const row of Object.values(WELL_FORMED)) insert(s, row, `ok-${row.kind}`);
      return s.storage.sql.exec(`SELECT kind FROM Subscriptions WHERE clientAddress LIKE 'ok-%' ORDER BY kind`).toArray().map((r) => r.kind);
    });
    expect(written).toEqual(['query', 'resource', 'roster', 'tree']);
  });

  // One case per (kind, column) pair a rule names, plus a dominion bit of 2 and a kind outside the
  // four. Each CHECK is its own constraint, so removing one reds exactly its own cases — a rule
  // written as `sub IS NOT NULL` alone, say, reds every `profileId` case.
  it.each([
    ['resource', 'sub', null], ['resource', 'profileId', null], ['resource', 'dominionOverHostAtSubscribe', null], ['resource', 'query', '{}'],
    ['query', 'sub', null], ['query', 'profileId', null], ['query', 'dominionOverHostAtSubscribe', null], ['query', 'query', null],
    ['query', 'dominionOverHostAtSubscribe', 2],
    ['roster', 'sub', 's'], ['roster', 'profileId', 'p'], ['roster', 'dominionOverHostAtSubscribe', 0], ['roster', 'query', '{}'],
    ['tree', 'sub', 's'], ['tree', 'profileId', 'p'], ['tree', 'dominionOverHostAtSubscribe', 0], ['tree', 'query', '{}'],
    ['tree', 'topic', 'x'],
    ['roster', 'kind', 'bogus'],
  ] as Array<[SubscriptionKind, keyof Row, string | number | null]>)('a %s row with %s = %s is refused', async (kind, column, value) => {
    const star = uniqueStar();
    await starAdmin(star);
    const outcome = await inStar(star, (_i, s) => {
      try { insert(s, { ...WELL_FORMED[kind], [column]: value }, 'bad'); return 'inserted'; }
      catch (e) { return (e as Error).message; }
    });
    expect(outcome).toMatch(/CHECK constraint failed/);
  });
});

// ── Storage the old registries left ────────────────────────────────────────────────────────────

describe('storage the four old registries left behind', () => {
  it('gets the table, because its marker is new — a subscribe of every kind succeeds after the old one is at 2', async () => {
    const star = uniqueStar();
    const admin = await starAdmin(star);
    const P = uuid();
    await commit(admin, star, { [P]: { op: 'create', typeName: 'Parent', nodeId: ROOT_NODE_ID, value: { name: 'p' } } });

    // Pre-merge storage: no `Subscriptions` table, no marker of its own, and the old registry's
    // high-water mark at 2. Then construct the plane again, as a cold start would.
    // Mutation: reuse the old marker string for the new table → nothing is created, and every
    // subscribe below fails with "no such table" → red.
    await inStar(star, (inst, s) => {
      s.storage.sql.exec('DROP TABLE IF EXISTS Subscriptions');
      s.storage.kv.delete('__sql_migrations_Subscriptions');
      s.storage.kv.put('__sql_migrations_Subscribers', 2);
      inst.onStart();
    });

    const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: P };
    await admin.resources.subscribe('Parent', P).snapshot;
    await admin.resources.subscribeQuery(query).ready;
    await admin.subscribeQuerySubscribers(query).ready;
    admin.callStarSubscribeTree(star);
    const id = addressOfClient(admin);
    await vi.waitFor(async () => expect(await rows(star, 'tree', id)).toBe(1));
    for (const kind of ['resource', 'query', 'roster'] as const) expect(await rows(star, kind, id)).toBe(1);
  });
});

// ── Each kind hears only its own updates ───────────────────────────────────────────────────────

describe('each kind hears only its own updates', () => {
  it('a resource, a query, a roster and a tree subscriber on one topic each receive their own kind and no other', async () => {
    const star = uniqueStar();
    const admin = await starAdmin(star);
    const P = uuid();
    const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: P };
    const topic = canonicalQueryHash(query); // the resource shares the query's topic, so a missing kind filter shows
    await commit(admin, star, {
      [P]: { op: 'create', typeName: 'Parent', nodeId: ROOT_NODE_ID, value: { name: 'p' } },
      [topic]: { op: 'create', typeName: 'Parent', nodeId: ROOT_NODE_ID, value: { name: 't' } },
    });
    const tab = async () => (await adminClientAt(NebulaClientTest, new Browser(), star, star, adminOf(star))).client;
    const r = await tab();
    await r.resources.subscribe('Parent', topic).snapshot;
    const w = await tab();
    await w.subscribeQuerySubscribers(query).ready;
    const q = await tab();
    const data = q.resources.subscribeQuery(query);
    await data.ready;
    await vi.waitFor(() => expect(w.lastQuerySubscribersUpdate?.roster).toHaveLength(1)); // q's join
    const t = await tab();
    t.callStarSubscribeTree(star);
    await vi.waitFor(() => expect(t.orgTreeUpdateCount).toBe(1));

    const counts = (c: NebulaClientTest) => ({
      resource: c.resourceUpdateCount, query: c.queryUpdateCount, roster: c.querySubscribersUpdateCount, tree: c.orgTreeUpdateCount,
    });
    const before = { r: counts(r), q: counts(q), w: counts(w), t: counts(t) };

    // One update of each kind: a resource put, a query member, a tree change, and q's leave (a roster change).
    admin.callStarRead(star, VERSION, topic);
    await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
    const eTag = (admin.lastResult as { meta: { eTag: string } }).meta.eTag;
    await commit(admin, star, { [topic]: { op: 'put', eTag, value: { name: 't2' } } });
    await commit(admin, star, { [uuid()]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent: P, label: 'c' } } });
    await vi.waitFor(() => expect(q.queryUpdateCount).toBe(before.q.query + 1));
    await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'hear', 'Hear');
    data[Symbol.dispose]();
    await vi.waitFor(() => {
      expect(r.resourceUpdateCount).toBe(before.r.resource + 1);
      expect(w.querySubscribersUpdateCount).toBe(before.w.roster + 1);
      expect(t.orgTreeUpdateCount).toBe(before.t.tree + 1);
    });
    // A round trip on each socket, so a wrong-kind push sent during those updates has landed.
    for (const c of [r, q, w, t]) await c.resources.read('Parent', P);

    // Mutations: drop the kind filter from the resource, roster or tree audience → a row of
    // another kind on the same topic (or any row, for the tree) receives it → red.
    const delta = (c: NebulaClientTest, b: ReturnType<typeof counts>) => {
      const now = counts(c);
      return { resource: now.resource - b.resource, query: now.query - b.query, roster: now.roster - b.roster, tree: now.tree - b.tree };
    };
    expect(delta(r, before.r)).toEqual({ resource: 1, query: 0, roster: 0, tree: 0 });
    expect(delta(q, before.q)).toEqual({ resource: 0, query: 1, roster: 0, tree: 0 });
    expect(delta(w, before.w)).toEqual({ resource: 0, query: 0, roster: 1, tree: 0 });
    expect(delta(t, before.t)).toEqual({ resource: 0, query: 0, roster: 0, tree: 1 });
  });
});

// ── Each remover takes only its own kind ───────────────────────────────────────────────────────

/**
 * One client holding a row of every kind ON ONE TOPIC. Query and roster rows share a topic
 * naturally; the resource is given the query's hash as its id so its row does too. Without that,
 * a remover that dropped its `kind =` filter would still find only its own row.
 */
async function holdEveryKind() {
  const star = uniqueStar();
  const admin = await starAdmin(star);
  const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: uuid() };
  const topic = canonicalQueryHash(query);
  await commit(admin, star, { [topic]: { op: 'create', typeName: 'Parent', nodeId: ROOT_NODE_ID, value: { name: 'h' } } });

  const { client } = await adminClientAt(NebulaClientTest, new Browser(), star, star, adminOf(star));
  const resource = client.resources.subscribe('Parent', topic);
  await resource.snapshot;
  const data = client.resources.subscribeQuery(query);
  await data.ready;
  const watch = client.subscribeQuerySubscribers(query);
  await watch.ready;
  client.callStarSubscribeTree(star);
  const id = addressOfClient(client);
  await vi.waitFor(async () => expect(await rows(star, 'tree', id)).toBe(1));
  const held = await inStar(star, (_i, s) => s.storage.sql.exec(
    'SELECT kind, topic FROM Subscriptions WHERE clientAddress = ? ORDER BY kind', id).toArray());
  expect(held).toEqual([
    { kind: 'query', topic }, { kind: 'resource', topic }, { kind: 'roster', topic }, { kind: 'tree', topic: '' },
  ]);
  return { star, admin, client, id, resource, data, watch };
}

const surviving = async (star: string, id: string) => Object.fromEntries(await Promise.all(
  (['resource', 'query', 'roster', 'tree'] as const).map(async (k) => [k, await rows(star, k, id)])));

describe('each remover takes only its own kind', () => {
  it('unsubscribing the resource drops the resource row alone', async () => {
    const { star, id, resource } = await holdEveryKind();
    resource[Symbol.dispose]();
    // Mutation: drop `kind = 'resource'` from its remover → the query and roster rows go too → red.
    await vi.waitFor(async () => expect(await rows(star, 'resource', id)).toBe(0));
    expect(await surviving(star, id)).toEqual({ resource: 0, query: 1, roster: 1, tree: 1 });
  });

  it('unsubscribing the data drops the query row alone, and the client, still watching, gets the shrunk roster', async () => {
    const { star, client, id, data } = await holdEveryKind();
    await vi.waitFor(() => expect(client.lastQuerySubscribersUpdate?.roster).toHaveLength(1)); // it watches itself
    data[Symbol.dispose]();
    // Mutation: drop `kind = 'query'` from its remover → the roster row goes too, so no shrunk
    // roster arrives, and the resource row with it → red.
    await vi.waitFor(() => expect(client.lastQuerySubscribersUpdate?.roster).toEqual([]));
    expect(await surviving(star, id)).toEqual({ resource: 1, query: 0, roster: 1, tree: 1 });
  });

  it('unsubscribing the roster drops the roster row alone', async () => {
    const { star, id, watch } = await holdEveryKind();
    watch[Symbol.dispose]();
    // Mutation: drop `kind = 'roster'` from its remover → the resource and query rows go too → red.
    await vi.waitFor(async () => expect(await rows(star, 'roster', id)).toBe(0));
    expect(await surviving(star, id)).toEqual({ resource: 1, query: 1, roster: 0, tree: 1 });
  });

  it('reaping a closed tab from the tree drops the tree row alone', async () => {
    const { star, admin, client, id } = await holdEveryKind();
    client.disconnect();
    await vi.waitFor(() => expect(client.connectionState).toBe('disconnected'));
    // A tree change is the one update this client's other rows do not receive.
    await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'reap', 'Reap');
    // Mutation: key the tree remover on `clientAddress` alone → every row of the client goes → red.
    await vi.waitFor(async () => expect(await rows(star, 'tree', id)).toBe(0));
    expect(await surviving(star, id)).toEqual({ resource: 1, query: 1, roster: 1, tree: 0 });
  });
});

// ── A table from before the address column ─────────────────────────────────────────────────────
// In-lane, because only storage written by an older build has this shape: no running system can
// produce it now, and the deployed `test-nebula` is where it would otherwise first meet one.

describe('a subscriber table keyed on clientId migrates to the address', () => {
  const columns = (sql: SqlStorage) => sql.exec('PRAGMA table_info(Subscriptions)').toArray().map((c: any) => c.name);

  it('Subscriptions drops its old rows once, and keeps the rows written after', async () => {
    const star = uniqueStar();
    await starAdmin(star);
    const seen = await inStar(star, (_i, s) => {
      const sql = s.storage.sql;
      // The shape the table had before, with its marker where that build left it.
      sql.exec('DROP TABLE Subscriptions');
      sql.exec(`CREATE TABLE Subscriptions (kind TEXT NOT NULL, topic TEXT NOT NULL, clientId TEXT NOT NULL,
        subscriberBinding TEXT NOT NULL, subscribedAt TEXT NOT NULL, sub TEXT, profileId TEXT,
        dominionOverHostAtSubscribe INTEGER, query TEXT, PRIMARY KEY (kind, topic, clientId)) WITHOUT ROWID`);
      sql.exec(`INSERT INTO Subscriptions (kind, topic, clientId, subscriberBinding, subscribedAt)
        VALUES ('tree', '', 'old.tab1', 'NEBULA_CLIENT_GATEWAY', '2026-10-01T00:00:00.000Z')`);
      s.storage.kv.put('__sql_migrations_Subscriptions', 1);
      const build = () => new Subscriptions(s, () => ({ callChain: [] }) as any, undefined as any, () => star);
      build();
      const migrated = { columns: columns(sql), rows: sql.exec('SELECT COUNT(*) AS n FROM Subscriptions').toArray()[0].n };
      sql.exec(`INSERT INTO Subscriptions (kind, topic, clientAddress, subscribedAt)
        VALUES ('tree', '', 'STAR/x/new.tab1', '2026-10-06T00:00:00.000Z')`);
      build();
      return { ...migrated, kept: sql.exec('SELECT clientAddress FROM Subscriptions').toArray() };
    });
    // Mutation: give the drop the baseline's id, 1, and the old table survives with its column.
    expect(seen.columns).toContain('clientAddress');
    expect(seen.columns).not.toContain('clientId');
    expect(seen.rows).toBe(0);
    expect(seen.kept).toEqual([{ clientAddress: 'STAR/x/new.tab1' }]);
  });

  it('a Profile\'s Subscribers drops its old rows once, and keeps the rows written after', async () => {
    const profile = (env as any).PROFILE.getByName(uuid());
    const seen = await (runInDurableObject as any)(profile, (_i: unknown, s: DurableObjectState) => {
      const sql = s.storage.sql;
      const cols = () => sql.exec('PRAGMA table_info(Subscribers)').toArray().map((c: any) => c.name);
      sql.exec('DROP TABLE Subscribers');
      sql.exec(`CREATE TABLE Subscribers (clientId TEXT PRIMARY KEY, subscriberBinding TEXT NOT NULL,
        subscribedAt TEXT NOT NULL DEFAULT '') WITHOUT ROWID`);
      sql.exec(`INSERT INTO Subscribers (clientId, subscriberBinding) VALUES ('old.tab1', 'NEBULA_CLIENT_GATEWAY')`);
      ensureSubscribersTable(sql);
      const migrated = { columns: cols(), rows: sql.exec('SELECT COUNT(*) AS n FROM Subscribers').toArray()[0].n };
      sql.exec(`INSERT INTO Subscribers (clientAddress, subscribedAt) VALUES ('STAR/x/new.tab1', '2026-10-06T00:00:00.000Z')`);
      ensureSubscribersTable(sql);
      return { ...migrated, kept: sql.exec('SELECT clientAddress FROM Subscribers').toArray() };
    });
    // Mutation: drop the table whatever its columns, and the row written after goes too.
    expect(seen.columns).toEqual(['clientAddress', 'subscribedAt']);
    expect(seen.rows).toBe(0);
    expect(seen.kept).toEqual([{ clientAddress: 'STAR/x/new.tab1' }]);
  });
});
