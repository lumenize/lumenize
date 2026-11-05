/**
 * The compile checks a build runs (tasks/archive/nebula-codegen-loop.md):
 * `compileSource(path, content)` dispatches by extension and returns `{ ok, errorTail? }`.
 * A `.vue` goes through the build box's own `checkVueSfc`, checked as `src/App.vue` of the
 * scaffold app in the repo, so its type pass reads the real `NebulaClient`, the real `vue`
 * and the scaffold's own `nebula.ts`, as the build box reads them under `/workspace`.
 *
 * In-lane rather than `/live` because each case is one call into a pure check; the same check
 * runs on real builds in `dev-star-follows-the-build` and `first-app-built`, whose apps land
 * only with no findings. Node rather than the vitest-plugin lane because the check reads a
 * disk, which only Node gives it.
 *
 * Capable-of-failing proof for each gate: a known-good input returns `ok:true` and a
 * broken one returns `ok:false` with an actionable tail — gutting the compiler call
 * collapses the contrast.
 */
import { describe, it, expect } from 'vitest';
import { compileTemplate, parse } from '@vue/compiler-sfc';
import { compileSource, compileVueSfc } from './codegen-gate';

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
    [id]: { op: 'create', typeName: 'Todo', nodeId: crypto.randomUUID(), value: { title: title.value, done: false } },
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
    a: { op: '${op}', typeName: 'Todo', nodeId: crypto.randomUUID(), value: {} },
  });
}
</script>
<template><button @click="go">go</button></template>`;

describe('ontology gate (reuses compileOntologyVersion)', () => {
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

describe('SFC gate: Pass 1 (transpile)', () => {
  it('a known-good App.vue compiles to { ok: true }', () => {
    expect(compileSource('src/App.vue', APP_GOOD)).toEqual({ ok: true });
  });

  it('a syntactically-broken App.vue returns { ok: false, errorTail }', () => {
    const r = compileSource('src/App.vue', APP_SYNTAX_BROKEN);
    expect(r.ok).toBe(false);
    expect(r.errorTail).toBeTruthy();
  });

  it('bindings are threaded into the template: setup refs resolve to $setup.x, not _ctx.x', () => {
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

describe('SFC gate: Pass 2 (type-check against the real client and Vue)', () => {
  it('a correct op union literal type-checks clean → { ok: true }', () => {
    expect(compileSource('src/App.vue', appWithOp('create'))).toEqual({ ok: true });
  });

  it("the invented op:'set' is rejected by the type-checker → { ok: false, errorTail }", () => {
    const r = compileSource('src/App.vue', appWithOp('set'));
    expect(r.ok).toBe(false);
    expect(r.errorTail).toBeTruthy();
    // Pass 1 alone (transpile) would PASS this — it's valid Vue/TS syntax. Only the
    // Pass-2 semantic check against the Nebula API rejects the bad union literal.
    // Mutation: resolve `./nebula` to a module declaring `client: any` → red.
    expect(r.errorTail).toContain('TS2322');
  });

  it('the full known-good data-bound App.vue (ref/computed/store/transaction) type-checks clean', () => {
    // Capable-of-failing for Pass 2: this exercises the real client surface; a
    // spurious Pass-2 error (e.g. unresolved 'vue'/'./nebula'/crypto) would fail it.
    expect(compileSource('src/App.vue', APP_GOOD)).toEqual({ ok: true });
  });

  it('a list view on the documented query surface type-checks clean', () => {
    // A false finding holds a correct build back from `.dev` unless the model previews it.
    // A hand-written copy of the client lacked `subscribeQuery` until 2026-10-15.
    const listing = `<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { client } from './nebula';

const deals = ref(-1);
onMounted(() => {
  const list = client.resources.subscribeQuery({ queryType: 'parentChild', typeName: 'Deal', field: 'pipeline', value: 'p1' });
  list.setRenderWindow(list.resourceIds.slice(0, 25));
  list.onChange(() => { deals.value = list.resourceIds.length; });
});
</script>

<template><p>{{ deals }}</p></template>`;
    expect(compileSource('src/App.vue', listing)).toEqual({ ok: true });
  });

  it('an app written the way the docs and the platform guidance teach type-checks clean', () => {
    // Each line is something `website/docs/nebula` or `platform/AGENTS.md` teaches. Mutations:
    // drop the `*.vue` module declaration from `sfc-check.ts` → the component import reds;
    // drop its `reportFor` → errors in files the model did not write are reported against the
    // app (the client's type graph reaches Mesh's server files, which need the Workers types a
    // browser app does not load) → every clean case reds.
    const taught = `<script setup lang="ts">
