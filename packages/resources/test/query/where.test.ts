/**
 * The WHERE compiler's text, its bound values and its refusals. Pure: a filter and an ontology in,
 * SQL out, so it needs no running system. `query-sqlite.test.ts` runs the same SQL in SQLite.
 */
import { describe, it, expect } from 'vitest';
import { compileQuery, compileWhere, MAX_BOUND_PARAMS, QueryError } from '../../src/query';
import type { Filter } from '../../src/query';
import { fields } from './fixture';

const where = (filter: Filter) => compileWhere(fields(), 'Deal', filter);
const refusal = (filter: unknown, typeName = 'Deal'): string => {
  try {
    compileWhere(fields(), typeName, filter as Filter);
  } catch (e) {
    expect((e as Error).name).toBe('QueryError');
    expect(e).toBeInstanceOf(QueryError);
    return (e as Error).message;
  }
  throw new Error(`compiled, where a refusal was expected: ${JSON.stringify(filter)}`);
};

const STAGE = `json_extract(value, '$.stage')`;
const AMOUNT = `json_extract(value, '$.amount')`;
const AMOUNT_HOLDS = `json_type(value, '$.amount') IN ('integer', 'real')`;
const TITLE = `json_extract(value, '$.title')`;
const TITLE_HOLDS = `json_type(value, '$.title') IN ('text')`;

describe('compileWhere: the SQL and the bound values', () => {
  it.each<[string, Filter, string, Array<string | number>]>([
    ['a bare value is equality', { stage: 'open' }, `${STAGE} = ?`, ['open']],
    ['$eq', { amount: { $eq: 5 } }, `${AMOUNT} = ?`, [5]],
    ['$ne matches a missing value too', { amount: { $ne: 5 } }, `${AMOUNT} IS NOT ?`, [5]],
    ['a boolean binds as 1 or 0', { won: true }, `json_extract(value, '$.won') = ?`, [1]],
    ['false binds as 0', { won: false }, `json_extract(value, '$.won') = ?`, [0]],
    ['a Date is read at .iso and bound as its ISO string', { due: new Date('2026-12-01T00:00:00Z') },
      `json_extract(value, '$.due.iso') = ?`, ['2026-12-01T00:00:00.000Z']],
    ['a dotted path', { 'address.geo.lat': 3 }, `json_extract(value, '$.address.geo.lat') = ?`, [3]],
    ['ordering on a number carries its type guard', { amount: { $gt: 1000 } }, `(${AMOUNT} > ? AND ${AMOUNT_HOLDS})`, [1000]],
    ['ordering on a Date needs no guard', { due: { $lte: new Date('2026-01-01T00:00:00Z') } },
      `json_extract(value, '$.due.iso') <= ?`, ['2026-01-01T00:00:00.000Z']],
    ['two operators on one field are ANDed, in the order written', { amount: { $gte: 1, $lt: 9 } },
      `((${AMOUNT} >= ? AND ${AMOUNT_HOLDS}) AND (${AMOUNT} < ? AND ${AMOUNT_HOLDS}))`, [1, 9]],
    ['two fields are ANDed, in the order written', { stage: 'open', amount: 5 }, `(${STAGE} = ? AND ${AMOUNT} = ?)`, ['open', 5]],
    ['$in', { stage: { $in: ['lead', 'won'] } }, `${STAGE} IN (?, ?)`, ['lead', 'won']],
    ['$in with no values', { stage: { $in: [] } }, '0 = 1', []],
    ['$nin', { amount: { $nin: [1, 2] } }, `(${AMOUNT} IS NULL OR ${AMOUNT} NOT IN (?, ?))`, [1, 2]],
    ['$nin with no values', { amount: { $nin: [] } }, '1 = 1', []],
    ['$exists true', { amount: { $exists: true } }, AMOUNT_HOLDS, []],
    ['$exists false', { amount: { $exists: false } }, `(${AMOUNT_HOLDS} IS NOT TRUE)`, []],
    ['null is $exists false', { amount: null }, `(${AMOUNT_HOLDS} IS NOT TRUE)`, []],
    ['$exists on an object tells a real one from a wrapped null', { address: { $exists: true } },
      `(json_type(value, '$.address') = 'object' AND json_type(value, '$.address."$type"') IS NULL)`, []],
    ['$startsWith is a key range', { title: { $startsWith: 'Ac' } }, `(${TITLE} >= ? AND ${TITLE} < ? AND ${TITLE_HOLDS})`, ['Ac', 'Ad']],
    ['$startsWith past the range form compares the prefix', { title: { $startsWith: 'A😀' } },
      `(substr(${TITLE}, 1, ?) = ? AND ${TITLE_HOLDS})`, [2, 'A😀']],
    ['$startsWith with nothing', { title: { $startsWith: '' } }, TITLE_HOLDS, []],
    ['$endsWith counts characters', { title: { $endsWith: '😀x' } }, `(substr(${TITLE}, -?) = ? AND ${TITLE_HOLDS})`, [2, '😀x']],
    ['$contains', { title: { $contains: 'cm' } }, `(instr(${TITLE}, ?) > 0 AND ${TITLE_HOLDS})`, ['cm']],
    ['$or', { $or: [{ stage: 'won' }, { amount: 5 }] }, `(${STAGE} = ? OR ${AMOUNT} = ?)`, ['won', 5]],
    ['$and', { $and: [{ stage: 'won' }, { amount: 5 }] }, `(${STAGE} = ? AND ${AMOUNT} = ?)`, ['won', 5]],
    ['$nor', { $nor: [{ stage: 'won' }, { amount: 5 }] }, `((${STAGE} = ? OR ${AMOUNT} = ?) IS NOT TRUE)`, ['won', 5]],
    ['$not', { $not: { stage: 'won' } }, `((${STAGE} = ?) IS NOT TRUE)`, ['won']],
    ['$not on a field', { amount: { $not: { $gt: 5 } } }, `((${AMOUNT} > ? AND ${AMOUNT_HOLDS}) IS NOT TRUE)`, [5]],
    ['no conditions', {}, '', []],
  ])('%s', (_name, filter, sql, params) => {
    expect(where(filter)).toEqual({ sql, params });
  });

  it('compileQuery opens with the type\'s current rows, as literals', () => {
    const rows = `typeName = 'Deal' AND validTo = '9999-01-01T00:00:00.000Z' AND deleted = 0`;
    expect(compileQuery(fields(), 'Deal', {}, [])).toEqual({ where: rows, params: [] });
    expect(compileQuery(fields(), 'Deal', { stage: 'open' }, [{ type: 'Deal', fields: ['stage'] }]))
      .toEqual({ where: `${rows} AND ${STAGE} = ?`, params: ['open'] });
  });

  it('is pure: the same filter compiles to the same text twice, and leaves the filter as it was', () => {
    const filter = { stage: { $in: ['lead', 'open'] }, amount: { $gt: 1 } };
    const before = JSON.stringify(filter);
    expect(where(filter)).toEqual(where(filter));
    expect(JSON.stringify(filter)).toBe(before);
  });
});

