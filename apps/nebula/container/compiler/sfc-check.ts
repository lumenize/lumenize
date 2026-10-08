/**
 * The container-side SFC type check — both passes of the old in-Worker codegen gate,
 * now living where the compiling runs (tasks/archive/nebula-move-compilers-out-of-the-worker.md:
 * every build-like step runs in the container; the Worker orchestrates and stores).
 *
 * Pass 1 transpiles with `@vue/compiler-sfc` (syntax + template errors, and the
 * `bindingMetadata` threading the blank-render trap demands); Pass 2 semantically
 * type-checks `<script setup>` against the Nebula client API + Vue ambient types —
 * tsc cannot read a `.vue`, so Pass 2 is built on Pass 1's descriptor. Findings are
 * ADVISORY: the job runs every step regardless (a type finding never gates the
 * bundle), and the model judges them.
 *
 * Runs under plain Node in the build box (bundled into `/build/job.cjs` at image
 * build). The virtual file mounts mirror the real workspace layout (`/src/nebula.d.ts`
 * beside the checked file) so a generated app's relative `./nebula` import resolves.
 */
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { checkTypeScript } from '@lumenize/ts-runtime-parser-validator/compile';
// The shared contract leaf — the same constants the Node-side offline scorer checks
// against (src/sfc-contract.ts), so the two checkers cannot drift.
import { NEBULA_API_DTS, VUE_SHIM_DTS, ALLOWED_IMPORT_SHIMS_DTS } from '../../src/sfc-contract';

/**
 * Check one SFC, both passes, returning raw diagnostic lines. Never throws:
 * pass-1 parse/compile errors become findings too, so the job's report shape is
 * uniform whatever broke.
 */
export function checkVueSfc(relPath: string, source: string): { findings: string[] } {
  const findings: string[] = [];
  const virtualName = `${relPath}.check.ts`;
  // Findings carry the REAL path — strip the virtual suffix wherever tsc echoes it.
  const unvirtualize = (s: string) => s.split(virtualName).join(relPath);

  // ── Pass 1: transpile (syntax + template) ───────────────────────────────
  const { descriptor, errors } = parse(source, { filename: relPath });
  if (errors.length > 0) {
    for (const e of errors) findings.push(`${relPath}: ${e instanceof Error ? e.message : String(e)}`);
    return { findings }; // no descriptor to build pass 2 on
  }
  let bindings: Record<string, unknown> | undefined;
  if (descriptor.script || descriptor.scriptSetup) {
    try {
      const script = compileScript(descriptor, { id: 'check' });
      bindings = script.bindings;
    } catch (e) {
      findings.push(`${relPath}: ${e instanceof Error ? e.message : String(e)}`);
      return { findings };
    }
  }
  if (descriptor.template) {
    const tpl = compileTemplate({
      source: descriptor.template.content,
      filename: relPath,
      id: 'check',
      // Thread the <script setup> bindings so the template resolves setup-scope
      // refs to `$setup.x` (NOT `_ctx.x`) — without this a <script setup>
      // component renders blank (sfc-compile-needs-bindingmetadata).
      compilerOptions: { bindingMetadata: bindings as any },
    });
    for (const e of tpl.errors) findings.push(`${relPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Pass 2: semantic type-check of <script setup> (the op:'set' class) ───
  const setup = descriptor.scriptSetup?.content;
  if (setup) {
    const result = checkTypeScript({
      files: {
        [`/${virtualName}`]: setup,
        // Resolved by the relative `import … from './nebula'` (NOT an ambient
        // module — relative specifiers resolve to a real file beside the SFC).
        '/src/nebula.d.ts': NEBULA_API_DTS,
        // Global ambient `.d.ts` (bare `'vue'`/`'lucide-vue-next'` modules + the
        // <script setup> macros) — must be program roots to register globally.
        '/vue-shim.d.ts': VUE_SHIM_DTS,
        '/allowed-imports.d.ts': ALLOWED_IMPORT_SHIMS_DTS,
      },
      rootNames: [`/${virtualName}`, '/vue-shim.d.ts', '/allowed-imports.d.ts'],
    });
    for (const f of result.findings) findings.push(unvirtualize(f));
  }
  return { findings };
}
