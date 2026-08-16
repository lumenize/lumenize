/**
 * **Downward dominion is total, and it is the DOMINION that grants — not an open scope.**
 *
 * A **universe** admin, obtained by a REAL email login (`provisionAndLogin`, ADR-009 rung 1), acts in
 * a Star beneath itself where it holds **no DAG grant at all**, and the write COMMITS — via the
 * scope-admin bypass in `DagTree.requirePermission`. A non-admin at that same Star is DENIED the
 * identical op, which is what proves the first result is the bypass rather than an ungated scope.
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
 * `authScope` is the UNIVERSE and the callee is a Star two levels below, so `isAtOrAbove` has to do
 * real work — where the platform root returned `true` without reading its second argument at all.
 * A covering admin at a real tier is therefore the stronger observer, not a weaker one.
 *
 * ⚠️ **The admin holds no DAG grant at TARGET, and that is load-bearing.** `Star.onBeforeCall`'s
 * root-admin seed is an EXACT-identity test (`authScope === instanceName`), so a *covering* admin
 * never trips it. If that seed ever became hierarchical this scenario would still pass — but for the
 * wrong reason, through a grant instead of the bypass. The control limb is what keeps it honest.
 */
import assert from 'node:assert/strict';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { connectDriver } from '../lib/harness';

/** Resource ops on the DevStudio host only — never a build, so the boot skips Docker. */
export const needsContainer = false;

/** A `.dev` scope neither identity founded or holds a grant on. */
const TARGET = 'claude-reach.sandbox.dev';

export async function run(stack: DevStack): Promise<void> {
  // REAL LOGIN (rung 1) — `provisionAndLogin` claims the universe, logs in there for real, then
  // creates the galaxy + star beneath with that admin's own token and re-issues at TARGET. The
  // resulting claim is the server's: `authScope` = the universe, `aud` = TARGET, `scopeAdmin` set.
  // No mint, no `reason`, nothing hand-built for the assertion to be wrong about.
  const admin = await connectDriver(stack, { scope: TARGET });

  // The control — a NON-admin at TARGET. This one keeps its rung-3 mint, and ADR-009 wants the
  // justification at the site: real login genuinely cannot produce this identity, because every
  // open path into a Star (`claim-star`) mints its founder as that Star's ADMIN.
  const control = await connectDriver(stack, {
    scope: TARGET,
    mint: {
      reason:
        'real login CANNOT produce this identity: every open entry into a Star mints its founder ' +
        'as that Star\'s admin — and a NON-admin at TARGET is exactly the control this scenario needs.',
      issuerInstanceName: TARGET,
      scopeAdmin: false,
    },
  });

  try {
    const adminOut = await admin.client.resources.transaction({
      [crypto.randomUUID()]: {
        op: 'create',
        typeName: 'Message',
        nodeId: ROOT_NODE_ID,
        value: { session: crypto.randomUUID(), role: 'user', content: 'covering-admin dominion' },
      },
    });
    assert.equal(
      adminOut.kind,
      'committed',
      `a covering universe admin should act on an ungranted Star beneath it via the ` +
      `access.scopeAdmin bypass, got kind=${adminOut.kind}`,
    );

    const controlOut = await control.client.resources.transaction({
      [crypto.randomUUID()]: {
        op: 'create',
        typeName: 'Message',
        nodeId: ROOT_NODE_ID,
        value: { session: crypto.randomUUID(), role: 'user', content: 'should be denied' },
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
