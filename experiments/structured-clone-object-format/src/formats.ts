/**
 * Candidate wire formats for the DAG state, plus the current tuple format
 * as a baseline. All formats round-trip `DagTreeState` exactly, but expose
 * different surface areas to RFC 7396 (JSON Merge Patch).
 *
 * Phase 1 fixtures contain no JS-level cycles or aliases (per the task
 * doc § Out of scope). The wire formats here therefore only need to handle
 * plain objects with string/number/boolean leaves. The encoders are written
 * so they're a faithful preview of how the full format would behave once
 * cycle support is added in Phase 2 — i.e., they maintain the `objects`
 * indirection table (formats W1–W3) so the merge-patch tradeoffs we measure
 * here will hold up.
 *
 * Formats:
 *   - tuple  : current `@lumenize/structured-clone` format — array of tuples.
 *   - W1     : tuple format but `objects` is an object keyed by stringified id.
 *   - W2     : per-slot `{ $type, ...props }` — per-field merge-patch works.
 *   - W3     : plain JS objects stored natively; special types use a single
 *              reserved `$type` key (`{ $date: "..." }` etc.). For Phase 1's
 *              DAG (no special types) plain objects encode 1:1.
 *   - W4     : SuperJSON-style — nested `json` document + sparse `meta` for
 *              non-JSON types. No `objects` indirection for cycle-free graphs.
 */

import type { DagTreeState, NodeId } from './dag';
import type { JsonValue } from './merge-patch';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

interface WireFormat<TWire extends JsonValue> {
  name: string;
  encode(state: DagTreeState): TWire;
  decode(wire: TWire): DagTreeState;
}

// ---------------------------------------------------------------------------
// Tuple (current `@lumenize/structured-clone` format) — BASELINE
//
// All complex objects placed in `objects[]`; refs are `["$lmz", id]`; primitives
// inline as tuples like `["string", "..."]`, `["boolean", false]`. This faithfully
// reproduces what packages/structured-clone/src/preprocess.ts produces for a
// plain-JSON state.
// ---------------------------------------------------------------------------

type TupleSlot = [string, ...JsonValue[]];
type TupleWire = { root: JsonValue; objects: TupleSlot[] };

function encodeTuple(state: DagTreeState): TupleWire {
  const objects: TupleSlot[] = [];
  const seen = new WeakMap<object, number>();

  function enc(v: JsonValue): JsonValue {
    if (v === null) return ['null'] as TupleSlot;
    if (typeof v === 'string') return ['string', v] as TupleSlot;
    if (typeof v === 'number') return ['number', v] as TupleSlot;
    if (typeof v === 'boolean') return ['boolean', v] as TupleSlot;
    if (Array.isArray(v)) {
      if (seen.has(v)) return ['$lmz', seen.get(v)!] as TupleSlot;
      const id = objects.length;
      objects.push(['array', []] as TupleSlot);
      seen.set(v, id);
      const items = v.map((x) => enc(x as JsonValue));
      objects[id] = ['array', items] as TupleSlot;
      return ['$lmz', id] as TupleSlot;
    }
    if (typeof v === 'object') {
      if (seen.has(v as object)) return ['$lmz', seen.get(v as object)!] as TupleSlot;
      const id = objects.length;
      objects.push(['object', {}] as TupleSlot);
      seen.set(v as object, id);
      const out: Record<string, JsonValue> = {};
      for (const k of Object.keys(v)) out[k] = enc((v as Record<string, JsonValue>)[k] as JsonValue);
      objects[id] = ['object', out] as TupleSlot;
      return ['$lmz', id] as TupleSlot;
    }
    throw new Error(`tuple: unsupported value ${v}`);
  }

  const root = enc(state as unknown as JsonValue);
  return { root, objects };
}

function decodeTuple(w: TupleWire): DagTreeState {
  const cache: Record<number, JsonValue> = {};
  function dec(v: JsonValue): JsonValue {
    if (!Array.isArray(v)) throw new Error('tuple: malformed (expected tuple)');
    const tag = v[0] as string;
    if (tag === 'null') return null;
    if (tag === 'string') return v[1] as string;
    if (tag === 'number') return v[1] as number;
    if (tag === 'boolean') return v[1] as boolean;
    if (tag === '$lmz') {
      const id = v[1] as number;
      if (id in cache) return cache[id] as JsonValue;
      const slot = w.objects[id] as TupleSlot;
      return decSlot(id, slot);
    }
    throw new Error(`tuple: unknown tag ${tag}`);
  }
  function decSlot(id: number, slot: TupleSlot): JsonValue {
    const tag = slot[0] as string;
    if (tag === 'array') {
      const arr: JsonValue[] = [];
      cache[id] = arr;
      for (const item of slot[1] as JsonValue[]) arr.push(dec(item as JsonValue));
      return arr;
    }
    if (tag === 'object') {
      const out: Record<string, JsonValue> = {};
      cache[id] = out;
      for (const k of Object.keys(slot[1] as object)) {
        out[k] = dec((slot[1] as Record<string, JsonValue>)[k] as JsonValue);
      }
      return out;
    }
    throw new Error(`tuple: unknown slot tag ${tag}`);
  }
  return dec(w.root) as unknown as DagTreeState;
}

