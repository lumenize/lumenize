/**
 * ResourceDataPlane — the composable resource data-plane capability.
 *
 * Lifted out of `Star` (Child 1 of the multi-user chat thread) so it can be
 * composed by ANY Nebula node that needs to host Resources — `Star` today,
 * the Galaxy (chat `Session`/`Message` Resources). ADR-007: composition,
 * never reimplemented.
 *
 * It owns the data-plane trio — `DagTree` + `Resources` + `Subscriptions` — and
 * **Handler 2** (the actual resource op + result-delivery + the mutation
 * broadcast). It deliberately does NOT own:
 *   - **Handler 1 / the ontology-version gate** — Galaxy's multi-version concern,
 *     stays per-host (Star gates; the Galaxy's fixed pre-Phase-2 ontology is never
 *     stale). See `nebula-devstudio-data-plane.md` D8.
 *   - **mesh I/O construction** — the capability has no `this.lmz`/`this.ctn`
 *     (like `Resources`/`DagTree`, which is why they take `()=>callContext`).
 *     All continuation construction stays host-side, reached via the injected
 *     {@link ResourceHostBridge}.
 *   - **the ontology source** — reached only via the injected {@link OntologyProvider}
 *     (Star: Galaxy-cached row; Galaxy: a compiled platform constant), so the
 *     capability never couples to Galaxy.
 */

import { debug } from '@lumenize/debug';
import type { CallContext } from '@lumenize/mesh';
import type { ParserValidator, TypeMetadata } from '@lumenize/ts-runtime-parser-validator';
import type { InviteSummary, InviteeError } from '@lumenize/nebula-auth';
import type { PermissionTier } from './dag-ops';
import { DagTree } from './dag-tree';
import { Resources } from './resources';
import { Subscriptions } from './subscriptions';
import { QuerySubs } from './query-subscriptions';
import type { QuerySubscriberRow } from './query-subscriptions';
import { QuerySubscriberListSubs } from './query-subscriber-list-subs';
import { canonicalQueryHash } from './query-hash';
import type { QueryDescriptor, QueryUpdatePayload, SubscriberEntry } from './query-hash';
import { parse } from '@lumenize/structured-clone';
import type { OperationDescriptor, TransactionResult, Snapshot } from './resources';

/**
 * Supplies the active ontology `{ version, facet, relationships }` for resource
 * ops — the only way the capability learns about the ontology (it never fetches
 * it itself). Star's impl reads the Galaxy-cached row; the Galaxy's compiles the
 * in-source `Session`/`Message` types. `version` is stamped into snapshot metadata
 * and is therefore server-sourced, never client-supplied.
 *
 * `relationships` is the compiled ontology's relationship metadata
 * (`Record<typeName, Record<field, Relationship>>`) — needed by `subscribeQuery`
 * (Child 2) to validate that a query's `field` exists on `typeName` and is a
 * to-one relationship (D11/D1). Widened from Child 1's `{ version, facet }`; both
 * providers already produce it (the Galaxy-cached row carries it; the Galaxy's
 * `compileOntologyVersion` emits it).
 */
export type OntologyProvider = () => {
  version: string;
  facet: ParserValidator;
  relationships: TypeMetadata['relationships'];
};

/** A single fanout destination — `{ bindingName, instanceName }` (the Gateway + clientId). */
export interface BroadcastTarget {
  bindingName: string;
  instanceName: string;
}

/** One requested node invitee: the address, and the DAG tier to grant at the node. */
export interface NodeInvitee { email: string; tier: PermissionTier }

/** {@link ResourceDataPlane.invite}'s synchronous ack — SUBMISSION outcomes only (a true delivery
 *  failure is out-of-band and arrives hours later, when no tab is listening); everything downstream
 *  lands in `_InviteStatus` rows the members panel query-subscribes. */
export interface NodeInviteAck { accepted: number; errors: InviteeError[] }

/** The DAG tier vocabulary, as a runtime gate — mesh args are compile-time typed but
 *  runtime-unchecked, and `invite`'s eventual caller is Studio-GENERATED app code (ADR-001: the
 *  mesh method is the validation boundary). */
const PERMISSION_TIERS: ReadonlySet<string> = new Set(['admin', 'write', 'read']);

/** Structural email gate — non-empty local part, `@`, non-empty domain (the same hand-rolled shape
 *  the Registry re-checks; a failure here is a per-invitee error, never a whole-batch one). */
function isValidInviteEmail(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  const at = email.indexOf('@');
  return at > 0 && at < email.length - 1;
}

/**
 * Host-side mesh I/O the data-plane invokes. The host DO (Star/Galaxy)
 * implements each method with its own `this.lmz`/`this.ctn`/`this.svc`, so every
 * continuation is constructed host-side (ADR-007 / review m1). Delivery targets
 * the originating client via the `NEBULA_CLIENT_GATEWAY` binding; broadcast
 * targets carry their own per-subscriber binding.
 */
