/**
 * NebulaAuthFacade — the mesh-speaking entry for what an authenticated SESSION does with the
 * Registry: invites, listing an account's apps, creating an app, deleting a scope, and
 * impersonation. HTTP carries the session lifecycle (login, refresh, a link page's consume); this
 * facade carries the session's mutations, reached with an ordinary `lmz.call` or `callAsync` (a
 * service binding with `instanceName: undefined` routes as a `LumenizeWorker`). The ONE raw hop left
 * on this path — facade → Registry DO stub — lives here, in infrastructure code where raw RPC is
 * native, next to the invariants the facade enforces (ADR-023's facade bridge).
 *
 * **Every method decides on the verified claims**, with the facade's own message. Most refuse before
 * their hop; `impersonate` must first read its subject's scope from the Registry, and `expandScope`
 * answers an empty level rather than refusing. Where the Registry acts on a caller's authority it
 * keeps its own check, as the invariant against a caller that skipped the facade. A call carrying no
 * claims at all is refused once, in {@link NebulaAuthFacade.onBeforeCall}.
 *
 * **The scope lifecycle hooks are the consumer's.** A deletion or a creation must wipe Durable
 * Objects only the consuming Worker can name, so a consumer subclasses this class and supplies
 * {@link NebulaAuthFacade.hooks}; the property is abstract, so a subclass without them does not
 * compile, since an optional seam would skip a teardown silently.
 *
 * What the facade owns, all computed from `callContext.originAuth` (framework-verified, never
 * caller-suppliable) and a scope string — no DAG, and no Registry read but the one `impersonate`
 * needs:
 *
 *  - **Eligibility** — exact-scope membership ∨ dominion over the target scope. Every member may
 *    invite non-admin peers into exactly their own scope (an identity test, never a hierarchy
 *    one); dominion holders may invite anywhere below. The forbidden shape — a Star member
 *    inviting into the Universe — is unrepresentable rather than checked.
 *  - **The cap** — the minted bit never exceeds the inviter's dominion verdict: a requested
 *    `scopeAdmin` is honored only under dominion, and a peer inviter's request caps to false.
 *    The request selects; the verdict licenses.
 *  - **The validation boundary (ADR-001)** — mesh continuation args are compile-time typed but
 *    runtime-unchecked, so the call's shape is checked here (`targetScope` a parseable scope,
 *    `invitees` an array, the bit passing only `=== true`); a PER-ENTRY defect (a malformed email,
 *    a non-object entry) passes through and comes back as the Registry's per-invitee error in the
 *    resolved summary — the batch never fails whole either way.
 *  - **The ADR-016 projection** — the full verified claims ride from `originAuth` into the
 *    `callerClaims` parameter `issueInvites` takes, `act` chain included; identity is never
 *    hand-threaded.
 *
 * Expected client errors are THROWN here with distinguishable messages (mesh errors preserve
 * `message` end-to-end) — the Registry stays throw-free for them and re-asserts only the cap
 * in-method, where a violation is an invariant breach (raw-comm.md § Errors).
 *
 * Behind a dedicated subpath export (`@lumenize/nebula-auth/facade`), never the root barrel — a
 * mesh-composing class in a widely-imported index breaks pure-unit transforms (packaging.md).
 *
 * **Invite links point at the platform host, on the origin the inviter's connection ARRIVED on** —
 * `callContext.originRequest.origin`, which the Gateway stamps from the upgrade request's URL (what
 * routing delivered, never a client-supplied header — a client-chosen origin in an emailed login link
 * would be an account-takeover vector, which is why it is read from the Trust DMZ and from nowhere
 * else). The Registry spells the platform host from it, keeping its protocol and port, so a local
 * stack's link names `http://platform.lumenize.localhost:{port}` and production's
 * `https://platform.lumenize.dev`, with no per-venue re-pointing anywhere, and the link's page
 * returns the invitee to the invited scope's own host. The deployment's platform host,
 * `platformOrigin(deploymentOrigin(env))`, is the FALLBACK for a chain no client originated (a DO- or
 * Worker-originated invite, `newChain: true`), so a link a Durable Object sends names the stack that
 * sent it.
 */
