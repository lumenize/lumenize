/**
 * NebulaDO — Base class for all Nebula tier Durable Objects (Universe, Galaxy, Star)
 *
 * Provides structural tenant isolation via onBeforeCall() and shared guard
 * functions for @mesh(guard) decorators.
 */

import { LumenizeDO, mesh } from '@lumenize/mesh';
import type { CallContext } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import { buildAuthScopePattern, hasDominionOver, isPlatformInstance, matchAccess } from '@lumenize/nebula-auth';
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
 * caller's `authScopePattern` covers. `requirePassage`'s tenant branch deliberately admits a
 * caller whose `aud` sits *below* this node (a member of a child may call its parent), so a bare
 * bit check let an admin of a child scope act as admin on its ancestors. Reachable today by
 * narrowing a `/mint-narrower-token` mint. See tasks/nebula-confine-admin-bypass.md.
 *
 * **Fail closed on a missing instance name.** `instanceName` is permanently `undefined` on a
 * `LumenizeWorker`, and a node type could compose this guard *without* `requirePassage`. Never
 * coerce: `?? ''` denies every scoped admin, `!` opens the hole.
 *
 * ⚠️ This deliberately mirrors only branch (a) of `requirePassage`, not its platform-name reject
 * (b) or `buildAuthScopePattern` parse (d) — whose ORDER there is load-bearing because
 * `matchAccess('*', x)` is true for any string, including an unparseable name. The invariant that
 * makes that sound here: `onBeforeCall` always runs before guard execution, and both `NebulaDO` and
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
      `Admin access required for ${name} — your admin scope is ${claims.access.authScopePattern}`,
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
 * Accepts a mesh call iff EITHER:
 * - **downward dominion** — the caller is an `access.scopeAdmin` whose
 *   `authScopePattern` covers this node's instance name (one admin identity
 *   reaches everything in its dominion, no per-target `aud` re-mint); OR
 * - **tenant boundary** — the call's active scope (`aud`) is covered by the scope
 *   encoded in the instance name (the original check; all a non-admin ever uses).
 *
 * The dominion clause is **gated on `access.scopeAdmin`**: pattern-coverage alone is not
 * dominion, so a non-admin with a wildcard pattern keeps today's aud-narrowed
 * behavior exactly (a descendant it doesn't actively scope to is rejected).
 *
 * Branch ORDER is load-bearing: the missing-name fail-close, the platform-name
 * reject, and the `buildAuthScopePattern(name)` parse all run BEFORE the dominion
 * clause — otherwise a wildcard/`*` admin would short-circuit past them, since
 * `matchAccess('*', x)` is `true` for any string (incl. an unparseable name).
 *
 * Every rejection is an `Error` (never a bare string — a thrown string lands in
 * `lastResult`, not `lastError`).
 *
 * ⚠️ **The NAME is true against [ADR-015](../../../docs/adr/015-passage-and-dominion.md)'s
 * DEFINITION of passage, not yet against its PREDICATE — and that gap is deliberate, not an
 * oversight.** ADR-015 defines passage as `isAtOrBelow(authScope, targetScope) ∨ dominion`, computed over
 * the member's own scope. The tenant branch below still compares the **client-chosen `aud`**, and
 * any descendant may be requested — so a non-admin at `u.*` can select `aud = u.g.s` and pass at
 * `u.g.s`, which the ADR's predicate refuses. **This body therefore computes a strict SUPERSET of
 * passage.** It is named ahead of that change on purpose (ADR-015 clause 3 sets the precedent for
 * pre-announcing a name), and `tasks/nebula-passage-dominion-from-scope.md` closes it by switching
 * this branch's input from `aud` to the server-trusted `authScope`. **Until then, do not read this
 * name as a claim that the ADR's predicate is what runs here.**
 */
export function requirePassage(
  name: string | undefined,
  claims: NebulaJwtPayload | undefined,
): void {
  // (a) fail-closed — the envelope carried no callee instance name.
  if (!name) {
    throw new Error('Mesh call missing callee instance name');
  }

  // (b) platform-name reject — `buildAuthScopePattern('nebula-platform')` is `*`
  // (accept-all); no tier/container node IS the platform DO, so reject it before
  // the gate could collapse to accept-all. Runs before the dominion clause so a
  // covering admin can't call into a DO masquerading at the platform name.
  if (isPlatformInstance(name)) {
    throw new Error('Active-scope mismatch');
  }

  // (d) throws on an unparseable tier name (e.g. >3 segments, illegal slug) —
  // fail closed rather than swallow. Before the dominion clause for the same reason.
  const pattern = buildAuthScopePattern(name);

  // Downward dominion (gated on access.scopeAdmin — pattern-coverage is NOT dominion).
  // Delegates to the ONE shared predicate (ADR-007); its body is exactly the inline form this
  // previously hand-rolled, truthiness guard included.
  if (hasDominionOver(claims?.access, name)) {
    return;
  }

  // (c) + (e) — the original active-scope tenant boundary (the non-admin path).
  const aud = claims?.aud;
  if (!aud) {
    throw new Error('Missing active scope (aud)');
  }
  if (!matchAccess(pattern, aud)) {
    throw new Error('Active-scope mismatch');
  }
}

/**
 * NebulaDO — base class for Universe, Galaxy, and Star.
 *
 * onBeforeCall() enforces **structural** passage via the shared
 * {@link requirePassage} helper (composed, not reimplemented — ADR-007). A
 * mesh call is accepted iff the caller is an `access.scopeAdmin` whose dominion
 * covers this DO's **instance name** (downward dominion), OR its JWT `aud`
 * (active scope) is covered by the scope encoded in that name (the tenant
 * boundary; the non-admin path). The name is run through `buildAuthScopePattern`
 * (Star → exact id; Galaxy/Universe → `<id>.*`, covering the scope and every
 * descendant). There is no trust-on-first-use lock and no stored `aud` — scope
 * is derived from the name on every call.
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
