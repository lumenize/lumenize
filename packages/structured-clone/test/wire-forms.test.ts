/**
 * Each value takes the form a merge patch can address one place at a time:
 * Maps, Sets and long id lists as objects, `null` and holes as tags, binary
 * as base64, and a request's body like any other value.
 *
 * The codec is a pure function of its input, so these need no running system.
 *
 * Mutations, each of which reds a test here:
 * - drop the `$` escape for an array-index key, or for a key that starts with `$`
 * - drop `keyType`, or skip the escape for a number key
 * - drop the distinctness check, or the size threshold, or skip holes in the element check
 * - encode every Map as `entries`, every Set as `values`, or every array plain
 * - write a property's `null` as JSON `null`, or a hole as one
 * - encode binary as a number array, from `.buffer` rather than the view's window,
 *   or with one spread into `String.fromCharCode`
 * - check base64 with a pattern that repeats a group of four, which overflows
 *   the regex stack on a few megabytes
 * - copy a request's `body` raw, or leave a body out of the index
 * - build requests and responses in document order rather than when first needed
 */

import { describe, it, expect } from 'vitest';
import { stringify, parse, preprocess, RequestSync, ResponseSync } from '../src/index.js';

const roundTrip = <T>(value: T): T => parse(stringify(value));

// Every JSON null in an encoding: there must be none.
function nullsIn(json: string): string[] {
  const found: string[] = [];
  const walk = (v: unknown, at: string): void => {
    if (v === null) found.push(at);
    else if (Array.isArray(v)) v.forEach((el, i) => walk(el, `${at}/${i}`));
    else if (typeof v === 'object') for (const k of Object.keys(v)) walk((v as any)[k], `${at}/${k}`);
  };
  walk(JSON.parse(json), '#');
  return found;
}