export interface ResourceHostBridge {
  deliverResourceUpdate(
    clientId: string,
    resourceType: string,
    resourceId: string,
    result: Snapshot | Error,
  ): void;
  /** Fan a committed mutation out to `targets` (originator already excluded). The
   *  host owns the `svc.broadcast` call + its drop-on-failed-fanout cleanup. */
  broadcastResourceUpdate(resourceId: string, snapshot: Snapshot, targets: BroadcastTarget[]): void;
  /** Fan a query membership push to the NO-DENIAL group — one identical payload
   *  (the full `resourceIds`) via `svc.broadcast` (D4/D17). Attaches the 4-arg
   *  `onResult` so dead-client cleanup reaps these rows too (m6). */
  broadcastQueryUpdate(queryHash: string, resourceIds: string[], targets: BroadcastTarget[]): void;
  /** Deliver an INDIVIDUALIZED query push to one has-denial subscriber (always
   *  carries `deniedNodes`; `resourceIds` iff `onPartial:'allow'` — D4/D14), or an
   *  Error (validation failure). Also `onResult`-cleaned (m6). */
  deliverQueryUpdate(clientId: string, queryHash: string, result: QueryUpdatePayload | Error): void;
  /** Fan a subscriber-list roster (the query's distinct-by-`sub` `{ sub, profileId }` set) to its
   *  WATCHERS — on any data-subscriber join/leave. `svc.broadcast`; drop-on-failed-fanout cleanup rides
   *  the DEDICATED `onQuerySubscriberListBroadcastResult` (the WATCHER table, NOT `QuerySubscribers`).
   *  tasks/nebula-subscriber-lists.md. */
  broadcastRosterUpdate(queryHash: string, roster: SubscriberEntry[], targets: BroadcastTarget[]): void;
  /** Deliver the current roster to ONE joining WATCHER (its initial `subscribeQuerySubscribers` snapshot),
   *  or an Error (fail-closed on an invalid query). Single-target; dedicated-reap `onResult`-cleaned. */
  deliverRosterUpdate(clientId: string, queryHash: string, result: SubscriberEntry[] | Error): void;
}

export class ResourceDataPlane {
  #getOntology: OntologyProvider;
  #bridge: ResourceHostBridge;
  #dagTree: DagTree;
  #resources: Resources;
  #subscriptions: Subscriptions;
  #querySubs: QuerySubs;
  #querySubscriberListSubs: QuerySubscriberListSubs;

