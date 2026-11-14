/**
 * The compiled SQL, run by the SQLite a Durable Object has.
 *
 * The unit tests beside this file pin the SQL text. This file holds what text cannot show: that
 * SQLite accepts each statement, selects the resources the filter means, and uses an index compiled
 * from the same ontology. It writes rows straight into a host's `Snapshots` table, in the stored
 * form the serializer gives them, because the engine is not wired into the Resources plane yet and
 * so no client call reaches it. When it is, a `/live` scenario takes over the selecting half.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { stringify } from '@lumenize/structured-clone';
import { END_OF_TIME, ROOT_NODE_ID } from '../../src/index';
import { compileIndex, compileQuery, compileWhere, currentRowsSql, findUnqueryable, MAX_BOUND_PARAMS, QUERY_INDEX_PREFIX } from '../../src/query';
import type { Filter } from '../../src/query';
import { fields } from './fixture';

const shared = { city: 'Cary' };
const DEALS: Record<string, Record<string, unknown>> = {
  acme: { title: 'Acme renewal', stage: 'open', amount: 1500, budget: 2000, won: false, due: new Date('2026-12-01T00:00:00Z'), owner: 'p1', address: { city: 'Raleigh', geo: { lat: 35.8 } } },
  globex: { title: 'Globex pilot', stage: 'lead', amount: 500, budget: null, won: false, owner: 'p2', address: { city: 'Durham' }, note: 'call back' },
  upsell: { title: 'acme upsell', stage: 'won', amount: 1000, won: true, due: new Date('2026-06-01T00:00:00Z'), owner: 'p1', note: undefined },
  initech: { title: 'Initech', stage: 'open', won: false, owner: 'p2', note: 'Ünïcode 😀 tail' },
  infinite: { title: 'Infinite', stage: 'lead', amount: Infinity, budget: -Infinity, won: false, owner: 'p3' },
};

type Sql = { exec: (query: string, ...bindings: unknown[]) => { toArray: () => Array<Record<string, unknown>> } };

async function inHost<T>(name: string, run: (sql: Sql) => T | Promise<T>): Promise<T> {
  const stub = env.STAR.getByName(name);
  return (runInDurableObject as any)(stub, (_instance: unknown, state: { storage: { sql: Sql } }) => run(state.storage.sql));
}

async function seed(name: string): Promise<void> {
  const rows: Array<[string, string, string, string, number, string]> = [];
  for (const [id, value] of Object.entries(DEALS)) rows.push([id, 'Deal', '2026-01-01T00:00:00.000Z', END_OF_TIME, 0, await stringify(value)]);
  // Rows a query for current Deals must never return: superseded, deleted, and another type.
  rows.push(['acme', 'Deal', '2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, await stringify({ ...DEALS.acme, stage: 'lead' })]);
  rows.push(['gone', 'Deal', '2026-01-01T00:00:00.000Z', END_OF_TIME, 1, await stringify({ ...DEALS.acme })]);
  rows.push(['task', 'Task', '2026-01-01T00:00:00.000Z', END_OF_TIME, 0, await stringify({ title: 'Acme renewal', stage: 'open' })]);
  await inHost(name, (sql) => {
    for (const [id, typeName, validFrom, validTo, deleted, value] of rows) {
      sql.exec(
        `INSERT INTO Snapshots (resourceId, nodeId, typeName, ontologyVersion, validFrom, validTo, recordedClaims, deleted, value)
         VALUES (?, ?, ?, 'v1', ?, ?, '{}', ?, ?)`,
        id, ROOT_NODE_ID, typeName, validFrom, validTo, deleted, value,
      );
    }
  });
}

/**
 * Every current Deal `filter` matches. It joins the clause to the type's current rows itself, so a
 * filter is judged for what it selects whether or not an index could look anything up for it.
 */
async function select(name: string, filter: Filter): Promise<string[]> {
  const { sql: clause, params } = compileWhere(fields(), 'Deal', filter);
  const where = clause ? `${currentRowsSql(fields(), 'Deal')} AND ${clause}` : currentRowsSql(fields(), 'Deal');
  return inHost(name, (sql) =>
    sql.exec(`SELECT resourceId FROM Snapshots WHERE ${where} ORDER BY resourceId`, ...params).toArray().map((row) => row.resourceId as string));
}

