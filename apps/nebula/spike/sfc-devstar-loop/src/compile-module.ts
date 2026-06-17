import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc';
import ts from 'typescript';

/**
 * The full SFC → runnable-ESM pipeline: `@vue/compiler-sfc` (resolve Vue macros)
 * → `typescript` (strip the remaining non-macro TS) → assemble script + render
 * into one importable ES module.
 *
 * This is the step the bake-off recon flagged as missing from `galaxy.ts`'s
 * `compileSFC`: the Vue compiler resolves macros but leaves `interface`, `: T`,
 * and `ref<T>()` in the output, so a `lang="ts"` SFC isn't executable JS.
 *
 * ⚠️ **Lives outside `galaxy.ts` on purpose.** A raw `import ts from 'typescript'`
 * crashes the workerd isolate ("Worker exited unexpectedly") — verified — so it
 * must NOT enter the DO's import graph or it breaks every pool-workers test. This
 * module is exercised in Node (`test-node/`). When this pipeline moves into the
 * DevStar (build-seq #1), tsc gets bundled for workerd via the validator's proven
 * pattern (`packages/ts-runtime-parser-validator/scripts/bundle-tsc.mjs`); the
 * transpile+assembly logic here is identical regardless of where tsc runs.
 */
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

export function compileSFCToModule(sfcSource: string, id = 'spike'): CompileModuleResult {
  const empty = { script: '', render: '', styles: [] as string[], module: '' };

  const parseResult = parse(sfcSource);
  if (parseResult.errors.length > 0) {
    return { ...empty, errors: parseResult.errors.map((e) => String(e.message ?? e)) };
  }
  const { descriptor } = parseResult;
  const errors: string[] = [];

  let script = '';
  if (descriptor.script || descriptor.scriptSetup) {
    try {
      script = compileScript(descriptor, { id }).content;
    } catch (err) {
      errors.push(`compileScript: ${(err as Error).message}`);
    }
  }

  let render = '';
  if (descriptor.template) {
    try {
      const r = compileTemplate({ source: descriptor.template.content, filename: `${id}.vue`, id });
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

  // Strip remaining TS from the macro-resolved script. transpileModule is
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
