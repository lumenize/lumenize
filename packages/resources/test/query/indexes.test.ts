/**
 * The index compiler's SQL and refusals. Pure: a specification and an ontology in, SQL out.
 * `query-sqlite.test.ts` creates the same indexes in SQLite and reads the plan.
 */
import { describe, it, expect } from 'vitest';
import { compileIndex, compileQuery, compileWhere, MAX_INDEX_FIELDS, QUERY_INDEX_PREFIX } from '../../src/query';
import { fields } from './fixture';

const ROWS = `typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0`;
const refusal = (spec: { type: string; fields: string[] }): string => {
  try { compileIndex(fields(), spec); } catch (e) { expect((e as Error).name).toBe('QueryError'); return (e as Error).message; }
  throw new Error('compiled, where a refusal was expected');
};

describe('compileIndex', () => {
  it('names the index for its type and fields, and limits it to the type\'s current rows', () => {
    expect(compileIndex(fields(), { type: 'Deal', fields: ['stage', 'due', 'address.city'] })).toEqual({
      name: 'idx_Snapshots_q_Deal:stage,due,address.city',
      createSql: `CREATE INDEX IF NOT EXISTS "idx_Snapshots_q_Deal:stage,due,address.city" ON Snapshots(` +
        `json_extract(value, '$.stage'), json_extract(value, '$.due.iso'), json_extract(value, '$.address.city')) WHERE ${ROWS}`,
      dropSql: `DROP INDEX IF EXISTS "idx_Snapshots_q_Deal:stage,due,address.city"`,
    });
  });

  // SQLite matches a query to an index by the expression's text and the index's WHERE, so each
  // must be exactly what the WHERE compiler writes for the same field.
  it.each(['title', 'stage', 'amount', 'won', 'due', 'owner', 'address.city', 'address.geo.lat'])(
    'indexes %s on the expression a filter on it compares', (path) => {
      const { createSql } = compileIndex(fields(), { type: 'Deal', fields: [path] });
      const expression = createSql.slice(createSql.indexOf('ON Snapshots(') + 'ON Snapshots('.length, createSql.indexOf(') WHERE '));
      expect(compileWhere(fields(), 'Deal', { [path]: { $exists: true } }).sql).toContain(expression.replace('json_extract', 'json_type'));
      expect(createSql.endsWith(` WHERE ${compileQuery(fields(), 'Deal', {}, []).where}`)).toBe(true);
    });

  it('gives one specification one name, and another order another', () => {
    const a = compileIndex(fields(), { type: 'Deal', fields: ['stage', 'amount'] });
    expect(compileIndex(fields(), { type: 'Deal', fields: ['stage', 'amount'] })).toEqual(a);
    expect(compileIndex(fields(), { type: 'Deal', fields: ['amount', 'stage'] }).name).not.toBe(a.name);
    expect(compileIndex(fields(), { type: 'Task', fields: ['stage'] }).name).toBe(`${QUERY_INDEX_PREFIX}Task:stage`);
  });

  it.each<[string, { type: string; fields: string[] }, string]>([
    ['a type the ontology does not declare', { type: 'Nope', fields: ['a'] }, 'The ontology has no type named "Nope"'],
    ['no fields', { type: 'Deal', fields: [] }, 'An index on Deal names at least one field'],
    ['a field twice', { type: 'Deal', fields: ['stage', 'stage'] }, 'An index on Deal names "stage" twice'],
    ['a field the type does not declare', { type: 'Deal', fields: ['nope'] }, 'Deal has no field "nope"'],
    ['an object', { type: 'Deal', fields: ['address'] }, 'Deal.address holds an object, which an index cannot order'],
    ['an array', { type: 'Deal', fields: ['tags'] }, 'Deal.tags cannot be queried: it is an array'],
    ['too many fields', { type: 'Deal', fields: ['title', 'stage', 'amount', 'budget', 'won', 'due', 'owner', 'note', 'address.city'] },
      `An index on Deal names 9 fields, and may name ${MAX_INDEX_FIELDS}`],
  ])('refuses %s', (_name, spec, message) => {
    expect(refusal(spec)).toContain(message);
  });
});
