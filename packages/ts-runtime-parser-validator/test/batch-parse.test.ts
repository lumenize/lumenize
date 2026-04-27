/**
 * `parseBatch()` — heterogeneous, key-preserving, per-item-success/failure.
 *
 * Covers the cases the single-item `parse()` doesn't reach: mixed typeNames in
 * one call, a Map's worth of keys round-tripping unchanged, and per-item
 * isolation (one key's failure doesn't poison its neighbors). The rich-types
 * cases here are not a re-run of `parity/values.test.ts` — just enough to
 * catch a regression where batching breaks structured-clone semantics for
 * one item but not another.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

type ParseResult =
  | { valid: true; data: unknown }
  | { valid: false; errors: Array<{ path: string; expected: string; value?: unknown; description?: string }> };

type ParseRequest = { value: unknown; typeName: string };

interface PrimaryStub {
  parse: (
    typeDefinitions: string,
    typeName: string,
    value: unknown,
    bundleId?: string,
  ) => Promise<ParseResult>;
  parseBatch: (
    typeDefinitions: string,
    items: Map<string, ParseRequest>,
    bundleId?: string,
  ) => Promise<Map<string, ParseResult>>;
}

function getStub(): PrimaryStub {
  const ns = env.PRIMARY_DO;
  return ns.get(ns.idFromName('primary')) as unknown as PrimaryStub;
}

const SHARED_TYPES = `
interface Todo {
  title: string;
  done: boolean;
  /** @default 0 */
  priority?: number;
}
interface Tag {
  name: string;
  /** @default [] */
  aliases?: string[];
}
`;

describe('parseBatch — empty input', () => {
  it('empty Map → empty Map', async () => {
    const out = await getStub().parseBatch(SHARED_TYPES, new Map(), 'batch-empty');
    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(0);
  });
});

describe('parseBatch — keys and shapes', () => {
  it('single-item batch: result keyed by the input key, shape matches parse()', async () => {
    const items = new Map<string, ParseRequest>([
      ['k1', { value: { title: 'Fix bug', done: false }, typeName: 'Todo' }],
    ]);
    const batchOut = await getStub().parseBatch(SHARED_TYPES, items, 'batch-single');
    expect(Array.from(batchOut.keys())).toEqual(['k1']);

    const parseOut = await getStub().parse(SHARED_TYPES, 'Todo', { title: 'Fix bug', done: false }, 'batch-single');
    expect(batchOut.get('k1')).toEqual(parseOut);
  });

  it('heterogeneous batch: mixed typeNames, keys preserved in iteration order', async () => {
    const items = new Map<string, ParseRequest>([
      ['todo-a', { value: { title: 'A', done: false }, typeName: 'Todo' }],
      ['tag-x', { value: { name: 'x' }, typeName: 'Tag' }],
      ['todo-b', { value: { title: 'B', done: true }, typeName: 'Todo' }],
    ]);
    const out = await getStub().parseBatch(SHARED_TYPES, items, 'batch-hetero');

    expect(Array.from(out.keys())).toEqual(['todo-a', 'tag-x', 'todo-b']);
    for (const r of out.values()) expect(r.valid).toBe(true);

    const todoA = out.get('todo-a');
    const tagX = out.get('tag-x');
    const todoB = out.get('todo-b');
    if (!todoA?.valid || !tagX?.valid || !todoB?.valid) throw new Error('expected all valid');
    expect(todoA.data).toEqual({ title: 'A', done: false, priority: 0 });
    expect(tagX.data).toEqual({ name: 'x', aliases: [] });
    expect(todoB.data).toEqual({ title: 'B', done: true, priority: 0 });
  });
});

describe('parseBatch — per-item isolation', () => {
  it('mix of valid + invalid: invalid keys carry errors, valid keys carry filled data', async () => {
    const items = new Map<string, ParseRequest>([
      ['ok', { value: { title: 'good', done: true }, typeName: 'Todo' }],
      ['bad', { value: { title: 42, done: 'yes' }, typeName: 'Todo' }],
      ['ok2', { value: { title: 'good2', done: false }, typeName: 'Todo' }],
    ]);
    const out = await getStub().parseBatch(SHARED_TYPES, items, 'batch-mix');

    const ok = out.get('ok');
    const bad = out.get('bad');
    const ok2 = out.get('ok2');
    if (!ok?.valid) throw new Error('ok should be valid');
    if (!ok2?.valid) throw new Error('ok2 should be valid');
    expect(bad?.valid).toBe(false);

    expect(ok.data).toEqual({ title: 'good', done: true, priority: 0 });
    expect(ok2.data).toEqual({ title: 'good2', done: false, priority: 0 });
    if (bad?.valid === false) {
      expect(bad.errors.length).toBeGreaterThan(0);
    }
  });

  it('unknown typeName for one key fails with `unknown type`, others succeed', async () => {
    const items = new Map<string, ParseRequest>([
      ['ok', { value: { title: 'good', done: true }, typeName: 'Todo' }],
      ['nope', { value: { whatever: true }, typeName: 'NotAType' }],
    ]);
    const out = await getStub().parseBatch(SHARED_TYPES, items, 'batch-unknown');

    expect(out.get('ok')?.valid).toBe(true);
    const nope = out.get('nope');
    expect(nope?.valid).toBe(false);
    if (nope?.valid === false) {
      expect(nope.errors[0].expected).toBe('NotAType');
      expect(nope.errors[0].description).toBe('unknown type');
    }
  });
});

describe('parseBatch — defaults', () => {
  it('each item gets its own filled data (separate, not shared)', async () => {
    const items = new Map<string, ParseRequest>([
      ['a', { value: { title: 'A', done: false }, typeName: 'Todo' }],
      ['b', { value: { title: 'B', done: false, priority: 7 }, typeName: 'Todo' }],
    ]);
    const out = await getStub().parseBatch(SHARED_TYPES, items, 'batch-defaults');

    const a = out.get('a');
    const b = out.get('b');
    if (!a?.valid || !b?.valid) throw new Error('expected all valid');
    expect((a.data as { priority: number }).priority).toBe(0);
    expect((b.data as { priority: number }).priority).toBe(7);
    expect(a.data).not.toBe(b.data);
  });
});

describe('parseBatch — cycles within an item', () => {
  it('cyclic input is safely walked (separate seen map per item)', async () => {
    const types = `