  /**
   * @param getHostName - The host DO's own instance name, as a **thunk**. Required: it is the scope
   *   the `access.scopeAdmin` bypass is confined to (`hasDominionOver`), at both confinement points —
   *   `DagTree.requirePermission` (live claim) and the two subscribe-time writers (stored verdict).
   *   ⚠️ **Must be lazy.** `ResourceDataPlane` is constructed in the host's `onStart()`, where
   *   `this.lmz.instanceName` is not yet stamped; `Star.resetDevData` also re-runs `onStart()` after
   *   a `deleteAll()` that wipes the identity key. A captured value would be permanently `undefined`
   *   for that isolate — and since the guards fail closed on an absent name, every first-touch call
   *   would be denied. Mirror `getCallContext`, which is lazy for the same reason.
   */
  constructor(
    ctx: DurableObjectState,
    getCallContext: () => CallContext,
    getOntology: OntologyProvider,
    bridge: ResourceHostBridge,
    onDagChanged: () => void,
    getHostName: () => string | undefined,
  ) {
    this.#getOntology = getOntology;
    this.#bridge = bridge;
    // The capability hangs the Flow-3 trigger B rerun off DagTree's onChanged,
    // IN ADDITION to the host's hook (Star's org-tree broadcast / the Galaxy's no-op).
    // A permission change reruns ALL live queries (a grant changes readability across
    // every type → no typeName filter); cheap at v1 scale, no drops. The host
    // hook runs first, then the query rerun. (Fires only AFTER construction — on a
    // real DAG mutation — so `#querySubs`, assigned below, always exists by then.)
    this.#dagTree = new DagTree(ctx, getCallContext, () => {
      onDagChanged();
      this.#rerunQueries(() => true);
    }, getHostName);
    this.#resources = new Resources(ctx, getCallContext, this.#dagTree);
    this.#subscriptions = new Subscriptions(ctx, getCallContext, this.#dagTree, this.#resources, getHostName);
    this.#querySubs = new QuerySubs(ctx, getCallContext, this.#dagTree, this.#resources, getHostName);
    this.#querySubscriberListSubs = new QuerySubscriberListSubs(ctx);
  }

  /** The composed DAG tree — the host's `@mesh dagTree()` entry returns this. */
  get dagTree(): DagTree {
    return this.#dagTree;
  }

  // ─── Node invites (two-plane: the DAG grant here, the membership via the facade) ────────

  /**
   * Invite people onto a NODE — the two-plane operation, written ONCE for every host
   * (Star + Galaxy) so the security logic cannot fork: it initiates here, where the
   * inviter's authority lives (`requirePermission`: `admin` at `nodeId` — the only authz
   * decision on this path, because the facade cannot evaluate a DAG grant by design),
   * writes `pending` `_InviteStatus` rows locally, fires the membership mint through the
   * host-supplied `fireInvite`, and returns the ack. The result handler
   * ({@link onInviteResult}) writes the `setPermission` grants and flips each row to
   * `sent`/`submission-failed` — so the two planes are both written at INVITE time, and
   * the invitee's first login finds everything in place (no login-time sequencing).
   *
   * `fireInvite` is the ONE host-typed piece — the capability has no `this.lmz`/`this.ctn`
   * (mesh I/O construction stays host-side, like the {@link ResourceHostBridge}), so the
   * host builds the facade call with its OWN result continuation and passes it in. It is
   * invoked only when at least one invitee survived validation.
   *
   * Batch semantics: one `nodeId` per call (one `requirePermission` licenses the whole
   * batch), `tier` per invitee, a malformed email joins the per-invitee errors without
   * failing the batch — but an out-of-vocabulary `tier` refuses the WHOLE call before any
   * side effect (a grant vocabulary error is a caller bug, not a per-address condition).
   *
   * The facade call requests NO `scopeAdmin` bit — the cap rule in its degenerate form: a
   * node inviter's authority is a DAG grant, and the `tier` parameter governs the DAG
   * grant only. Convergence: one `_InviteStatus` row per (email, node) — a re-invite
   * converges on the existing row (fresh `tier`, back to `pending`) rather than
   * duplicating, so a second admin sees one coherent state (ADR-008 org-visibility).
   *
   * Precondition: the host must hold a WORKING ontology — the `_InviteStatus` rows ride
   * the ordinary Resources pipeline, so this fails closed (before the facade fires) on a
   * host that has never had one.
   */
  async invite(
    nodeId: string,
    invitees: NodeInvitee[],
    fireInvite: (valid: NodeInvitee[]) => void,
  ): Promise<NodeInviteAck> {
    // ── The ADR-001 boundary: shape-check what the wire cannot. Whole-call refusals carry their
    // own messages, each distinguishable from the DAG refusal (`PermissionDeniedError`'s
    // "admin permission required on node …") and from every facade refusal.
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      throw new Error('Invalid node invite: nodeId must be a node id string');
    }
    if (!Array.isArray(invitees)) {
      throw new Error('Invalid node invite: invitees must be an array');
    }
    const errors: InviteeError[] = [];
    const valid: NodeInvitee[] = [];
    for (const entry of invitees) {
      if (entry === null || typeof entry !== 'object') {
        errors.push({ email: '', error: 'Invalid invitee entry' });
        continue;
      }
      const { email, tier } = entry as { email: unknown; tier: unknown };
      if (!PERMISSION_TIERS.has(tier as string)) {
        // BEFORE any mint or send side effect, deliberately whole-call — see the JSDoc.
        throw new Error(`Invalid node invite: tier "${String(tier)}" is not one of admin | write | read`);
      }
      if (!isValidInviteEmail(email)) {
        errors.push({ email: typeof email === 'string' ? email : '', error: 'Invalid email format' });
        continue;
      }
      // Normalize exactly as the Registry does — the handler's tier lookup keys on the summary's
      // normalized address, so the two sides must agree.
      valid.push({ email: email.toLowerCase().trim(), tier: tier as PermissionTier });
    }

    // The DAG gate at the door — one check licenses the whole batch.
    this.#dagTree.requirePermission(nodeId, 'admin');

    if (valid.length > 0) {
      // `pending` rows, converged on (email, node) — through the ordinary transaction path, so
      // validation, `actingToken` attribution (the inviter, `act` chain included) and subscriber
      // fan-out all apply. Server-side write → no originating client to exclude ('').
      const ops: Record<string, OperationDescriptor> = {};
      for (const v of valid) {
        const existing = this.#findInviteStatus(nodeId, v.email);
        const value = { node: nodeId, email: v.email, tier: v.tier, state: 'pending' };
        if (existing) {
          ops[existing.resourceId] = { op: 'put', eTag: existing.meta.eTag, value };
        } else {
          ops[crypto.randomUUID()] = { op: 'create', nodeId, typeName: '_InviteStatus', value };
        }
      }
      const written = await this.doTransaction(crypto.randomUUID(), ops, '');
      if (!written.ok) {
        // Unreachable through this method's own inputs (the ops were just derived from current
        // rows under the input gate) — surface loudly rather than half-invite.
        throw new Error(`node invite could not record its pending state: ${JSON.stringify(written.errors)}`);
      }

      // Fire the membership mint through the ONE issuing entry, receiving the outcome in the
      // host's TRAVELING handler (two one-way calls): the slow email I/O runs on the CPU-billed
      // facade Worker while the host DO's input gates stay closed, and the handler runs on a
      // cold, storage-restored host if this one was evicted. `callContext` (the inviter's
      // verified claims) propagates across the hop, so the facade's eligibility + the
      // Registry's ADR-016 record see the real acting principal.
      fireInvite(valid);
    }
    return { accepted: valid.length, errors };
  }

  /**
   * The node invite's result handler — the body behind each host's traveling
   * continuation (never awaited), so it survives the host's eviction and the inviter's
   * disconnect. Writes the second plane: `setPermission` at the node for every minted
   * `sub` (already-member outcomes included — that is what heals the one reachable
   * two-plane inconsistency, a membership without its grant), then flips each
   * `_InviteStatus` row to `sent`/`submission-failed`.
   *
   * ⚠️ The host's forward MUST be `public` and NOT `@mesh()` — the fire-back lands via
   * `__handleResponse` (allowlist off, scope-check on), and an `@mesh` there would let
   * any in-scope caller forge an invite outcome and write themselves grants. The whole
   * body is wrapped: an uncaught throw in a fire-back handler is silently lost, so
   * failures are logged with identifiers only.
   */
  async onInviteResult(
    nodeId: string, tiers: Record<string, PermissionTier>, result?: unknown,
  ): Promise<void> {
    const log = debug('nebula.ResourceDataPlane.invite');
    try {
      if (result instanceof Error) {
        // The whole submission failed (facade refusal or infra) — every pending row flips.
        // ⚠️ DEFENSIVE, with no honest in-lane producer today (testing.md's hard-to-reach
        // exception): the host pre-validates with the same email gate the Registry re-runs, sends
        // no bit for the cap to breach on, and its caller passed `requirePermission` — so reaching
        // here requires an infrastructure failure or a facade eligibility change. What replaces
        // the test is that the event announces itself below and the flip is visible org-wide.
        await this.#flipInviteStatuses(nodeId, Object.keys(tiers).map((email) =>
          ({ email, state: 'submission-failed', error: result.message })));
        log.warn('node invite submission failed', { nodeId, error: result.message });
        return;
      }
      const summary = result as InviteSummary;
      // The grants FIRST — they are the operation's point; the flips are reporting. Runs under the
      // response-leg callContext (the inviter's claims), so `setPermission`'s own `admin` gate
      // re-checks the same principal `requirePermission` admitted at the door.
      for (const r of summary.results) {
        const tier = tiers[r.email];
        if (!tier) {
          // A summary row for an address this call never sent — an invariant breach, not a grant.
          log.error('node invite summary named an unrequested address — no grant written', { nodeId });
          continue;
        }
        this.#dagTree.setPermission(nodeId, r.sub, tier);
      }
      await this.#flipInviteStatuses(nodeId, [
        ...summary.results.map((r) => ({ email: r.email, state: 'sent' as const })),
        ...summary.errors.map((e) => ({ email: e.email, state: 'submission-failed' as const, error: e.error })),
      ]);
    } catch (err) {
      // Never rethrow — a fire-back handler's throw vanishes. Identifiers only.
      log.error('node invite result handling failed', {
        nodeId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The CURRENT `_InviteStatus` row for (email, node), or null — the convergence lookup. */
  #findInviteStatus(nodeId: string, email: string): (Snapshot & { resourceId: string }) | null {
    for (const { resourceId } of this.findCurrentByField('_InviteStatus', 'node', nodeId)) {
      const snapshot = this.doRead(resourceId);
      if (snapshot && (snapshot.value as { email?: string }).email === email) {
        return { ...snapshot, resourceId };
      }
    }
    return null;
  }

  /** Flip each (email, node) row's `state` (+ optional `error`), subscriber fan-out included.
   *  PER-ROW transactions, deliberately — the rows are independent, and one atomic batch would let
   *  a single stale eTag (a concurrent re-invite converging that address mid-flight) void the
   *  SIBLING invitees' flips, stranding them at `pending` with only a warn to show for it. A row
   *  that vanished or moved on (converged by a newer writer) is skipped: that writer owns its
   *  state. */
  async #flipInviteStatuses(
    nodeId: string,
    flips: Array<{ email: string; state: 'sent' | 'submission-failed'; error?: string }>,
  ): Promise<void> {
    for (const flip of flips) {
      const existing = this.#findInviteStatus(nodeId, flip.email);
      if (!existing) continue;
      const value = {
        ...(existing.value as Record<string, unknown>),
        state: flip.state,
        ...(flip.error !== undefined ? { error: flip.error } : {}),
      };
      if (flip.error === undefined) delete (value as Record<string, unknown>).error;
      const written = await this.doTransaction(crypto.randomUUID(), {
        [existing.resourceId]: { op: 'put', eTag: existing.meta.eTag, value },
      }, '');
      if (!written.ok) {
        debug('nebula.ResourceDataPlane.invite').warn('an _InviteStatus flip did not apply (a newer writer owns the row)', {
          nodeId, resourceId: existing.resourceId,
        });
      }
    }
  }

  /**
   * Permission-filtered fanout targets for a live query's current subscribers —
   * the subscriber connections that hold `read` on `nodeId` right now. Exposed so
   * a host can push a **transient** signal to a query's audience WITHOUT a Resource
   * write (Child 3 option (b): the Galaxy's assistant progress/thought stream fans to
   * the session query's subscribers, then commits ONE durable Message). The capability
   * owns targeting + the `access.scopeAdmin`-aware read recheck (never re-implemented
   * host-side, D3/D16); the host owns delivery via its own `this.svc.broadcast`.
   *
   * Per-CONNECTION (one entry per subscribed tab, no dedup by `sub`) — every open tab
   * is a delivery target. `nodeId` is the node the transient content will live under
   * (e.g. the node the assistant Message will be created at), so delivery honors the
   * same read gate the eventual committed Resource will. Returns `[]` when no
   * subscriber may read `nodeId` (the caller should skip the broadcast).
   */
  targetsForQuery(query: QueryDescriptor, nodeId: string): BroadcastTarget[] {
    return this.#querySubs
      .forQueryHash(canonicalQueryHash(query))
      .filter((r) =>
        this.#dagTree.evaluatePermissions([nodeId], 'read', r.sub, Boolean(r.dominionOverHostAtSubscribe)).allowed.size > 0)
      .map((r) => ({ bindingName: r.subscriberBinding, instanceName: r.clientId }));
  }

  // --- Subscriber-list roster (a query's live subscriber roster, delivered to WATCHERS —
  //     tasks/nebula-subscriber-lists.md) ---

  /**
   * The DISTINCT-by-`sub` roster for a query — a set of PEOPLE, not connections. `forQueryHash` returns
   * one row per connection (per tab), so dedup by `sub`, and a defined `profileId` never loses to an
   * absent one (M3). Advisory / display-only: carries no `dominionOverHostAtSubscribe`/permission data (ADR-008). Reused
   * verbatim from the presence build; the standalone reshape changed the AUDIENCE (watchers), not this.
   */
  #rosterFor(queryHash: string): SubscriberEntry[] {
    const bySub = new Map<string, SubscriberEntry>();
    for (const r of this.#querySubs.forQueryHash(queryHash)) {
      const existing = bySub.get(r.sub);
      if (!existing) bySub.set(r.sub, r.profileId != null ? { sub: r.sub, profileId: r.profileId } : { sub: r.sub });
      else if (existing.profileId == null && r.profileId != null) existing.profileId = r.profileId;
    }
    return [...bySub.values()];
  }

  /**
   * Roster delivery targets — one per WATCHER connection (a subscriber of the query's subscriber-LIST,
   * NOT a data-subscriber). Built from `QuerySubscriberListSubs.forQueryHash` with NO permission filter:
   * the roster is reachability-gated + uniform (ADR-008), so any reachable watcher gets the full roster.
   */
  #watcherTargets(queryHash: string): BroadcastTarget[] {
    return this.#querySubscriberListSubs
      .forQueryHash(queryHash)
      .map((r) => ({ bindingName: r.subscriberBinding, instanceName: r.clientId }));
  }

  /** Broadcast the current distinct-by-`sub` roster to a query's WATCHERS — fired ONLY on a genuine
   *  data-subscriber join (`isNewSub`) or an actual leave (`rowsWritten > 0`). A read-only projection of
   *  `QuerySubscribers` written to a SEPARATE watcher table, so it can never echo into the commit/rerun
   *  scan (echo-free by table-separation). */
  #broadcastRoster(queryHash: string): void {
    const targets = this.#watcherTargets(queryHash);
    if (targets.length === 0) return;
    this.#bridge.broadcastRosterUpdate(queryHash, this.#rosterFor(queryHash), targets);
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

  /** Drop all query-sub rows (ontology-install cleanup). Returns the distinct
   *  `(subscriberBinding, clientId)` pairs dropped so the host can UNION them with
   *  `clearSubscribers()` and push ONE `OntologyStaleError` per client (m1). */
  clearQuerySubscribers(): Array<{ subscriberBinding: string; clientId: string }> {
    return this.#querySubs.clear();
  }

  /** Drop all subscriber-list WATCHER rows (ontology-install cleanup). Returns the distinct
   *  `(subscriberBinding, clientId)` pairs dropped so the host UNIONs them into the SAME one-per-client
   *  `OntologyStaleError` signal as the two data registries (tasks/nebula-subscriber-lists.md). */
  clearWatchers(): Array<{ subscriberBinding: string; clientId: string }> {
    return this.#querySubscriberListSubs.clearWatchers();
  }

  /**
   * Register a WATCHER of `query`'s live subscriber-list roster (the standalone subscription — the watcher
   * is NOT a data-subscriber). Validates the query fail-closed (parity with `doSubscribeQuery`); on success
   * registers the watcher + delivers the CURRENT roster single-target to the joining watcher (its initial
   * snapshot). A watcher joining does NOT change roster content → no re-push to other watchers. Identity
   * (`clientId`/`subscriberBinding`) comes from the host wrapper (`callChain`), reachability-gated.
   */
  doSubscribeQuerySubscribers(query: QueryDescriptor, clientId: string, subscriberBinding: string): void {
    const queryHash = canonicalQueryHash(query);
    try {
      this.#validateQuery(query);
    } catch (err) {
      // Fail-closed: reject the watcher handle (Error keyed by queryHash) so a typo'd/malformed query
      // doesn't register a silent, permanently-empty watcher.
      debug('nebula.ResourceDataPlane.doSubscribeQuerySubscribers').warn('watcher query rejected', {
        queryHash, clientId, error: err instanceof Error ? err.message : String(err),
      });
      this.#bridge.deliverRosterUpdate(clientId, queryHash, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.#querySubscriberListSubs.registerWatcher(queryHash, clientId, subscriberBinding);
    debug('nebula.ResourceDataPlane.subscribers').debug('watch', { event: 'watch', queryHash, clientId });
    this.#bridge.deliverRosterUpdate(clientId, queryHash, this.#rosterFor(queryHash));
  }

  /** Drop one subscriber-list WATCHER row — `unsubscribeQuerySubscribers` + the host's DEDICATED
   *  roster-broadcast-result handler call this (the latter on a `ClientDisconnectedError`). Drops ONLY
   *  from the watcher table (NOT `QuerySubscribers`) and does NOT re-fire `#broadcastRoster`. */
  removeQuerySubscriberListWatcher(queryHash: string, clientId: string): void {
    this.#querySubscriberListSubs.removeWatcher(queryHash, clientId);
  }

  /** Drop one query-sub row — `unsubscribeQuery` + the host's query-broadcast-result
   *  handler call this (the latter on a `ClientDisconnectedError`, m6). On an ACTUAL
   *  removal (`rowsWritten > 0`) re-push the shrunk roster to the query's WATCHERS; a no-op remove
   *  (duplicate/late fire-back) emits nothing — the mass-disconnect-storm guard. */
  removeQuerySubscriber(queryHash: string, clientId: string): void {
    const removed = this.#querySubs.removeQuerySubscriber(queryHash, clientId);
    debug('nebula.ResourceDataPlane.subscribers').debug('remove', {
      event: 'remove', queryHash, clientId, mode: removed > 0 ? 'broadcast' : 'noop',
    });
    if (removed > 0) this.#broadcastRoster(queryHash);
  }

  /**
   * Server-internal **create-if-absent** (D-session): idempotently seed a fixed
   * platform Resource (the Galaxy's default `Session`) with NO client-facing result
   * delivery. A live snapshot already present → no-op. A first create still fans out
   * to any subscribers (mirrors {@link doTransaction}'s post-commit hook; originator
   * `''` — a server seed has no client origin). The caller must be in an authed
   * context with `write` on `nodeId`.
   *
   * ✅ **Confined, via the ordinary path — no special-casing here.** This method holds no admin
   * check of its own: it goes through `Resources.transaction` → `DagTree.requirePermission`, which
   * is confinement point 1. So the platform-seed path (the Galaxy's `ensureSession` running under
   * the admin's call) has passage **iff that admin's `authScope` covers THIS host** — the
   * same rule as every other caller. See tasks/nebula-confine-admin-bypass.md.
   */
  async ensureResource(
    resourceId: string, typeName: string, nodeId: string, value: Record<string, unknown>,
  ): Promise<void> {
    if (this.#resources.read(resourceId)) return; // idempotent: a live snapshot exists
    const { version, facet } = this.#getOntology();
    await this.#resources.transaction(
      { [resourceId]: { op: 'create', typeName, nodeId, value } },
      version, crypto.randomUUID(), facet,
      (mutations) => { this.#broadcast(mutations, ''); this.#rerunQueriesForCommit(mutations); },
    );
  }

  // ─── Handler 2 (the actual op + delivery) ──────────────────────────

  /** Execute a transaction at the host's current ontology version + deliver the
   *  result. Committed mutations fan out via the bridge (originator excluded). */
  async doTransaction(
    newETag: string,
    ops: Record<string, OperationDescriptor>,
    clientId: string,
  ): Promise<TransactionResult> {
    try {
      const { version, facet } = this.#getOntology();
      // RETURN the result — the framework fires it back to the originating client's `callAsync`
      // (D5 pattern (a)). The committed-mutation broadcasts to OTHER subscribers stay a fire-and-forget
      // side effect (originator excluded via `clientId`). An infra throw propagates → `callAsync` rejects.
      return await this.#resources.transaction(ops, version, newETag, facet,
        (mutations) => {
          // The single post-commit hook drives BOTH channels (Flow 2 + Flow 3 A):
          // single-resource content fanout, then the query rerun for touched types.
          this.#broadcast(mutations, clientId);
          this.#rerunQueriesForCommit(mutations);
        });
    } catch (err) {
      debug('nebula.ResourceDataPlane.doTransaction').error('handler threw', {
        clientId,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Read a resource (DAG read-permission enforced in `Resources.read`) and RETURN it — the framework
   *  fires the value back to the originating client's `callAsync` (D5 pattern (a)); a permission/not-found
   *  throw propagates → `callAsync` rejects. Logged for server-side observability, then re-thrown. */
  doRead(resourceId: string): Snapshot | null {
    try {
      return this.#resources.read(resourceId);
    } catch (err) {
      debug('nebula.ResourceDataPlane.doRead').error('handler threw', {
        resourceId,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Enumerate the CURRENT resources of `typeName` whose to-one relationship `field` equals
   *  `value` — the host-side twin of a `parentChild` query's evaluation, for host code that must
   *  CONVERGE on an existing row before writing (e.g. `Star.invite`'s one-`_InviteStatus`-row-per-
   *  (email, node) rule). Read-only; carries no permission gate of its own — the write that follows
   *  goes through `doTransaction`'s ordinary checks, and reads of the values go through `doRead`. */
  findCurrentByField(typeName: string, field: string, value: string): Array<{ resourceId: string; nodeId: string }> {
    return this.#resources.enumerateCurrentByField(typeName, field, value);
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

  // ─── Query subscriptions (Child 2) ─────────────────────────────────

  /**
   * Register a query subscriber (Flow 1) + push the initial membership state.
   * **Registration always succeeds** — no permission check (authorize at delivery,
   * D2/D4) — but the query is FIRST validated against the ontology contract
   * (`queryType` known, `field` a to-one relationship, `orderBy` supported, D1/D12).
   * On a validation failure NOTHING is registered and the error is delivered to the
   * client keyed by the (locally-computed) `queryHash` so its handle rejects (an
   * unknown `queryType` thus fails CLOSED). On success the membership-delivery
   * routine runs scoped to JUST this new subscriber.
   */
  doSubscribeQuery(query: QueryDescriptor, clientId: string, subscriberBinding: string): void {
    try {
      this.#validateQuery(query);
    } catch (err) {
      const queryHash = canonicalQueryHash(query);
      debug('nebula.ResourceDataPlane.doSubscribeQuery').warn('query rejected', {
        clientId, queryType: query.queryType, typeName: query.typeName, field: query.field,
        error: err instanceof Error ? err.message : String(err),
      });
      this.#bridge.deliverQueryUpdate(clientId, queryHash,
        err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const { row, queryHash, isNewSub } = this.#querySubs.registerQuerySubscriber(query, clientId, subscriberBinding);
    // Initial push — scoped to the one new subscriber (mirrors single-resource
    // subscribe, which pushes the first snapshot rather than returning it).
    this.#broadcastQueries(query, [row]);
    // Subscriber-list roster: a data-subscriber join that is a distinct-by-`sub` GAIN (`isNewSub`) grew
    // the roster → re-push it to the query's WATCHERS. A non-`isNewSub` join (reconnect / 2nd tab of an
    // already-present `sub`) did NOT change the roster → fire NOTHING (no else-push: the joining
    // DATA-subscriber is not a watcher and has no binding for a roster; the reconnect-storm guard +
    // Decision 1's roster⇒watchers-only — tasks/nebula-subscriber-lists.md).
    debug('nebula.ResourceDataPlane.subscribers').debug('subscribe', {
      event: 'subscribe', queryHash, clientId, mode: isNewSub ? 'broadcast' : 'noop',
    });
    if (isNewSub) this.#broadcastRoster(queryHash);
  }

  /**
   * Validate a query against the ontology contract (D1/D12). Throws on:
   *   - an unknown `queryType` (v1 supports only `'parentChild'` — fail closed so an
   *     app on a newer type gets a clean error, not garbage);
   *   - a `field` that isn't a to-one relationship on `typeName` (per the seam's
   *     `relationships` metadata, D11);
   *   - an unsupported `orderBy` (v1 only `'validFrom'`, D15).
   */
  #validateQuery(query: QueryDescriptor): void {
    if (query.queryType !== 'parentChild') {
      throw new Error(`Unsupported queryType '${query.queryType}' — v1 supports only 'parentChild'`);
    }
    const rels = this.#getOntology().relationships;
    const rel = rels[query.typeName]?.[query.field];
    if (!rel || rel.cardinality !== 'one') {
      throw new Error(
        `Query field '${query.typeName}.${query.field}' must be a to-one relationship`,
      );
    }
    if (query.orderBy !== undefined && query.orderBy !== 'validFrom') {
      throw new Error(`Unsupported orderBy '${query.orderBy}' — v1 supports only 'validFrom'`);
    }
  }

  /**
   * The one queryType-specific step (D-generic routine): evaluate a query to its
   * current ordered result set. v1 `parentChild` → `enumerateCurrentByField` over
   * current snapshots (full scan while D8 defers the index, M1).
   */
  #evaluateQuery(query: QueryDescriptor): Array<{ resourceId: string; nodeId: string }> {
    return this.#resources.enumerateCurrentByField(query.typeName, query.field, query.value);
  }

  /**
   * The single membership-delivery primitive (generic over `queryType`) — called by
   * Flow 1 (the one new subscriber) and Flow 3 (each query's subscribers, on commit
   * or permission change). Evaluates the query to its current result set, evaluates
   * each target's read permission (no short-circuit), then PARTITIONS:
   *   - **no-denial** targets (can read every match) share ONE identical payload
   *     (the full `resourceIds`) → `bridge.broadcastQueryUpdate` (svc.broadcast);
   *   - **has-denial** targets each get an individualized `bridge.deliverQueryUpdate`
   *     per their own `onPartial` (read from the stored query — `onPartial` is NOT
   *     in the queryHash, so co-`queryHash` subscribers may differ, D2/M3): `'allow'`
   *     → `{ resourceIds (readable), deniedNodes }`; `'error'` → `{ deniedNodes }`.
   * The client REPLACES its set on every push (idempotent, self-healing — no delta).
   */
  #broadcastQueries(query: QueryDescriptor, targets: QuerySubscriberRow[]): void {
    if (targets.length === 0) return;
    const queryHash = canonicalQueryHash(query);
    const matches = this.#evaluateQuery(query); // ordered by (validFrom, resourceId)
    const allResourceIds = matches.map((m) => m.resourceId);
    const matchNodeIds = matches.map((m) => m.nodeId);

    const noDenial: QuerySubscriberRow[] = [];
    for (const t of targets) {
      const { allowed, denied } = this.#dagTree.evaluatePermissions(
        matchNodeIds, 'read', t.sub, Boolean(t.dominionOverHostAtSubscribe),
      );
      if (denied.size === 0) {
        noDenial.push(t);
        continue;
      }
      // Has-denial → individualized. onPartial is read PER TARGET (not in the hash).
      const onPartial = (parse(t.query) as QueryDescriptor).onPartial ?? 'allow';
      const deniedNodes = [...denied];
      const result: QueryUpdatePayload = onPartial === 'allow'
        ? { resourceIds: matches.filter((m) => allowed.has(m.nodeId)).map((m) => m.resourceId), deniedNodes }
        : { deniedNodes };
      this.#bridge.deliverQueryUpdate(t.clientId, queryHash, result);
    }

    if (noDenial.length > 0) {
      const noDenialTargets = noDenial.map((t) => ({ bindingName: t.subscriberBinding, instanceName: t.clientId }));
      this.#bridge.broadcastQueryUpdate(queryHash, allResourceIds, noDenialTargets);
    }
  }

  /**
   * Flow 3 trigger A (on commit): rerun every live query whose `typeName` was
   * touched by the commit, re-pushing its full membership. The query channel
   * re-delivers by RERUNNING queries (not by mapping mutations to resources) — an
   * unchanged result is replaced with itself (a client-side no-op). Reruns more than
   * strictly necessary on purpose (the affected-resource filter + deltas are deferred,
   * over-the-wire cost dominates). A mutation to an unrelated `typeName` triggers NO
   * push here (the touched-type filter). `onMutations` provides the touched snapshots.
   */
  #rerunQueriesForCommit(mutations: Map<string, Snapshot>): void {
    const touched = new Set<string>();
    for (const snap of mutations.values()) touched.add(snap.meta.typeName);
    this.#rerunQueries((q) => touched.has(q.typeName));
  }

  /**
   * Rerun the live queries matching `shouldRerun`, grouped by `queryHash` (all rows
   * sharing a hash are one query + its subscribers). Selection is a SCAN of the
   * (small) subscription table (D8 — a decomposed-column index is the deferred
   * optimization), not a per-mutation match. Shared by the commit trigger (filter by
   * touched type, Phase 4) and the permission-change trigger (all live queries,
   * Phase 5 / D6).
   */
  #rerunQueries(shouldRerun: (q: QueryDescriptor) => boolean): void {
    const groups = new Map<string, { query: QueryDescriptor; rows: QuerySubscriberRow[] }>();
    for (const row of this.#querySubs.all()) {
      let g = groups.get(row.queryHash);
      if (!g) {
        g = { query: parse(row.query) as QueryDescriptor, rows: [] };
        groups.set(row.queryHash, g);
      }
      g.rows.push(row);
    }
    for (const { query, rows } of groups.values()) {
      if (shouldRerun(query)) this.#broadcastQueries(query, rows);
    }
  }

  /**
   * Resource-mutation broadcast — invoked from `Resources.transaction` via the
   * `onMutations` callback after a successful commit. Looks up subscribers per
   * mutated resource, excludes the originator, and hands the target set to the
   * host bridge for the actual `svc.broadcast`.
   *
   * D3 (Child 2): a per-push DAG read recheck closes the subscribe-time-only gap
   * Child 1 carried into the capability. A subscriber who lost read since
   * subscribing is SKIPPED for this push — never dropped (ADR-008 / D5; readable
   * state returns via the Flow-3 permission rerun when access does). The recheck
   * is an explicit-sub `evaluatePermissions` honoring the row's stored
   * `dominionOverHostAtSubscribe` (the `access.scopeAdmin` bypass, D16), NOT the live caller's
   * `requirePermission`. Closing it in the capability protects Star AND Galaxy.
   */
  #broadcast(mutations: Map<string, Snapshot>, originatorClientId: string): void {
    for (const [resourceId, snapshot] of mutations) {
      const subscribers = this.#subscriptions.forResource(resourceId);
      const targets = subscribers
        .filter((sub) => sub.clientId !== originatorClientId)
        .filter((sub) =>
          this.#dagTree.evaluatePermissions(
            [snapshot.meta.nodeId], 'read', sub.sub, Boolean(sub.dominionOverHostAtSubscribe),
          ).allowed.size > 0)
        .map((sub) => ({ bindingName: sub.subscriberBinding, instanceName: sub.clientId }));
      this.#bridge.broadcastResourceUpdate(resourceId, snapshot, targets);
    }
  }
}