import { debug } from '@lumenize/debug';
import { LumenizeWorker, mesh, type OriginRequest } from '@lumenize/mesh';
import { hasDominionOver, parseId } from './parse-id';
import { deploymentOrigin, platformOrigin } from './hosts';
import {
  ImpersonationRefusedError, REGISTRY_INSTANCE_NAME, sanitizeInviterName,
} from './types';
import type {
  InviteMintResult, InviteSummary, InviteeRequest, NebulaJwtPayload, ScopeLifecycleHooks, ScopeNode,
  ScopeTarget,
} from './types';
import type { AffectedScope, NebulaAuthRegistry, ScopeDeletionPlan } from './nebula-auth-registry';
import { sendInviteEmails, summarizeInvites } from './invite-entry';
import { mintImpersonationToken, wakeCertificates } from './worker-token';

/** The Registry methods this facade reaches, typed against the class so a rename reaches `tsc`. */
type RegistryStub = {
  [K in 'createGalaxy' | 'expandScope' | 'planScopeDeletion' | 'executeScopeDeletion' | 'issueInvites' | 'checkSlugAvailable']:
    (...args: Parameters<NebulaAuthRegistry[K]>) => Promise<Awaited<ReturnType<NebulaAuthRegistry[K]>>>;
};

export abstract class NebulaAuthFacade extends LumenizeWorker {
  /**
   * Wipes the Durable Objects a deletion removed or a creation wrote. Supplied by the consuming
   * Worker, which alone can name them; required, so a subclass that forgets does not compile.
   */
  protected abstract readonly hooks: ScopeLifecycleHooks;

  /**
   * Fail closed on absent claims, once, for every method. A `newChain` continuation is the live
   * producer of a claims-less callContext, and an empty-but-truthy default would hand it a verdict.
   */
  override onBeforeCall(): void {
    super.onBeforeCall();
    const claims = this.lmz.callContext.originAuth?.claims as unknown as NebulaJwtPayload | undefined;
    if (!claims?.access?.authScope) {
      throw new Error('NebulaAuthFacade requires a verified identity: this call carried no origin claims');
    }
  }