import { ref, onBeforeUnmount, toRefs, reactive } from 'vue';
import DealRow from './components/DealRow.vue';
import { ROOT_NODE_ID } from '@lumenize/resources/frontend';
import { client } from './nebula';

const isAdmin = client.claims.access?.scopeAdmin === true;
const state = reactive({ saving: false });
const { saving } = toRefs(state);
const message = ref('');
const sub = client.resources.subscribe('Deal', 'd1');
const denied = sub.deniedNodes.length > 0;
onBeforeUnmount(() => sub[Symbol.dispose]());

async function save() {
  saving.value = true;
  const outcome = await client.resources.transaction({
    d2: { op: 'create', typeName: 'Deal', nodeId: ROOT_NODE_ID, value: { title: 'x' } },
  });
  switch (outcome.kind) {
    case 'committed': message.value = 'saved'; break;
    case 'timeout': message.value = outcome.retryable ? 'try again' : ''; break;
    case 'ontology-stale': message.value = outcome.currentVersion; break;
    default: message.value = 'failed';
  }
  saving.value = false;
}
</script>

<template>
  <DealRow v-if="isAdmin && !denied" />
  <button @click="save">{{ message }}</button>
</template>`;
    expect(compileSource('src/App.vue', taught)).toEqual({ ok: true });
  });
});

describe('SFC gate: Pass 2 reads the real types, so it is exact both ways', () => {
  const setup = (body: string) => `<script setup lang="ts">\n${body}\n</script>\n<template><p>x</p></template>`;

  it('a misspelled client method is a finding, naming the method the client has', () => {
    // A loose copy of the client let any member through; the real `ClientResources` does not.
    const r = compileSource('src/App.vue', setup(`import { client } from './nebula';
client.resources.subscribeQuerry({ queryType: 'parentChild', typeName: 'Deal', field: 'pipeline', value: 'p1' });`));
    expect(r.ok).toBe(false);
    expect(r.errorTail).toContain("src/App.vue(3,18): error TS2551: Property 'subscribeQuerry' does not exist");
    expect(r.errorTail).toContain("Did you mean 'subscribeQuery'?");
  });

  it('a finding names its line in the .vue, wherever the <script setup> block sits', () => {
    // Mutation: drop the padding in `checkVueSfc` → the line counts from the block → red.
    const r = compileSource('src/App.vue', `<template>
  <p>{{ n }}</p>
</template>

<script setup lang="ts">
const n: number = 'one';
</script>`);
    expect(r.errorTail).toContain('src/App.vue(6,7): error TS2322');
  });

  it('a misspelled Vue import is a finding', () => {
    // Mutation: declare `vue` as a shorthand module (every import `any`) → red.
    const r = compileSource('src/App.vue', setup(`import { onMountd } from 'vue';\nonMountd(() => {});`));
    expect(r.ok).toBe(false);
    expect(r.errorTail).toContain('TS2724');
  });

  it("a component in a subfolder resolves `../nebula` from where it sits", () => {
    // The `<script setup>` is checked beside its `.vue`; checked from `src/`, `../nebula`
    // would not resolve and the clean case reds. Mutation: check every SFC as `src/App.vue`.
    const component = (op: string) => setup(`import { client } from '../nebula';
client.resources.transaction({ a: { op: '${op}', typeName: 'Deal', nodeId: 'n', value: {} } });`);
    expect(compileVueSfc(component('create'), 'src/components/DealRow.vue')).toMatchObject({ ok: true });
    const wrong = compileVueSfc(component('set'), 'src/components/DealRow.vue');
    expect(wrong.ok).toBe(false);
    expect(wrong.errorTail).toContain('src/components/DealRow.vue(');
  });

  it('`using` and the store read clean under the app\'s own lib', () => {
    // The app's tsconfig targets ESNext, whose lib declares `Symbol.dispose`. Mutation: drop
    // `tsconfigPath` from the check, which falls back to ES2022 + DOM and to resolution that
    // reads no package `exports` → this and the client cases red.
    expect(compileSource('src/App.vue', setup(`import { computed } from 'vue';
import { store } from './nebula';
const n = computed(() => Object.keys(store.Deal ?? {}).length);
using held = { [Symbol.dispose]() {} };
void n; void held;`))).toEqual({ ok: true });
  });
});

describe('dispatch: non-compiled paths', () => {
  it('a non-.vue/.d.ts path is write-only (no compile) → { ok: true }', () => {
    expect(compileSource('src/styles.css', 'body { color: red; }')).toEqual({ ok: true });
    expect(compileSource('README.md', '# anything {{{ not vue')).toEqual({ ok: true });
  });
});
