/**
 * What a model reads of a tool's result, and what the record keeps of a tab run's value
 * (`modelText` and `clipRunResult` in `src/codegen-loop.ts`).
 *
 * In-lane and pure: both are functions from a value to a value, with no running system in them.
 * That a real tab's `Map` reaches the record and the model this way is `run-in-tab.test.ts`'s,
 * and a real page's is the `/live` scenario `persona-tabs`.
 */
import { describe, it, expect } from 'vitest';
import { modelText, clipRunResult, RUN_RESULT_MAX_CHARS, RUN_ERROR_MAX_CHARS } from '../src/codegen-loop';

describe('modelText', () => {
  // Every other tool's result is plain data, and its text must not move.
  // Mutation: render through the walk without honouring `toJSON` → the Date reads `{}`.
  it('renders plain data exactly as JSON.stringify does', () => {
    for (const value of [
      { ok: true, path: 'src/App.vue', lines: [1, 2, 3], nested: { b: 2, a: 1 }, none: null, gone: undefined },
      ['a', undefined, null, { x: -0 }],
      'text', 7, true, null,
      { when: new Date(0), where: new URL('https://crm.acme.lumenize.dev/deals?x=1') },
    ]) {
      expect(modelText(value)).toBe(JSON.stringify(value));
    }
  });

  // Mutations, one per branch: drop the Map branch → `{}`; the Set branch → `{}`; the Error branch
  // → no name or message; the bigint branch → JSON throws; the non-finite branch → `null`.
  it('renders what JSON loses: a Map as its entries, a Set as its members, an Error with its fields, a bigint, and a number JSON has no word for', () => {
    expect(modelText(new Map<unknown, unknown>([['n1', { slug: 'deals' }], [2, new Set(['a'])]]))).toBe('[["n1",{"slug":"deals"}],[2,["a"]]]');
    expect(modelText({ failed: Object.assign(new TypeError('no such deal'), { retryable: true }) }))
      .toBe('{"failed":{"retryable":true,"name":"TypeError","message":"no such deal"}}');
    expect(modelText({ big: 10n, nan: NaN, up: Infinity, down: -Infinity })).toBe('{"big":"10","nan":"NaN","up":"Infinity","down":"-Infinity"}');
    expect(modelText(undefined)).toBe('undefined');
  });

  // Mutations: drop the cycle test → the walk never ends; forget an object once its walk is done
  // → the second, unrelated mention of `shared` reads as a cycle.
  it('names a cycle where the object is met inside itself, and renders an object mentioned twice both times', () => {
    const loop: { name: string; self?: unknown; kids?: unknown[] } = { name: 'loop' };
    loop.self = loop;
    loop.kids = [{ parent: loop }];
    expect(modelText(loop)).toBe('{"name":"loop","self":"[cycle]","kids":[{"parent":"[cycle]"}]}');
    const shared = { id: 1 };
    expect(modelText({ a: shared, b: shared })).toBe('{"a":{"id":1},"b":{"id":1}}');
  });
});

describe('clipRunResult', () => {
  // Mutation: keep the value as JSON has it → the record's Map is a plain object.
  it('keeps a value whole, as the object it was handed', () => {
    const tree = new Map([['n1', 'deals']]);
    const kept = clipRunResult({ ok: true, value: { tree } }) as { ok: true; value: { tree: Map<string, string> } };
    expect(kept.value.tree).toBe(tree);
  });

  // Mutations: never clip → the long value is kept; measure the value's JSON → a Map of many
  // entries measures two characters and is never clipped.
  it('replaces a value whose text runs long by the start of that text, and cuts a long error', () => {
    const many = new Map(Array.from({ length: 4000 }, (_, i) => [`node-${i}`, i] as const));
    const clipped = clipRunResult({ ok: true, value: many }) as { ok: true; clipped: true; text: string; note: string };
    expect(clipped.clipped).toBe(true);
    expect(clipped.text).toBe(modelText(many).slice(0, RUN_RESULT_MAX_CHARS));
    expect(clipped.note).toContain(`${modelText(many).length} characters`);
    expect(clipRunResult({ ok: false, error: 'E'.repeat(RUN_ERROR_MAX_CHARS + 5) }))
      .toEqual({ ok: false, error: `${'E'.repeat(RUN_ERROR_MAX_CHARS)}… (${RUN_ERROR_MAX_CHARS + 5} characters in all)` });
  });
});