async function plan(name: string, query: string, ...params: unknown[]): Promise<string> {
  return inHost(name, (sql) => sql.exec(`EXPLAIN QUERY PLAN ${query}`, ...params).toArray().map((row) => String(row.detail)).join(' | '));
}

async function queryIndexes(name: string): Promise<string[]> {
  return inHost(name, (sql) =>
    sql.exec(`SELECT name FROM sqlite_master WHERE type = 'index' AND substr(name, 1, ?) = ?`, QUERY_INDEX_PREFIX.length, QUERY_INDEX_PREFIX)
      .toArray().map((row) => row.name as string));
}

describe('a compiled filter selects the resources it means', () => {
  const host = `query-${crypto.randomUUID().slice(0, 8)}`;
  beforeAll(() => seed(host));

  const ALL = ['acme', 'globex', 'infinite', 'initech', 'upsell'];
  const cases: Array<[string, Filter, string[]]> = [
    ['no conditions: every current Deal, and no superseded, deleted or Task row', {}, ALL],
    ['equality on a string', { title: 'Acme renewal' }, ['acme']],
    ['equality on an enum', { stage: 'open' }, ['acme', 'initech']],
    ['equality on a number', { amount: 1000 }, ['upsell']],
    ['equality on a boolean', { won: true }, ['upsell']],
    ['equality on false', { won: false }, ['acme', 'globex', 'infinite', 'initech']],
    ['equality on a Date', { due: new Date('2026-12-01T00:00:00Z') }, ['acme']],
    ['equality on a relationship id', { owner: 'p1' }, ['acme', 'upsell']],
    ['a dotted path into an object', { 'address.city': 'Durham' }, ['globex']],
    ['a dotted path two levels down', { 'address.geo.lat': { $gt: 35 } }, ['acme']],
    ['several fields are ANDed', { stage: 'open', owner: 'p2' }, ['initech']],
    ['$gt on a number skips absent, null and Infinity', { amount: { $gt: 900 } }, ['acme', 'upsell']],
    ['$gte', { amount: { $gte: 1000 } }, ['acme', 'upsell']],
    ['$lt on a number skips -Infinity and null', { budget: { $lt: 5000 } }, ['acme']],
    ['$lte', { amount: { $lte: 500 } }, ['globex']],
    ['a range', { amount: { $gt: 500, $lt: 1500 } }, ['upsell']],
    ['$gt on a Date', { due: { $gt: new Date('2026-07-01T00:00:00Z') } }, ['acme']],
    ['$lt on a Date skips a Deal with no due date', { due: { $lt: new Date('2027-01-01T00:00:00Z') } }, ['acme', 'upsell']],
    ['$gt on a string compares bytes, so lower case sorts last', { title: { $gt: 'Z' } }, ['upsell']],
    ['$ne also matches a Deal whose field holds no value', { amount: { $ne: 1500 } }, ['globex', 'infinite', 'initech', 'upsell']],
    ['$in', { stage: { $in: ['lead', 'won'] } }, ['globex', 'infinite', 'upsell']],
    ['$in with no values matches nothing', { stage: { $in: [] } }, []],
    ['$nin also matches a Deal whose field holds no value', { amount: { $nin: [500, 1000] } }, ['acme', 'infinite', 'initech']],
    ['$nin with no values matches everything', { amount: { $nin: [] } }, ALL],
    ['$exists true: a value of the declared type', { amount: { $exists: true } }, ['acme', 'globex', 'upsell']],
    ['$exists false: absent, and Infinity', { amount: { $exists: false } }, ['infinite', 'initech']],
    ['null: absent, null and -Infinity', { budget: null }, ['globex', 'infinite', 'initech', 'upsell']],
    ['null on a field set to undefined', { note: null }, ['acme', 'infinite', 'upsell']],
    ['$exists on an object', { address: { $exists: true } }, ['acme', 'globex']],
    ['null on an object', { address: null }, ['infinite', 'initech', 'upsell']],
    ['$exists on a Date', { due: { $exists: false } }, ['globex', 'infinite', 'initech']],
    ['$startsWith is case-sensitive', { title: { $startsWith: 'Acme' } }, ['acme']],
    ['$startsWith with nothing matches every string', { note: { $startsWith: '' } }, ['globex', 'initech']],
    ['$startsWith ending in a character past the range form', { note: { $startsWith: 'Ünïcode 😀' } }, ['initech']],
    ['$endsWith', { title: { $endsWith: 'pilot' } }, ['globex']],
    ['$endsWith counts characters, not UTF-16 units', { note: { $endsWith: '😀 tail' } }, ['initech']],
    ['$contains', { title: { $contains: 'cme' } }, ['acme', 'upsell']],
    ['$or', { $or: [{ stage: 'won' }, { owner: 'p2' }] }, ['globex', 'initech', 'upsell']],
    ['$and', { $and: [{ stage: 'open' }, { amount: { $gt: 1000 } }] }, ['acme']],
    ['$nor also matches a Deal whose fields hold no value', { $nor: [{ amount: { $gt: 900 } }, { stage: 'lead' }] }, ['initech']],
    ['$not also matches a Deal whose field holds no value', { $not: { amount: { $gt: 900 } } }, ['globex', 'infinite', 'initech']],
    ['$not on a field', { amount: { $not: { $gt: 900 } } }, ['globex', 'infinite', 'initech']],
  ];

  it.each(cases)('%s', async (_name, filter, expected) => {
    expect(await select(host, filter)).toEqual(expected);
  });

  // The clause alone, against one snapshot by its key: the probe that asks whether a write
  // entered or left a query's results. The superseded `acme` row held `stage: 'lead'`.
  it('the clause alone judges one snapshot, current or not', async () => {
    const { sql: clause, params } = compileWhere(fields(), 'Deal', { stage: 'lead' });
    const matches = (validFrom: string) => inHost(host, (sql) =>
      sql.exec(`SELECT 1 AS hit FROM Snapshots WHERE resourceId = ? AND validFrom = ? AND ${clause}`, 'acme', validFrom, ...params).toArray().length);
    expect(await matches('2025-01-01T00:00:00.000Z')).toBe(1);
    expect(await matches('2026-01-01T00:00:00.000Z')).toBe(0);
  });

  it('the value check names exactly the rows whose numbers a comparison skips', async () => {
    const flagged: string[] = [];
    for (const [id, value] of Object.entries(DEALS)) {
      if (findUnqueryable(fields(), 'Deal', await stringify(value)).length > 0) flagged.push(id);
    }
    expect(flagged).toEqual(['infinite']);
    const aliased = await stringify({ ...DEALS.acme, address: shared, other: shared });
    expect(findUnqueryable(fields(), 'Deal', aliased)).toEqual([]);
  });
});

