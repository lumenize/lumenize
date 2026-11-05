/**
 * The container-side SFC type check — both passes of the old in-Worker codegen gate,
 * now living where the compiling runs (tasks/archive/nebula-move-compilers-out-of-the-worker.md:
 * every build-like step runs in the container; the Worker orchestrates and stores).
 *
 * Pass 1 transpiles with `@vue/compiler-sfc` (syntax + template errors, and the
 * `bindingMetadata` threading the blank-render trap demands); Pass 2 semantically
 * type-checks `<script setup>` — tsc cannot read a `.vue`, so Pass 2 is built on Pass 1's
 * descriptor. A finding never stops the job's bundle; the Galaxy holds a build with
 * findings back from `.dev` unless the model previews it, so a false finding holds back a
 * correct app.
 *
 * Pass 2 therefore checks against the code the app is built with, read from disk: the app's
 * own `tsconfig.json` and `src/` (its `nebula.ts` included), and the packages installed
 * beside it — `vue`, `lucide-vue-next`, and `@lumenize/resources`, vendored as source by the
 * Dockerfile. The `<script setup>` is checked as a file beside the `.vue` it came from, so
 * its relative imports resolve as they do in the build. Runs under plain Node, in the build
 * box (bundled into `/build/job.cjs` at image build) and in the `offline` test project.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { checkTypeScript } from '@lumenize/ts-runtime-parser-validator/compile';
import type { DiskReader } from '@lumenize/ts-runtime-parser-validator/compile';

const disk: DiskReader = {
  fileExists: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
  readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } },
  directoryExists: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
  getDirectories: (p) => {
    try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  },
  realpath: (p) => { try { return realpathSync(p); } catch { return p; } },
};

/** tsc cannot read a component file, so an import of a sibling `.vue` is typed `any`. */
const VUE_MODULE_DTS = "declare module '*.vue' { const component: any; export default component; }";

/**
 * Check one SFC of the app rooted at `appRoot` (`/workspace` in the build box), both passes,
 * returning raw diagnostic lines that name `relPath`. Never throws: pass-1 parse/compile
 * errors become findings too, so the job's report shape is uniform whatever broke.
 * `templateCode` is the compiled template, for a test of the bindings threading.
 */
export function checkVueSfc(appRoot: string, relPath: string, source: string): { findings: string[]; templateCode?: string } {
  const findings: string[] = [];

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
  let templateCode: string | undefined;
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
    templateCode = tpl.code;
  }

  // ── Pass 2: semantic type-check of <script setup> (the op:'set' class) ───
  const block = descriptor.scriptSetup;
  if (block?.content) {
    // Pad the block down to where it sits, so a finding's line is its line in the `.vue`.
    const setup = '\n'.repeat(block.loc.start.line - 1) + block.content;
    const checked = join(appRoot, `${relPath}.check.ts`);
    const vueModule = join(appRoot, 'src/__vue-module.check.d.ts');
    const tsconfig = join(appRoot, 'tsconfig.json');
    const result = checkTypeScript({
      files: { [checked]: setup, [vueModule]: VUE_MODULE_DTS },
      rootNames: [checked, vueModule],
      disk,
      ...(existsSync(tsconfig) ? { tsconfigPath: tsconfig } : {}),
      // Only the model's file: the client's type graph reaches Mesh's server files, which need
      // Workers types a browser app does not load, so the rest of the program is never clean.
      reportFor: [checked],
    });
    // Findings carry the REAL path: the engine prints the checked file's path without its
    // leading slash, and the `.check.ts` suffix is ours.
    const printed = checked.replace(/^\//, '');
    for (const f of result.findings) findings.push(f.split(printed).join(relPath));
  }
  return { findings, templateCode };
}
