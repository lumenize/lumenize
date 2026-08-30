/**
 * The OFFLINE compile checks — ⚠️ NOT on any deployed path. The Worker-side per-write
 * gate died when the compilers left the Worker
 * (tasks/archive/nebula-move-compilers-out-of-the-worker.md): a `write_file` is a pure write
 * now, and the LIVE checking runs in the container build job
 * (`container/compiler/job.ts` + `sfc-check.ts`, against the same
 * `src/sfc-contract.ts` this file mounts). What survives here, and why:
 *
 *  - the offline prompt harness (tasks/on-hold/nebula-offline-prompt-harness.md)
 *    scores model output with {@link compileSource} in plain Node — seconds-fast,
 *    no Docker — so this module stays importable outside workerd (no mesh, no
 *    `cloudflare:workers`);
 *  - `codegen-gate.test.ts` pins the check behaviour (the `$setup` bindings
 *    threading, the ontology reserved-prefix guard reaching a compile, the
 *    sanitizer) at pool-workers speed.
 *
 * Given `(path, content)`, dispatch by extension: `*.d.ts` (the ontology) →
 * {@link compileOntologyVersion}; `*.vue` → the two-pass SFC check (Pass 1
 * transpiles with `@vue/compiler-sfc`; Pass 2 type-checks `<script setup>` against
 * the contract — catches API misuse like the invented `op: 'set'`, which a
 * transpile-only pass misses); any other path → `{ ok: true }`.
 *
 * @see memory sfc-compile-needs-bindingmetadata, tsc-in-workerd-must-bundle
 */
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { checkTypeScript } from '@lumenize/ts-runtime-parser-validator/compile';
import { compileOntologyVersion } from '../../src/ontology-compile';
import { NEBULA_API_DTS, VUE_SHIM_DTS, ALLOWED_IMPORT_SHIMS_DTS } from '../../src/sfc-contract';

/** Uniform Rung-1 result. `errorTail` (bounded + sanitized) is present iff `!ok`. */
export interface GateResult {
  ok: boolean;
  errorTail?: string;
}

/** Cap on the fed-back / persisted error tail (D8 — bounded so it neither bloats
 *  the prompt nor harms eval-fixture portability when persisted in the codegen record). */
const MAX_ERROR_TAIL = 4000;

/**
 * Strip host-absolute paths + bundler/workerd-internal frames and bound the length.
 * Raw `@vue/compiler-sfc` / `tsc` output can embed absolute paths or internal
 * stack frames; unbounded it bloats the prompt and harms eval-fixture portability
 * (the corpus persists this on the agent Message's codegen record).
 */
export function sanitizeErrorTail(raw: string): string {
  let s = raw
    // bundler/runtime stack frames (workerd, node internals, node_modules)
    .replace(/\s*at\s+[^\n]*\((?:worker|node:internal|[^)]*\/node_modules\/)[^)]*\)/g, '')
    // absolute paths into bundled deps
    .replace(/(?:\/[\w.@-]+)*\/(?:node_modules|dist)\/[\w./@-]+/g, '<bundled>')
    // host-absolute paths
    .replace(/\/(?:Users|home|root|private|var|tmp)\/[\w./@ -]+/g, '<path>')
    // the gate's internal virtual filename → the file the model actually wrote
    .replace(/\/?app-setup\.ts/g, 'App.vue')
    .trim();
  if (s.length > MAX_ERROR_TAIL) s = s.slice(0, MAX_ERROR_TAIL) + '\n…(truncated)';
  return s;
}

/** Normalize a model-supplied path the way `writeSource` does (strip leading
 *  slashes) so a near-miss on the canonical ontology path can't dodge dispatch. */
function normalizeRelPath(path: string): string {
  return path.replace(/^\/+/, '');
}

/**
 * The two-pass SFC gate. Exported (beyond {@link compileSource}'s uniform result)
 * so a Phase-1 probe can assert Pass-1 bindings threading: `templateCode` must
 * reference `$setup.x`, not `_ctx.x` (the blank-render trap — see
 * `sfc-compile-needs-bindingmetadata`).
 */
