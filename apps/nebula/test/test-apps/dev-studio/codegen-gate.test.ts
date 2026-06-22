/**
 * Phase 1 — Rung-1 compile gates (tasks/archive/nebula-codegen-loop.md). The container-free
 * self-correction signal: `compileSource(path, content)` dispatches by extension and
 * returns `{ ok, errorTail? }`. Runs under vitest-pool-workers — no container, no AI
 * binding (the `dev-studio` project carries `nodejs_compat` + the bundled `tsc`).
 *
 * Capable-of-failing proof for each gate: a known-good input returns `ok:true` and a
 * broken one returns `ok:false` with an actionable tail — gutting the compiler call
 * collapses the contrast.
 *
 * @see tasks/archive/nebula-codegen-loop.md § Phase 1
 */
import { describe, it, expect } from 'vitest';
import { compileTemplate, parse, compileScript } from '@vue/compiler-sfc';
import { compileSource, compileVueSfc } from '../../../src/codegen-gate';

const ONTOLOGY_GOOD = `interface Todo { title: string; done: boolean; }`;
// Missing field type — a parse/type error generateParseModule surfaces as a throw.
const ONTOLOGY_BROKEN = `interface Todo { title: ; done: boolean; }`;

const APP_GOOD = `<script setup lang="ts">
import { ref, computed } from 'vue';
import { client, store } from './nebula';

const title = ref('');
const count = computed(() => Object.keys(store.Todo ?? {}).length);

function add() {
  const id = crypto.randomUUID();
  client.resources.transaction({
    [id]: { op: 'create', typeName: 'Todo', nodeId: 1, value: { title: title.value, done: false } },
  });
}
</script>

<template>
  <div>
    <input v-model="title" />
    <button @click="add">Add ({{ count }})</button>
  </div>
</template>`;

// Same app, but unterminated <template> — a hard SFC syntax error.
const APP_SYNTAX_BROKEN = `<script setup lang="ts">
const x = 1;
</script>
<template>
  <div>{{ x }}
</template-oops>`;

// The viability-probe failure class: a bad union literal on the typed client call.
const appWithOp = (op: string) => `<script setup lang="ts">
import { client } from './nebula';
function go() {
  client.resources.transaction({
    a: { op: '${op}', typeName: 'Todo', nodeId: 1, value: {} },
  });
}
</script>
<template><button @click="go">go</button></template>`;

describe('Phase 1 — ontology Rung-1 gate (reuses compileOntologyVersion)', () => {
  it('a known-good ontology .d.ts compiles to { ok: true }', () => {
    expect(compileSource('src/ontology.d.ts', ONTOLOGY_GOOD)).toEqual({ ok: true });
  });

  it('a broken ontology .d.ts returns { ok: false, errorTail }', () => {
    const r = compileSource('src/ontology.d.ts', ONTOLOGY_BROKEN);
    expect(r.ok).toBe(false);
    expect(r.errorTail).toBeTruthy();
    expect(r.errorTail!.length).toBeGreaterThan(0);
  });

  it('dispatches a leading-slash + bare ontology path to the ontology gate (normalization)', () => {
    expect(compileSource('/src/ontology.d.ts', ONTOLOGY_GOOD)).toEqual({ ok: true });
    expect(compileSource('ontology.d.ts', ONTOLOGY_GOOD)).toEqual({ ok: true });
  });
});

describe('Phase 1 — SFC Rung-1 gate: Pass 1 (transpile)', () => {
  it('a known-good App.vue compiles to { ok: true }', () => {
    expect(compileSource('src/App.vue', APP_GOOD)).toEqual({ ok: true });
  });

  it('a syntactically-broken App.vue returns { ok: false, errorTail }', () => {
    const r = compileSource('src/App.vue', APP_SYNTAX_BROKEN);
    expect(r.ok).toBe(false);
    expect(r.errorTail).toBeTruthy();
  });

  it('bindings are threaded into the template (SC#3): setup refs resolve to $setup.x, not _ctx.x', () => {
    const sfc = `<script setup lang="ts">
import { ref } from 'vue';
const greeting = ref('hi');
</script>
<template><p>{{ greeting }}</p></template>`;
    const { ok, templateCode } = compileVueSfc(sfc);
    expect(ok).toBe(true);
    // Threaded: the setup-ref is accessed via $setup.
    expect(templateCode).toContain('$setup.greeting');
    expect(templateCode).not.toContain('_ctx.greeting');

    // Discriminator: the SAME template compiled WITHOUT bindingMetadata falls back
    // to _ctx.greeting — proving the threading is load-bearing (drop it → blank render).
    const { descriptor } = parse(sfc, { filename: 'App.vue' });
    const unthreaded = compileTemplate({
      source: descriptor.template!.content,
      filename: 'App.vue',
      id: 'gate',
      compilerOptions: {}, // no bindingMetadata
    });
    expect(unthreaded.code).toContain('_ctx.greeting');
    expect(unthreaded.code).not.toContain('$setup.greeting');
  });
});

describe('Phase 1 — SFC Rung-1 gate: Pass 2 (semantic type-check, the op:set headline)', () => {
  it('a correct op union literal type-checks clean → { ok: true }', () => {
    expect(compileSource('src/App.vue', appWithOp('create'))).toEqual({ ok: true });
  });

  it("the invented op:'set' is rejected by the type-checker → { ok: false, errorTail }", () => {
    const r = compileSource('src/App.vue', appWithOp('set'));
    expect(r.ok).toBe(false);
    expect(r.errorTail).toBeTruthy();
    // Pass 1 alone (transpile) would PASS this — it's valid Vue/TS syntax. Only the
    // Pass-2 semantic check against the Nebula API rejects the bad union literal.
  });

  it('the full known-good data-bound App.vue (ref/computed/store/transaction) type-checks clean', () => {
    // Capable-of-failing for Pass 2: this exercises the real client surface; a
    // spurious Pass-2 error (e.g. unresolved 'vue'/'./nebula'/crypto) would fail it.
    expect(compileSource('src/App.vue', APP_GOOD)).toEqual({ ok: true });
  });
});

describe('Phase 1 — dispatch: non-compiled paths', () => {
  it('a non-.vue/.d.ts path is write-only (no compile) → { ok: true }', () => {
    expect(compileSource('src/styles.css', 'body { color: red; }')).toEqual({ ok: true });
    expect(compileSource('README.md', '# anything {{{ not vue')).toEqual({ ok: true });
  });
});
