/**
 * The decoder constructs only what the encoder emits, whatever a payload names.
 *
 * Every payload here is hand-written wire JSON that no encoder produces, which is
 * why these need no running system: a real client cannot send them, and the
 * decoder is a pure function of the string. They run in Node, workerd and
 * chromium alike because the globals within reach differ by runtime — `WebSocket`
 * and `EventSource` in workerd, `Image` and `Audio` in a browser.
 *
 * Mutations, each of which reds its describe:
 * - restore `(globalThis as any)[name] || Error` in `errorClassNamed`
 * - drop the `Object.getPrototypeOf(Ctor) === TypedArray` conjunct in `allocArrayBuffer`
 * - make `setOwn` assign `__proto__` rather than define it
 * - drop the `typeof base64 !== 'string'` check in `base64ToBytes`
 * - on a pointer that misses the index, walk the parsed document instead
 * - fill a `$ref`'s target when the `$ref` is resolved, rather than in the fill pass
 * - key the index by each container's whole pointer rather than its own segment
 * - restore the decoder's `default:` branch, which kept an unknown `$type` as data
 * - read an unknown `keyType` as strings
 * - decode a number key with `Number` and no canonical check
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { stringify, parse } from '../src/index.js';

const wire = (json: unknown) => JSON.stringify(json);

// A non-Error global that counts its constructions, registered the way a custom
// Error class is, so the decoder can find it by name if anything lets it.
let constructed = 0;
class Tripwire {
  constructor() {
    constructed++;
  }
}

class ProbeError extends Error {
  override name = 'ProbeError';
  constructor(message: string, public field?: string) {
    super(message);
  }
}
class NestedProbeError extends ProbeError {
  override name = 'NestedProbeError';
}

beforeAll(() => {
  Object.assign(globalThis, { Tripwire, ProbeError, NestedProbeError });
});
afterAll(() => {
  for (const name of ['Tripwire', 'ProbeError', 'NestedProbeError']) delete (globalThis as any)[name];
});

const presentHere = (names: string[]) =>
  names.filter((name) => typeof (globalThis as any)[name] === 'function');

describe('an encoded error names a global that is not an Error class', () => {
  const XSS = '<img src=x onerror="globalThis.xss = 1">';

  it.each(presentHere(['Map', 'WebSocket', 'EventSource', 'Request', 'Image', 'Audio', 'Function']))(
    '%s decodes to an Error that carries the name as data',
    (name) => {
      const err = parse(wire({ $type: 'error', name, message: 'wss://attacker.invalid/', innerHTML: XSS }));

      expect(Object.getPrototypeOf(err)).toBe(Error.prototype);
      expect(err).not.toBeInstanceOf((globalThis as any)[name]);
      expect(err.name).toBe(name);
      expect(err.message).toBe('wss://attacker.invalid/');
      // A custom own property still round-trips; on an Error it is inert data.
      expect(Object.getOwnPropertyDescriptor(err, 'innerHTML')?.value).toBe(XSS);
    },
  );

  it.each([
    ['inline', (error: unknown) => parse(wire(error))],
    ['aliased', (error: unknown) => parse(wire([{ $ref: '#/1' }, error]))[0]],
  ])('constructs nothing when the error is %s', (_, decode) => {
    const before = constructed;
    const err = decode({ $type: 'error', name: 'Tripwire', message: 'm' });

    expect(constructed).toBe(before);
    expect(Object.getPrototypeOf(err)).toBe(Error.prototype);
    expect(err.name).toBe('Tripwire');
  });

  it.each([
    ['ProbeError', () => new ProbeError('Invalid email', 'email')],
    ['NestedProbeError', () => new NestedProbeError('Invalid email', 'email')],
  ])('a custom %s registered on globalThis keeps instanceof', (name, make) => {
    const shared = make();
    const restored = parse(stringify(make()));
    const [aliased] = parse(stringify([shared, shared]));

    for (const err of [restored, aliased]) {
      expect(err).toBeInstanceOf((globalThis as any)[name]);
      expect(err).toBeInstanceOf(ProbeError);
      expect(err.name).toBe(name);
      expect(err.field).toBe('email');
    }
  });
});

describe('an encoded typed array names a global that is not a typed array', () => {
  it.each(presentHere(['Map', 'WebSocket', 'Image', 'Audio', 'Function', 'Buffer']))(
    'subtype %s decodes to a Uint8Array of the same bytes',
    (subtype) => {
      const arr = parse(wire({ $type: 'arraybuffer', subtype, base64: 'aGk=' }));

      expect(Object.getPrototypeOf(arr)).toBe(Uint8Array.prototype);
      expect(Array.from(arr)).toEqual([104, 105]);
    },
  );

  it('constructs nothing for subtype Tripwire', () => {
    const before = constructed;
    const arr = parse(wire({ $type: 'arraybuffer', subtype: 'Tripwire', base64: 'AQ==' }));

    expect(constructed).toBe(before);
    expect(Object.getPrototypeOf(arr)).toBe(Uint8Array.prototype);
  });

  it.each(presentHere([
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
    'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  ]))('a built-in %s still round-trips as itself', (name) => {
    const Ctor = (globalThis as any)[name];
    const values = name.startsWith('Big') ? [1n, 2n, 3n] : [1, 2, 3];
    const arr = parse(stringify(new Ctor(values)));

    expect(Object.getPrototypeOf(arr)).toBe(Ctor.prototype);
    expect(Array.from(arr)).toEqual(values);
  });
});

describe('a wire key named __proto__', () => {
  // Written as strings: in a JS object literal, `__proto__` sets the prototype.
  it.each([
    ['a plain object', '{"__proto__":{"isAdmin":true}}', Object.prototype],
    ['an aliased plain object', '[{"$ref":"#/1"},{"__proto__":{"isAdmin":true}}]', Object.prototype],
    ['an error', '{"$type":"error","name":"Error","message":"m","__proto__":{"isAdmin":true}}', Error.prototype],
  ])('arrives on %s as an own key, not as its prototype', (_, payload, prototype) => {
    const decoded = parse(payload);
    const value = Array.isArray(decoded) ? decoded[0] : decoded;

    expect(Object.getPrototypeOf(value)).toBe(prototype);
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(value.isAdmin).toBeUndefined();
  });

  it('round-trips as the own key native structuredClone keeps', () => {
    const source = JSON.parse('{"__proto__":{"y":2},"b":1}');
    const restored = parse(stringify(source));

    expect(Object.keys(restored)).toEqual(Object.keys(structuredClone(source)));
    expect(Object.getOwnPropertyDescriptor(restored, '__proto__')?.value).toEqual({ y: 2 });
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
  });
});

describe('an encoded arraybuffer whose bytes are not base64', () => {
  it.each([
    ['a length rather than bytes', { subtype: 'Float64Array', base64: 1_000_000 }, /base64 is not a string/],
    ['bytes as a number array', { subtype: 'ArrayBuffer', data: [1, 2, 3] }, /base64 is not a string/],
    ['text that is not base64', { subtype: 'Uint8Array', base64: 'not base64!' }, /base64 is not base64/],
    ['base64 missing its padding', { subtype: 'Uint8Array', base64: 'AQI' }, /base64 is not base64/],
    ['7 bytes for a Float64Array', { subtype: 'Float64Array', base64: 'AQIDBAUGBw==' }, /not a whole number of Float64Array elements/],
    ['a DataView window outside its buffer', { subtype: 'DataView', base64: 'AQID', byteOffset: 8, byteLength: 1_000_000 }, /names a window/],
  ])('is refused, not allocated: %s', (_, fields, message) => {
    const payload = wire({ $type: 'arraybuffer', ...fields });

    expect(() => parse(payload)).toThrow(DOMException);
    expect(() => parse(payload)).toThrow(message);
  });
});

describe('a $ref that names no value in the document', () => {
  const prototypeKeys = () => Object.getOwnPropertyNames(Object.prototype).sort();

  it.each([
    ['__proto__, with no such own key', '{"a":{"$ref":"#/__proto__"}}'],
    ['constructor/constructor, with no such own key', '{"a":{"$ref":"#/constructor/constructor"}}'],
    ['a dangling index', '[{"$ref":"#/5"}]'],
    ["a Map's entries pair rather than a value in it", '{"m":{"$type":"map","entries":[[{"k":1},{"v":1}]]},"r":{"$ref":"#/m/entries/0"}}'],
    ["a Date's payload", '{"when":{"$type":"date","iso":"2026-10-14T00:00:00.000Z"},"r":{"$ref":"#/when/iso"}}'],
    ['another $ref', '[{"$ref":"#/1"},{"$ref":"#/0"}]'],
    ['a pointer with no #', '[{"$ref":"/1"},{}]'],
    ['the numeric form the format used to write', '[{"$ref":0},{}]'],
    ['an array index written with a leading zero', '[{"$ref":"#/01"},{}]'],
  ])('is refused: %s', (_, payload) => {
    const before = prototypeKeys();

    expect(() => parse(payload)).toThrow(DOMException);
    expect(() => parse(payload)).toThrow(/names no value|holds no JSON Pointer/);
    expect(prototypeKeys()).toEqual(before);
    expect(({} as any).isAdmin).toBeUndefined();
  });

  it('is refused when it has a sibling key', () => {
    expect(() => parse('[{"$ref":"#/1","x":1},{}]')).toThrow(/sibling keys/);
  });
});

describe('a document a hostile sender sized to blow up the index', () => {
  // Node reports its heap; workerd and chromium run the same decode and its
  // correctness checks, with no heap figure to read.
  const heapUsed = (): number | undefined =>
    typeof process !== 'undefined' && typeof process.memoryUsage === 'function'
      && globalThis.navigator?.userAgent?.startsWith('Node.js')
      ? process.memoryUsage().heapUsed
      : undefined;
  const decodeWithin32MB = (payload: string) => {
    const before = heapUsed();
    const decoded = parse(payload);
    const after = heapUsed();
    if (before !== undefined && after !== undefined) expect(after - before).toBeLessThan(32 * 1024 * 1024);
    return decoded;
  };

  it('decodes 1,000 levels of 1,000-character keys whose bottom cycles to the root', () => {
    const keys = Array.from({ length: 1000 }, (_, i) => String(i).padStart(1000, 'k'));
    const payload = keys.map((k) => `{"${k}":`).join('') + '{"$ref":"#"}' + '}'.repeat(1000);

    const decoded = decodeWithin32MB(payload);

    let at = decoded;
    for (const k of keys.slice(0, -1)) at = at[k];
    expect(at[keys[999]]).toBe(decoded);
  });

  it('decodes 4,000 same-length siblings under a key longer than 16 KB', () => {
    const big = 'b'.repeat(16 * 1024 + 1);
    const siblings = Array.from({ length: 4000 }, (_, i) => `"s${String(i).padStart(4, '0')}":{}`).join(',');
    const payload = `{"${big}":{${siblings}},"r":{"$ref":"#/${big}/s3999"}}`;

    const decoded = decodeWithin32MB(payload);

    expect(Object.keys(decoded[big])).toHaveLength(4000);
    expect(decoded.r).toBe(decoded[big].s3999);
  });

  it('decodes 20,000 forward references, each to an object holding the next', () => {
    const elements = Array.from({ length: 20_000 }, (_, i) =>
      i < 19_999 ? `{"next":{"$ref":"#/${i + 1}"}}` : '{}');
    const payload = `[${elements.join(',')}]`;

    const decoded = decodeWithin32MB(payload);

    expect(decoded).toHaveLength(20_000);
    for (let i = 0; i < 19_999; i++) {
      if (decoded[i].next !== decoded[i + 1]) expect.fail(`element ${i} does not hold element ${i + 1}`);
    }
  });
});

describe('a shape the encoder never writes', () => {
  it.each([
    ['an unknown tag', '{"$type":"not-a-tag","x":1}', /unknown \$type "not-a-tag"/],
    ['a Map whose keyType is bigint', '{"$type":"map","keyType":"bigint","object":{"$1":"a"}}', /unknown keyType "bigint"/],
    ['a Set whose keyType is unknown', '{"$type":"set","keyType":"date","object":{"a":1}}', /unknown keyType "date"/],
    ['a Map with both object and entries', '{"$type":"map","object":{},"entries":[]}', /both object and entries/],
    ['a Map with neither form', '{"$type":"map"}', /neither object nor entries/],
    ['a Set with neither form', '{"$type":"set"}', /neither object nor values/],
    ["a Map's entries that are not pairs", '{"$type":"map","entries":[[1]]}', /entries are not pairs/],
    ['a keyType beside entries', '{"$type":"map","keyType":"number","entries":[]}', /carries a keyType/],
    ['a Set member held by 2', '{"$type":"set","object":{"a":2}}', /held by 2, not 1/],
    ['an array member held by true', '{"$type":"array","object":{"a":true}}', /held by true, not 1/],
    ['an object-form key escaped needlessly', '{"$type":"map","object":{"$x":1}}', /escaped needlessly/],
    ['an array index left unescaped', '{"$type":"map","object":{"42":1}}', /left unescaped/],
    ['a number key spelled 0x10', '{"$type":"map","keyType":"number","object":{"0x10":1}}', /not how the encoder writes 16/],
    ['a number key spelled -0', '{"$type":"set","keyType":"number","object":{"-0":1}}', /not how the encoder writes 0/],
    ['a function carrying more than its name', '{"$type":"function","name":"f","x":1}', /more than its name/],
    ['a JSON null', '{"a":null}', /a JSON null/],
    ['a hole outside an array', '{"a":{"$type":"hole"}}', /hole outside an array/],
  ])('is refused, directly and through a forward $ref: %s', (_, payload, message) => {
    const before = constructed;

    for (const doc of [payload, `[{"$ref":"#/1"},${payload}]`]) {
      expect(() => parse(doc)).toThrow(DOMException);
      expect(() => parse(doc)).toThrow(message);
    }
    expect(constructed).toBe(before);
  });

  it('is refused at the top level: a bare JSON null', () => {
    expect(() => parse('null')).toThrow(/a JSON null/);
  });

  it("is refused when a $ref names a Map's encoding rather than a value in it", () => {
    expect(() => parse('{"tags":{"$type":"map","object":{"a":{}}},"r":{"$ref":"#/tags/object"}}'))
      .toThrow(/names no value/);
  });

  it.each([
    ['request', '{"$type":"request-sync","data":{"url":"https://example.com/","method":"POST","headers":{"$type":"headers","entries":[]},"body":{"$ref":"#"}}}'],
    ['response', '{"$type":"response-sync","data":{"status":200,"statusText":"","headers":{"$type":"headers","entries":[]},"body":{"$ref":"#"}}}'],
  ])("is refused when a %s's body is a $ref to itself", (_, payload) => {
    expect(() => parse(payload)).toThrow(DOMException);
    expect(() => parse(payload)).toThrow(/being built/);
  });
});