describe('compileQuery: a filter must give an index something to look up', () => {
  const INDEXES = [
    { type: 'Deal', fields: ['stage', 'amount'] }, { type: 'Deal', fields: ['title'] }, { type: 'Task', fields: ['owner'] },
  ];
  const served = (filter: Filter, indexes = INDEXES): string => {
    try { compileQuery(fields(), 'Deal', filter, indexes); } catch (e) { expect((e as Error).name).toBe('QueryError'); return (e as Error).message; }
    return 'served';
  };

  it.each<[string, Filter]>([
    ['equality on an index\'s first field', { stage: 'open' }],
    ['$eq', { stage: { $eq: 'open' } }],
    ['$in with values', { stage: { $in: ['open'] } }],
    ['a range', { title: { $gte: 'A', $lt: 'B' } }],
    ['one end of a range', { title: { $gt: 'A' } }],
    ['a prefix', { title: { $startsWith: 'Ac' } }],
    ['a lookup beside conditions no index can look up', { stage: 'open', owner: { $ne: 'p1' }, note: null, due: { $exists: false } }],
    ['a lookup beside a negative on the same field', { title: { $gt: 'A', $ne: 'B' } }],
    ['a lookup inside a top-level $and', { $and: [{ note: null }, { stage: 'open' }] }],
    ['a lookup inside a nested $and', { $and: [{ $and: [{ stage: 'open' }] }] }],
    ['no conditions at all, which asks for every Deal', {}],
  ])('serves %s', (_name, filter) => {
    expect(served(filter)).toBe('served');
  });

  const REFUSED = 'This filter would read every current Deal. Give it a condition an index can look up';
  it.each<[string, Filter]>([
    ['a field with no index', { owner: 'p1' }],
    ['an index\'s second field alone', { amount: 5 }],
    ['a field only another type indexes', { owner: { $in: ['p1'] } }],
    ['null alone', { stage: null }],
    ['$exists alone, true or false', { stage: { $exists: true } }],
    ['$ne alone', { stage: { $ne: 'open' } }],
    ['$nin alone', { stage: { $nin: ['open'] } }],
    ['$in with no values', { stage: { $in: [] } }],
    ['$not on the field', { title: { $not: { $gt: 'A' } } }],
    ['$endsWith alone', { title: { $endsWith: 'x' } }],
    ['$contains alone', { title: { $contains: 'x' } }],
    ['a prefix of nothing', { title: { $startsWith: '' } }],
    ['a prefix past the range form', { title: { $startsWith: 'A😀' } }],
    ['a lookup only inside $or', { $or: [{ stage: 'open' }, { stage: 'won' }] }],
    ['a lookup only inside $not', { $not: { stage: 'open' } }],
    ['a lookup only inside $nor', { $nor: [{ stage: 'open' }] }],
    ['a lookup inside an $or inside $and', { $and: [{ $or: [{ stage: 'open' }] }] }],
  ])('refuses %s', (_name, filter) => {
    expect(served(filter)).toContain(REFUSED);
  });

  it('says which fields the type\'s indexes start with, or that it has none', () => {
    expect(served({ owner: 'p1' })).toContain(`Deal's indexes start with "stage", "title"`);
    expect(served({ owner: 'p1' }, [{ type: 'Task', fields: ['owner'] }])).toContain('Deal has no index');
    expect(served({ owner: 'p1' }, [])).toContain('Deal has no index');
  });

  it('still refuses what compileWhere refuses, before it looks at the indexes', () => {
    expect(served({ nope: 1 })).toBe('Deal has no field "nope"');
  });
});

