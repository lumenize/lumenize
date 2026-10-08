/**
 * NebulaClient — a `MeshClient` that composes {@link ClientResources}, the Client's half of the
 * Resources plane, the way a node composes `Resources`.
 *
 * The session is `MeshClient`'s: the token from the platform host's refresh, the active scope its
 * first token's `aud` names (ADR-022), logout, impersonation, invites and the Profile channel. This
 * class adds what an app reads and writes: `resources`, `orgTree`, the store the factory binds, and
 * the host's pushes, which arrive at the `@mesh()`-decorated methods below and forward to
 * `ClientResources`. It hands `ClientResources` the three moments only the Client sees: each new
 * token, each connection state, and the host's report that subscriptions may be gone.
 */

// Imports use the Node-safe /client subpath so this file can be imported from Node test harnesses
// (e.g. apps/nebula/test/browser/) — the main `@lumenize/mesh` entry pulls in `cloudflare:workers`
// and fails outside Workers. The same applies to types.
import { MeshClient, mesh } from '@lumenize/mesh/client';
import type { AuthClaims, ConnectionState, MeshClientConfig } from '@lumenize/mesh/client';
import { ClientResources } from './client-resources';
import type {
  NebulaStoreAdapter, OntologyStaleInfo, ResourceDenied, SubscriberListSubscription,
  SubscriberRosterDelivery,
} from './client-resources';
import type { Snapshot } from './snapshots';
import type { QueryDescriptor, QueryUpdatePayload, SubscriberRosterPayload } from './query-hash';
import type { OrgTreeState } from './org-ops';

// The resource types an app reads, from where they live, so every importer of this module keeps
// its import.
export type {
  TransactionOutcome, TransactionResourceResolution, ResourceHandler, ConflictResolverVerdict,
  OperationDescriptor, ResourceSubscription, ResourceDenied, ResourceStoreEntry, SubscribeQueryOptions,
  QuerySubscription, SubscriberListSubscription, SubscriberRosterDelivery, OntologyStaleInfo,
  TransactionOptions, ReadOptions, NebulaStoreAdapter,
} from './client-resources';
export type { ProfileChannelSnapshot, ProfileSubscription } from '@lumenize/mesh/client';

export interface NebulaClientConfig extends Omit<MeshClientConfig, 'refresh' | 'platformOrigin'> {
  /**
   * The platform host's origin, `https://platform.lumenize.dev`, where every refresh goes. The
   * browser sends the platform host's cookies with it and names this page in `Origin`, and the
   * answer's `aud` is the page host's scope. `createNebulaClient` derives it from the page.
   */
  platformOrigin: string;
  /**
   * App version this client was built against (lock-step with the server's ontology version).
   * Auto-attached to every `client.resources.*` call. The serving layer injects it, from the
   * version the Galaxy has APPLIED.
   *
   * **Optional, because an app with no resources is a first-class app.** Until an Apply runs there
   * is no version to pin, and a client without one still connects, authenticates, chats and reads
   * profiles — only the resource plane is unavailable, and it refuses per operation with
   * `NoOntologyInstalledError` rather than refusing to construct. Requiring it here is what used to
   * blank a freshly generated app's preview at mount.
   */
  ontologyVersion?: string;
  /**
   * Optional hook invoked when the server signals the client's ontology
   * version is stale (deploys happened since this client started). Typical
   * implementation: `() => window.location.reload()`. No default — undefined
   * means opted-out, in which case the staleness signal still surfaces via
   * the originating Promise's `{ resolution: 'ontology-stale' }` outcome.
   */
  onShouldRefreshUI?: (info: OntologyStaleInfo) => void;
  /**
   * Which mesh binding hosts this client's Resources — every `client.resources.*` op,
   * `client.orgTree.*`, and the org-tree channel. Default `'STAR'`. Every host serves the
   * same surface through its one `resources` door, so a client pointed at the Galaxy reads its
   * tree the same way. Studio's posts route by `StudioClient`'s chat pair, never this field.
   */
  resourceHostBinding?: string;
}

/**
 * The Client a generated app builds, through `createNebulaClient`. See the module header for what
 * it adds to `MeshClient`; `client.resources` and `client.orgTree` are `ClientResources`' APIs.
 */
export class NebulaClient extends MeshClient<AuthClaims> {
  readonly #resources: ClientResources;

