/**
 * NebulaAuthFacade — the mesh-speaking entry for what an authenticated SESSION does with the
 * Registry. HTTP carries the session lifecycle (login, refresh, the accept-invite click); this
 * facade carries the session's mutations, reached with an ordinary `lmz.call` (a service binding
 * with `instanceName: undefined` routes as a `LumenizeWorker`) — the client directly for scope
 * invites, a platform node for two-plane operations. The ONE raw hop left on this path — facade →
 * Registry DO stub — lives here, in infrastructure code where raw RPC is native, next to the
 * invariants the facade enforces (mesh.md § *Nebula platform code never drops to raw primitives*).
 *
 * What the facade owns, all computed from `callContext.originAuth` (framework-verified, never
 * caller-suppliable) and a scope string — no DAG, no Registry read:
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
 * ⚠️ **Invite links mint against {@link NEBULA_AUTH_ISSUER}** — a mesh call carries no request URL,
 * so there is no origin to read (the HTTP entries read `url.origin`; a client-supplied origin would
 * be an open-redirect vector into email). The issuer IS the app's canonical public origin, so
 * production links are right by construction; a harness driving a local stack re-points the host
 * (`pointLinkAt`'s existing job), and test lanes read the URL from test-mode `links` or the
 * captured message rather than from a browser bar.
 */
import { LumenizeWorker, mesh } from '@lumenize/mesh';
import { hasDominionOver, parseId } from './parse-id';
import { NEBULA_AUTH_ISSUER, REGISTRY_INSTANCE_NAME, sanitizeInviterName } from './types';
import type { InviteMintResult, InviteSummary, InviteeRequest, NebulaJwtPayload } from './types';
import { sendInviteEmails, summarizeInvites } from './invite-entry';

export class NebulaAuthFacade extends LumenizeWorker {
  /**
   * Issue invites into `targetScope` — the sole issuing entry (scope invites call it directly; a
   * node-initiated two-plane invite calls it with no bit requested).
   *
   * Cross-node-self-contained: the one downstream await is a raw Workers RPC issued from a Worker,
   * so a client `callAsync` receives the full per-invitee summary synchronously; sends finish
   * under `ctx.waitUntil` after the summary is produced.
   *
   * @throws Error with a distinguishable message for each expected client refusal: absent verified
   *   claims (fail closed), a malformed `targetScope`/`invitees` shape, no membership-or-dominion,
   *   and dominion-lacking admins — see the message constants in the body; callers assert the
   *   message, never a boolean.
   */
  @mesh()
  async invite(targetScope: string, invitees: InviteeRequest[], inviterName?: string): Promise<InviteSummary> {
    // ── Fail closed on absent claims — a `newChain` continuation is the live producer of a
    // claims-less callContext, and an empty-but-truthy default here would hand it a verdict.
    // The framework's `callContext` getter THROWS outside a mesh dispatch (a raw RPC on the
    // binding), which is the same no-verified-identity fact — collapse both to the one refusal
    // rather than leaking a framework error for one of them.
    let claims: NebulaJwtPayload | undefined;
    try {
      claims = this.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined;
    } catch { claims = undefined; }
    if (!claims?.access?.authScope) {
      throw new Error('Invite requires a verified identity: this call carried no origin claims');
    }

    // ── The ADR-001 boundary: shape-check what the wire cannot. ─────────────────────────────────
    if (typeof targetScope !== 'string') {
      throw new Error('Invalid invite target: targetScope must be a scope string');
    }
    try { parseId(targetScope); }
    catch (e) {
      throw new Error(`Invalid invite target "${targetScope}": ${(e as Error).message}`);
    }
    if (!Array.isArray(invitees)) {
      throw new Error('Invalid invite request: invitees must be an array');
    }

    // ── Eligibility: exact-scope membership ∨ dominion — one sentence, enforced once, here. ─────
    const access = claims.access;
    const memberHere = access.authScope === targetScope;
    const dominionHere = hasDominionOver(access, targetScope);
    if (!memberHere && !dominionHere) {
      // Post-verdict message pick (the route pipeline's convention): the refusal names WHICH rule
      // failed for THIS caller — an admin asked beyond their scope vs. a member with no standing
      // here at all. Both name only values the caller already holds (ADR-008).
      throw new Error(access.scopeAdmin
        ? `Token scope "${access.authScope}" does not administer "${targetScope}"`
        : `Token scope "${access.authScope}" is not a membership at "${targetScope}" and holds no scopeAdmin over it`);
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
    const registry = (this.env as any).NEBULA_AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME);
    const mint = await registry.issueInvites(
      targetScope, capped, NEBULA_AUTH_ISSUER, claims, cleanName,
    ) as InviteMintResult;

    const testMode = (this.env as any).NEBULA_AUTH_TEST_MODE === 'true';
    if (!testMode) {
      // Post-return, under waitUntil: the summary never waits on provider I/O, and the helper
      // catches per-invitee (identifiers only), so this can never reject.
      this.ctx.waitUntil(sendInviteEmails(this.env, {
        instanceName: targetScope, origin: NEBULA_AUTH_ISSUER, invitees: mint.results,
      }));
    }
    return summarizeInvites(mint, testMode);
  }
}