const uuid = (n: number) => `0b6c${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;

describe('a Map or Set whose keys are all strings', () => {
  it('takes the object form, with an array-index key escaped so it keeps its place', () => {
    const map = new Map([['b', 1], ['42', 2]]);

    expect(stringify(map)).toBe('{"$type":"map","object":{"b":1,"$42":2}}');
    expect([...roundTrip(map).keys()]).toEqual(['b', '42']);
  });

  it('keeps a real "$42" apart from "42"', () => {
    const map = new Map([['$42', 'dollar'], ['42', 'plain'], ['$$x', 'two']]);

    expect(stringify(map)).toBe('{"$type":"map","object":{"$$42":"dollar","$42":"plain","$$$x":"two"}}');
    expect([...roundTrip(map)]).toEqual([['$42', 'dollar'], ['42', 'plain'], ['$$x', 'two']]);
  });

  it('applies the same to a Set', () => {
    const set = new Set(['b', '42', '$42']);

    expect(stringify(set)).toBe('{"$type":"set","object":{"b":1,"$42":1,"$$42":1}}');
    expect([...roundTrip(set)]).toEqual(['b', '42', '$42']);
  });

  it('takes the object form when empty', () => {
    expect(stringify(new Map())).toBe('{"$type":"map","object":{}}');
    expect(stringify(new Set())).toBe('{"$type":"set","object":{}}');
    expect(roundTrip(new Map()).size).toBe(0);
  });

  it('keeps a key named __proto__ as an entry', () => {
    const restored = roundTrip(new Map([['__proto__', 1], ['toString', 2]]));

    expect([...restored]).toEqual([['__proto__', 1], ['toString', 2]]);
  });
});

describe('a Map or Set whose keys are all numbers', () => {
  it('takes the object form with keyType number, and decodes number keys in order', () => {
    const map = new Map([[2026, 'a'], [1.5, 'b'], [NaN, 'c'], [-1, 'd']]);

    expect(stringify(map)).toBe('{"$type":"map","keyType":"number","object":{"$2026":"a","1.5":"b","NaN":"c","-1":"d"}}');
    const restored = roundTrip(map);
    expect([...restored.keys()]).toEqual([2026, 1.5, NaN, -1]);
    expect(restored.get(2026)).toBe('a');
  });

  it('keeps every number exactly', () => {
    const keys = [0, Infinity, -Infinity, 0.1 + 0.2, 1e21, 5e-324, Number.MAX_SAFE_INTEGER];

    expect([...roundTrip(new Set(keys))]).toEqual(keys);
  });

  it('keeps entries or values when the keys mix strings and numbers', () => {
    expect(stringify(new Map<unknown, number>([['a', 1], [2, 2]]))).toBe('{"$type":"map","entries":[["a",1],[2,2]]}');
    expect(stringify(new Set<unknown>(['a', 2]))).toBe('{"$type":"set","values":["a",2]}');
    expect([...roundTrip(new Map<unknown, number>([['a', 1], [2, 2]]))]).toEqual([['a', 1], [2, 2]]);
  });
});

describe('an array', () => {
  const ids = Array.from({ length: 8 }, (_, i) => uuid(i));

  it('of distinct strings over 256 bytes takes exactly the object form', () => {
    const encoded = preprocess(ids) as any;

    expect(Object.keys(encoded)).toEqual(['$type', 'object']);
    expect(encoded.$type).toBe('array');
    expect(Object.keys(encoded.object)).toEqual(ids);
    expect(Object.values(encoded.object).every((v) => v === 1)).toBe(true);
    expect(roundTrip(ids)).toEqual(ids);
  });

  it('escapes an array-index member so it keeps its place', () => {
    const list = [...ids, '7', '$x'];

    expect(Object.keys((preprocess(list) as any).object).slice(-2)).toEqual(['$7', '$$x']);
    expect(roundTrip(list)).toEqual(list);
  });

  it('stays plain when one string repeats', () => {
    const repeated = [...ids.slice(0, 7), ids[0]];

    expect(JSON.stringify(repeated)).toHaveLength(313);
    expect(Array.isArray(preprocess(repeated))).toBe(true);
    expect(roundTrip(repeated)).toEqual(repeated);
  });

  it('stays plain under 256 bytes', () => {
    expect(stringify(['red', 'green', 'blue'])).toBe('["red","green","blue"]');
  });

  it('stays plain with a hole, keeping the hole and its length', () => {
    const holed = [...ids];
    delete holed[3];

    expect(Array.isArray(preprocess(holed))).toBe(true);
    const restored = roundTrip(holed);
    expect(restored).toHaveLength(8);
    expect(3 in restored).toBe(false);
    expect(restored[4]).toBe(ids[4]);
  });

  it('decodes the same on both sides of the threshold', () => {
    const short = ids.slice(0, 6);
    const long = ids.slice(0, 7);

    expect(Array.isArray(preprocess(short))).toBe(true);
    expect(Array.isArray(preprocess(long))).toBe(false);
    expect(roundTrip(short)).toEqual(short);
    expect(roundTrip(long)).toEqual(long);
  });

  it('keeps a sparse hole as a hole', () => {
    const restored = roundTrip([1, , 3]);

    expect(restored).toHaveLength(3);
    expect(1 in restored).toBe(false);
    expect(stringify([1, , 3])).toBe('[1,{"$type":"hole"},3]');
  });
});

describe('a shared object first written under an object-form Map key', () => {
  it('is referenced through the encoded key', () => {
    const s = { id: 's' };
    const value = { tags: new Map([['42', s]]), pinned: s };

    expect(stringify(value)).toBe('{"tags":{"$type":"map","object":{"$42":{"id":"s"}}},"pinned":{"$ref":"#/tags/object/$42"}}');
    const restored = roundTrip(value);
    expect(restored.pinned).toBe(restored.tags.get('42'));
  });
});

describe('a null', () => {
  it('is a tag, so a property holding it stays an own key', () => {
    expect(stringify({ a: 1, b: null })).toBe('{"a":1,"b":{"$type":"null"}}');
    const restored = roundTrip({ a: 1, b: null });
    expect(Object.hasOwn(restored, 'b')).toBe(true);
    expect(restored.b).toBeNull();
  });

  it('round-trips at the top level', () => {
    expect(stringify(null)).toBe('{"$type":"null"}');
    expect(roundTrip(null)).toBeNull();
  });
});

describe('a value nesting every form', () => {
  it('round-trips deep-equal, keeps every shared reference, and holds no JSON null', () => {
    const roster = Array.from({ length: 10 }, (_, i) => uuid(i));
    const keyA = { k: 'a' };
    const holed = [1, , 3];
    const value = {
      byName: new Map([['ids', new Set([3, 1.5])], ['42', null]]),
      roster,
      again: roster,
      byObject: new Map([[keyA, 'a'], [{ k: 'b' }, 'b']]),
      nothing: null,
      holed,
      bytes: new Uint8Array([0, 255, 7]),
      keyA,
    };

    const json = stringify(value);
    expect(nullsIn(json)).toEqual([]);
    const restored = parse(json);
    expect(restored).toEqual(value);
    expect(restored.again).toBe(restored.roster);
    expect([...restored.byObject.keys()][0]).toBe(restored.keyA);
    expect(1 in restored.holed).toBe(false);
    expect([...restored.byName.get('ids')]).toEqual([3, 1.5]);
  });
});

describe('binary', () => {
  const isNode = globalThis.navigator?.userAgent?.startsWith('Node.js') === true;

  it('travels as base64 of exactly its bytes', () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) % 256;

    const encoded = preprocess(bytes) as any;
    expect(encoded).toEqual({ $type: 'arraybuffer', subtype: 'Uint8Array', base64: expect.any(String) });
    expect(encoded.base64.length).toBeLessThanOrEqual(1400);
    expect(Array.from(roundTrip(bytes))).toEqual(Array.from(bytes));
  });

  it('round-trips 1 MB', () => {
    const bytes = new Uint8Array(1 << 20);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;

    const restored = roundTrip(bytes);
    expect(restored.length).toBe(bytes.length);
    expect(restored[123_456]).toBe(123_456 % 251);
    expect(restored[bytes.length - 1]).toBe((bytes.length - 1) % 251);
  });

  it('round-trips 8 MiB, past where a backtracking base64 check overflows', () => {
    const bytes = new Uint8Array(8 << 20);
    bytes[bytes.length - 1] = 7;

    const restored = roundTrip(bytes);
    expect(restored.length).toBe(bytes.length);
    expect(restored[bytes.length - 1]).toBe(7);
  });

  it.runIf(isNode)("sends Node's Buffer.from('hi') as its two bytes, not its pool", () => {
    const hi = (globalThis as any).Buffer.from('hi');
    // The dangerous shape: a view onto a larger shared buffer.
    expect(hi.buffer.byteLength).toBeGreaterThan(2);

    expect(preprocess(hi)).toEqual({ $type: 'arraybuffer', subtype: 'Uint8Array', base64: 'aGk=' });
  });

  it('sends a view as its own window', () => {
    const whole = Uint8Array.from({ length: 40 }, (_, i) => i);
    const window = whole.subarray(10, 20);
    const floats = new Float64Array(new ArrayBuffer(32), 8, 2);
    floats.set([1.5, -2.25]);
    const view = new DataView(whole.buffer, 4, 3);

    expect(Array.from(roundTrip(window))).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const restoredFloats = roundTrip(floats);
    expect(restoredFloats).toBeInstanceOf(Float64Array);
    expect(Array.from(restoredFloats)).toEqual([1.5, -2.25]);
    const restoredView = roundTrip(view);
    expect(restoredView).toBeInstanceOf(DataView);
    expect(restoredView.byteLength).toBe(3);
    expect([0, 1, 2].map((i) => restoredView.getUint8(i))).toEqual([4, 5, 6]);
  });

  it('round-trips an ArrayBuffer, and keeps NaN payloads and bigints exactly', () => {
    const buffer = Uint8Array.from([9, 8, 7]).buffer;
    const big = new BigInt64Array([-1n, 2n ** 62n]);
    const floats = new Float64Array([NaN, -0, Infinity]);

    expect(Array.from(new Uint8Array(roundTrip(buffer)))).toEqual([9, 8, 7]);
    expect(Array.from(roundTrip(big))).toEqual([-1n, 2n ** 62n]);
    const restored = roundTrip(floats);
    expect(Number.isNaN(restored[0])).toBe(true);
    expect(Object.is(restored[1], -0)).toBe(true);
    expect(restored[2]).toBe(Infinity);
  });
});

describe("a request's or response's body", () => {
  it('encodes like any value, so an empty body is no JSON null', () => {
    const request = new RequestSync('https://example.com/');
    const response = new ResponseSync(null);

    expect(nullsIn(stringify(request))).toEqual([]);
    expect(nullsIn(stringify(response))).toEqual([]);
    expect(roundTrip(request).body).toBeNull();
    expect(roundTrip(response).body).toBeNull();
  });

  it('keeps an ArrayBuffer body as its bytes', () => {
    const response = new ResponseSync(Uint8Array.from([104, 105]).buffer, { status: 201 });

    const restored = roundTrip(response);
    expect(restored.body).toBeInstanceOf(ArrayBuffer);
    expect(restored.text()).toBe('hi');
    expect(restored.status).toBe(201);
  });

  it('keeps a shared object first written in a body, referenced through data/body', () => {
    const s = { id: 's' };
    const value = { req: new RequestSync('https://example.com/', { method: 'POST', body: s }), later: s };

    expect(preprocess(value)).toMatchObject({ later: { $ref: '#/req/data/body' } });
    const restored = roundTrip(value);
    expect(restored.later).toBe(restored.req.body);
  });

  it('keeps a body that is itself a response, in a document holding a $ref', () => {
    const shared = { id: 's' };
    const value = {
      req: new RequestSync('https://example.com/', { method: 'POST', body: new ResponseSync('hi') as any }),
      a: shared,
      b: shared,
    };

    const restored = roundTrip(value);
    expect(restored.req.body).toBeInstanceOf(ResponseSync);
    expect((restored.req.body as unknown as ResponseSync).text()).toBe('hi');
  });

  it("decodes a body's $ref to a request later in the document", () => {
    const first = new RequestSync('https://example.com/first');
    const value = { a: first, b: new RequestSync('https://example.com/second', { method: 'POST', body: first as any }) };
    const encoded = preprocess(value) as any;
    // A patch can put `b` ahead of `a`; the $ref must resolve either way.
    const reordered = JSON.stringify({ b: encoded.b, a: encoded.a });

    expect(encoded.b.data.body).toEqual({ $ref: '#/a' });
    const restored = parse(reordered);
    expect(restored.b.body).toBe(restored.a);
    expect(restored.a.url).toBe('https://example.com/first');
  });

  it('keeps an object body, Map and all', () => {
    const request = new RequestSync('https://example.com/', { method: 'POST', body: { tags: new Map([['a', 1]]) } as any });

    expect((roundTrip(request).body as any).tags.get('a')).toBe(1);
  });
});

describe("a user object with its own $type key", () => {
  it('round-trips, escaped as $$type', () => {
    expect(stringify({ $type: 'x', a: 1 })).toBe('{"$$type":"x","a":1}');
    expect(roundTrip({ $type: 'x', a: 1 })).toEqual({ $type: 'x', a: 1 });
  });
});
