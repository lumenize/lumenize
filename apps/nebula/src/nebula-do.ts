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
 * NebulaDO — base class for Universe, Galaxy, and Star.
 *
 * onBeforeCall() enforces **structural** tenant isolation: a mesh call is
 * accepted only if its JWT `aud` (active scope) is covered by the scope encoded
 * in this DO's **instance name**. The name is run through
 * `buildAuthScopePattern` (Star → exact id; Galaxy/Universe → `<id>.*`, which
 * covers the scope itself and every descendant star) and matched against `aud`
 * via `matchAccess`. There is no trust-on-first-use lock and no stored
 * `aud` — scope is derived from the name on every call, so a Galaxy/Universe
 * serves all of its descendant stars and a foreign `aud` is always rejected.
 *
 * Soundness rests on name == routing key: a tier DO is addressed by the same
 * `parseId`-valid id that becomes its `instanceName` (never a 64-hex DO id), so
 * the derived scope equals the address an attacker must already control.
 * See tasks/nebula-do-scope-isolation.md.
 */
export class NebulaDO extends LumenizeDO {
  onBeforeCall() {
    // Scope is derived from this DO's instance name (stamped from the envelope's
    // metadata.callee before onBeforeCall runs). Absent name ⇒ the call didn't
    // carry callee metadata — fail closed.
    const name = this.lmz.instanceName;

    // Entry marker (internal testing primitive): the local-executor path
    // (alarms, OCAN self-continuations) must NOT route through onBeforeCall, so
    // its absence on that path is asserted via this sink marker. See T-local-skip.
    debug('nebula.NebulaDO.onBeforeCall').debug('entry', { instanceName: name });

    if (!name) {
      throw new Error('Mesh call missing callee instance name');
    }

    // The platform instance name maps to the accept-all pattern `*`; no tier DO
    // is the platform DO, so reject it before it could collapse the gate.
    if (isPlatformInstance(name)) {
      throw new Error('Active-scope mismatch');
    }

    // Throws on an unparseable tier name (e.g. >3 segments, illegal slug) —
    // fail closed rather than swallow.
    const pattern = buildAuthScopePattern(name);

    const aud = (this.lmz.callContext.originAuth?.claims as NebulaJwtPayload | undefined)?.aud;
    if (!aud) {
      throw new Error('Missing active scope (aud)');
    }

    // Tenant boundary: the active scope must be covered by this DO's scope.
    if (!matchAccess(pattern, aud)) {
      throw new Error('Active-scope mismatch');
    }
  }
}
