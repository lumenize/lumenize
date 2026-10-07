/**
 * NebulaDO — Base class for all Nebula tier Durable Objects (Universe, Galaxy, Star)
 *
 * Provides structural tenant isolation via onBeforeCall() and shared guard
 * functions for @mesh(guard) decorators, and hosts the Clients on its scope's pages.
 */

import { ClientGateway, LumenizeDO, WS_CLOSE_GONE, mesh, rawRpc } from '@lumenize/mesh';
import type { CallContext, CallEnvelope, ClientGatewayHost, GatewayConnectionInfo } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import { hasDominionOver, hasPassageInto, isPlatformScope, noPassageMessage, parseId } from '@lumenize/nebula-auth';
import type { NebulaJwtPayload, VerdictClaims } from '@lumenize/nebula-auth';

/**
 * The minimal structural shape `requireDominionHere` reads (`lmz.callContext` +
 * `lmz.instanceName`), so the guard binds to what it actually consumes rather
 * than to the `NebulaDO` class. Module-private — `index.ts` exports the guard
 * functions, not this type.
 *
 * `instanceName` is OPTIONAL because `LmzApi.instanceName` is
 * `readonly instanceName?: string` — a required `string | undefined` here fails
 * to compile for `NebulaDO` itself.
 */
type HasCallContext = { lmz: { callContext: CallContext; instanceName?: string } };

/** The prefix a Client's upgrade arrives under at its host node: `/gateway/STAR/acme.crm.tenant1/alice.9f2c41aa`. */
export const GATEWAY_PREFIX = '/gateway';

/**
 * Guard: require admin access **over the node this call is running on**.
 * Used with @mesh(requireDominionHere) on subclass methods.
 *
 * Orthogonal to onBeforeCall's tenant boundary: onBeforeCall decides *which tenant* may call
 * (passage), `requireDominionHere` decides *whether the caller holds dominion here*.
 *
 * ⚠️ **The bare `access.scopeAdmin` bit is NOT dominion** — it is dominion only over what the
 * calling host's scope covers, the token's `aud` (the host rule, ADR-015 and ADR-022). A universe
 * admin calling from a tenant's host is an admin here only if this node is that tenant or beneath
 * it. `requirePassage` deliberately admits a caller whose host sits *below* this node (a page on a
 * child may call its parent), so a bare bit check would let that caller act as admin on its
 * ancestors. See tasks/archive/nebula-confine-admin-bypass.md.
 *
 * **Fail closed on a missing instance name.** `instanceName` is permanently `undefined` on a
 * `LumenizeWorker`, and a node type could compose this guard *without* `requirePassage`. Never
 * coerce: `?? ''` denies every scoped admin, `!` opens the hole.
 *
 * ⚠️ This deliberately mirrors only branch (a) of `requirePassage`, not its platform-name reject
 * (b) or its name parse (d) — whose ORDER there is load-bearing because the reserved platform scope
 * is the ROOT of the scope tree, so a superuser holds dominion over any string, an unparseable name
 * included. The invariant that makes that sound here: `onBeforeCall` always runs before guard
 * execution, and `NebulaDO` composes `requirePassage`, so (b)/(d) have already run on every
 * Nebula node. That is an enforced ordering, not an incidental property.
 *
 * Typed against the structural `HasCallContext` shape (not `NebulaDO`) so the
 * guard binds to what it reads, not to a class hierarchy.
 */
