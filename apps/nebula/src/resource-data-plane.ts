/**
 * ResourceDataPlane — the composable resource data-plane capability.
 *
 * Lifted out of `Star` (Child 1 of the multi-user chat thread) so it can be
 * composed by ANY Nebula node that needs to host Resources — `Star` today,
 * `DevStudio` next (chat `Session`/`Turn` Resources). ADR-007: composition,
 * never reimplemented.
 *
 * It owns the data-plane trio — `DagTree` + `Resources` + `Subscriptions` — and
 * **Handler 2** (the actual resource op + result-delivery + the mutation
 * broadcast). It deliberately does NOT own:
 *   - **Handler 1 / the ontology-version gate** — Galaxy's multi-version concern,
 *     stays per-host (Star gates; DevStudio's single fixed ontology is never
 *     stale). See `nebula-devstudio-data-plane.md` D8.
 *   - **mesh I/O construction** — the capability has no `this.lmz`/`this.ctn`
 *     (like `Resources`/`DagTree`, which is why they take `()=>callContext`).
 *     All continuation construction stays host-side, reached via the injected
 *     {@link ResourceHostBridge}.
 *   - **the ontology source** — reached only via the injected {@link OntologyProvider}
 *     (Star: Galaxy-cached row; DevStudio: a compiled platform constant), so the
 *     capability never couples to Galaxy.
 */

import { debug } from '@lumenize/debug';
import type { CallContext } from '@lumenize/mesh';
import type { ParserValidator } from '@lumenize/ts-runtime-parser-validator';
import { DagTree } from './dag-tree';
import { Resources } from './resources';
import { Subscriptions } from './subscriptions';
import type { OperationDescriptor, TransactionResult, Snapshot } from './resources';

/**
 * Supplies the active ontology `{ version, facet }` for resource ops — the only
 * way the capability learns about the ontology (it never fetches it itself).
 * Star's impl reads the Galaxy-cached row; DevStudio's compiles the in-source
 * `Session`/`Turn` types. `version` is stamped into snapshot metadata and is
 * therefore server-sourced, never client-supplied.
 */
export type OntologyProvider = () => { version: string; facet: ParserValidator };

/** A single fanout destination — `{ bindingName, instanceName }` (the Gateway + clientId). */
export interface BroadcastTarget {
  bindingName: string;
  instanceName: string;
}

/**
 * Host-side mesh I/O the data-plane invokes. The host DO (Star/DevStudio)
 * implements each method with its own `this.lmz`/`this.ctn`/`this.svc`, so every
 * continuation is constructed host-side (ADR-007 / review m1). Delivery targets
 * the originating client via the `NEBULA_CLIENT_GATEWAY` binding; broadcast
 * targets carry their own per-subscriber binding.
 */
export interface ResourceHostBridge {
  deliverTransactionResult(clientId: string, result: TransactionResult | Error): void;
  deliverReadResponse(clientId: string, requestId: string, result: Snapshot | null | Error): void;
  deliverResourceUpdate(
    clientId: string,
    resourceType: string,
    resourceId: string,
    result: Snapshot | Error,
  ): void;
  /** Fan a committed mutation out to `targets` (originator already excluded). The
   *  host owns the `svc.broadcast` call + its drop-on-failed-fanout cleanup. */
  broadcastResourceUpdate(resourceId: string, snapshot: Snapshot, targets: BroadcastTarget[]): void;
}

export class ResourceDataPlane {
  #getOntology: OntologyProvider;
  #bridge: ResourceHostBridge;
  #dagTree: DagTree;
  #resources: Resources;
  #subscriptions: Subscriptions;

  constructor(
    ctx: DurableObjectState,
    getCallContext: () => CallContext,
    getOntology: OntologyProvider,
    bridge: ResourceHostBridge,
    onDagChanged: () => void,
  ) {
    this.#getOntology = getOntology;
    this.#bridge = bridge;
    this.#dagTree = new DagTree(ctx, getCallContext, onDagChanged);
    this.#resources = new Resources(ctx, getCallContext, this.#dagTree);
    this.#subscriptions = new Subscriptions(ctx, getCallContext, this.#dagTree, this.#resources);
  }