describe('an index compiled from the same ontology serves the query', () => {
  const host = `index-${crypto.randomUUID().slice(0, 8)}`;
  beforeAll(() => seed(host));

  it('is created, used by a query on its leading field, and dropped', async () => {
    const spec = { type: 'Deal', fields: ['stage', 'amount'] };
    const index = compileIndex(fields(), spec);
    const { where, params } = compileQuery(fields(), 'Deal', { stage: 'open', amount: { $gt: 1000 } }, [spec]);
    const query = `SELECT resourceId FROM Snapshots WHERE ${where}`;

    expect(await plan(host, query, ...params)).not.toContain(QUERY_INDEX_PREFIX);
    await inHost(host, (sql) => { sql.exec(index.createSql); });
    expect(await queryIndexes(host)).toEqual([index.name]);
    // SEARCH is a lookup by the index's key; SCAN would be a walk of every row in it.
    const served = `SEARCH Snapshots USING INDEX ${index.name}`;
    expect(await plan(host, query, ...params)).toContain(served);
    // A second create is a no-op, and the query still answers as it did with no index.
    await inHost(host, (sql) => { sql.exec(index.createSql); });
    expect(await select(host, { stage: 'open', amount: { $gt: 1000 } })).toEqual(['acme']);

    // The leading field alone is looked up. The second field alone is not: SQLite may still walk
    // the index, since it holds only current Deals, but it cannot look a key up in it.
    const leading = compileQuery(fields(), 'Deal', { stage: 'lead' }, [spec]);
    expect(await plan(host, `SELECT resourceId FROM Snapshots WHERE ${leading.where}`, ...leading.params)).toContain(served);
    const second = compileWhere(fields(), 'Deal', { amount: 1000 });
    expect(await plan(host, `SELECT resourceId FROM Snapshots WHERE ${currentRowsSql(fields(), 'Deal')} AND ${second.sql}`, ...second.params)).not.toContain('SEARCH');
    // Which is why the compiler refuses that filter with this index alone.
    expect(() => compileQuery(fields(), 'Deal', { amount: 1000 }, [spec])).toThrow('This filter would read every current Deal');

    // The drop is read from the catalogue: asked again in the same words, EXPLAIN here answers
    // with the plan it gave before the drop.
    await inHost(host, (sql) => { sql.exec(index.dropSql); });
    expect(await queryIndexes(host)).toEqual([]);
    expect(await select(host, { stage: 'open', amount: { $gt: 1000 } })).toEqual(['acme']);
  });

  it('serves a Date, a dotted path and a prefix', async () => {
    for (const [path, filter] of [
      ['due', { due: { $gt: new Date('2026-07-01T00:00:00Z') } }],
      ['address.city', { 'address.city': 'Durham' }],
      ['title', { title: { $startsWith: 'Acme' } }],
    ] as Array<[string, Filter]>) {
      const index = compileIndex(fields(), { type: 'Deal', fields: [path] });
      await inHost(host, (sql) => { sql.exec(index.createSql); });
      const { where, params } = compileQuery(fields(), 'Deal', filter, [{ type: 'Deal', fields: [path] }]);
      expect(await plan(host, `SELECT resourceId FROM Snapshots WHERE ${where}`, ...params), path).toContain(`SEARCH Snapshots USING INDEX ${index.name}`);
      await inHost(host, (sql) => { sql.exec(index.dropSql); });
    }
  });
});

