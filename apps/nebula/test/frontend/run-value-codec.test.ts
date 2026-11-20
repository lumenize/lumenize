/**
 * The codec reads a Vue reactive value through its proxies, and what it makes can cross windows.
 *
 * A page answers Studio's run request across `postMessage`, whose own structured clone refuses a
 * Vue proxy. So the page encodes the code's value with `@lumenize/structured-clone` first, and
 * that rests on two properties this file holds: the codec walks a reactive `Map`, `Set` and object
 * as it walks plain ones, and its output is plain data the browser's clone accepts (jsdom
 * `frontend` project, since a reactive store needs Vue and nothing else).
 */
import { describe, it, expect } from 'vitest';
import { reactive } from 'vue';
import { preprocess, postprocess } from '@lumenize/structured-clone';

describe("the codec over a Vue store's values", () => {
  it('carries a reactive Map, Set and Date, a cycle, and what JSON drops, across a window boundary', () => {
    const store = reactive({
      tree: { nodes: new Map([['n1', { slug: 'deals' }]]), edges: new Set(['root:n1']) },
      when: new Date(0),
    });
    const loop: { name: string; self?: unknown } = { name: 'loop' };
    loop.self = loop;
    const value = {
      tree: store.tree, when: store.when, big: 10n, nothing: undefined, nan: NaN, loop,
      failed: Object.assign(new TypeError('no such deal'), { retryable: true }),
    };
    // The positive control for the premise: the browser's own clone refuses the reactive value.
    expect(() => structuredClone(value)).toThrow();
    const arrived = postprocess(structuredClone(preprocess(value))) as typeof value & { loop: { self: unknown } };
    expect(arrived.tree.nodes).toBeInstanceOf(Map);
    expect([...arrived.tree.nodes]).toEqual([['n1', { slug: 'deals' }]]);
    expect(arrived.tree.edges).toBeInstanceOf(Set);
    expect([...arrived.tree.edges]).toEqual(['root:n1']);
    expect(arrived.when).toBeInstanceOf(Date);
    expect(arrived.when.getTime()).toBe(0);
    expect(arrived.big).toBe(10n);
    expect('nothing' in arrived).toBe(true);
    expect(arrived.nan).toBeNaN();
    expect(arrived.loop.self).toBe(arrived.loop);
    expect(arrived.failed).toBeInstanceOf(TypeError);
    expect([arrived.failed.message, (arrived.failed as { retryable?: boolean }).retryable]).toEqual(['no such deal', true]);
  });
});
