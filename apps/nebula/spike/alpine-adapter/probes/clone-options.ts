/**
 * Probe: what's the cleanest way to capture a deep-clone snapshot of a
 * Vue-reactive value? Options:
 *
 *   A. `structuredClone(proxy)` — naive, fails with DataCloneError
 *   B. `structuredClone(toRaw(proxy))` — uses Vue's escape hatch first
 *   C. Hand-rolled `deepClonePlain(proxy)` — current implementation
 *   D. JSON.parse(JSON.stringify(proxy)) — works on plain JSON-shaped data
 */
import { reactive, toRaw } from '@vue/reactivity';

function deepClonePlain(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClonePlain);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as object)) {
    out[k] = deepClonePlain((v as Record<string, unknown>)[k]);
  }
  return out;
}

const state: any = reactive({
  todo: {
    'task-1': {
      value: { title: 'orig', status: 'todo', tags: ['a', 'b'] },
      meta: { eTag: 'v1', when: new Date('2026-01-01') },
    },
  },
});

const valueProxy = state.todo['task-1'].value;
const metaProxy = state.todo['task-1'].meta;

// ── A: structuredClone directly on Proxy ─────────────────────────────────
console.log('\n── A: structuredClone(proxy) ──');
try {
  const cloned = structuredClone(valueProxy);
  console.log('   PASS — value:', cloned);
} catch (e) {
  console.log('   FAIL —', (e as Error).message);
}

// ── B: structuredClone after toRaw ───────────────────────────────────────
console.log('\n── B: structuredClone(toRaw(proxy)) ──');
try {
  const raw = toRaw(valueProxy);
  const cloned = structuredClone(raw);
  console.log('   PASS — value:', cloned);
  console.log('   identity (cloned !== raw):', cloned !== raw);
} catch (e) {
  console.log('   FAIL —', (e as Error).message);
}

// Tougher: nested objects inside an array — does toRaw recurse?
const stateWithNested: any = reactive({
  items: [{ title: 'a' }, { title: 'b' }],
});
const items = stateWithNested.items;
console.log('\n── B2: structuredClone(toRaw(<array-of-objects>)) ──');
try {
  const raw = toRaw(items);
  const cloned = structuredClone(raw);
  console.log('   PASS — value:', cloned);
} catch (e) {
  console.log('   FAIL —', (e as Error).message);
}

// B3: meta with a Date — does toRaw preserve it correctly through clone?
console.log('\n── B3: structuredClone(toRaw(<obj-with-Date>)) ──');
try {
  const raw = toRaw(metaProxy);
  const cloned = structuredClone(raw);
  console.log('   PASS — value:', cloned);
  console.log('   Date preserved:', cloned.when instanceof Date);
} catch (e) {
  console.log('   FAIL —', (e as Error).message);
}

// ── C: hand-rolled deepClonePlain ────────────────────────────────────────
console.log('\n── C: deepClonePlain(proxy) ──');
try {
  const cloned = deepClonePlain(valueProxy) as any;
  console.log('   PASS — value:', cloned);
  console.log('   Date preserved (no, becomes empty obj):', deepClonePlain(metaProxy));
} catch (e) {
  console.log('   FAIL —', (e as Error).message);
}

// ── D: JSON round-trip ──────────────────────────────────────────────────
console.log('\n── D: JSON.parse(JSON.stringify(proxy)) ──');
try {
  const cloned = JSON.parse(JSON.stringify(valueProxy));
  console.log('   PASS — value:', cloned);
  console.log('   metaProxy cloned:', JSON.parse(JSON.stringify(metaProxy)));
} catch (e) {
  console.log('   FAIL —', (e as Error).message);
}
