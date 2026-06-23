/**
 * NebulaDO — Base class for all Nebula tier Durable Objects (Universe, Galaxy, Star)
 *
 * Provides structural tenant isolation via onBeforeCall() and shared guard
 * functions for @mesh(guard) decorators.
 */

import { LumenizeDO } from '@lumenize/mesh';
import type { CallContext } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import { buildAuthScopePattern, isPlatformInstance, matchAccess } from '@lumenize/nebula-auth';
import type { NebulaJwtPayload } from '@lumenize/nebula-auth';

/**
 * The minimal structural shape `requireAdmin` reads. Both NebulaDO and the
 * sibling NebulaContainer satisfy it (each exposes `lmz.callContext`), so the
 * guard works on either without casting one to the other's class.
 */
type HasCallContext = { lmz: { callContext: CallContext } };

/**
 * Guard: require admin access in the caller's JWT claims.
 * Used with @mesh(requireAdmin) on subclass methods.
 *
 * Orthogonal to onBeforeCall's tenant boundary: onBeforeCall decides *which
 * tenant* may call (the scope check), `requireAdmin` decides *whether the call
 * must be admin-originated*. A galaxy-A admin is still rejected by onBeforeCall
 * from reaching galaxy B.
 *
 * Typed against the structural `HasCallContext` shape (not `NebulaDO`) so it
 * guards NebulaContainer — a sibling node type — without a cast.
 */
export function requireAdmin(instance: HasCallContext) {
  const claims = instance.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined;
  if (!claims?.access?.admin) {
    throw new Error('Admin access required');
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
 * - **higher-admin reach** — the caller is an `access.admin` whose
 *   `authScopePattern` covers this node's instance name (one admin identity
 *   reaches everything in its authority, no per-target `aud` re-mint); OR
 * - **tenant boundary** — the call's active scope (`aud`) is covered by the scope
 *   encoded in the instance name (the original check; all a non-admin ever uses).
 *
 * The reach clause is **gated on `access.admin`**: pattern-coverage alone is not
 * authority, so a non-admin with a wildcard pattern keeps today's aud-narrowed
 * behavior exactly (a descendant it doesn't actively scope to is rejected).
 *
 * Branch ORDER is load-bearing: the missing-name fail-close, the platform-name
 * reject, and the `buildAuthScopePattern(name)` parse all run BEFORE the reach
 * clause — otherwise a wildcard/`*` admin would short-circuit past them, since
 * `matchAccess('*', x)` is `true` for any string (incl. an unparseable name).
 *
 * Every rejection is an `Error` (never a bare string — a thrown string lands in
 * `lastResult`, not `lastError`).
 */
export function enforceScopeReach(
  name: string | undefined,
  claims: NebulaJwtPayload | undefined,
): void {
  // (a) fail-closed — the envelope carried no callee instance name.
  if (!name) {
    throw new Error('Mesh call missing callee instance name');
  }

  // (b) platform-name reject — `buildAuthScopePattern('nebula-platform')` is `*`
  // (accept-all); no tier/container node IS the platform DO, so reject it before
  // the gate could collapse to accept-all. Runs before the reach clause so a
  // covering admin can't reach a DO masquerading at the platform name.
  if (isPlatformInstance(name)) {
    throw new Error('Active-scope mismatch');
  }

  // (d) throws on an unparseable tier name (e.g. >3 segments, illegal slug) —
  // fail closed rather than swallow. Before the reach clause for the same reason.
  const pattern = buildAuthScopePattern(name);

  // Higher-admin reach (gated on access.admin — pattern-coverage is NOT authority).
  const access = claims?.access;
  if (access?.admin && access.authScopePattern && matchAccess(access.authScopePattern, name)) {
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
 * onBeforeCall() enforces **structural** scope reach via the shared
 * {@link enforceScopeReach} helper (composed, not reimplemented — ADR-007). A
 * mesh call is accepted iff the caller is an `access.admin` whose authority
 * covers this DO's **instance name** (higher-admin reach), OR its JWT `aud`
 * (active scope) is covered by the scope encoded in that name (the tenant
 * boundary; the non-admin path). The name is run through `buildAuthScopePattern`
 * (Star → exact id; Galaxy/Universe → `<id>.*`, covering the scope and every
 * descendant). There is no trust-on-first-use lock and no stored `aud` — scope
 * is derived from the name on every call.
 *
 * Soundness rests on name == routing key: a tier DO is addressed by the same
 * `parseId`-valid id that becomes its `instanceName` (never a 64-hex DO id), so
 * the derived scope equals the address an attacker must already control.
 * See tasks/nebula-onbeforecall-higher-admin-reach.md and
 * tasks/archive/nebula-do-scope-isolation.md.
 */
export class NebulaDO extends LumenizeDO {
  onBeforeCall() {
    // Scope is derived from this DO's instance name (stamped from the envelope's
    // metadata.callee before onBeforeCall runs).
    const name = this.lmz.instanceName;

    // Entry marker (internal testing primitive): the local-executor path
    // (alarms, OCAN self-continuations) must NOT route through onBeforeCall, so
    // its absence on that path is asserted via this sink marker. See T-local-skip.
    debug('nebula.NebulaDO.onBeforeCall').debug('entry', { instanceName: name });

    enforceScopeReach(
      name,
      this.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined,
    );
  }
}