describe('compileWhere: what it refuses, by message', () => {
  it.each<[string, unknown, string]>([
    ['a field the type does not declare', { nope: 1 }, 'Deal has no field "nope"'],
    ['a path past a declared object', { 'address.zip': 1 }, 'Deal has no field "address.zip"'],
    ['a path through a scalar', { 'title.length': 1 }, 'Deal.title has no fields of its own to reach into'],
    ['an inherited name is no field', { constructor: 1 }, 'Deal has no field "constructor"'],
    ['an array field', { tags: 'a' }, 'Deal.tags cannot be queried: it is an array'],
    ['a Map field', { scores: 1 }, 'Deal.scores cannot be queried: it is a Map'],
    ['a bigint field', { big: 1 }, 'Deal.big cannot be queried: it is a bigint'],
    ['a string for a number', { amount: '5' }, '$eq on Deal.amount takes a finite number, and got "5"'],
    ['Infinity', { amount: { $lt: Infinity } }, '$lt on Deal.amount takes a finite number, and got Infinity'],
    ['NaN', { amount: NaN }, '$eq on Deal.amount takes a finite number, and got NaN'],
    ['a number for a string', { title: 5 }, '$eq on Deal.title takes a string, and got 5'],
    ['a string for a boolean', { won: 'true' }, '$eq on Deal.won takes true or false, and got "true"'],
    ['a string for a Date', { due: '2026-01-01' }, '$eq on Deal.due takes a valid Date, and got "2026-01-01"'],
    ['an invalid Date', { due: new Date('nope') }, '$eq on Deal.due takes a valid Date, and got Date(invalid)'],
    ['a number for an id', { owner: 7 }, "$eq on Deal.owner takes a resource's id, and got 7"],
    ['a value outside an enum', { stage: 'closed' }, '$eq on Deal.stage takes one of "lead", "open", "won", and got "closed"'],
    ['a value outside an enum, in a list', { stage: { $in: ['open', 'x'] } }, '$in on Deal.stage takes one of "lead", "open", "won", and got "x"'],
    ['ordering on an enum', { stage: { $gt: 'lead' } }, '$gt on Deal.stage: its values are a fixed list'],
    ['ordering on a boolean', { won: { $gt: false } }, '$gt on Deal.won: a boolean has no order to compare by'],
    ['ordering on an id', { owner: { $lt: 'p2' } }, '$lt on Deal.owner: an id has no order to compare by'],
    ['$in without a list', { stage: { $in: 'open' } }, '$in on Deal.stage takes a list of values, and got "open"'],
    ['$exists without a boolean', { amount: { $exists: 1 } }, '$exists takes true or false, and Deal.amount got 1'],
    ['$startsWith on a number', { amount: { $startsWith: '1' } }, '$startsWith on Deal.amount needs a string field, and Deal.amount is a number'],
    ['$contains on an enum', { stage: { $contains: 'o' } }, '$contains on Deal.stage needs a string field, and Deal.stage is a fixed list of values'],
    ['$endsWith without a string', { title: { $endsWith: 5 } }, '$endsWith on Deal.title takes a string, and got 5'],
    ['$elemMatch', { title: { $elemMatch: {} } }, '$elemMatch on Deal.title: a query cannot look inside an array yet'],
    ['$size', { title: { $size: 2 } }, '$size on Deal.title: a query cannot look inside an array yet'],
    ['an operator nobody defined', { title: { $regex: 'a' } }, '$regex on Deal.title is not an operator this engine knows'],
    ['an object compared whole', { address: { city: 'Raleigh' } }, 'Deal.address is compared with {"city":"Raleigh"}'],
    ['an operator on an object', { address: { $eq: 1 } }, 'Deal.address holds an object, so it takes only $exists or null'],
    ['operators mixed with plain keys', { amount: { $gt: 1, more: 2 } }, 'Deal.amount is compared with {"$gt":1,"more":2}'],
    ['an empty condition', { amount: {} }, 'Deal.amount is compared with {}'],
    ['an array as a value', { title: ['a'] }, '$eq on Deal.title takes a string, and got ["a"]'],
    ['$and without a list', { $and: { stage: 'open' } }, '$and takes a list of filters, and got {"stage":"open"}'],
    ['$or with an empty list', { $or: [] }, '$or takes a list of filters, and got []'],
    ['an empty filter in a list', { $or: [{}] }, '$or[0] is an empty filter'],
    ['a top-level operator nobody defined', { $where: 'x' }, '$where is not an operator a filter can open with'],
    ['$not on a field without operators', { amount: { $not: 5 } }, '$not on Deal.amount takes operators'],
    ['a filter that is no object', 'stage = open', 'A filter is an object of fields and conditions; the filter is "stage = open"'],
    ['a filter that is a list', [{ stage: 'open' }], 'A filter is an object of fields and conditions'],
  ])('%s', (_name, filter, message) => {
    expect(refusal(filter)).toContain(message);
  });

  it('refuses a type the ontology does not declare, an inherited name among them', () => {
    expect(refusal({}, 'Nope')).toBe('The ontology has no type named "Nope"');
    expect(refusal({}, 'toString')).toBe('The ontology has no type named "toString"');
    expect(refusal({ stage: 'open' }, `Deal' OR 1=1 --`)).toContain('has no type named');
  });

  it(`binds ${MAX_BOUND_PARAMS} values and refuses one more`, () => {
    const numbers = (count: number) => Array.from({ length: count }, (_, i) => i);
    expect(where({ amount: { $in: numbers(MAX_BOUND_PARAMS) } }).params).toHaveLength(MAX_BOUND_PARAMS);
    expect(refusal({ amount: { $in: numbers(MAX_BOUND_PARAMS + 1) } })).toContain(`binds ${MAX_BOUND_PARAMS + 1} values, and one query may bind ${MAX_BOUND_PARAMS}`);
    expect(refusal({ amount: { $in: numbers(MAX_BOUND_PARAMS) }, stage: 'open' })).toContain(`binds ${MAX_BOUND_PARAMS + 1} values`);
  });

  // The extractor only lists plain identifiers, so these come from a hand-built map: the resolver
  // holds the line itself, since a name reaches the SQL as text.
  it('refuses a field or a type whose name is not a plain identifier', () => {
    const odd = { 'Bad"Type': { a: { kind: 'string', optional: false } }, T: { "a'b": { kind: 'string', optional: false } } } as const;
    const message = (typeName: string, filter: Filter) => {
      try { compileWhere(odd as never, typeName, filter); } catch (e) { return (e as Error).message; }
      return 'compiled';
    };
    expect(message('T', { "a'b": 'x' })).toBe(`T.a'b cannot be queried: its name is not a plain identifier`);
    expect(message('Bad"Type', { a: 'x' })).toBe('The ontology has no type named "Bad"Type"');
  });

  it('puts nothing a caller sends into the SQL text', () => {
    const hostile = `x' OR '1'='1`;
    const { sql, params } = where({ title: hostile, note: { $startsWith: hostile }, owner: { $in: [hostile] } });
    expect(sql).not.toContain(hostile);
    expect(sql).not.toContain(`OR '1'`);
    expect(params).toEqual([hostile, hostile, hostile.slice(0, -1) + '2', hostile]);
  });
});
