/**
 * NebulaDO — Base class for all Nebula tier Durable Objects (Universe, Galaxy, Star)
 *
 * Provides structural tenant isolation via onBeforeCall() and shared guard
 * functions for @mesh(guard) decorators.
 */

import { LumenizeDO, mesh } from '@lumenize/mesh';
import type { CallContext } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import { hasDominionOver, hasPassageInto, isPlatformScope, parseId } from '@lumenize/nebula-auth';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

/**
 * The minimal structural shape `requireDominionHere` reads. Both NebulaDO and the
 * sibling NebulaContainer satisfy it (each exposes `lmz.callContext` and
 * `lmz.instanceName`), so the guard works on either without casting one to the
 * other's class. Module-private — `index.ts` exports the guard functions, not
 * this type.
 *
 * `instanceName` is OPTIONAL because `LmzApi.instanceName` is
 * `readonly instanceName?: string` — a required `string | undefined` here fails
 * to compile for `NebulaDO` itself.
 */
type HasCallContext = { lmz: { callContext: CallContext; instanceName?: string } };

/**
 * Guard: require admin access **over the node this call is running on**.
 * Used with @mesh(requireDominionHere) on subclass methods.
 *
 * Orthogonal to onBeforeCall's tenant boundary: onBeforeCall decides *which tenant* may call
 * (passage), `requireDominionHere` decides *whether the caller holds dominion here*.
 *
 * ⚠️ **The bare `access.scopeAdmin` bit is NOT dominion** — it is dominion only over what the
 * caller's `authScope` covers. `requirePassage` deliberately admits a caller whose own scope sits
 * *below* this node (a member of a child may call its parent), so a bare bit check let an admin of
 * a child scope act as admin on its ancestors. See tasks/nebula-confine-admin-bypass.md.
 *
 * **Fail closed on a missing instance name.** `instanceName` is permanently `undefined` on a
 * `LumenizeWorker`, and a node type could compose this guard *without* `requirePassage`. Never
 * coerce: `?? ''` denies every scoped admin, `!` opens the hole.
 *
 * ⚠️ This deliberately mirrors only branch (a) of `requirePassage`, not its platform-name reject
 * (b) or its name parse (d) — whose ORDER there is load-bearing because the reserved platform scope
 * is the ROOT of the scope tree, so a superuser holds dominion over any string, an unparseable name
 * included. The invariant that makes that sound here: `onBeforeCall` always runs before guard
 * execution, and both `NebulaDO` and
 * `NebulaContainer` compose `requirePassage`, so (b)/(d) have already run on every node that
 * composes both. That is an enforced ordering, not an incidental property.
 *
 * Typed against the structural `HasCallContext` shape (not `NebulaDO`) so it
 * guards NebulaContainer — a sibling node type — without a cast.
 */
export function requireDominionHere(instance: HasCallContext) {
  const claims = instance.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined;
  const name = instance.lmz.instanceName;
  if (!name) {
    throw new Error('Admin check failed: missing callee instance name');
  }
  if (!claims?.access?.scopeAdmin) {
    throw new Error('Admin access required');
  }
  if (!hasDominionOver(claims.access, name)) {
    // Distinct from the bare-non-admin message above: the caller IS an admin, just not of THIS
    // node — a different user action (switch scope / ask the admin above you, vs. request admin).
    // ADR-008 disclaims confidentiality of the scope boundary and discloses the denied set on
    // purpose, and both operands are already in the caller's own JWT, so naming them leaks nothing.
    throw new Error(
      `Admin access required for ${name} — your admin scope is ${claims.access.authScope}`,
    );
  }
}

