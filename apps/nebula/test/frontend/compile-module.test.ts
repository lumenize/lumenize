/**
 * Studio compile pipeline — P1 (the "runnable ESM, callable export" bar).
 *
 * Runs in node/jsdom (the only non-workerd project) because workerd cannot
 * `import()` a module string — so the "compile actually runs inside the DevStar
 * DO" bar lives in the workerd suite (`dev-star-compile.test.ts`), and the
 * "the emitted ESM is genuinely importable and a known export is callable" bar
 * lives here. Both exercise the SAME `compileSFCToModule` (and the same vendor
 * tsc bundle it imports).
 *
 * The compiled module imports Vue runtime helpers from a bare `'vue'`
 * specifier (a data: URL can't resolve bare specifiers), so we rewrite those to
 * a generated no-op stub before importing — enough to prove the module loads
 * and its `setup`/`render` exports are callable. Rendering against real Vue +
 * the reactive store is the deferred T3 check.
 *
 * @see tasks/nebula-studio-compile-pipeline.md § Phase 1
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { compileSFCToModule } from '../../src/compile-module';

const TODO_SFC_TS = `<template>
  <div :class="{ done: completed }">
    <h2>{{ title }}</h2>
    <ul>
      <li v-for="item in items" :key="item.id">{{ item.label }}</li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

interface TodoItem { id: string; label: string; done: boolean; }

const props = defineProps<{ title: string; items: TodoItem[]; }>();
const completed = ref<boolean>(false);
const count = ref<number>(props.items.length);
</script>`;

/**
 * Import an assembled SFC module, rewriting its bare `'vue'` imports to a
 * generated no-op stub data URL (bare specifiers don't resolve in data: URLs).
 */
async function importCompiled(moduleSource: string) {
  const names = new Set<string>();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]vue['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(moduleSource))) {
    for (const part of m[1].split(',')) {
      // The stub must export the IMPORTED name (`Fragment` in `Fragment as
      // _Fragment`), not the local alias the module binds it to.
      const exported = part.split(/\s+as\s+/)[0].trim();
      if (exported) names.add(exported);
    }
  }
  // Identity-on-first-arg stub: `defineComponent(options)` → `options` (so the
  // assembled default export keeps its `setup`); render helpers (`openBlock`,
  // `createElementBlock`, …) are exercised as callable no-ops.
  const stubBody = names.size
    ? `export const ${[...names].map((n) => `${n} = (...a) => a[0]`).join(', ')};\nexport default {};`
    : 'export default {};';
  const stubUrl = `data:text/javascript,${encodeURIComponent(stubBody)}`;
  const rewritten = moduleSource.replace(/from\s*['"]vue['"]/g, `from "${stubUrl}"`);
  return import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(rewritten)}`);
}

describe('compileSFCToModule — runnable ESM + callable export', () => {
  it('strips residual TS the Vue compiler leaves behind', () => {
    const r = compileSFCToModule(TODO_SFC_TS, 'App');
    expect(r.errors).toEqual([]);
    expect(r.script.length).toBeGreaterThan(0);
    // Mutation-checked in the spike: these survive compileScript and are removed
    // only by transpileModule (the vendor-bundled tsc).
    expect(r.script).not.toContain('interface TodoItem');
    expect(r.script).not.toContain('ref<boolean>');
    expect(r.script).not.toContain('ref<number>');
  });

  it('produces a module that parses as valid JS (no syntax errors)', () => {
    const r = compileSFCToModule(TODO_SFC_TS, 'App');
    // transpileModule with diagnostics on surfaces syntactic errors — an empty
    // list proves the stitched ESM is structurally valid JS ("loadable").
    const check = ts.transpileModule(r.module, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
      reportDiagnostics: true,
    });
    expect(check.diagnostics ?? []).toEqual([]);
  });

  it('imports the assembled module and a known export is callable', async () => {
    const r = compileSFCToModule(TODO_SFC_TS, 'App');
    expect(r.errors).toEqual([]);

    const mod = await importCompiled(r.module);
    expect(mod.default).toBeTypeOf('object');
    // The render fn (compiled from <template>) and the setup fn (compiled from
    // <script setup>) are both callable on the assembled default export.
    expect(mod.default.render).toBeTypeOf('function');
    expect(mod.default.setup).toBeTypeOf('function');

    // Exercise the transpiled <script setup> body: `ref<boolean>(false)` became
    // `ref(false)` against the stubbed (no-op) `ref`. Calling setup proves the
    // emitted script is executable JS, not just syntactically valid text.
    const ctx = { expose() {}, attrs: {}, slots: {}, emit() {} };
    expect(() => mod.default.setup({ title: 't', items: [] }, ctx)).not.toThrow();
  });

  it('surfaces parse errors gracefully on a malformed SFC', () => {
    const r = compileSFCToModule('<template>{{ unclosed', 'Bad');
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.module).toBe('');
  });
});
