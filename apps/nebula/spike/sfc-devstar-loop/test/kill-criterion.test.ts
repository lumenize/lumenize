import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

// Representative SFC: covers <template>, <script setup>, scoped <style>,
// v-model deep paths, optional chaining, v-if, v-for. The kinds of
// constructs the doc's worked examples use.
const REPRESENTATIVE_SFC = `<template>
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

<script setup>
import { ref } from 'vue';
const props = defineProps(['id', 'store']);
const completed = ref(false);
</script>

<style scoped>
.done {
  text-decoration: line-through;
  color: var(--color-muted, gray);
}
</style>`;

describe('kill criterion: @vue/compiler-sfc runs in Workers', () => {
  it('compiles a representative SFC inside a DO', async () => {
    const stubId = env.GALAXY.idFromName('spike');
    const stub = env.GALAXY.get(stubId);
    const result = await stub.compileSFC(REPRESENTATIVE_SFC, 'spike-test');

    // Surface any errors first so failures are diagnosable.
    expect(result.errors).toEqual([]);

    // Each block compiled to non-empty output.
    expect(result.script.length).toBeGreaterThan(0);
    expect(result.template.length).toBeGreaterThan(0);
    expect(result.styles.length).toBe(1);
    expect(result.styles[0].length).toBeGreaterThan(0);

    // Template result should be an executable render function.
    expect(result.template).toContain('export function');

    // Style should preserve the scoped attribute selector or class.
    expect(result.styles[0]).toContain('done');
  });

  it('compiles a TypeScript SFC (lang="ts") with type annotations', async () => {
    const TS_SFC = `<template>
  <div>{{ count }}</div>
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
  items: TodoItem[];
}>();

const count = ref<number>(props.items.length);
</script>`;

    const stubId = env.GALAXY.idFromName('spike-ts');
    const stub = env.GALAXY.get(stubId);
    const result = await stub.compileSFC(TS_SFC, 'spike-ts');

    expect(result.errors).toEqual([]);
    expect(result.script.length).toBeGreaterThan(0);
    expect(result.template.length).toBeGreaterThan(0);

    // `@vue/compiler-sfc` processes Vue's SFC macros — `defineProps<{...}>()`
    // gets transformed into a runtime prop declaration. The bare type-arg
    // macro form should NOT survive into the output.
    expect(result.script).not.toContain('defineProps<{');

    // Note: `@vue/compiler-sfc` does NOT strip non-Vue TS syntax on its own
    // (interface declarations, `: T` annotations on non-macro symbols, etc.).
    // That's a downstream-transpiler concern (chain typescript/@swc after).
    // The kill criterion here is "lang='ts' doesn't crash compileScript and
    // Vue macros resolve correctly" — confirmed.
  });

  it('produces parse errors gracefully on malformed SFC', async () => {
    const stubId = env.GALAXY.idFromName('spike-bad');
    const stub = env.GALAXY.get(stubId);
    const result = await stub.compileSFC('<template>{{ unclosed', 'bad');

    // We expect errors — but the call shouldn't throw, and the result
    // shape should still be intact.
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
