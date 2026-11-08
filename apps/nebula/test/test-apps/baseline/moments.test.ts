/**
 * A transaction's moment: one per transaction that writes, minted as it commits, and a read of one
 * resource that its history does not slow.
 *
 * In-lane rather than `/live`, and each case says why: several commits in one millisecond, which
 * only a pinned `Date` gives; a validation held open on demand, which only the test seam gives; and
 * the rows a statement read, which only code inside the Durable Object sees. What a client sees of
 * the same rules is the scenario `each-transaction-gets-one-moment`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { ROOT_NODE_ID } from '@lumenize/resources';
import type { TransactionResult, OntologyVersionConfig } from '@lumenize/resources';
import { universeAdminClient, foundAndLogin, createSubject, createInvitedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';
import type { StarTest } from './index';

const uuid = () => crypto.randomUUID();
const TYPES = 'interface TestResource { title: string }\ninterface Parent { name: string }\ninterface Child { parent: Parent; label: string }';
const COMPILE_TIMEOUT_MS = 60_000;
const LATEST_MOMENT_KEY = 'resources:latestMoment';
const iso = (ms: number) => new Date(ms).toISOString();

type SinkEntry = { namespace: string; message: string; data?: Record<string, any> };
let sink: SinkEntry[] = [];
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e as unknown as SinkEntry)); });
afterEach(() => { vi.useRealTimers(); clearDebugSink(); });

const door = (c: NebulaClientTest) => (c.ctn() as any).resources;
function newDev() {
  const galaxy = `mo-${uuid().slice(0, 8)}.app`;
  return { galaxy, dev: `${galaxy}.dev` };
}
async function admin(galaxy: string, scope: string) {
  return (await universeAdminClient(NebulaClientTest, new Browser(), galaxy, scope, 'admin@example.com', 'v1')).client;
}
/** A plain member of the `.dev` Star, with passage and no grant. */
async function member(galaxy: string, dev: string, email: string) {
  const adminBrowser = new Browser();
  const { accessToken } = await foundAndLogin(adminBrowser, galaxy, 'admin@example.com', galaxy);
  await createSubject(adminBrowser, dev, accessToken, email);
  return (await createInvitedClient(NebulaClientTest, new Browser(), dev, dev, email, 'v1')).client;
}
async function install(c: NebulaClientTest, star: string, config: OntologyVersionConfig, holdParseMs?: number) {
  await c.lmz.callAsync('STAR', star, c.ctn<StarTest>().applyOntologyForTest(config, holdParseMs), { timeoutMs: COMPILE_TIMEOUT_MS });
}
const tx = (c: NebulaClientTest, star: string, ops: Record<string, unknown>, version = 'v1') =>
  c.lmz.callAsync('STAR', star, door(c).transaction(version, ops), { timeoutMs: 30_000 }) as Promise<TransactionResult>;
const createTest = (rid: string) => ({ [rid]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: rid } } });
const stub = (star: string) => (env as any).STAR.getByName(star);
/** Each resource's current `validFrom`, read from storage. */
async function currentMoments(star: string): Promise<Record<string, string>> {
  return (runInDurableObject as any)(stub(star), (_i: unknown, c: DurableObjectState) => Object.fromEntries(
    c.storage.sql.exec(`SELECT resourceId, validFrom FROM Snapshots WHERE validTo = '9999-01-01T00:00:00.000Z'`)
      .toArray().map((r) => [r.resourceId as string, r.validFrom as string])));
}
async function latestMoment(star: string): Promise<string | undefined> {
  return (runInDurableObject as any)(stub(star), (_i: unknown, c: DurableObjectState) => c.storage.kv.get<string>(LATEST_MOMENT_KEY));
}
/** Pin `Date` at a whole second a minute ahead, later than every moment the setup wrote. Timers stay real. */
function pinClock(): number {
  const t = Math.ceil((Date.now() + 60_000) / 1000) * 1000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(t);
  return t;
}