export function requireDominionHere(instance: HasCallContext) {
  const claims = instance.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined;
  const name = instance.lmz.instanceName;
  if (!name) {
    throw new Error('Admin check failed: missing callee instance name');
  }
  // ⚠️ **A bare `scopeAdmin` test, standing alone — and it decides NOTHING.** `hasDominionOver`
  // below strictly subsumes it (its own first operand is this same bit), so this branch changes
  // only the MESSAGE: "you are not an admin anywhere" reads differently to a user than "you are an
  // admin, but not of this node", and they imply different next actions. Kept for that, not for a
  // verdict — do not read a pass here as authority.
  if (!claims?.access?.scopeAdmin) {
    throw new Error('Admin access required');
  }
  if (!hasDominionOver(claims, name)) {
    // Distinct from the bare-non-admin message above: the caller IS an admin, just not from THIS
    // host over THIS node — a different user action (go to this node's own page, or ask the admin
    // above you, vs. request admin). It names the operand that decided, the calling host's scope,
    // and the membership the token rests on, which may well cover this node. ADR-008 disclaims
    // confidentiality of the scope boundary, and both are in the caller's own JWT.
    throw new Error(
      `Admin access required for ${name} — the calling host's scope is ${claims.aud}, ` +
      `and the token rests on the membership at ${claims.access.authScope}`,
    );
  }
}

/**
 * The structural scope guard shared by every Nebula node type's `onBeforeCall`
 * (all extend NebulaDO) — composed, not reimplemented, per ADR-007 ("one
 * guard path, one place to audit"). Pure (instance name + the call's claims in,
 * throw-or-return out) so its branches are unit-mutation-testable without a
 * DO harness.
 *
 * Accepts a mesh call iff the caller has **passage** into this node — the shared
 * {@link hasPassageInto} predicate, not a disjunction re-assembled here. Both of its
 * arms matter and neither is sufficient alone: the caller's own scope sits at or
 * below this node (a member of a child reaching its parent, conferring no dominion),
 * OR the caller holds dominion here (the whole downward rule).
 *
 * **Passage is computed from the call's `activeScope`**: the token's `aud`, the calling host's
 * scope (the host rule, ADR-015 and ADR-022), or, for a chain a node started with no claims, that
 * node's scope as a plain member. `NebulaDO.onBeforeCall` derives which and hands it in as
 * `claims`. The refresh derives `aud` from the page's `Origin`, which page script cannot set, so
 * it says which page, and so whose code, made the call. A plain member cannot widen it:
 * verification refuses a plain membership's token whose `aud` differs from its `authScope`.
 *
 * Branch ORDER is load-bearing: the missing-name fail-close, the platform-name
 * reject, and the name parse all run BEFORE the passage clause — otherwise a
 * superuser would short-circuit past them, since the reserved platform scope is the
 * ROOT of the tree and so has passage to any string (incl. an unparseable name).
 *
 * Every rejection is an `Error` (never a bare string — a thrown string lands in
 * `lastResult`, not `lastError`).
 */
export function requirePassage(
  name: string | undefined,
  claims: VerdictClaims | undefined,
): void {
  // (a) fail-closed — the envelope carried no callee instance name.
  if (!name) {
    throw new Error('Mesh call missing callee instance name');
  }

  // (b) NAME RESERVATION — `_platform` is the reserved platform scope, and under the root
  // model it is the one instance name EVERY authenticated caller has passage to. Nothing is
  // deployed there yet, and `lmz.call` takes the binding and the instance name separately, so
  // without this reject a caller could instantiate an arbitrary DO class at the most-reachable
  // name in the system and call its ungated `@mesh()` methods. Runs before the passage clause so
  // it fires for a superuser too. ⚠️ It is TEMPORARY and goes from REJECTED to BOUND — never to
  // open — in whatever change eventually registers an occupant for the name.
  if (isPlatformScope(name)) {
    throw new Error(`"${name}" is the reserved platform scope, and no call may reach it`);
  }

  // (d) throws on an unparseable tier name (e.g. >3 segments, illegal slug) — fail closed rather
  // than swallow. ⚠️ Load-bearing on its own now: `isAtOrAbove` is deliberately grammar-free, so
  // this is the ONLY thing standing between a malformed callee name and a plain string compare.
  // Before the passage clause because every scope is at or below the platform root, so the root
  // name has passage from anywhere and an unparseable name would never reach this parse.
  parseId(name);

  // (c) PASSAGE — the ONE shared predicate (ADR-007), both arms, computed from the call's
  // `activeScope`. Not re-assembled here: a disjunction spelled at the call site is how one arm
  // silently goes missing, and each omission breaks a different half of ADR-015 (drop the upward
  // arm and a Star member cannot reach its own Galaxy; drop dominion and an admin cannot act
  // downward at all).
  //
  // ⚠️ The absent-claim case is the predicate's, not this line's: it returns `false` rather than
  // throwing, so an unauthenticated or malformed claim lands here as an ordinary refusal.
  if (!hasPassageInto(claims, name)) {
    throw new Error(noPassageMessage(claims?.aud, name));
  }
}

