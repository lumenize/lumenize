/**
 * Rung-1 compile gates — the container-free self-correction signal for the Studio
 * codegen loop (tasks/nebula-codegen-loop.md Phase 1). Given `(path, content)`,
 * dispatch by file extension to the right compiler and return a uniform
 * `{ ok, errorTail? }`: the loop feeds `errorTail` back to the model each round.
 *
 * Two gates, picked by extension (Decision D3):
 *  - `*.d.ts` (the ontology) → {@link compileOntologyVersion} (reuse; shipped).
 *  - `*.vue` → the **two-pass SFC gate** (Decision B1): Pass 1 transpiles with
 *    `@vue/compiler-sfc` (catches syntax/template errors); Pass 2 **semantically
 *    type-checks** the `<script setup>` against the Nebula client API + Vue types
 *    (catches API misuse like the viability probe's invented `op: 'set'`, which a
 *    transpile-only pass misses).
 *  - any other path → write-only, no compile, `{ ok: true }`.
 *
 * **Standalone by design** (the codegen-loop task's "factor-out hook"): the offline
 * prompt harness imports this gate rather than re-deriving it. No DO/mesh state —
 * pure functions, runnable under vitest-pool-workers with no container and no AI
 * binding. `nodejs_compat` is required (`@vue/compiler-sfc` + the bundled `tsc`).
 *
 * @see tasks/nebula-codegen-loop.md § Phase 1
 * @see memory sfc-compile-needs-bindingmetadata, tsc-in-workerd-must-bundle
 */
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { checkTypeScript } from '@lumenize/ts-runtime-parser-validator';
import { compileOntologyVersion } from './galaxy';

/** Uniform Rung-1 result. `errorTail` (bounded + sanitized) is present iff `!ok`. */
export interface GateResult {
  ok: boolean;
  errorTail?: string;
}

/** Cap on the fed-back / persisted error tail (D8 — bounded so it neither bloats
 *  the prompt nor harms eval-fixture portability when stored in `TurnRecord.error`). */
const MAX_ERROR_TAIL = 4000;

/**
 * The Nebula client API surface the generated `App.vue` targets — the contract the
 * SFC semantic gate type-checks `<script setup>` against. Mirrors the real public
 * API (`client.resources.{transaction,subscribe,read,write,createAndSubscribe}`,
 * `client.claims`, the reactive `store`, `ready`); `EngineOp` is copied verbatim
 * from {@link ../frontend/conflict-outcome} so a bad union literal (`op: 'set'`)
 * fails to type-check exactly as it would against the live client.
 *
 * Authored here as the `.d.ts` for the `./nebula` bootstrap module the generated app
 * imports `{ client, store }` from — placed at the virtual path the relative import
 * resolves to (ambient `declare module` only matches *bare* specifiers, not relative
 * ones). The data-bound-generation prompt (out of scope, exploratory) will tell the
 * model to target this same contract.
 */
const NEBULA_API_DTS = `
/** A single operation in an explicit transaction batch (mirrors EngineOp). */
export type OperationDescriptor =
  | { op: 'create'; typeName: string; nodeId: number; value: unknown }
  | { op: 'put'; typeName: string; value: unknown; eTag?: string }
  | { op: 'move'; typeName: string; nodeId: number; eTag?: string }
  | { op: 'delete'; typeName: string; eTag?: string };

export type TransactionOutcome = {
  kind: 'committed' | 'conflict' | 'rejected' | 'infrastructure-error';
  resources: Record<string, unknown>;
};

export interface ResourceSubscription {
  snapshot: Promise<{ value: unknown; eTag: string } | null>;
  [Symbol.dispose](): void;
}

export interface Client {
  readonly claims: { sub: string; [k: string]: unknown };
  resources: {
    transaction(ops: Record<string, OperationDescriptor>): Promise<TransactionOutcome>;
    subscribe(resourceType: string, resourceId: string): ResourceSubscription;
    read(resourceType: string, resourceId: string): Promise<{ value: unknown; eTag: string } | null>;
    write(resourceType: string, resourceId: string, opts?: { quietMs?: number }): void;
    createAndSubscribe(resourceType: string, resourceId: string, nodeId: number, value: unknown): ResourceSubscription;
  };
}

export const client: Client;
/** The Vue-reactive UI store keyed by resource type → id → value. */
export const store: Record<string, Record<string, any>>;
export const ready: Promise<void>;
`;

/**
 * Minimal Vue ambient surface for the SFC semantic gate: the `<script setup>`
 * compiler macros as ambient globals (they have no import in source) plus the
 * `'vue'` reactivity API the generated apps import. Loose-but-typed — enough that
 * valid code type-checks clean and a Nebula-API misuse still surfaces, without
 * dragging Vue's full `.d.ts` graph into the isolate.
 */
const VUE_SHIM_DTS = `
declare module 'vue' {
  export interface Ref<T> { value: T; }
  export function ref<T>(value: T): Ref<T>;
  export function ref<T = any>(): Ref<T | undefined>;
  export function reactive<T extends object>(target: T): T;
  export function computed<T>(getter: () => T): Ref<T>;
  export function watch(source: any, cb: (...args: any[]) => void, options?: any): () => void;
  export function watchEffect(effect: () => void): () => void;
  export function onMounted(cb: () => void): void;
  export function onUnmounted(cb: () => void): void;
  export function nextTick(cb?: () => void): Promise<void>;
  export type Component = any;
  export type DefineComponent = any;
}
// <script setup> compiler macros — auto-available, no import (Vue rewrites them).
declare function defineProps<T = {}>(): Readonly<T>;
declare function defineEmits<T = (...args: any[]) => void>(): T;
declare function defineExpose(exposed?: Record<string, any>): void;
declare function defineModel<T = any>(name?: any, options?: any): { value: T };
declare function defineOptions(options: Record<string, any>): void;
declare function defineSlots<T = Record<string, any>>(): T;
declare function withDefaults<T, D>(props: T, defaults: D): T;
`;

/** Third-party packages the seed prompt allows the model to import — declared as
 *  shorthand ambient modules (all imports become `any`) so legitimate icon imports
 *  don't trip the gate. An import of any OTHER package is a real gate failure (the
 *  prompt forbids it); the data-bound-generation phase widens this if needed. */
const ALLOWED_IMPORT_SHIMS_DTS = `
declare module 'lucide-vue-next';
`;

/**
 * Strip host-absolute paths + bundler/workerd-internal frames and bound the length
 * (D8). Raw `@vue/compiler-sfc` / `tsc` output can embed absolute paths or internal
 * stack frames; unbounded it bloats the prompt and harms eval-fixture portability
 * (the corpus persists this in `TurnRecord.error`).
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
 *  bundle, mapping throw/no-throw → `{ ok, errorTail }` (D3). */
function compileOntologyGate(content: string): GateResult {
  try {
    compileOntologyVersion({ version: 'gate', types: content });
    return { ok: true };
  } catch (e) {
    return { ok: false, errorTail: sanitizeErrorTail(e instanceof Error ? e.message : String(e)) };
  }
}

/**
 * Path-dispatched Rung-1 compile — the loop's self-correction signal. Normalizes
 * the path first (D3), then dispatches by extension: `*.d.ts` → ontology gate,
 * `*.vue` → SFC two-pass gate, anything else → write-only `{ ok: true }`.
 *
 * Pure + synchronous; no container, no AI binding. The caller (the loop driver)
 * writes the file to the Workspace BEFORE calling this, then feeds `errorTail`
 * back to the model.
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
