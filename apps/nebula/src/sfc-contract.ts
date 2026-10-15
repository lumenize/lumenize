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
 * public API that `website/docs/nebula/api-reference.md` teaches (`client.resources.*`, the
 * client's own `dispose`/`logout`/`orgTree`/`subscribe*`, `client.claims`, the reactive `store`,
 * `ready`). ⚠️ A documented call missing here is a FALSE finding, and a build with findings is
 * held back from `.dev` unless the model previews it, so a gap here holds back correct code;
 * loose types beat absent ones. `OperationDescriptor` is copied
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

/** The documented five-kind outcome (api-reference § TransactionOutcome). */
export type TransactionOutcome =
  | { kind: 'committed'; resources: Record<string, unknown> }
  | { kind: 'rejected'; retryable: boolean; resources: Record<string, unknown> }
  | { kind: 'timeout'; retryable: true }
  | { kind: 'infrastructure-error'; retryable: true; error: Error }
  | { kind: 'ontology-stale'; retryable: false; clientVersion: string; currentVersion: string };

export interface ResourceSubscription {
  readonly snapshot: Promise<{ value: unknown; eTag: string; meta?: Record<string, any> } | null>;
  readonly deniedNodes: string[];
  onChange(cb: () => void): void;
  [Symbol.dispose](): void;
}

/** The one query shape: equality on a single to-one relationship field. */
export interface QueryDescriptor {
  queryType: 'parentChild';
  typeName: string;
  field: string;
  value: string;
  orderBy?: 'validFrom';
}

export interface QuerySubscription {
  readonly ready: Promise<void>;
  readonly resourceIds: string[];
  readonly deniedNodes: string[];
  setRenderWindow(resourceIds: string[]): void;
  onChange(cb: () => void): void;
  [Symbol.dispose](): void;
}

export interface Client {
  readonly claims: {
    sub: string;
    aud?: string;
    profileId?: string;
    access?: { scopeAdmin?: boolean; authScope?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  resources: {
    transaction(ops: Record<string, OperationDescriptor>, options?: Record<string, unknown>): Promise<TransactionOutcome>;
    subscribe(resourceType: string, resourceId: string): ResourceSubscription;
    unsubscribe(resourceType: string, resourceId: string): void;
    subscribeQuery(query: QueryDescriptor, options?: { renderGraceMs?: number }): QuerySubscription;
    read(resourceType: string, resourceId: string, options?: { ontologyVersion?: string }): Promise<{ value: unknown; eTag: string } | null>;
    write(resourceType: string, resourceId: string, opts?: { quietMs?: number }): void;
    createAndSubscribe(resourceType: string, resourceId: string, nodeId: string, value: unknown): ResourceSubscription;
    onTransactionResourceResolution(resourceType: string, handler: (resourceId: string, resolution: any) => any, options?: Record<string, unknown>): void;
    transactionDebounce(resourceType: string, opts: { quietMs?: number; maxWaitMs?: number; fields?: Record<string, { quietMs?: number; maxWaitMs?: number }> }): void;
  };
  orgTree: Record<string, (...args: any[]) => Promise<any>>;
  subscribeProfile(profileId: string): { [Symbol.dispose](): void; [k: string]: unknown };
  subscribeQuerySubscribers(query: QueryDescriptor): { [Symbol.dispose](): void; [k: string]: unknown };
  dispose(): void;
  logout(): Promise<void>;
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
  export function onBeforeMount(cb: () => void): void;
  export function onBeforeUnmount(cb: () => void): void;
  export function onBeforeUpdate(cb: () => void): void;
  export function onUpdated(cb: () => void): void;
  export function onErrorCaptured(cb: (...args: any[]) => any): void;
  export function nextTick(cb?: () => void): Promise<void>;
  export function shallowRef<T>(value: T): Ref<T>;
  export function shallowReactive<T extends object>(target: T): T;
  export function readonly<T>(target: T): Readonly<T>;
  export function toRef(source: any, key?: any): Ref<any>;
  export function toRefs<T extends object>(object: T): { [K in keyof T]: Ref<T[K]> };
  export function toValue<T>(source: T | Ref<T> | (() => T)): T;
  export function unref<T>(ref: T | Ref<T>): T;
  export function isRef(value: unknown): value is Ref<any>;
  export function markRaw<T>(value: T): T;
  export function toRaw<T>(value: T): T;
  export function provide(key: any, value: any): void;
  export function inject<T = any>(key: any, defaultValue?: T): T;
  export function useTemplateRef<T = any>(key: string): Ref<T | null>;
  export function useId(): string;
  export function useAttrs(): Record<string, unknown>;
  export function useSlots(): Record<string, any>;
  export function defineComponent(options: any): any;
  export function defineAsyncComponent(loader: any): any;
  export function h(...args: any[]): any;
  export type Component = any;
  export type DefineComponent = any;
}
// The checker's lib predates explicit resource management, which the docs teach (\`using\`,
// \`[Symbol.dispose]()\`), so its symbol is declared here as lib.esnext.disposable declares it.
interface SymbolConstructor {
  readonly dispose: unique symbol;
  readonly asyncDispose: unique symbol;
}
// A component file is checked on its own, so an import of a sibling \`.vue\` resolves here.
declare module '*.vue' {
  const component: any;
  export default component;
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

/** Packages the platform's guidance allows the model to import — declared as shorthand
 *  ambient modules (all imports become `any`) so a legitimate import produces no finding:
 *  the icons, and `@lumenize/resources/frontend`, from which the docs import `ROOT_NODE_ID`,
 *  `buildOrgTreeView` and `textMerge`. An import of any OTHER package is a real finding (the
 *  prompt forbids it). */
export const ALLOWED_IMPORT_SHIMS_DTS = `
declare module 'lucide-vue-next';
declare module '@lumenize/resources/frontend';
`;