/**
 * The structural scope guard shared by every Nebula node type's `onBeforeCall`
 * (NebulaDO + NebulaContainer) — composed, not reimplemented, per ADR-007 ("one
 * guard path, one place to audit"). Pure (instance name + verified claims in,
 * throw-or-return out) so its branches are unit-mutation-testable without a
 * DO/Container harness.
 *
 * Accepts a mesh call iff the caller has **passage** into this node — the shared
 * {@link hasPassageInto} predicate, not a disjunction re-assembled here. Both of its
 * arms matter and neither is sufficient alone: the caller's own scope sits at or
 * below this node (a member of a child reaching its parent, conferring no dominion),
 * OR the caller holds dominion here (the whole downward rule).
 *
 * ⚠️ **Passage is computed from the caller's own `authScope`, never from the
 * client-chosen `aud`.** That is the substantive change over the previous body, and it
 * is what makes the name true: `aud` is a value the client selects at refresh, so
 * deciding passage on it let a non-admin at `{u}` select `aud = {u}.{g}.{s}` and reach
 * a tenant Star it holds no membership in. Under `authScope` that is refused **by
 * construction** — there is no branch to get wrong, because the input a caller can
 * choose is no longer read. `aud` remains on the token and on the wire for the
 * Gateway's outbound fence (`onBeforeCallToClient`); it just stops deciding this.
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
  claims: NebulaJwtPayload | undefined,
): void {
  // (a) fail-closed — the envelope carried no callee instance name.
  if (!name) {
    throw new Error('Mesh call missing callee instance name');
  }

  // (b) NAME RESERVATION — `nebula-platform` is the reserved platform scope, and under the root
  // model it is the one instance name EVERY authenticated caller has passage to. Nothing is
  // deployed there yet, and `lmz.call` takes the binding and the instance name separately, so
  // without this reject a caller could instantiate an arbitrary DO class at the most-reachable
  // name in the system and call its ungated `@mesh()` methods. Runs before the dominion clause so
  // it fires for a superuser too. ⚠️ It is TEMPORARY and goes from REJECTED to BOUND — never to
  // open — in whatever change eventually registers an occupant for the name.
  if (isPlatformScope(name)) {
    throw new Error('Active-scope mismatch');
  }

  // (d) throws on an unparseable tier name (e.g. >3 segments, illegal slug) — fail closed rather
  // than swallow. ⚠️ Load-bearing on its own now: `isAtOrAbove` is deliberately grammar-free, so
  // this is the ONLY thing standing between a malformed callee name and a plain string compare.
  // Before the dominion clause because the platform root holds dominion over any string.
  parseId(name);

  // (c) PASSAGE — the ONE shared predicate (ADR-007), both arms, computed from the caller's own
  // `authScope`. Not re-assembled here: a disjunction spelled at the call site is how one arm
  // silently goes missing, and each omission breaks a different half of ADR-015 (drop the upward
  // arm and a Star member cannot reach its own Galaxy; drop dominion and an admin cannot act
  // downward at all).
  //
  // ⚠️ The absent-claim case is the predicate's, not this line's: it returns `false` rather than
  // throwing, so an unauthenticated or malformed claim lands here as an ordinary refusal. The old
  // `if (!aud) throw` is GONE with the `aud` read that justified it — `verify.ts` already refuses
  // any token without an `aud`, so it was unreachable on the live path even before this.
  if (!hasPassageInto(claims?.access, name)) {
    throw new Error('Active-scope mismatch');
  }
}

/**
 * NebulaDO — base class for Universe, Galaxy, and Star.
 *
 * onBeforeCall() enforces **structural** passage via the shared
 * {@link requirePassage} helper (composed, not reimplemented — ADR-007). A
 * mesh call is accepted iff the caller is an `access.scopeAdmin` whose dominion
 * covers this DO's **instance name** (downward dominion), OR the caller's own
 * `access.authScope` sits at or below the scope encoded in that name (the tenant
 * boundary; the non-admin path). Containment is by whole dot-separated segment —
 * a scope covers itself and every descendant, and nothing else — so no tier
 * grammar is involved. There is no trust-on-first-use lock and no stored `aud`;
 * the scope is read off the name on every call, and the caller's half comes from
 * their membership rather than from a value they select.
 *
 * Soundness rests on name == routing key: a tier DO is addressed by the same
 * `parseId`-valid id that becomes its `instanceName` (never a 64-hex DO id), so
 * the derived scope equals the address an attacker must already control.
 * See tasks/archive/nebula-onbeforecall-higher-admin-reach.md and
 * tasks/archive/nebula-do-scope-isolation.md.
 */
export class NebulaDO extends LumenizeDO {
  /**
   * Tear this node down — wipe ALL of its storage. The destructive deprovision primitive the
   * scope-deletion cascade fans out to (and the one a future soft-delete reaper will call after
   * its grace window — so this is the foundation, NOT a stopgap). Distinct from
   * `Star.resetDevData`, which wipes then RE-INITS to keep the live `.dev` sandbox usable:
   * teardown does not re-init, because the node is being removed from existence, not reset.
   *
   * `@mesh(requireDominionHere)` + `onBeforeCall`'s passage gate it — only an admin whose dominion
   * covers this instance can fire it (the same wall as every other admin mutator; not in the
   * non-admin frozen surface). `deleteAll()` is the sanctioned async-storage exception (no sync
   * variant); it clears the entire private store (SQL + KV + alarms). `blockConcurrencyWhile`
   * closes the input gate so nothing lands mid-wipe (the sync `requireDominionHere` already ran).
   */
  @mesh(requireDominionHere)
  async teardown(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.deleteAll();
    });
  }

  onBeforeCall() {
    // Scope is derived from this DO's instance name (stamped from the envelope's
    // metadata.callee before onBeforeCall runs).
    const name = this.lmz.instanceName;

    // Entry marker (internal testing primitive): the local-executor path
    // (alarms, OCAN self-continuations) must NOT route through onBeforeCall, so
    // its absence on that path is asserted via this sink marker. See T-local-skip.
    debug('nebula.NebulaDO.onBeforeCall').debug('entry', { instanceName: name });

    requirePassage(
      name,
      this.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined,
    );
  }
}