  /**
   * Decoded JWT payload — **non-null on NebulaClient**.
   *
   * `MeshClient` types `claims` as `Readonly<AuthClaims> | null` (a genuine null window before the
   * first token refresh). NebulaClient narrows it to non-null: the factory's `ready` promise
   * resolves only after that first refresh populates claims, so by the time component / app code
   * runs, `client.claims` is always present — which is what lets the blessed examples write
   * `client.claims.sub` without `!`/`?.` under strict TS.
   *
   * Behaviorally-neutral re-declaration: the runtime getter is the inherited one (this only drops
   * `| null` from the type). Code that runs **before** `ready` — admin tools, scripts — must still
   * guard with `?.`.
   */
  get claims(): Readonly<AuthClaims> {
    return super.claims as Readonly<AuthClaims>;
  }

  constructor(config: NebulaClientConfig) {
    const {
      ontologyVersion,
      onShouldRefreshUI,
      resourceHostBinding,
      onConnectionStateChange: userOnConnectionStateChange,
      ...meshConfig
    } = config;
    // `refresh` is left out of the config type, and dropped here too, so a cast cannot supply one:
    // a NebulaClient's token always comes from the platform host for this page, and its scope from
    // that token. A child from `impersonate()` gets its own through MeshClient's private seam.
    delete (meshConfig as { refresh?: unknown }).refresh;

    // MeshClient delivers its first connection state on a microtask, after construction, so this
    // callback can read `#resources`.
    super({
      ...meshConfig,
      onConnectionStateChange: (state) => {
        this.#resources.onConnectionStateChange(state);
        userOnConnectionStateChange?.(state);
      },
    });

    this.#resources = new ClientResources(this, {
      ontologyVersion,
      resourceHostBinding,
      subscribeTimeoutMs: config.subscribeTimeoutMs,
      onShouldRefreshUI,
    });
  }

  /** Resource namespace — subscribe, read and transaction. Local: no member reaches the wire. */
  get resources(): ClientResources['api'] {
    return this.#resources.api;
  }

  /**
   * Org/permission-tree mutations, each a resilient `callAsync` through the host's `resources`
   * door. Reads arrive on their own channel, at `onOrgTreeUpdate`'s listener.
   */
  get orgTree(): ClientResources['orgTree'] {
    return this.#resources.orgTree;
  }

  /** Inject the UI store the engine writes through (the factory's). See `ClientResources.bindStore`. */
  bindStore(adapter: NebulaStoreAdapter): void {
    this.#resources.bindStore(adapter);
  }

  /**
   * Register a runtime listener for connection-state transitions. The factory uses this to mirror
   * state into `store.lmz.connection.*`, and reads {@link connectionState} once at creation to
   * replay the current state. Single-handler; a later call replaces it. The config's
   * `onConnectionStateChange`, if any, still fires too.
   */
  onConnectionStateChange(handler: ((state: ConnectionState) => void) | null): void {
    this.#resources.setConnectionStateListener(handler);
  }

  /**
   * Register a runtime listener for org-tree updates, which the factory mirrors into
   * `store.lmz.orgTree.value`. Single-handler; replaces. Registering one also opts this client
   * into subscribing the tree on connect.
   */
  onOrgTreeUpdate(handler: ((state: OrgTreeState) => void) | null): void {
    this.#resources.setOrgTreeListener(handler);
  }

  /**
   * Register a runtime listener for subscriber-list rosters, which the factory mirrors into
   * `store.lmz.querySubscribers.<typeName>.<field>[value]`. Single-handler; replaces.
   */
  onQuerySubscribersUpdate(handler: ((delivery: SubscriberRosterDelivery) => void) | null): void {
    this.#resources.setQuerySubscribersListener(handler);
  }

  /**
   * Subscribe to the live subscriber-LIST roster of `query`, without its data. The roster lands at
   * `store.lmz.querySubscribers.<typeName>.<field>[value]` through the factory's listener.
   */
  subscribeQuerySubscribers(query: QueryDescriptor): SubscriberListSubscription {
    return this.#resources.subscribeQuerySubscribers(query);
  }

  /**
   * Flush pending debounced writes immediately (component unmount / input blur / explicit). No
   * args flushes every resource; while disconnected the write path stays held until reconnect.
   */
  flush(resourceType?: string, resourceId?: string): void {
    this.#resources.flush(resourceType, resourceId);
  }

  /**
   * Tear down the client: flush pending debounced writes and settle every open submission, then
   * disconnect and end any impersonation. Nothing submits after this resolves
   * (api-reference § client.dispose). Distinct from {@link logout}, which also ends the session.
   */
  override async dispose(): Promise<void> {
    await this.#resources.dispose();
    await super.dispose();
  }

  /** The accumulated progress for an in-flight assistant `messageId`, or `undefined` once the
   *  durable Message superseded it (or nothing streamed). */
  streamingProgress(messageId: string): string | undefined {
    return this.#resources.streamingProgress(messageId);
  }

  /** Register the live-progress hook (the UI renders each accumulated chunk). */
  setOnStreamChunk(hook: (messageId: string, progress: string, replyTo?: string) => void): void {
    this.#resources.setOnStreamChunk(hook);
  }

  /**
   * @internal Test-only — runs the resources half of the walk `onSubscriptionRequired` runs (the
   * Profile channel's restore is `MeshClient`'s and is not run), for tests that exercise what one
   * re-subscribe does without forcing a lost subscription first.
   */
  _restoreSubscriptionsForTest(): void { this.#resources._restoreSubscriptionsForTest(); }

  /**
   * The ontology version this op pins, or a refusal naming why there is none — see
   * `ClientResources.requireOntologyVersion`. Protected, for a subclass's own resource writes.
   */
  protected requireOntologyVersion(operation: string): string {
    return this.#resources.requireOntologyVersion(operation);
  }

  /** A child from `impersonate()` reads the same app version on the same resource host. */
  protected override childConfig(): NebulaClientConfig {
    return {
      ...super.childConfig(),
      ontologyVersion: this.#resources.ontologyVersion,
      resourceHostBinding: this.#resources.resourceHostBinding,
    } as NebulaClientConfig;
  }

  // ─── What the session hands ClientResources ───────────────────────────────

  /** The host node says subscriptions may be gone: Resources restores its own, then the session's. */
  override onSubscriptionRequired(): void {
    this.#resources.onSubscriptionRequired();
    super.onSubscriptionRequired();
  }

  /** A new token: Resources compares its admin verdict. */
  override onClaimsChange(): void {
    this.#resources.onClaimsChange();
  }

  // ─── The host's pushes, each `@mesh()`-decorated and forwarded ─────────────
  //
  // Top-level methods, so the wire names them as it always has (`ctn<NebulaClient>()
  // .handleResourceUpdate(…)`); the bodies are `ClientResources`'.

  /** A resource update from the host: the answer to a subscribe, or a later broadcast. */
  @mesh()
  handleResourceUpdate(resourceType: string, resourceId: string, result: Snapshot | ResourceDenied | null | Error): void {
    this.#resources.handleResourceUpdate(resourceType, resourceId, result);
  }

  /** An org-tree snapshot from the host: the answer to `subscribeTree`, or a tree change. */
  @mesh()
  handleOrgTreeUpdate(envelope: { value: OrgTreeState }): void {
    this.#resources.handleOrgTreeUpdate(envelope);
  }

  /** A query-membership push, correlated by the locally computed `queryHash`. */
  @mesh()
  handleQueryUpdate(queryHash: string, result: QueryUpdatePayload | Error): void {
    this.#resources.handleQueryUpdate(queryHash, result);
  }

  /** A subscriber-list roster push for a watcher this client holds. */
  @mesh()
  handleQuerySubscribersUpdate(queryHash: string, result: SubscriberRosterPayload | Error): void {
    this.#resources.handleQuerySubscribersUpdate(queryHash, result);
  }

  /** A transient assistant-progress chunk for `messageId`, the Client's end of `streamProgress`. */
  @mesh()
  handleStreamChunk(messageId: string, progress: string, replyTo?: string): void {
    this.#resources.handleStreamChunk(messageId, progress, replyTo);
  }

  // ─── A subscribe's result handlers, sent `onErrorOnly` ─────────────────────
  //
  // No `@mesh()`: each runs only as this client's own continuation, at the response door.

  onResourceSubscribeRefused(resourceType: string, resourceId: string, result?: unknown): void {
    this.#resources.onResourceSubscribeRefused(resourceType, resourceId, result);
  }

  onQuerySubscribeRefused(queryHash: string, result?: unknown): void {
    this.#resources.onQuerySubscribeRefused(queryHash, result);
  }

  onRosterSubscribeRefused(queryHash: string, result?: unknown): void {
    this.#resources.onRosterSubscribeRefused(queryHash, result);
  }

  // No onBeforeCall override — NebulaClient inherits MeshClient's default, which refuses a call
  // whose immediate caller is another client and accepts DO/Worker-mediated pushes (Star fanout,
  // transaction/read result). That default is the ONLY check on a call from another tab: the host
  // node's `requirePassageIntoSender` checks a node sender's passage and leaves a client sender to
  // this class. An override added here MUST call super.onBeforeCall().
}
