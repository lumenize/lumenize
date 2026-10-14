/**
 * A shared object is written once, and every later occurrence is a `$ref`
 * whose JSON Pointer names that first place in the encoding.
 *
 * The codec is a pure function of its input, so these need no running system.
 *
 * Mutations, each of which reds a test here:
 * - build a segment from the raw key rather than the encoded one
 * - skip `~` escaping in `escapePointerSegment`, or escape `/` before `~`
 * - refuse every `__proto__` segment
 * - resolve a `$ref` only from containers already filled
 * - emit the `{ json, meta }` wrapper
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse, preprocess, RequestSync } from '../src/index.js';

describe('an encoding', () => {
  it('is the encoded value, with no wrapper', () => {
    expect(stringify({ title: 'Ship it' })).toBe('{"title":"Ship it"}');
  });
});

describe('a shared object', () => {
  const shared = () => ({ id: 'shared' });

  it.each([
    ['a plain key', (s: object) => ({ owner: s, later: s }), '#/owner', (r: any) => r.owner],
    ['a key the encoder escapes, $$x', (s: object) => ({ $$x: s, later: s }), '#/$$$x', (r: any) => r.$$x],
    ['an array element', (s: object) => ({ list: [0, s], later: s }), '#/list/1', (r: any) => r.list[1]],
    ['a Map value in entries form', (s: object) => ({ m: new Map<unknown, unknown>([['k', s], [1, 0]]), later: s }), '#/m/entries/0/1', (r: any) => r.m.get('k')],
    ['a Map value in object form, under key 42', (s: object) => ({ m: new Map([['42', s]]), later: s }), '#/m/object/$42', (r: any) => r.m.get('42')],
    ['a Map key', (s: object) => ({ m: new Map([[s, 1]]), later: s }), '#/m/entries/0/0', (r: any) => [...r.m.keys()][0]],
    ['a Set member', (s: object) => ({ set: new Set([s]), later: s }), '#/set/values/0', (r: any) => [...r.set][0]],
    ["an Error's cause", (s: object) => ({ e: new Error('m', { cause: s }), later: s }), '#/e/cause', (r: any) => r.e.cause],
    ["an Error's own property", (s: object) => ({ e: Object.assign(new Error('m'), { detail: s }), later: s }), '#/e/detail', (r: any) => r.e.detail],
    ['the empty key', (s: object) => ({ '': s, later: s }), '#/', (r: any) => r['']],
  ])('first written under %s is referenced by that place', (_, build, pointer, firstPlace) => {
    const value = build(shared());

    expect(preprocess(value)).toMatchObject({ later: { $ref: pointer } });
    const restored = parse(stringify(value));
    expect(restored.later).toEqual({ id: 'shared' });
    expect(restored.later).toBe(firstPlace(restored));
  });

  it('keeps its identity wherever it was first written', () => {
    const s = shared();
    const e = Object.assign(new Error('m', { cause: s }), { detail: s });
    const restored = parse(stringify({
      $$x: s,
      list: [s],
      m: new Map([[s, s]]),
      set: new Set([s]),
      e,
      later: s,
    }));

    expect(restored.list[0]).toBe(restored.$$x);
    const [[key, mapValue]] = [...restored.m];
    expect(key).toBe(restored.$$x);
    expect(mapValue).toBe(restored.$$x);
    expect([...restored.set][0]).toBe(restored.$$x);
    expect(restored.e.cause).toBe(restored.$$x);
    expect(restored.e.detail).toBe(restored.$$x);
    expect(restored.later).toBe(restored.$$x);
  });

  it('under a request’s headers is referenced through data/headers', () => {
    // RequestSync copies the Headers it is given, so share the copy it holds.
    const request = new RequestSync('https://example.com/', { headers: { 'x-a': '1' } });
    const value = { request, later: request.headers };

    expect(preprocess(value)).toMatchObject({ later: { $ref: '#/request/data/headers' } });
    // The decoded request copies its headers too, so only the value matches.
    const restored = parse(stringify(value));
    expect(restored.later).toBeInstanceOf(Headers);
    expect(restored.later.get('x-a')).toBe('1');
  });

  it('under keys a/b and a~1b keeps the two apart', () => {
    const slash = { id: 'slash' };
    const tilde = { id: 'tilde' };
    const value = { 'a/b': slash, 'a~1b': tilde, first: slash, second: tilde };

    expect(preprocess(value)).toMatchObject({
      first: { $ref: '#/a~1b' },
      second: { $ref: '#/a~01b' },
    });
    const restored = parse(stringify(value));
    expect(restored.first).toBe(restored['a/b']);
    expect(restored.second).toBe(restored['a~1b']);
    expect(restored.first.id).toBe('slash');
    expect(restored.second.id).toBe('tilde');
  });

  it('under the empty key, beside a cycle through the root, keeps both apart', () => {
    const value: any = { '': shared() };
    value.self = value;
    value.later = value[''];

    const encoded = preprocess(value) as any;
    expect(encoded.self).toEqual({ $ref: '#' });
    expect(encoded.later).toEqual({ $ref: '#/' });
    const restored = parse(stringify(value));
    expect(restored.self).toBe(restored);
    expect(restored.later).toBe(restored['']);
  });

  it('under an own __proto__ key is referenced by #/__proto__', () => {
    const value = JSON.parse('{"__proto__":{"id":"shared"}}');
    value.later = Object.getOwnPropertyDescriptor(value, '__proto__')!.value;

    expect(stringify(value)).toBe('{"__proto__":{"id":"shared"},"later":{"$ref":"#/__proto__"}}');
    const restored = parse(stringify(value));
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
    expect(restored.later).toBe(Object.getOwnPropertyDescriptor(restored, '__proto__')!.value);
  });
});

describe('a document whose keys a patch has reordered', () => {
  it('decodes a $ref that comes before its target to the same object', () => {
    // A merge patch adds keys last, so `pinned` can land after `later`.
    const restored = parse('{"later":{"$ref":"#/pinned/row"},"pinned":{"row":{"id":"r1"}}}');

    expect(restored.later).toBe(restored.pinned.row);
    expect(restored.later).toEqual({ id: 'r1' });
  });

  it('decodes a cycle whose $ref comes before the object that closes it', () => {
    const restored = parse('{"b":{"back":{"$ref":"#/a"}},"a":{"next":{"$ref":"#/b"}}}');

    expect(restored.a.next).toBe(restored.b);
    expect(restored.b.back).toBe(restored.a);
  });
});
