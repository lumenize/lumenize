/**
 * The SFC type-check CONTRACT — the ambient `.d.ts` surfaces a generated `App.vue` is
 * checked against. A pure-constants LEAF (no imports), shared by the two checkers so
 * the contract cannot drift between them:
 *  - the container build job's `checkVueSfc` (`container/compiler/sfc-check.ts`) — the
 *    live path; the Dockerfile COPYs this file into the image bundle;
 *  - the Node-side `compileVueSfc` (`test/offline/codegen-gate.ts`) — the offline
 *    scoring surface (tasks/on-hold/nebula-offline-prompt-harness.md) and its tests.
 */

/**
 * The Nebula client API surface the generated `App.vue` targets. Mirrors the real
 * public API (`client.resources.{transaction,subscribe,read,write,createAndSubscribe}`,
 * `client.claims`, the reactive `store`, `ready`); `OperationDescriptor` is copied
 * verbatim from the frontend's conflict-outcome `EngineOp` so a bad union literal
 * (`op: 'set'`) fails to type-check exactly as it would against the live client.
 * Mount at the path the app's relative `./nebula` import resolves to.
 */
export const NEBULA_API_DTS = `
/** A single operation in an explicit transaction batch (mirrors EngineOp). */
export type OperationDescriptor =
  | { op: 'create'; typeName: string; nodeId: string; value: unknown }
  | { op: 'put'; typeName: string; value: unknown; eTag?: string }
  | { op: 'move'; typeName: string; nodeId: string; eTag?: string }
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
    createAndSubscribe(resourceType: string, resourceId: string, nodeId: string, value: unknown): ResourceSubscription;
  };
}

export const client: Client;
/** The Vue-reactive UI store keyed by resource type → id → value. */
export const store: Record<string, Record<string, any>>;
export const ready: Promise<void>;
`;

/**
 * Minimal Vue ambient surface for the semantic pass: the `<script setup>` compiler
 * macros as ambient globals (they have no import in source) plus the `'vue'`
 * reactivity API the generated apps import. Loose-but-typed — enough that valid code
 * type-checks clean and a Nebula-API misuse still surfaces, without dragging Vue's
 * full `.d.ts` graph in.
 */
export const VUE_SHIM_DTS = `
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
 *  don't produce findings. An import of any OTHER package is a real finding (the
 *  prompt forbids it). */
export const ALLOWED_IMPORT_SHIMS_DTS = `
declare module 'lucide-vue-next';
`;