  /** The composed DAG tree — the host's `@mesh dagTree()` entry returns this. */
  get dagTree(): DagTree {
    return this.#dagTree;
  }

  /** Drop all subscriber rows (deploy/ontology-install cleanup). Star's
   *  host-retained `#installState` calls this on a new-version install. */
  clearSubscribers(): Array<{ subscriberBinding: string; clientId: string }> {
    return this.#subscriptions.clear();
  }

  /** Drop one subscriber row — the host's broadcast-result handler calls this on
   *  a `ClientDisconnectedError` (drop-on-failed-fanout cleanup). */
  removeSubscriber(resourceId: string, clientId: string): void {
    this.#subscriptions.removeSubscriber(resourceId, clientId);
  }

  // ─── Handler 2 (the actual op + delivery) ──────────────────────────

  /** Execute a transaction at the host's current ontology version + deliver the
   *  result. Committed mutations fan out via the bridge (originator excluded). */
  async doTransaction(
    newETag: string,
    ops: Record<string, OperationDescriptor>,
    clientId: string,
  ): Promise<void> {
    try {
      const { version, facet } = this.#getOntology();
      const result = await this.#resources.transaction(ops, version, newETag, facet,
        (mutations) => this.#broadcast(mutations, clientId));
      this.#bridge.deliverTransactionResult(clientId, result);
    } catch (err) {
      debug('nebula.ResourceDataPlane.doTransaction').error('handler threw', {
        clientId,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      this.#bridge.deliverTransactionResult(clientId, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Read a resource (DAG read-permission enforced in `Resources.read`) + deliver. */
  doRead(resourceId: string, requestId: string, clientId: string): void {
    try {
      const snapshot = this.#resources.read(resourceId);
      this.#bridge.deliverReadResponse(clientId, requestId, snapshot);
    } catch (err) {
      debug('nebula.ResourceDataPlane.doRead').error('handler threw', {
        clientId,
        resourceId,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      this.#bridge.deliverReadResponse(clientId, requestId, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Register a subscriber (subscribe-time DAG read check + existence/type checks
   *  in `Subscriptions.subscribe`) + push the initial snapshot. */
  doSubscribe(
    resourceType: string,
    resourceId: string,
    clientId: string,
    subscriberBinding: string,
  ): void {
    try {
      const snapshot = this.#subscriptions.subscribe(resourceType, resourceId, clientId, subscriberBinding);
      this.#bridge.deliverResourceUpdate(clientId, resourceType, resourceId, snapshot);
    } catch (err) {
      debug('nebula.ResourceDataPlane.doSubscribe').error('handler threw', {
        clientId,
        resourceType,
        resourceId,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      this.#bridge.deliverResourceUpdate(clientId, resourceType, resourceId,
        err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Resource-mutation broadcast — invoked from `Resources.transaction` via the
   * `onMutations` callback after a successful commit. Looks up subscribers per
   * mutated resource, excludes the originator, and hands the target set to the
   * host bridge for the actual `svc.broadcast`.
   *
   * Per the pinned subscribe-time-only guard semantics, we do NOT re-check DAG
   * read permission per subscriber per push (Child 2 closes this — Open Q2).
   */
  #broadcast(mutations: Map<string, Snapshot>, originatorClientId: string): void {
    for (const [resourceId, snapshot] of mutations) {
      const subscribers = this.#subscriptions.forResource(resourceId);
      const targets = subscribers
        .filter((sub) => sub.clientId !== originatorClientId)
        .map((sub) => ({ bindingName: sub.subscriberBinding, instanceName: sub.clientId }));
      this.#bridge.broadcastResourceUpdate(resourceId, snapshot, targets);
    }
  }
}
