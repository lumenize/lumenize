/**
 * The OFFLINE compile checks — ⚠️ NOT on any deployed path. The Worker-side per-write
 * gate died when the compilers left the Worker
 * (tasks/archive/nebula-move-compilers-out-of-the-worker.md): a `write_file` is a pure write
 * now, and the LIVE checking runs in the container build job
 * (`container/compiler/job.ts` + `sfc-check.ts`). This file runs that same `checkVueSfc`
 * against the scaffold app in the repo, `container/app`, whose imports resolve through the
 * repo's `node_modules` to the Vue the build box installs and the workspace's own
 * `@lumenize/resources`. What survives here, and why:
 *
 *  - the offline prompt harness (tasks/on-hold/nebula-offline-prompt-harness.md)
 *    scores model output with {@link compileSource} in plain Node — seconds-fast,
 *    no Docker — so this module stays importable outside workerd (no mesh, no
 *    `cloudflare:workers`);
 *  - `codegen-gate.test.ts` pins the check behaviour (the `$setup` bindings
 *    threading, the ontology reserved-prefix guard reaching a compile, what the
 *    real client and Vue accept and refuse) in the `offline` project, the one with
 *    a disk to read them from.
 *
 * Given `(path, content)`, dispatch by extension: `*.d.ts` (the ontology) →
 * {@link compileOntologyVersion}; `*.vue` → the two-pass SFC check (Pass 1
 * transpiles with `@vue/compiler-sfc`; Pass 2 type-checks `<script setup>` against
 * the app's real imports — catches API misuse like the invented `op: 'set'`, which a
 * transpile-only pass misses); any other path → `{ ok: true }`.
 *
 * @see memory sfc-compile-needs-bindingmetadata, tsc-in-workerd-must-bundle
 */
import { fileURLToPath } from 'node:url';
import { compileOntologyVersion } from '../../src/ontology-compile';
import { checkVueSfc } from '../../container/compiler/sfc-check';

/** The scaffold app every Galaxy is seeded with, checked here as the build box checks
 *  `/workspace`. */
export const SCAFFOLD_APP = fileURLToPath(new URL('../../container/app', import.meta.url));

/** Uniform Rung-1 result. `errorTail` (bounded + sanitized) is present iff `!ok`. */
export interface GateResult {
  ok: boolean;
  errorTail?: string;
}

/** Cap on the fed-back / persisted error tail (bounded so it neither bloats
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
 * The two-pass SFC gate, as the build box runs it, on `src/App.vue` of the scaffold app.
 * Exported (beyond {@link compileSource}'s uniform result) so a probe can assert Pass-1
 * bindings threading: `templateCode` must reference `$setup.x`, not `_ctx.x` (the
 * blank-render trap — see `sfc-compile-needs-bindingmetadata`).
 */
export function compileVueSfc(content: string, relPath = 'src/App.vue'): GateResult & { templateCode?: string } {
  const { findings, templateCode } = checkVueSfc(SCAFFOLD_APP, relPath, content);
  return findings.length === 0
    ? { ok: true, templateCode }
    : { ok: false, errorTail: sanitizeErrorTail(findings.join('\n')), templateCode };
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
