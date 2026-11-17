/**
 * Core factory types for `@lumenize/resources/frontend`.
 */
import type { ConnectionState } from '@lumenize/mesh/client';
import type { NebulaStoreAdapter, ResourceSubscription, ProfileChannelSnapshot, ProfileSubscription, SubscriberListSubscription, SubscriberRosterDelivery } from '../nebula-client';
import type { QueryDescriptor } from '../query-hash';

/**
 * Middleware fires on every write through the Proxy `set` trap (and wrapped
 * Map/Set mutators), regardless of write origin: v-model, @click, internal
 * code, server fanout. Return a value to substitute for `newValue`; return
 * `undefined` to leave `newValue` unchanged; throw to abort the write entirely
 * (which also aborts the synced-state submission, since synced-state runs
 * after the user chain).
 */
export type Middleware = (args: {
  path: string;
  oldValue: unknown;
  newValue: unknown;
  context: WriteContext;
}) => unknown;

/**
 * Write-context discriminator. `'local'` is the default (user-driven write);
 * `'remote'` / `'rollback'` / `'computed'` bypass the synced-state middleware
 * (the source — server fanout, engine rollback, or vivification — has already
 * authoritatively decided the value, so it must not re-enqueue a transaction).
 */
export type WriteContext = { source: 'local' | 'remote' | 'rollback' | 'computed' };

/**
 * The subset of `NebulaClient` the factory's store layer drives. The real
 * NebulaClient satisfies this structurally; tests pass a lightweight mock that
 * runs the same conflict-outcome engine over a recording mesh transport.
 *
 * The factory does NOT instantiate the engine or debounce queue — NebulaClient
 * owns them. The factory injects a {@link NebulaStoreAdapter} via
 * `bindStore(...)`, drives the debounced v-model path via `resources.write`,
 * manages auto-subscribe via `resources.{subscribe,unsubscribe}`, and surfaces
 * connection state via `onConnectionStateChange` + `connectionState`.
 */
export interface StoreClient {
  /** Inject the Vue-reactive adapter the engine writes optimistic state through. */
  bindStore(adapter: NebulaStoreAdapter): void;
  /** Current connection state — read once at factory creation to replay it. */
  readonly connectionState: ConnectionState;
  /** Register the factory's connection-state listener (mirrors to lmz.connection.*). */
  onConnectionStateChange(handler: (state: ConnectionState) => void): void;
  /** Register the factory's org-tree listener (mirrors to lmz.orgTree.value).
   *  Registering it also opts the client into auto-subscribing the tree on connect. */
  onOrgTreeUpdate(handler: (state: unknown) => void): void;
  /** Register the factory's global-Profile listener (mirrors each pushed snapshot to
   *  store.lmz.profiles[id].value/meta — the DEDICATED profile channel, never resources.*). */
  onProfileUpdate(handler: (profileId: string, snapshot: ProfileChannelSnapshot) => void): void;
  /** Subscribe to a global Profile by id (auto-subscribe 0→1). Returns a handle the factory holds +
   *  disposes after grace; pushes arrive via `onProfileUpdate`. Dedicated channel (not `resources.*`). */
  subscribeProfile(profileId: string): ProfileSubscription;
  /** Register the factory's subscriber-list roster listener (mirrors each roster to the query-in-path
   *  surface `store.lmz.querySubscribers.<typeName>.<field>[value]`). */
  onQuerySubscribersUpdate(handler: (delivery: SubscriberRosterDelivery) => void): void;
  /** Subscribe to a query's live subscriber-list roster — the STANDALONE watcher sub (roster only, NOT
   *  the query's data). Returns a handle the factory holds + disposes after grace; the roster arrives via
   *  `onQuerySubscribersUpdate` and lands at the query-in-path store surface. */
  subscribeQuerySubscribers(query: QueryDescriptor): SubscriberListSubscription;
  /** Flush pending debounced writes (no args = all). */
  flush(resourceType?: string, resourceId?: string): void;
  /** Flush + settle open submissions + tear down the debounce queue. */
  dispose(): Promise<void>;
  resources: {
    /** Enqueue a debounced put of the resource's current optimistic store value. */
    write(
      resourceType: string,
      resourceId: string,
      opts?: { quietMs?: number; preWriteValue?: unknown },
    ): void;
    /** Subscribe to a resource (auto-subscribe 0→1). Returns a handle the factory
     *  holds and disposes after the grace period; fanout arrives via the adapter. */
    subscribe(resourceType: string, resourceId: string): ResourceSubscription;
  };
}

// ─── The store, typed from the app's ontology ───────────────────────────────

declare global {
  /**
   * The app's ontology types by name: `{ ShoppingList: ShoppingList; ShoppingItem: ShoppingItem }`.
   * Empty here. An app's type check fills it in from the interfaces `src/ontology.d.ts` exports,
   * so `store.resources` is typed by the app's own data model with nothing for the app to write.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface LumenizeOntology {}
}

type OntologyType = LumenizeOntology[keyof LumenizeOntology];
/** Each ontology type `F` is the same type as: assignable both ways, so a look-alike with one more field is not one. */
type SameAs<F, A> = A extends unknown ? ([F] extends [A] ? ([A] extends [F] ? true : never) : never) : never;
type IsOntologyType<F> = [SameAs<F, OntologyType>] extends [never] ? false : true;
type Opaque = Date | RegExp | Error | Map<unknown, unknown> | Set<unknown> | ((...args: never[]) => unknown);
type StoredField<F> =
  F extends undefined | null ? F
  : IsOntologyType<F> extends true ? string
  : F extends Opaque ? F
  : F extends ReadonlyArray<infer E> ? StoredField<E>[]
  : F extends object ? { [K in keyof F]: StoredField<F[K]> }
  : F;

/**
 * An ontology type as it is stored and as the store holds it. A field typed as another ontology
 * type is a reference, and a reference holds the related resource's id (ADR-006):
 * `Stored<ShoppingItem>['list']` is `string` where the interface says `list: ShoppingList`, and a
 * `members: User[]` field is `string[]`.
 */
export type Stored<T> = { [K in keyof T]: StoredField<T[K]> };

/** One resource in the store. `value` is absent until its snapshot arrives, and while it is denied. */
export interface StoreEntry<V> {
  value: V;
  meta: { validFrom: string; nodeId: string; typeName: string; deleted?: boolean; [key: string]: unknown };
  deniedNodes: string[];
}

/** `store.resources`: every ontology type by name, each a map from resource id to its entry. */
export type StoreResources = [keyof LumenizeOntology] extends [never]
  ? Record<string, Record<string, StoreEntry<any>>>
  : { [N in keyof LumenizeOntology]: Record<string, StoreEntry<Stored<LumenizeOntology[N]>>> };

/** The store. `resources` is typed from the ontology; the app's own state beside it is its own. */
export interface NebulaStore {
  resources: StoreResources;
  [key: string]: any;
}