export const tupleFormat: WireFormat<TupleWire> = {
  name: 'tuple',
  encode: encodeTuple,
  decode: decodeTuple,
};

// ---------------------------------------------------------------------------
// W1: tuple format with `objects` as an object keyed by id
// ---------------------------------------------------------------------------

type W1Wire = { root: JsonValue; objects: Record<string, TupleSlot> };

function encodeW1(state: DagTreeState): W1Wire {
  const t = encodeTuple(state);
  const objects: Record<string, TupleSlot> = {};
  for (let i = 0; i < t.objects.length; i++) objects[String(i)] = t.objects[i]!;
  return { root: t.root, objects };
}

function decodeW1(w: W1Wire): DagTreeState {
  const objects: TupleSlot[] = [];
  for (const k of Object.keys(w.objects)) objects[Number(k)] = w.objects[k]!;
  return decodeTuple({ root: w.root, objects });
}

export const w1Format: WireFormat<W1Wire> = {
  name: 'W1',
  encode: encodeW1,
  decode: decodeW1,
};

// ---------------------------------------------------------------------------
// W2: per-slot `{ $type, ...props }`. Primitives remain inline tuples
// (matching tuple format); plain objects/arrays/(future special types) are
// type-tagged via a `$type` key alongside their data.
// ---------------------------------------------------------------------------

type W2Slot =
  | { $type: 'object'; props: Record<string, JsonValue> }
  | { $type: 'array'; items: JsonValue[] };
type W2Wire = { root: JsonValue; objects: Record<string, W2Slot> };

function encodeW2(state: DagTreeState): W2Wire {
  const objects: Record<string, W2Slot> = {};
  const seen = new WeakMap<object, number>();
  let nextId = 0;

  function enc(v: JsonValue): JsonValue {
    if (v === null) return ['null'];
    if (typeof v === 'string') return ['string', v];
    if (typeof v === 'number') return ['number', v];
    if (typeof v === 'boolean') return ['boolean', v];
    if (Array.isArray(v)) {
      if (seen.has(v)) return ['$lmz', seen.get(v)!];
      const id = nextId++;
      seen.set(v, id);
      objects[String(id)] = { $type: 'array', items: [] };
      const items = v.map((x) => enc(x as JsonValue));
      objects[String(id)] = { $type: 'array', items };
      return ['$lmz', id];
    }
    if (typeof v === 'object') {
      if (seen.has(v as object)) return ['$lmz', seen.get(v as object)!];
      const id = nextId++;
      seen.set(v as object, id);
      objects[String(id)] = { $type: 'object', props: {} };
      const props: Record<string, JsonValue> = {};
      for (const k of Object.keys(v)) props[k] = enc((v as Record<string, JsonValue>)[k] as JsonValue);
      objects[String(id)] = { $type: 'object', props };
      return ['$lmz', id];
    }
    throw new Error(`W2: unsupported ${v}`);
  }

  const root = enc(state as unknown as JsonValue);
  return { root, objects };
}

function decodeW2(w: W2Wire): DagTreeState {
  const cache: Record<number, JsonValue> = {};
  function dec(v: JsonValue): JsonValue {
    if (!Array.isArray(v)) throw new Error('W2: malformed root');
    const tag = v[0] as string;
    if (tag === 'null') return null;
    if (tag === 'string') return v[1] as string;
    if (tag === 'number') return v[1] as number;
    if (tag === 'boolean') return v[1] as boolean;
    if (tag === '$lmz') {
      const id = v[1] as number;
      if (id in cache) return cache[id] as JsonValue;
      const slot = w.objects[String(id)]!;
      if (slot.$type === 'array') {
        const arr: JsonValue[] = [];
        cache[id] = arr;
        for (const it of slot.items) arr.push(dec(it as JsonValue));
        return arr;
      } else {
        const out: Record<string, JsonValue> = {};
        cache[id] = out;
        for (const k of Object.keys(slot.props)) out[k] = dec(slot.props[k] as JsonValue);
        return out;
      }
    }
    throw new Error(`W2: unknown tag ${tag}`);
  }
  return dec(w.root) as unknown as DagTreeState;
}