/** A node's scope is its name when that parses as one; anything else names none. */
function scopeNamed(instanceName: string | undefined): string | undefined {
  if (!instanceName) return undefined;
  try { return parseId(instanceName).raw; } catch { return undefined; }
}

/**
 * Guard: a Client receives a node's call only if its holder has passage into the node that sent it.
 *
 * The sender is the call's last hop, `callChain.at(-1)`, which the mesh stamps and no client can
 * write. Its scope is its name when that parses as one: a Galaxy reaches a tab on one of its Stars'
 * hosts, since upward is free, and a sibling Star is refused as lateral (ADR-015). A Star
 * `acme.crm.tenant2` pushing to a tab on `acme.crm.tenant1`'s host is refused; the Galaxy
 * `acme.crm` pushing there passes. A sender whose name is no scope, the `Profile`, passes, so a
 * node not named by a scope must hold no tenant's data.
 *
 * It is needed because a server-side node can address any Client whose address it holds, and this
 * is what stops a lateral one. It reads the sender's address and no claims of the writer's, so a
 * push that starts a fresh chain passes it.
 *
 * A sender that is itself a Client is not checked here: its name does not parse as a scope, so it
 * offers none to check passage into. The receiving Client decides, and `LumenizeClient.onBeforeCall`
 * refuses it by default.
 */
export function requirePassageIntoSender(envelope: CallEnvelope, connectionInfo: GatewayConnectionInfo): void {
  const sender = envelope.callContext.callChain.at(-1);
  if (!sender) throw new Error('Call to a client names no sender');

  // Another Client: the receiving Client decides (see above).
  if (sender.type === 'LumenizeClient') return;

  const senderScope = scopeNamed(sender.instanceName);
  if (senderScope === undefined) return;

  const claims = connectionInfo.claims as unknown as NebulaJwtPayload;
  if (!hasPassageInto(claims, senderScope)) {
    throw new Error(noPassageMessage(claims?.aud, senderScope));
  }
}

/**
 * NebulaDO — base class for Universe, Galaxy, and Star.
 *
 * onBeforeCall() enforces **structural** passage via the shared
 * {@link requirePassage} helper (composed, not reimplemented — ADR-007). A
 * mesh call is accepted iff the caller is an `access.scopeAdmin` whose dominion
 * from its host covers this DO's **instance name** (downward dominion), OR the
 * call's `activeScope` sits at or below the scope encoded in that name (the
 * non-admin path). That is the token's `aud`, the calling host's scope, or, on a
 * chain a scoped node started, that node's scope. Containment is by whole dot-separated segment —
 * a scope covers itself and every descendant, and nothing else — so no tier
 * grammar is involved. There is no trust-on-first-use lock and no stored `aud`;
 * the node's half is read off its name on every call, and the caller's half comes
 * from the host the refresh read off `Origin`, which page script cannot set.
 *
 * Soundness rests on name == routing key: a tier DO is addressed by the same
 * `parseId`-valid id that becomes its `instanceName` (never a 64-hex DO id), so
 * the derived scope equals the address an attacker must already control.
 * See tasks/archive/nebula-onbeforecall-higher-admin-reach.md and
 * tasks/archive/nebula-do-scope-isolation.md.
 *
 * **It hosts the Clients on its scope's pages, by composing `ClientGateway`.** A page on
 * `tenant1.crm.acme.lumenize.dev` upgrades at `/gateway/alice.9f2c41aa`, and the Star
 * `acme.crm.tenant1` holds the socket as `acme.crm.tenant1/alice.9f2c41aa`; Universe, Galaxy and
 * Star add nothing for it. A call addressed to that name arrives at this node's doors and goes down
 * the socket after {@link requirePassageIntoSender}, and `onBeforeCall` never runs for it. A hosted
 * Client's own call to this node runs in place, through the same door and `onBeforeCall` as an RPC.
 */