export function compileVueSfc(content: string): GateResult & { templateCode?: string } {
  // ── Pass 1: transpile (syntax + template) ───────────────────────────────
  const { descriptor, errors } = parse(content, { filename: 'App.vue' });
  if (errors.length > 0) {
    return { ok: false, errorTail: sanitizeErrorTail(errors.map((e) => String(e instanceof Error ? e.message : e)).join('\n')) };
  }
  const id = 'gate';
  let bindings: Record<string, unknown> | undefined;
  if (descriptor.script || descriptor.scriptSetup) {
    try {
      const script = compileScript(descriptor, { id });
      bindings = script.bindings;
    } catch (e) {
      return { ok: false, errorTail: sanitizeErrorTail(e instanceof Error ? e.message : String(e)) };
    }
  }
  let templateCode: string | undefined;
  if (descriptor.template) {
    const tpl = compileTemplate({
      source: descriptor.template.content,
      filename: 'App.vue',
      id,
      // Thread the <script setup> bindings so the template resolves setup-scope
      // refs to `$setup.x` (NOT `_ctx.x`) — without this a <script setup>
      // component renders blank (sfc-compile-needs-bindingmetadata).
      compilerOptions: { bindingMetadata: bindings as any },
    });
    if (tpl.errors.length > 0) {
      return { ok: false, errorTail: sanitizeErrorTail(tpl.errors.map((e) => String(e instanceof Error ? e.message : e)).join('\n')) };
    }
    templateCode = tpl.code;
  }

  // ── Pass 2: semantic type-check of <script setup> (the op:'set' class) ───
  const setup = descriptor.scriptSetup?.content;
  if (setup) {
    const result = checkTypeScript({
      files: {
        '/app-setup.ts': setup,
        // Resolved by the relative `import … from './nebula'` (NOT an ambient
        // module — relative specifiers resolve to a real file, here `/nebula.d.ts`).
        '/nebula.d.ts': NEBULA_API_DTS,
        // Global ambient `.d.ts` (bare `'vue'`/`'lucide-vue-next'` modules + the
        // <script setup> macros) — must be program roots to register globally.
        '/vue-shim.d.ts': VUE_SHIM_DTS,
        '/allowed-imports.d.ts': ALLOWED_IMPORT_SHIMS_DTS,
      },
      rootNames: ['/app-setup.ts', '/vue-shim.d.ts', '/allowed-imports.d.ts'],
    });
    if (!result.ok) {
      return { ok: false, errorTail: sanitizeErrorTail(result.messages.join('\n')), templateCode };
    }
  }
  return { ok: true, templateCode };
}

/** The ontology Rung-1 gate: compile the `.d.ts` to a validator and discard the
 *  bundle, mapping throw/no-throw → `{ ok, errorTail }`. */
function compileOntologyGate(content: string): GateResult {
  try {
    compileOntologyVersion({ version: 'gate', types: content });
    return { ok: true };
  } catch (e) {
    return { ok: false, errorTail: sanitizeErrorTail(e instanceof Error ? e.message : String(e)) };
  }
}

/**
 * Path-dispatched compile check — the OFFLINE scoring entry (see the module header;
 * the live loop no longer calls this: a write is pure and the container `build`
 * checks). Normalizes the path first, then dispatches by extension: `*.d.ts` →
 * ontology check, `*.vue` → SFC two-pass check, anything else → `{ ok: true }`.
 *
 * Pure + synchronous; no container, no AI binding.
 */
export function compileSource(path: string, content: string): GateResult {
  const rel = normalizeRelPath(path);
  if (rel.endsWith('.d.ts')) return compileOntologyGate(content);
  if (rel.endsWith('.vue')) {
    const { ok, errorTail } = compileVueSfc(content);
    return { ok, errorTail };
  }
  return { ok: true };
}