export const w2Format: WireFormat<W2Wire> = {
  name: 'W2',
  encode: encodeW2 as (s: DagTreeState) => W2Wire,
  decode: decodeW2,
};

// ---------------------------------------------------------------------------
// W3: key-as-discriminator + unwrap.
//
// - Plain objects stored *natively* (no $type tag).
// - Plain primitives stored *natively* as JSON primitives.
// - References stored as `{ $ref: id }` to avoid colliding with user keys
//   like `$lmz` if they exist.
// - For Phase 1's DAG (no Date/Map/Set), plain objects look like JSON.
// - Escape rule for user keys starting with `$`: prefix with another `$`.
//   The DAG schema in this experiment has no `$`-prefixed keys so this
//   doesn't fire in the fixtures.
// ---------------------------------------------------------------------------

type W3Slot = Record<string, JsonValue> | JsonValue[];
type W3Wire = { root: JsonValue; objects: Record<string, W3Slot> };

function escapeKey(k: string): string {
  return k.startsWith('$') ? '$' + k : k;
}
function unescapeKey(k: string): string {
  return k.startsWith('$$') ? k.slice(1) : k;
}

function encodeW3(state: DagTreeState): W3Wire {
  const objects: Record<string, W3Slot> = {};
  const seen = new WeakMap<object, number>();
  let nextId = 0;

  function enc(v: JsonValue): JsonValue {
    // Primitives stay native — no wrapping.
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      if (seen.has(v)) return { $ref: seen.get(v)! };
      const id = nextId++;
      seen.set(v, id);
      objects[String(id)] = [];
      const arr: JsonValue[] = v.map((x) => enc(x as JsonValue));
      objects[String(id)] = arr;
      return { $ref: id };
    }
    if (seen.has(v as object)) return { $ref: seen.get(v as object)! };
    const id = nextId++;
    seen.set(v as object, id);
    objects[String(id)] = {};
    const out: Record<string, JsonValue> = {};
    for (const k of Object.keys(v)) {
      out[escapeKey(k)] = enc((v as Record<string, JsonValue>)[k] as JsonValue);
    }
    objects[String(id)] = out;
    return { $ref: id };
  }

  const root = enc(state as unknown as JsonValue);
  return { root, objects };
}

function decodeW3(w: W3Wire): DagTreeState {
  const cache: Record<number, JsonValue> = {};
  function dec(v: JsonValue): JsonValue {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => dec(x as JsonValue));
    const obj = v as Record<string, JsonValue>;
    if ('$ref' in obj && Object.keys(obj).length === 1) {
      const id = obj.$ref as number;
      if (id in cache) return cache[id] as JsonValue;
      const slot = w.objects[String(id)]!;
      if (Array.isArray(slot)) {
        const arr: JsonValue[] = [];
        cache[id] = arr;
        for (const it of slot) arr.push(dec(it as JsonValue));
        return arr;
      } else {
        const out: Record<string, JsonValue> = {};
        cache[id] = out;
        for (const k of Object.keys(slot)) out[unescapeKey(k)] = dec((slot as Record<string, JsonValue>)[k] as JsonValue);
        return out;
      }
    }
    const out: Record<string, JsonValue> = {};
    for (const k of Object.keys(obj)) out[unescapeKey(k)] = dec(obj[k] as JsonValue);
    return out;
  }
  return dec(w.root) as unknown as DagTreeState;
}

export const w3Format: WireFormat<W3Wire> = {
  name: 'W3',
  encode: encodeW3,
  decode: decodeW3,
};

// ---------------------------------------------------------------------------
// W4: SuperJSON-style — nested document + meta sidecar.
//
// For a cycle-free state with only plain primitives, `meta` is `{}` and `json`
// is the state encoded as plain JSON. Cycle handling would emit refs into
// `meta.paths` + an `aliases` table, but Phase 1's DAG has none.
// ---------------------------------------------------------------------------

type W4Wire = { json: JsonValue; meta: { paths?: Record<string, string>; aliases?: Record<string, JsonValue> } };

function encodeW4(state: DagTreeState): W4Wire {
  // For Phase 1 DAGs, no cycle handling needed — JSON-clone the state.
  return { json: JSON.parse(JSON.stringify(state)) as JsonValue, meta: {} };
}
function decodeW4(w: W4Wire): DagTreeState {
  // No special-type paths to reconstruct in Phase 1.
  return JSON.parse(JSON.stringify(w.json)) as DagTreeState;
}

export const w4Format: WireFormat<W4Wire> = {
  name: 'W4',
  encode: encodeW4,
  decode: decodeW4,
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ALL_FORMATS = [tupleFormat, w1Format, w2Format, w3Format, w4Format] as const;
