/**
 * The stored form of each kind of field, and the values a query would read wrongly.
 *
 * The first half pins what the serializer writes, because `src/query/fields.ts` builds its SQL on
 * those shapes: if structured-clone changes how it stores a Date or a null, this reds before a
 * query silently stops matching. The second half is the check a host runs on a write. Both are
 * pure, so neither needs a running system.
 */
import { describe, it, expect } from 'vitest';
import { stringify } from '@lumenize/structured-clone';
import { assertQueryable, findUnqueryable } from '../../src/query';
import { fields } from './fixture';

describe('the stored form the query engine reads', () => {
  it('keeps a string, a finite number and a boolean as plain JSON, nested objects included', async () => {
    expect(JSON.parse(await stringify({ title: 'a "quoted" $name', amount: 1.5, won: false, address: { city: 'Cary', geo: { lat: -3 } } })))
      .toEqual({ title: 'a "quoted" $name', amount: 1.5, won: false, address: { city: 'Cary', geo: { lat: -3 } } });
  });

  it('wraps a Date with its ISO string at .iso', async () => {
    expect(JSON.parse(await stringify({ due: new Date('2026-12-01T00:00:00Z') })))
      .toEqual({ due: { $type: 'date', iso: '2026-12-01T00:00:00.000Z' } });
  });

  it('wraps null, undefined and the numbers JSON cannot hold, each under $type', async () => {
    expect(JSON.parse(await stringify({ a: null, b: undefined, c: Infinity, d: -Infinity, e: NaN, f: -0 }))).toEqual({
      a: { $type: 'null' }, b: { $type: 'undefined' },
      c: { $type: 'number-special', value: 'Infinity' }, d: { $type: 'number-special', value: '-Infinity' },
      e: { $type: 'number-special', value: 'NaN' }, f: { $type: 'number-special', value: '-0' },
    });
  });

  it('stores an object held twice once, and a reference to it the second time', async () => {
    const shared = { city: 'Cary' };
    expect(JSON.parse(await stringify({ address: shared, billing: shared })))
      .toEqual({ address: { city: 'Cary' }, billing: { $ref: '#/address' } });
  });
});

describe('findUnqueryable', () => {
  const issues = async (value: Record<string, unknown>) => findUnqueryable(fields(), 'Deal', await stringify(value));

  it('passes a resource whose fields a query can read, with or without its optional ones', async () => {
    expect(await issues({ title: 'x', stage: 'open', amount: 5, budget: null, won: false, due: new Date(), owner: 'p', note: undefined, address: { city: 'c', geo: { lat: 0 } } })).toEqual([]);
    expect(await issues({ title: 'x', stage: 'open', won: false, owner: 'p' })).toEqual([]);
  });

  it.each([[Infinity, 'Infinity'], [-Infinity, '-Infinity'], [NaN, 'NaN'], [-0, '-0']])('names a number field holding %s', async (value, shown) => {
    expect(await issues({ amount: value })).toEqual([{
      path: 'amount', message: `Deal.amount is ${shown}, which a query cannot compare. Store a finite number, or leave the field out`,
    }]);
  });

  it('names a nested number by its dotted path, and every issue it finds', async () => {
    const found = await issues({ amount: NaN, address: { city: 'c', geo: { lat: Infinity } } });
    expect(found.map((issue) => issue.path)).toEqual(['amount', 'address.geo.lat']);
  });

  it('names an object that is a reference to one stored earlier', async () => {
    const geo = { lat: 1 };
    expect(await issues({ scores: new Map([['k', 1]]), address: { city: 'c', geo }, extra: geo })).toEqual([]);
    const found = findUnqueryable(fields(), 'Deal', JSON.stringify({ first: { city: 'c' }, address: { $ref: '#/first' } }));
    expect(found).toEqual([{ path: 'address', message: 'Deal.address is the same object as the one at first, and a query cannot reach into the second. Store a copy' }]);
  });

  it('names a Date field holding an invalid Date', () => {
    const found = findUnqueryable(fields(), 'Deal', JSON.stringify({ due: { $type: 'date', iso: 'not a date' } }));
    expect(found).toEqual([{ path: 'due', message: 'Deal.due is an invalid Date, which a query cannot compare' }]);
  });

  it('leaves a field a query cannot reach alone, whatever it holds', async () => {
    expect(await issues({ tags: ['a'], scores: new Map([['k', Infinity]]), big: 10n })).toEqual([]);
  });

  it('assertQueryable throws one QueryError naming every issue, and nothing for a clean value', async () => {
    expect(() => assertQueryable(fields(), 'Deal', JSON.stringify({ amount: 1 }))).not.toThrow();
    const stored = await stringify({ amount: NaN, budget: Infinity });
    expect(() => assertQueryable(fields(), 'Deal', stored)).toThrow('Deal.amount is NaN, which a query cannot compare. Store a finite number, or leave the field out; Deal.budget is Infinity');
    expect(() => findUnqueryable(fields(), 'Nope', '{}')).toThrow('The ontology has no type named "Nope"');
  });
});