export class NebulaDO extends LumenizeDO implements ClientGatewayHost {
  /** The paths {@link onRequest} dispatches on, and the only ones: `npm run audit:do-http` holds it to these. */
  static readonly HTTP_PREFIXES: readonly string[] = [GATEWAY_PREFIX];

  #clientGateway = new ClientGateway(this.ctx, this.env, this);

  /** What this node's doors hand a message addressed to a Client it hosts. */
  override get __clientGateway(): ClientGateway {
    return this.#clientGateway;
  }

  /**
   * Tear this node down: wipe all of its storage and reset the object, so the next call constructs
   * a fresh one. A deletion calls it on every scope it removes, and a creation on every scope it
   * writes, so a new owner starts empty. Distinct from `Star.resetDevData`, which wipes and then
   * re-initialises to keep the `.dev` sandbox usable.
   *
   * `@rawRpc()`, never `@mesh()`: it carries out a decision the Registry made where claims were
   * checked, and `@mesh()` would let any admin wipe a live app without deleting it (ADR-023).
   *
   * Logs `nebula.scope.teardown` first, with `this.lmz.instanceName` read with no fallback, so an
   * entry that stamped nothing shows as a missing name, and with the `operationId` of the facade
   * call that ordered it, so a reader counts what one call caused. Then {@link beforeTeardown}, `deleteAll()`,
   * a macrotask yield so the wipe persists before the abort (`durable-objects.md` § *Persist before
   * `ctx.abort()`*), and `ctx.abort('scope-deleted')`, without which `Resources`, `OrgTree` and the
   * Galaxy's Workspace would stay pointed at dropped tables and a re-created scope would fail with
   * `no such table`. The abort rejects the caller's call; the scope lifecycle hooks read that
   * rejection as the reset it is.
   *
   * A deletion closes every socket this node hosts with `WS_CLOSE_GONE` (4410) after
   * {@link beforeTeardown} and before `deleteAll()`. After, because a Galaxy's `beforeTeardown` can
   * wait twenty seconds on a certificate order, and a 4410 sent ahead of it let a Client read the
   * chat it had been told was deleted; a socket accepted during that wait is closed with the rest.
   * Before, because the close frames go out during the wipe and the yield after it, and a close
   * sent after the wipe was lost to the abort, so the Client timed out instead (both found on the
   * deployed pass, 2026-10-07). No read reaches the node between the close and the wipe, since
   * storage holds the input gate. A creation sends no close of its own: its abort drops a socket
   * as any reset does, and the Client reconnects to the fresh object.
   */
  @rawRpc()
  async teardown(cause: 'deletion' | 'creation', operationId: string): Promise<void> {
    const instanceName = this.lmz.instanceName;
    let tier: string | undefined;
    try { tier = instanceName ? parseId(instanceName).tier : undefined; } catch { tier = undefined; }
    debug('nebula.scope.teardown').info('tearing down', {
      tier, cause, operationId, binding: this.lmz.bindingName, instanceName,
    });
    await this.beforeTeardown();
    if (cause === 'deletion') this.#clientGateway.closeAll(WS_CLOSE_GONE, 'Scope deleted');
    await this.ctx.storage.deleteAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.ctx.abort('scope-deleted');
  }

  /** What a node releases outside its storage before {@link teardown} wipes it. Default: nothing. */
  protected async beforeTeardown(): Promise<void> {}

  // ─── Hosting the Clients on this scope's pages ──────────────────────────────────────────────

