/**
 * SFC → runnable-ESM pipeline, runnable **inside a DevStar Durable Object**.
 *
 * `@vue/compiler-sfc` resolves Vue macros (`defineProps<…>`, `withDefaults`, …)
 * and separates `<script>`/`<template>`/`<style>`, but leaves non-macro TS
 * (`interface`, `: T`, `ref<T>()`) in the script — so a `lang="ts"` SFC isn't
 * executable JS until a downstream transpile strips it. This module chains
 * `@vue/compiler-sfc` → `typescript`'s `transpileModule` → one importable ESM.
 *
 * ## tsc-in-workerd (build-seq #1a, exploratory question — RESOLVED: must bundle)
 *
 * `typescript` **cannot** be imported into the DevStar DO directly: BOTH a full
 * default import (`import ts from 'typescript'`) AND a narrow named import
 * (`import { transpileModule } from 'typescript'`) crash the workerd isolate at
 * module-load ("Worker exited unexpectedly") — the crash is `typescript`'s
 * module-init Node-builtin probing (`fs`/`os`/`process.argv`), not a
 * function-surface concern, so trimming the surface doesn't help. So tsc is
 * consumed from a pre-bundled, Node-builtin-shimmed vendor bundle
 * (`../vendor/tsc-transpile.bundle.mjs`, built by `scripts/bundle-tsc.mjs`,
 * committed). `@vue/compiler-sfc` itself runs unbundled under `nodejs_compat_v2`.
 * Full findings: `tasks/nebula-studio-compile-pipeline.md` § Phase-1 spike;
 * exercised by `test/.../dev-star-compile.test.ts` (compile runs INSIDE the DO).
 */
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc';
// tsc is consumed from the pre-bundled, workerd-shimmed vendor bundle — a bare
// `import … from 'typescript'` crashes the isolate at load (see this file's
// header + scripts/bundle-tsc.mjs). The `import type` below is erased at runtime
// (no crash) and gives the bundle's untyped `ts` the real typescript namespace.
// @ts-expect-error — pre-bundled tsc, no types; see scripts/bundle-tsc.mjs
import { ts as tsBundle } from '../vendor/tsc-transpile.bundle.mjs';
import type tsNamespace from 'typescript';
const ts = tsBundle as typeof tsNamespace;

export interface CompileModuleResult {
  /** `<script>`/`<script setup>` after macro resolution AND TS→JS transpile. */
  script: string;
  /** The compiled render function source (`export function render`). */
  render: string;
  styles: string[];
  /** script + render stitched into one importable ES module (bare `vue` specifiers). */
  module: string;
  errors: string[];
}

/**
 * Compile a `.vue` SFC string to a single importable ES module.
 *
 * Returns `{ errors: [...], module: '' }` on parse/compile failure rather than
 * throwing — the caller (Studio's iterate-on-errors loop) reads `errors` to
 * self-correct. A successful result has `errors: []` and a non-empty `module`.
 */
export function compileSFCToModule(sfcSource: string, id = 'app'): CompileModuleResult {
  const empty = { script: '', render: '', styles: [] as string[], module: '' };

  const parseResult = parse(sfcSource);
  if (parseResult.errors.length > 0) {
    return { ...empty, errors: parseResult.errors.map((e) => String(e.message ?? e)) };
  }
  const { descriptor } = parseResult;
  const errors: string[] = [];

  let script = '';
  // Binding metadata from `<script setup>` MUST flow into the template compile:
  // template and script are compiled separately here, so without it the render
  // emits generic `_ctx.x` + `_resolveComponent("X")` and a script-setup
  // component (whose `count`/`House` live in setupState, not the options-API
  // `_ctx`) renders blank values + unresolved components. With it, the render
  // references `$setup.x` directly. (The full SFC compiler threads this
  // automatically; we must do it by hand. Doesn't change emitted specifiers —
  // still bare `vue`, rewritten at the DevStar write boundary.)
  let bindingMetadata: ReturnType<typeof compileScript>['bindings'] | undefined;
  if (descriptor.script || descriptor.scriptSetup) {
    try {
      const compiled = compileScript(descriptor, { id });
      script = compiled.content;
      bindingMetadata = compiled.bindings;
    } catch (err) {
      errors.push(`compileScript: ${(err as Error).message}`);
    }
  }

  let render = '';
  if (descriptor.template) {
    try {
      const r = compileTemplate({
        source: descriptor.template.content,
        filename: `${id}.vue`,
        id,
        compilerOptions: { bindingMetadata },
      });
      render = r.code;
      if (r.errors.length > 0) {
        errors.push(...r.errors.map((e) => `compileTemplate: ${typeof e === 'string' ? e : e.message}`));
      }
    } catch (err) {
      errors.push(`compileTemplate: ${(err as Error).message}`);
    }
  }

  const styles: string[] = [];
  for (const styleBlock of descriptor.styles) {
    try {
      const sr = compileStyle({ source: styleBlock.content, filename: `${id}.vue`, id, scoped: styleBlock.scoped });
      styles.push(sr.code);
      if (sr.errors.length > 0) errors.push(...sr.errors.map((e) => `compileStyle: ${e.message}`));
    } catch (err) {
      errors.push(`compileStyle: ${(err as Error).message}`);
    }
  }

  if (errors.length > 0) return { ...empty, styles, errors };

  // Strip remaining TS from the macro-resolved script. `transpileModule` is
  // syntactic-only (no type-check, no fs) — the light path vs the validator's
  // full Program API. Keep ESM so imports/exports survive for assembly.
  const jsScript = script
    ? ts.transpileModule(script, {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      }).outputText
    : '';

  // Stitch into one module: the script's `export default` becomes a named const,
  // the render fn is attached to it, and that const is re-exported as the default.
  // Standard non-inline SFC assembly — Vue's runtime wires setup() → render.
  const scriptBody = jsScript.replace('export default', 'const __sfc_main =');
  const renderBody = render.replace('export function render', 'function render');
  const module = [scriptBody, renderBody, '__sfc_main.render = render;', 'export default __sfc_main;'].join('\n');

  return { script: jsScript, render, styles, module, errors: [] };
}