  /**
   * The verified claims of the call in flight — {@link onBeforeCall} refused their absence before
   * any method ran. A direct RPC on the binding skips that gate and fails closed here instead, since
   * the framework's `callContext` getter throws outside a mesh dispatch.
   */
  #claims(): NebulaJwtPayload {
    return this.lmz.callContext.originAuth!.claims as unknown as NebulaJwtPayload;
  }

  #registry(): RegistryStub {
    return (this.env as any).NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
  }

  /**
   * One id per facade call, logged on the facade's own line and handed to every teardown the call
   * orders, so a reader of the logs counts what one call caused.
   */
  #operation(method: string, target: string | undefined): { id: string; log: ReturnType<typeof debug> } {
    const id = crypto.randomUUID();
    const log = debug(`nebula-auth.facade.${method}`);
    log.debug('called', { operationId: id, target });
    return { id, log };
  }

  /**
   * Issue invites into `targetScope` — the sole issuing entry (scope invites call it directly; a
   * node-initiated two-plane invite calls it with no bit requested).
   *
   * Cross-node-self-contained: the one downstream await is a raw Workers RPC issued from a Worker,
   * so a client `callAsync` receives the full per-invitee summary synchronously; sends finish
   * under `ctx.waitUntil` after the summary is produced.
   *
   * @throws Error with a distinguishable message for each expected client refusal: a malformed
   *   `targetScope`/`invitees` shape, no membership-or-dominion, and dominion-lacking admins — see
   *   the message constants in the body; callers assert the message, never a boolean.
   */
  @mesh()
  async invite(targetScope: string, invitees: InviteeRequest[], inviterName?: string): Promise<InviteSummary> {
    const claims = this.#claims();
    const originRequest: OriginRequest | undefined = this.lmz.callContext.originRequest;
    // Where the emailed links point — the header JSDoc carries the trust argument and the fallback.
    const origin = originRequest?.origin ?? platformOrigin(deploymentOrigin(this.env));

    // ── The ADR-001 boundary: shape-check what the wire cannot. ─────────────────────────────────
    if (typeof targetScope !== 'string') {
      throw new Error('Invalid invite target: targetScope must be a scope string');
    }
    // The platform root is no host's scope, so no token holds dominion over it and it is refused
    // here as the id it is not (the host rule, ADR-015 and ADR-022): a superuser comes from the
    // bootstrap address, never from an invite.
    try { parseId(targetScope); }
    catch (e) {
      throw new Error(`Invalid invite target "${targetScope}": ${(e as Error).message}`);
    }
    if (!Array.isArray(invitees)) {
      throw new Error('Invalid invite request: invitees must be an array');
    }

    // ── Eligibility: the calling host is the target ∨ dominion — one sentence, enforced once, here.
    // Both read the host's scope, `aud` (the host rule): a plain member's token is for its own
    // scope's host alone, so `aud` equal to the target is a membership there, and an admin's reaches
    // down from the host it was minted for, never from its whole membership.
    const access = claims.access;
    const memberHere = claims.aud === targetScope;
    const dominionHere = hasDominionOver(claims, targetScope);
    if (!memberHere && !dominionHere) {
      // Post-verdict message pick (the route pipeline's convention): the refusal names WHICH rule
      // failed for THIS caller — an admin asked beyond their host vs. a member with no standing
      // here at all. Both name only values the caller already holds (ADR-008).
      throw new Error(access.scopeAdmin
        ? `Inviting into "${targetScope}" needs dominion over it, and the calling host's scope is "${claims.aud}"`
        : `Inviting into "${targetScope}" needs a membership there or dominion over it, and the calling host's scope is "${claims.aud}"`);
    }

    // ── The cap: the minted bit never exceeds the dominion verdict. Malformed entries pass
    // through unaltered — the Registry answers them as per-invitee errors, so the batch never
    // fails whole. The bit passes only `=== true` (never `"true"`/`1`), and a capped request is
    // silently a plain-member invite — the request selects, the verdict licenses.
    const capped = invitees.map((entry) =>
      (entry !== null && typeof entry === 'object')
        ? { email: (entry as InviteeRequest).email,
            ...(entry.scopeAdmin === true && dominionHere ? { scopeAdmin: true as const } : {}) }
        : entry);

    // ── The inviter's display name, sanitized HERE because this is the ADR-001 boundary and the
    // value is the one thing on this call the CALLER asserts about themselves. It is stamped on the
    // invitee's membership and rendered in their consent modal, where the adversary that modal
    // defends against is the person supplying it — so it is capped, stripped of control characters
    // (which could otherwise reflow the modal's own copy), and never presented as an identity we
    // vouch for. The handles beside it (`sub`, `profileId`) come from verified claims and carry the
    // accountability; this is decoration. An absent or unusable value simply yields no name.
    const cleanName = sanitizeInviterName(inviterName);

    // The one raw hop: facade → Registry DO stub. `claims` rides whole into `callerClaims` so the
    // ADR-016 record carries the full verified acting chain.
    const mint = await this.#registry().issueInvites(
      targetScope, capped as InviteeRequest[], origin, claims, cleanName,
    ) as InviteMintResult;

    const testMode = (this.env as any).NEBULA_AUTH_TEST_MODE === 'true';
    if (!testMode) {
      // Post-return, under waitUntil: the summary never waits on provider I/O, and the helper
      // catches per-invitee (identifiers only), so this can never reject.
      this.ctx.waitUntil(sendInviteEmails(this.env, {
        instanceName: targetScope, origin, invitees: mint.results,
      }));
    }
    return summarizeInvites(mint, testMode);
  }

  /**
   * One more level of the tree below the page's own scope — the universe page's list of its apps,
   * and Studio's list of an app's tenants. The parent is the caller's `aud`, never an argument, so a page
   * lists its own scope's children whatever else its holder administers.
   *
   * A caller without dominion over its page's scope gets an empty level without a Registry hop — the
   * same answer the Registry gives, since it re-derives coverage from accepted memberships.
   */
  @mesh()
  async expandScope(options?: { after?: string }): Promise<{ children: ScopeNode[]; nextCursor?: string }> {
    const claims = this.#claims();
    if (!hasDominionOver(claims, claims.aud)) return { children: [] };
    const after = typeof options?.after === 'string' ? options.after : undefined;
    return await this.#registry().expandScope(claims, after);
  }

  /**
   * Create an app — the galaxy and its `.dev` Star, written together by the Registry — then wipe
   * both scopes' Durable Objects before answering, so a slug someone deleted earlier starts empty,
   * and wake the galaxy's certificate order. A refusal, `slug_taken` included, arrives before the
   * hooks, so it tears nothing down and orders nothing.
   *
   * @throws Error naming the calling host's scope when the caller lacks dominion over the parent universe,
   *   worded apart from the Registry's own refusal; the Registry's `RegistryError` otherwise.
   */
  @mesh()
  async createGalaxy(universeGalaxyId: string): Promise<{ instanceName: string }> {
    const claims = this.#claims();
    const { id, log } = this.#operation('createGalaxy', universeGalaxyId);
    let universe: string;
    try {
      const parsed = parseId(universeGalaxyId);
      if (parsed.tier !== 'galaxy') throw new Error('an app id is universe.galaxy');
      universe = parsed.universe;
    } catch (e) {
      throw new Error(`Invalid app id "${String(universeGalaxyId)}": ${(e as Error).message}`);
    }
    if (!hasDominionOver(claims, universe)) {
      log.debug('refused', { operationId: id, target: universeGalaxyId });
      throw new Error(`Creating an app in "${universe}" needs dominion over it, and the calling host's scope is "${claims.aud}"`);
    }
    const created = await this.#registry().createGalaxy(universeGalaxyId, claims, id);
    await this.hooks.teardown([
      { instanceName: universeGalaxyId, tier: 'galaxy' },
      { instanceName: `${universeGalaxyId}.dev`, tier: 'star' },
    ], 'creation', id);
    await wakeCertificates(this.#registry(), this.hooks, [universeGalaxyId], id);
    log.info('created', { operationId: id, target: universeGalaxyId });
    return created;
  }

  /**
   * The confirm screen's plan for deleting `target`: what goes, and who else loses access. Mutates
   * nothing.
   *
   * @throws Error naming the calling host's scope when the caller lacks dominion over `target` from it.
   */
  @mesh()
  async planScopeDeletion(target: string): Promise<ScopeDeletionPlan> {
    const claims = this.#claims();
    this.#requireDominionOver(claims, target, 'Deleting');
    return await this.#registry().planScopeDeletion(target, claims);
  }

  /**
   * Delete `target` and everything below it, then wipe every Durable Object the deletion named.
   * Each target's wipe is the hook's own, so one that fails is logged and the rest still run.
   *
   * @throws Error naming the calling host's scope when the caller lacks dominion over `target` from it.
   */
  @mesh()
  async executeScopeDeletion(target: string): Promise<{ affected: AffectedScope[] }> {
    const claims = this.#claims();
    const { id, log } = this.#operation('executeScopeDeletion', target);
    this.#requireDominionOver(claims, target, 'Deleting');
    const result = await this.#registry().executeScopeDeletion(target, claims, id);
    await this.hooks.teardown(
      result.affected.map(({ instanceName, tier }): ScopeTarget =>
        ({ instanceName, tier: tier as ScopeTarget['tier'] })),
      'deletion', id,
    );
    log.info('deleted', { operationId: id, target, affected: result.affected.map(a => a.instanceName) });
    return result;
  }

  /**
   * Mint a token that acts as `sub`, on the caller's own page — the child's `aud` is the caller's,
   * so no argument names a scope. `ttlSeconds` is clamped server-side and can only shorten.
   *
   * @throws {@link ImpersonationRefusedError} — `terminal: true`, detected by `err.name` — for every
   *   refusal: retrying cannot help, because the gate chain now refuses this pairing. Any other
   *   rejection a caller sees is transport, and transient.
   */
  @mesh()
  async impersonate(sub: string, options?: { ttlSeconds?: number }): Promise<{ access_token: string; expires_in: number }> {
    const { id } = this.#operation('impersonate', typeof sub === 'string' ? sub : undefined);
    const minted = await mintImpersonationToken(this.env as Env, this.#claims(), sub, options?.ttlSeconds, id);
    if (!minted.ok) throw new ImpersonationRefusedError(minted.message);
    return { access_token: minted.accessToken, expires_in: minted.expiresIn };
  }

  /** The facade's own pre-check, worded apart from the Registry's so a reader can tell which refused. */
  #requireDominionOver(claims: NebulaJwtPayload, target: string, action: string): void {
    if (typeof target !== 'string' || !hasDominionOver(claims, target)) {
      throw new Error(`${action} "${String(target)}" needs dominion over it, and the calling host's scope is "${claims.aud}"`);
    }
  }
}