interface Node {
  label: string;
  next?: Node;
}
`;
    type CyclicNode = { label: string; next?: CyclicNode };
    const a: CyclicNode = { label: 'a' };
    const b: CyclicNode = { label: 'b', next: a };
    a.next = b;

    const c: CyclicNode = { label: 'c' };
    c.next = c;

    const items = new Map<string, ParseRequest>([
      ['ab', { value: a, typeName: 'Node' }],
      ['self', { value: c, typeName: 'Node' }],
    ]);
    const out = await getStub().parseBatch(types, items, 'batch-cycle');

    expect(out.get('ab')?.valid).toBe(true);
    expect(out.get('self')?.valid).toBe(true);
  });
});

describe('parseBatch — rich types in a batch', () => {
  it('Date and Map round-trip across the facet boundary in one batch', async () => {
    const types = `
interface Appt { when: Date; }
interface Buckets { counts: Map<string, number>; }
`;
    const items = new Map<string, ParseRequest>([
      ['appt', { value: { when: new Date('2026-04-20T10:30:00Z') }, typeName: 'Appt' }],
      ['buckets', { value: { counts: new Map([['x', 1], ['y', 2]]) }, typeName: 'Buckets' }],
    ]);
    const out = await getStub().parseBatch(types, items, 'batch-rich');

    expect(out.get('appt')?.valid).toBe(true);
    expect(out.get('buckets')?.valid).toBe(true);
  });
});