  /**
   * A Client's upgrade, under {@link GATEWAY_PREFIX}. The Worker verified its token, checked that
   * its `aud` is this node's scope and that its id begins with its `sub`, and rewrote the path to
   * name this node. Recognized by the prefix, never by an `Upgrade` header: `ClientGateway` reads
   * the token without verifying it, and the Galaxy's container dials back with an upgrade of its
   * own. Anything else is 404; a node with a surface of its own handles that first.
   */
  override async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith(`${GATEWAY_PREFIX}/`)) {
      return this.#clientGateway.acceptUpgrade(request);
    }
    return new Response('Not Found', { status: 404 });
  }

  /** A message from a hosted Client's socket. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.#clientGateway.receiveMessage(ws, message);
  }

  /** A hosted Client's socket closed; starts its grace period unless a new connection superseded it. */
  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.#clientGateway.socketClosed(ws, code, reason);
  }

  /** A hosted Client's socket errored. */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.#clientGateway.socketErrored(ws, error);
  }

  /**
   * Accept a Client only under an id that begins with its token's `sub`: Alice's tab is
   * `alice.9f2c41aa`. The Worker refuses the same upgrade before routing.
   */
  onBeforeAccept(instanceName: string, sub: string): Response | undefined {
    const id = instanceName.slice(instanceName.indexOf('/') + 1);
    const dot = id.indexOf('.');
    if (dot === -1 || id.slice(0, dot) !== sub) {
      return new Response('Forbidden: identity mismatch', { status: 403 });
    }
    return undefined;
  }

  /** A hosted Client's call carries the context its socket's verified attachment builds, unchanged. */
  onBeforeCallToMesh(baseContext: CallContext, connectionInfo: GatewayConnectionInfo, callId: string): CallContext {
    return baseContext;
  }

  /** A node's call to a hosted Client: {@link requirePassageIntoSender}. */
  onBeforeCallToClient(envelope: CallEnvelope, connectionInfo: GatewayConnectionInfo): undefined {
    requirePassageIntoSender(envelope, connectionInfo);
    return undefined;
  }

  onBeforeCall() {
    // Scope is derived from this DO's instance name (stamped from the envelope's
    // metadata.callee before onBeforeCall runs).
    const name = this.lmz.instanceName;

    // Entry marker (internal testing primitive): the local-executor path
    // (alarms, OCAN self-continuations) must NOT route through onBeforeCall, so
    // its absence on that path is asserted via this sink marker. See T-local-skip.
    debug('nebula.NebulaDO.onBeforeCall').debug('entry', { instanceName: name });

    requirePassage(name, claimsForPassage(this.lmz.callContext));
  }
}

/**
 * What passage reads for a call — the call's `activeScope`, with the admin bit beside it.
 *
 * A call carrying claims gives them as they are: `aud` is the scope its host spells. A chain with
 * no claims is one a node started, from an alarm or with `newChain`; it gives the scope of the
 * node that started it, `callChain[0]`, held as a plain member with no `scopeAdmin`. So the Star
 * `acme.crm.bigco` calling from an alarm has passage into itself, `acme.crm` and `acme`, and
 * dominion over nothing. The answer it gets back on that chain runs no passage check at all: mesh
 * skips `onBeforeCall` at a node's fire-back door on a chain the node started. A chain a node named by an id started, such as a Profile's, gives nothing, and passage
 * refuses it. A client's chain always carries claims, because its host node stamps them, so no
 * client can borrow a node's scope this way. Nothing is written into `originAuth`.
 *
 * This grants nothing a caller lacked: anyone with passage into a node has it into the node's
 * ancestors. It is sound only because a scope-shaped name always names an object that checks
 * passage into that scope — a `Profile` refuses to run under one — and because a hosted Client's
 * name always contains a `/`, `acme.crm.tenant1/alice.9f2c41aa`, so it never parses as one.
 */
function claimsForPassage(callContext: CallContext): VerdictClaims | undefined {
  const claims = callContext.originAuth?.claims as NebulaJwtPayload | undefined;
  if (claims) return claims;
  const starter = callContext.callChain[0];
  if (!starter?.instanceName) return undefined;
  let scope: string;
  try { scope = parseId(starter.instanceName).raw; } catch { return undefined; }
  return { aud: scope, access: { authScope: scope } };
}
