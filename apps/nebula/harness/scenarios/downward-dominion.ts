/**
 * **Downward dominion is total, and it is the DOMINION that grants — not an open scope.**
 *
 * A **universe** admin, obtained by a REAL email login (`provisionAndLogin`, ADR-009 rung 1), acts
 * on a Galaxy beneath itself where it holds **no DAG grant at all**, and the write COMMITS — via
 * the scope-admin bypass in `DagTree.requirePermission`. A non-admin at that same Galaxy is DENIED
 * the identical op, which is what proves the first result is the bypass rather than an ungated
 * scope. (Pre-collapse this drove a `.dev` Star; the collapse re-homed the harness's resource
 * plane onto the Galaxy chat host, and the subject — the bypass — is host-agnostic.)
 *
 * ⚠️ **Re-derived, not ported, and the reason is the whole argument for this tier.** The earlier
 * version of this scenario drove `connectDriver`'s **mint** path with `issuerInstanceName:
 * 'nebula-platform'`, and its own JSDoc had to record the consequence: *you could not produce a
 * denial by narrowing through this harness*, because the mint set the issuing instance from the
 * scope, so narrowing the scope narrowed the claim in lockstep and it still covered the callee.
 * That is a harness whose construction diverges from what the server issues — every assertion riding
 * it was about a shape production could not mint. Under `access.authScope` the lockstep dissolves
 * (the claim IS the scope), so the admin limb is now a real login and the server decides the claim.
 *
 * ⚠️ **The admin's dominion here is genuinely non-trivial, unlike the old `'*'` principal.** Its
 * `authScope` is the UNIVERSE and the callee is the Galaxy below, so `isAtOrAbove` has to do
 * real work — where the platform root returned `true` without reading its second argument at all.
 * A covering admin at a real tier is therefore the stronger observer, not a weaker one.
 *
 * ⚠️ **The admin holds no DAG grant at TARGET, and that is load-bearing.** Post-collapse the host
 * is the GALAXY chat plane, which has no root-admin seed at all (`Star.onBeforeCall`'s seed is
 * Star-only and exact-identity besides), so the admin's commit can come from nothing but the
 * confined scope-admin bypass. The control limb is what keeps it honest: the identical op denied
 * proves the first result is the bypass rather than an ungated scope.
 */
import assert from 'node:assert/strict';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { connectDriver } from '../lib/harness';

/** Resource ops on the Galaxy chat host only — never a build, so the boot skips Docker. */
export const needsContainer = false;

/** A galaxy neither identity founded or holds a grant on (the collapse's chat/resource host). */
const TARGET = 'claude-reach.sandbox';

export async function run(stack: DevStack): Promise<void> {
  // REAL LOGIN (rung 1) — `provisionAndLogin` claims the universe, logs in there for real, then
  // creates the galaxy beneath with that admin's own token and re-issues at TARGET. The
  // resulting claim is the server's: `authScope` = the universe, `aud` = TARGET, `scopeAdmin` set.
  // No mint, no `reason`, nothing hand-built for the assertion to be wrong about.
  const admin = await connectDriver(stack, { scope: TARGET });

  // The control — a NON-admin at TARGET. Rung-3 mint, justified per-site (ADR-009): the real
  // enrollment path for a non-admin member is the invite flow, and node-invite-roundtrip already
  // drives it end-to-end — its own negative control IS this denial with a genuinely-invited
  // member. This mint constructs only what that scenario proves constructible, isolating the
  // admin limb's bypass without a second email loop.
  const control = await connectDriver(stack, {
    scope: TARGET,
    mint: {
      reason:
        'a non-admin member is real-path constructible only via the invite flow, which ' +
        'node-invite-roundtrip drives end-to-end (incl. this very denial as its negative ' +
        'control); this mint isolates the bypass without repeating that email loop.',
      issuerInstanceName: TARGET,
      scopeAdmin: false,
    },
  });

  try {
    // Both limbs run the IDENTICAL op — a `Chat` create off the installed chat ontology — so a
    // divergent outcome can only be the permission decision, never the shape.
    const adminOut = await admin.client.resources.transaction({
      [crypto.randomUUID()]: {
        op: 'create',
        typeName: 'Chat',
        nodeId: ROOT_NODE_ID,
        value: { title: 'covering-admin dominion' },
      },
    });
    assert.equal(
      adminOut.kind,
      'committed',
      `a covering universe admin should act on an ungranted Galaxy beneath it via the ` +
      `access.scopeAdmin bypass, got kind=${adminOut.kind}`,
    );

    const controlOut = await control.client.resources.transaction({
      [crypto.randomUUID()]: {
        op: 'create',
        typeName: 'Chat',
        nodeId: ROOT_NODE_ID,
        value: { title: 'should be denied' },
      },
    });
    assert.equal(
      controlOut.kind,
      'rejected',
      `a non-admin must be denied on an ungranted scope (this is what proves the admin's success ` +
      `is the dominion bypass, not an open scope), got kind=${controlOut.kind}`,
    );
  } finally {
    admin.wipe();
    admin.dispose();
    control.dispose();
  }
}