// The rule `compileQuery` holds: every filter it accepts gives SQLite a key to look up, whatever
// else the filter carries, so none of them reads every current Deal.
describe('every filter compileQuery accepts is looked up in an index', () => {
  const host = `lookup-${crypto.randomUUID().slice(0, 8)}`;
  const specs = [{ type: 'Deal', fields: ['stage', 'amount'] }, { type: 'Deal', fields: ['title'] }, { type: 'Deal', fields: ['owner'] }];
  beforeAll(async () => {
    await seed(host);
    await inHost(host, (sql) => { for (const spec of specs) sql.exec(compileIndex(fields(), spec).createSql); });
  });

  it.each<[string, Filter, string[]]>([
    ['equality', { stage: 'open' }, ['acme', 'initech']],
    ['$in', { stage: { $in: ['lead', 'won'] } }, ['globex', 'infinite', 'upsell']],
    ['a prefix', { title: { $startsWith: 'Acme' } }, ['acme']],
    ['a range on a string', { title: { $gte: 'Globex' } }, ['globex', 'infinite', 'initech', 'upsell']],
    ['equality beside $ne', { stage: 'open', amount: { $ne: 1500 } }, ['initech']],
    ['equality beside null', { stage: 'lead', budget: null }, ['globex', 'infinite']],
    ['equality beside $exists false', { owner: 'p2', amount: { $exists: false } }, ['initech']],
    ['equality beside $nin and $not', { owner: 'p1', amount: { $nin: [1000] }, $not: { won: true } }, ['acme']],
    ['equality beside $nor and $contains', { owner: 'p2', $nor: [{ stage: 'lead' }], title: { $contains: 'tech' } }, ['initech']],
    ['equality inside $and', { $and: [{ owner: 'p1' }, { $or: [{ won: true }, { amount: { $gt: 1200 } }] }] }, ['acme', 'upsell']],
  ])('%s', async (_name, filter, expected) => {
    const { where, params } = compileQuery(fields(), 'Deal', filter, specs);
    expect(await plan(host, `SELECT resourceId FROM Snapshots WHERE ${where}`, ...params)).toContain('SEARCH Snapshots USING INDEX idx_Snapshots_q_Deal:');
    expect(await select(host, filter)).toEqual(expected);
  });
});

describe('the bound-parameter limit the compiler holds', () => {
  it(`is what SQLite here enforces: ${MAX_BOUND_PARAMS} bind, one more is refused`, async () => {
    const host = `limit-${crypto.randomUUID().slice(0, 8)}`;
    const run = (count: number) => inHost(host, (sql) => {
      try {
        sql.exec(`SELECT ${Array.from({ length: count }, () => '?').join(' + ')} AS total`, ...Array.from({ length: count }, () => 1)).toArray();
        return 'ran';
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(await run(MAX_BOUND_PARAMS)).toBe('ran');
    expect(await run(MAX_BOUND_PARAMS + 1)).not.toBe('ran');
  });
});
