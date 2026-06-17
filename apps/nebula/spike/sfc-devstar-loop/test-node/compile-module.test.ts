import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { compileSFCToModule } from '../src/compile-module';

// A todo SFC of the kind Studio's model would generate: lang="ts", an interface,
// a typed defineProps macro, and `ref<T>()` type-arguments — i.e. the residual TS
// that `@vue/compiler-sfc` alone leaves behind (see test/kill-criterion.test.ts,
// which proves these SURVIVE the Vue compiler; the transpile step removes them).
const TODO_SFC_TS = `<template>
  <div :class="{ done: completed }">
    <h2>{{ store.resources.todo[id]?.value?.title ?? 'Loading...' }}</h2>
    <input v-model="store.resources.todo[id].value.title" />
    <ul v-if="store.resources.todo[id]?.value?.items?.length">
      <li v-for="item in store.resources.todo[id].value.items" :key="item.id">
        {{ item.label }}
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

interface TodoItem {
  id: string;
  label: string;
  done: boolean;
}

const props = defineProps<{
  id: string;
  store: unknown;
  items: TodoItem[];
}>();

const completed = ref<boolean>(false);
const count = ref<number>(props.items.length);
</script>

<style scoped>
.done {
  text-decoration: line-through;
  color: var(--color-muted, gray);
}
</style>`;

describe('SFC → runnable ESM (transpile + assembly)', () => {
  it('strips residual TS the Vue compiler leaves behind', () => {
    const result = compileSFCToModule(TODO_SFC_TS, 'module-ts');

    expect(result.errors).toEqual([]);
    expect(result.script.length).toBeGreaterThan(0);

    // Capable-of-failing: kill-criterion.test.ts documents that the pre-transpile
    // script STILL contains these. Removing `ts.transpileModule` reintroduces them
    // (mutation-checked). The interface and the `ref<T>` type-args are non-macro TS
    // the Vue compiler leaves untouched.
    expect(result.script).not.toContain('interface TodoItem');
    expect(result.script).not.toContain('ref<boolean>');
    expect(result.script).not.toContain('ref<number>');
  });

  it('assembles script + render into one importable module', () => {
    const result = compileSFCToModule(TODO_SFC_TS, 'module-asm');

    expect(result.errors).toEqual([]);
    // The script's `export default` was rewritten to a named const, the render fn
    // attached, and that const re-exported as the module default.
    expect(result.module).toContain('const __sfc_main =');
    expect(result.module).toContain('function render');
    expect(result.module).toContain('__sfc_main.render = render;');
    expect(result.module).toContain('export default __sfc_main;');
    // Exactly one default export (the surgery didn't leave the original behind).
    expect(result.module.match(/export default/g)?.length).toBe(1);
    expect(result.styles.length).toBe(1);
  });

  it('produces a module that parses as valid JS (no syntax errors)', () => {
    const result = compileSFCToModule(TODO_SFC_TS, 'module-parse');

    // Re-transpile the assembled ESM to CJS with diagnostics on; transpileModule
    // surfaces *syntactic* errors, so an empty list proves the stitched module is
    // structurally valid JavaScript (T2: "loadable"), not just non-empty strings.
    const check = ts.transpileModule(result.module, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
      reportDiagnostics: true,
    });
    expect(check.diagnostics ?? []).toEqual([]);
  });

  it('surfaces parse errors gracefully on a malformed SFC', () => {
    const result = compileSFCToModule('<template>{{ unclosed', 'bad');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.module).toBe('');
  });
});