describe('one moment per transaction that writes', () => {
  it('three transactions in one pinned millisecond get .000, .001 and .002, and refused ones move nothing', async () => {
    const { galaxy, dev } = newDev();
    const a = await admin(galaxy, dev);
    await install(a, dev, { version: 'v1', types: TYPES });
    const m = await member(galaxy, dev, 'no-grant@example.com');
    const t = pinClock();

    const [r1, r2, r3] = [uuid(), uuid(), uuid()];
    expect((await tx(a, dev, createTest(r1))).ok).toBe(true);
    expect((await tx(a, dev, createTest(r2))).ok).toBe(true);
    // A conflict: a put naming a version r1 never had. Then a refusal: a member with no grant
    // creating at the root. Neither may move the latest moment.
    const conflict = await tx(a, dev, { [r1]: { op: 'put', ifValidFromMatches: 'never-a-version', value: { title: 'x' } } });
    expect(conflict.ok === false && Object.values(conflict.errors)[0].type).toBe('conflict');
    const refused = await tx(m, dev, createTest(uuid()));
    expect(refused.ok === false && Object.values(refused.errors)[0].type).toBe('permission');
    expect(await latestMoment(dev)).toBe(iso(t + 1));

    expect((await tx(a, dev, createTest(r3))).ok).toBe(true);
    const at = await currentMoments(dev);
    expect([at[r1], at[r2], at[r3]]).toEqual([iso(t), iso(t + 1), iso(t + 2)]);
    a[Symbol.dispose](); m[Symbol.dispose]();
  }, 60_000);

  it('a delete that commits while another transaction waits in its validator takes the earlier moment', async () => {
    const HOLD_MS = 3000;
    const { galaxy, dev } = newDev();
    const a = await admin(galaxy, dev);
    await install(a, dev, { version: 'v1', types: TYPES });
    const t = pinClock();
    const d = uuid();
    const created = await tx(a, dev, createTest(d));
    if (!created.ok) throw new Error('setup create failed');

    // A version whose validator holds `parseBatch`; the plane's cold-load marker fires when the
    // first op reaches it, so the delete below commits while that op waits.
    const held = `held-${uuid().slice(0, 6)}`;
    await install(a, dev, { version: held, types: TYPES }, HOLD_MS);
    const c = uuid();
    const waiting = tx(a, dev, createTest(c), held);
    // Polled with real timers: `vi.waitFor` advances faked timers, which would move the pinned clock.
    const coldLoaded = () => sink.some((e) => e.namespace === 'nebula.Resources.ontology'
      && e.message === 'facet cold load' && e.data?.version === held);
    for (let waited = 0; !coldLoaded(); waited += 20) {
      if (waited > 20_000) throw new Error('the held op never reached its validator');
      await new Promise((r) => setTimeout(r, 20));
    }
    const deleted = await tx(a, dev, { [d]: { op: 'delete', ifValidFromMatches: created.validFrom } }, held);
    expect(deleted.ok).toBe(true);
    expect((await waiting).ok).toBe(true);

    const at = await currentMoments(dev);
    expect([at[d], at[c]]).toEqual([iso(t + 1), iso(t + 2)]);
    a[Symbol.dispose]();
  }, 60_000);
});

describe('a read that history does not slow', () => {
  it('a resource with 100 snapshots reads in at most 2 rows, and a query reads only current rows', async () => {
    const { galaxy, dev } = newDev();
    const a = await admin(galaxy, dev);
    await install(a, dev, { version: 'v1', types: TYPES });
    const [parent, child] = [uuid(), uuid()];
    const made = await tx(a, dev, {
      [parent]: { op: 'create', typeName: 'Parent', nodeId: ROOT_NODE_ID, value: { name: 'p' } },
      [child]: { op: 'create', typeName: 'Child', nodeId: ROOT_NODE_ID, value: { parent, label: 'v0' } },
    });
    if (!made.ok) throw new Error('setup create failed');
    let version = made.validFrom;
    for (let i = 1; i < 100; i++) {
      const put = await tx(a, dev, { [child]: { op: 'put', ifValidFromMatches: version, value: { parent, label: `v${i}` } } });
      if (!put.ok) throw new Error(`put ${i} failed`);
      version = put.validFrom;
    }
    const rows = await (runInDurableObject as any)(stub(dev), (_i: unknown, c: DurableObjectState) => ({
      history: c.storage.sql.exec('SELECT COUNT(*) AS n FROM Snapshots WHERE resourceId = ?', child).toArray()[0].n as number,
      current: c.storage.sql.exec(`SELECT COUNT(*) AS n FROM Snapshots WHERE validTo = '9999-01-01T00:00:00.000Z'`).toArray()[0].n as number,
    }));
    expect(rows.history).toBe(100); // fixture guard: the history the reads must not walk

    // Record every statement the Star's storage runs while the read and the query run. The cursor
    // keeps its `rowsRead` after the code under test has consumed it.
    const seen: Array<{ sql: string; cursor: { rowsRead: number } }> = [];
    (globalThis as any).__momentsSeen = seen;
    await (runInDurableObject as any)(stub(dev), (_i: unknown, c: DurableObjectState) => {
      const sql = c.storage.sql as any;
      const exec = sql.exec;
      sql.__originalExec = exec;
      sql.exec = (query: string, ...bindings: unknown[]) => {
        const cursor = exec.call(sql, query, ...bindings);
        (globalThis as any).__momentsSeen?.push({ sql: query, cursor });
        return cursor;
      };
    });
    try {
      await a.lmz.callAsync('STAR', dev, door(a).read('v1', child));
      await a.lmz.callAsync('STAR', dev, door(a).subscribeQuery('v1',
        { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: parent }));
    } finally {
      await (runInDurableObject as any)(stub(dev), (_i: unknown, c: DurableObjectState) => {
        const sql = c.storage.sql as any;
        sql.exec = sql.__originalExec;
      });
      delete (globalThis as any).__momentsSeen;
    }

    const read = seen.filter((s) => /^\s*SELECT resourceId, nodeId, typeName[\s\S]*FROM Snapshots\s+WHERE resourceId = \?/.test(s.sql));
    const query = seen.filter((s) => /WHERE typeName = \? AND validTo = \?/.test(s.sql));
    expect(read.length).toBeGreaterThan(0); // the instrument saw the read at all
    expect(query.length).toBeGreaterThan(0); // and the query
    for (const s of read) expect(s.cursor.rowsRead).toBeLessThanOrEqual(2);
    // A scan of the current rows reads one entry past its last (measured: 3 for 2 current, 4 for 3).
    for (const s of query) expect(s.cursor.rowsRead).toBeLessThanOrEqual(rows.current + 1);
    a[Symbol.dispose]();
  }, 120_000);
});
