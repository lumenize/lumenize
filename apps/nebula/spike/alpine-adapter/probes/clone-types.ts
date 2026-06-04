/**
 * Probe: does `structuredClone(toRaw(proxy))` preserve all the types that
 * `@lumenize/structured-clone` supports (the ones realistic for resource
 * state — Dates, Maps, Sets, cycles, aliases, typed arrays, etc.)?
 *
 * Skipped: Request, Response, Blob, File, functions, DOM nodes — none of
 * these belong in a resource snapshot.
 */
import { reactive, toRaw } from '@vue/reactivity';

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail?: string) {
  const marker = cond ? 'PASS' : 'FAIL';
  console.log(`[${marker}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (cond) pass++; else fail++;
}

function snapshot<T>(v: T): T {
  return structuredClone(toRaw(v as any)) as T;
}

// ─── Primitives, null, undefined ────────────────────────────────────────────
{
  const s: any = reactive({ a: 1, b: 'x', c: true, d: null, e: undefined });
  const cloned = snapshot(s);
  check('primitives + null + undefined',
    cloned.a === 1 && cloned.b === 'x' && cloned.c === true && cloned.d === null && cloned.e === undefined);
}

// ─── BigInt ────────────────────────────────────────────────────────────────
{
  const s: any = reactive({ big: 9007199254740993n });
  try {
    const cloned = snapshot(s);
    check('BigInt', cloned.big === 9007199254740993n, `cloned.big=${cloned.big}`);
  } catch (e) {
    check('BigInt', false, (e as Error).message);
  }
}

// ─── Date ──────────────────────────────────────────────────────────────────
{
  const d = new Date('2026-05-13T12:34:56.789Z');
  const s: any = reactive({ when: d });
  const cloned = snapshot(s);
  check('Date preserved',
    cloned.when instanceof Date && cloned.when.getTime() === d.getTime(),
    `cloned.when=${cloned.when}`);
  check('Date is a copy (identity differs)', cloned.when !== d);
}

// ─── RegExp ────────────────────────────────────────────────────────────────
{
  const re = /^foo.*bar$/gi;
  const s: any = reactive({ pattern: re });
  const cloned = snapshot(s);
  check('RegExp preserved',
    cloned.pattern instanceof RegExp && cloned.pattern.source === '^foo.*bar$' && cloned.pattern.flags === 'gi');
}

// ─── Array (nested) ────────────────────────────────────────────────────────
{
  const s: any = reactive({ items: [{ id: 1 }, { id: 2 }] });
  const cloned = snapshot(s);
  check('Array of objects',
    Array.isArray(cloned.items) && cloned.items[0].id === 1 && cloned.items[1].id === 2);
}

// ─── Map ───────────────────────────────────────────────────────────────────
{
  const m = new Map<string, unknown>([['a', 1], ['b', { nested: true }]]);
  const s: any = reactive({ tags: m });
  const cloned = snapshot(s);
  check('Map preserved',
    cloned.tags instanceof Map && cloned.tags.get('a') === 1 && (cloned.tags.get('b') as any).nested === true,
    `tags type=${cloned.tags?.constructor?.name}`);
  check('Map is a copy (identity differs)', cloned.tags !== m);
}

// ─── Set ───────────────────────────────────────────────────────────────────
{
  const set = new Set([1, 'two', { three: 3 }]);
  const s: any = reactive({ labels: set });
  const cloned = snapshot(s);
  check('Set preserved',
    cloned.labels instanceof Set && cloned.labels.has(1) && cloned.labels.has('two') && cloned.labels.size === 3,
    `labels type=${cloned.labels?.constructor?.name}`);
}

// ─── Typed array ───────────────────────────────────────────────────────────
{
  const ta = new Uint8Array([1, 2, 3, 4]);
  const s: any = reactive({ blob: ta });
  const cloned = snapshot(s);
  check('Uint8Array preserved',
    cloned.blob instanceof Uint8Array && cloned.blob[0] === 1 && cloned.blob[3] === 4);
}

// ─── ArrayBuffer ───────────────────────────────────────────────────────────
{
  const buf = new ArrayBuffer(8);
  new Uint8Array(buf).set([10, 20, 30, 40, 50, 60, 70, 80]);
  const s: any = reactive({ buf });
  const cloned = snapshot(s);
  check('ArrayBuffer preserved',
    cloned.buf instanceof ArrayBuffer && new Uint8Array(cloned.buf)[0] === 10 && new Uint8Array(cloned.buf)[7] === 80);
}

// ─── Cycles ────────────────────────────────────────────────────────────────
{
  const obj: any = { name: 'root' };
  obj.self = obj;
  const s: any = reactive({ root: obj });
  try {
    const cloned = snapshot(s);
    const isSelf = cloned.root.self === cloned.root;
    check('Cyclic reference preserved', isSelf && cloned.root.name === 'root');
  } catch (e) {
    check('Cyclic reference preserved', false, (e as Error).message);
  }
}

// ─── Aliases (same object referenced twice; structuredClone preserves identity) ──
{
  const shared = { kind: 'shared' };
  const s: any = reactive({ a: shared, b: shared });
  const cloned = snapshot(s);
  check('Aliased reference: identity preserved across alias',
    cloned.a === cloned.b && cloned.a.kind === 'shared',
    `a===b? ${cloned.a === cloned.b}`);
  check('Aliased reference: clone is independent of original', cloned.a !== shared);
}

// ─── Error ─────────────────────────────────────────────────────────────────
{
  const err = new Error('boom');
  err.cause = 'because';
  const s: any = reactive({ err });
  try {
    const cloned = snapshot(s);
    check('Error preserved',
      cloned.err instanceof Error && cloned.err.message === 'boom',
      `cause=${cloned.err.cause}`);
  } catch (e) {
    check('Error preserved', false, (e as Error).message);
  }
}

// ─── Deep nested mix (realistic resource shape) ───────────────────────────
{
  const tags = new Set(['urgent', 'work']);
  const created = new Date('2026-01-01');
  const s: any = reactive({
    value: {
      title: 'do the thing',
      tags,
      created,
      subtasks: [
        { id: 't1', done: false, due: new Date('2026-02-01') },
        { id: 't2', done: true, due: null },
      ],
    },
    meta: { eTag: 'v42', count: 7n },
  });
  const cloned = snapshot(s);
  check('Realistic nested shape',
    cloned.value.title === 'do the thing'
      && cloned.value.tags instanceof Set
      && cloned.value.tags.has('urgent')
      && cloned.value.created instanceof Date
      && cloned.value.subtasks[0].due instanceof Date
      && cloned.value.subtasks[1].due === null
      && cloned.meta.eTag === 'v42'
      && cloned.meta.count === 7n);
}

console.log(`\n=== Summary: ${pass} pass, ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
