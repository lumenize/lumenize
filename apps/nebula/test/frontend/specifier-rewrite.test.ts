/**
 * `rewriteServedSpecifiers` — the DevStar write-boundary rewrite that maps the
 * compiled SFC's allowlisted bare specifiers to same-origin platform paths and
 * rejects everything else (so a served app resolves under `script-src 'self'`
 * with no import map). Pure-function bar; the in-DO end-to-end path is
 * `test/test-apps/baseline/dev-star-compile.test.ts`.
 *
 * @see tasks/nebula-self-hosted-assets.md § Phase 1
 */
import { describe, it, expect } from 'vitest';
import { rewriteServedSpecifiers } from '../../src/specifier-rewrite';
import { compileSFCToModule } from '../../src/compile-module';

describe('rewriteServedSpecifiers', () => {
  it('rewrites bare `vue` to ./vue.js (both quote styles)', () => {
    const r = rewriteServedSpecifiers(
      `import { ref } from 'vue';\nimport { openBlock as _o } from "vue"\n`,
    );
    expect(r.errors).toEqual([]);
    expect(r.code).toContain("import { ref } from './vue.js';");
    expect(r.code).toContain('import { openBlock as _o } from "./vue.js"');
    expect(r.code).not.toMatch(/from\s*['"]vue['"]/);
  });

  it('rewrites lucide icon imports to ./vendor/lucide/<name>.js', () => {
    const r = rewriteServedSpecifiers(`import House from 'lucide-vue-next/icons/house';\n`);
    expect(r.errors).toEqual([]);
    expect(r.code).toContain("import House from './vendor/lucide/house.js';");
  });

  it('rewrites a re-export from clause', () => {
    const r = rewriteServedSpecifiers(`export { ref } from 'vue';\n`);
    expect(r.errors).toEqual([]);
    expect(r.code).toContain("export { ref } from './vue.js';");
  });

  it('leaves relative / absolute / URL specifiers untouched', () => {
    const src =
      `import App from './App.js';\n` +
      `import x from '../shared.js';\n` +
      `import y from '/root.js';\n` +
      `export * from './vendor/vue.js';\n`;
    const r = rewriteServedSpecifiers(src);
    expect(r.errors).toEqual([]);
    expect(r.code).toBe(src);
  });

  it('rejects a non-allowlisted bare specifier', () => {
    const r = rewriteServedSpecifiers(`import _ from 'lodash';\n`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("Unsupported bare import 'lodash'");
  });

  it('rejects a lucide path that is not a single kebab segment (traversal guard)', () => {
    const r = rewriteServedSpecifiers(`import x from 'lucide-vue-next/icons/sub/evil';\n`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('Unsupported bare import');
  });

  it('does NOT rewrite a `from "vue"` substring inside a string literal', () => {
    // The false-positive a blind (non-line-anchored) scan would hit: these sit on
    // `const …` lines, not line-start import/export, so they stay verbatim.
    const src =
      `import { ref } from 'vue';\n` +
      `const msg = ref('hi from "vue" land');\n` +
      `const label = "imported from 'lodash' once";\n`;
    const r = rewriteServedSpecifiers(src);
    expect(r.errors).toEqual([]);
    expect(r.code).toContain(`ref('hi from "vue" land')`);
    expect(r.code).toContain(`"imported from 'lodash' once"`);
    expect(r.code).toContain("import { ref } from './vue.js';");
  });

  it('rewrites a bare side-effect import target as an error (only relative side-effects allowed)', () => {
    const r = rewriteServedSpecifiers(`import 'some-polyfill';\n`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("Unsupported bare import 'some-polyfill'");
  });

  it('leaves a relative side-effect import untouched', () => {
    const r = rewriteServedSpecifiers(`import './nebula.js';\n`);
    expect(r.errors).toEqual([]);
    expect(r.code).toBe(`import './nebula.js';\n`);
  });

  // The line-anchored rewrite is COMPLETE only because `transpileModule`
  // collapses every import to a single line. This pins that invariant end-to-end:
  // a MULTILINE source import, run through the real compile pipeline + rewrite,
  // must leave NO surviving bare `vue` (a missed one would 404 same-origin under
  // script-src 'self'). If a future tsc/option change emits multiline imports,
  // this goes red rather than silently shipping a broken bundle.
  it('catches a multiline `vue` import after the real compile collapses it', () => {
    const sfc = `<template><div>{{ n }}</div></template>
<script setup lang="ts">
import {
  ref,
  computed,
} from 'vue';
const n = ref(0);
const m = computed(() => n.value + 1);
</script>`;
    const compiled = compileSFCToModule(sfc, 'App');
    expect(compiled.errors).toEqual([]);
    const r = rewriteServedSpecifiers(compiled.module);
    expect(r.errors).toEqual([]);
    expect(r.code).toContain("from './vue.js'");
    expect(r.code).not.toMatch(/from\s*['"]vue['"]/);   // no surviving bare specifier
  });
});
