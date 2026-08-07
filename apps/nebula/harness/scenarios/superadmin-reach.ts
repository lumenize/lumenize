/**
 * Phase-3a acceptance B2-(i), realized via the Phase-1 client (the natural home for "drive a real
 * resource op") — `tasks/archive/claude-live-verification.md`.
 *
 * Capable-of-failing on the ENFORCEMENT path (not just the scopeAdmin flag): a `*` super-admin token
 * (issued by `nebula-platform` → `access.authScopePattern: '*'`, admin) reaches a scope it has NO
 * DAG grant on and SUCCEEDS via the scope-admin bypass in `DagTree.requirePermission`; a non-`*`
 * non-admin token for the SAME scope is DENIED the same op — proving the success is the bypass, not
 * an open scope. (The bypass itself is also unit-covered in dag-tree.test.ts with its own
 * mutation-check; this is the end-to-end, real-WS confirmation the bootstrap-array `*` promotion
 * feeds it.)
 *
 * ⚠️ This scenario stays green under the confinement (tasks/nebula-confine-admin-bypass.md), and the
 * reason is worth stating precisely: the bypass is now granted only when `authScopePattern` covers
 * the **callee node**, and `*` covers every node. So this exercises the **covering-admin** side of
 * the predicate — it is not, on its own, evidence about the non-covering side.
 *
 * ⚠️ **Do NOT read that as "narrow the pattern here and the op is denied."** You cannot produce a
 * denial by narrowing through this harness: `connectDriver`'s mint uses
 * `instanceName: mint.issuerInstanceName ?? scope` (harness.ts), so narrowing the scope narrows the
 * pattern in lockstep and it still covers the callee; and `buildNebulaJwtPayload` throws unless
 * `aud ⊆ authScopePattern`, so a token whose pattern misses its own aud is unmintable. The shape
 * that IS denied is a pattern covering the token's own `aud` but **not the node it calls** — reach
 * it by setting `issuerInstanceName` strictly below the node under test. That escalation shape is
 * covered by scope-isolation.test.ts's `access.scopeAdmin` confinement tests (whose principal is a real
 * exact-star-scoped admin), not here.
 */
import assert from 'node:assert/strict';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { connectDriver } from '../lib/harness';

/** A `.dev` scope neither identity founded or holds a grant on. */
const TARGET = 'claude-reach.sandbox.dev';

export async function run(stack: DevStack): Promise<void> {
  // A `*` super-scopeAdmin: token issued by nebula-platform → authScopePattern '*', admin. Its aud is
  // TARGET (covered by '*'), but it holds no DAG grant there.
  const admin = await connectDriver(stack, {
    scope: TARGET,
    mint: {
      reason:
        "this scenario is ABOUT precise token shapes: a '*' pattern issued by nebula-platform while " +
        'aud is TARGET. Real login could approximate it only by depending on the bootstrap-email ' +
        'grant, which would make the test assert about bootstrap config rather than the bypass.',
      issuerInstanceName: 'nebula-platform',
    },
  });
  // A non-`*` non-admin for the SAME scope: authScopePattern TARGET, no admin, no grant.
  const control = await connectDriver(stack, {
    scope: TARGET,
    mint: {
      reason:
        'real login CANNOT produce this identity: logging in at TARGET makes you its admin, hence ' +
        'admin — and a NON-admin at TARGET is exactly the control this scenario needs.',
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
        value: { session: crypto.randomUUID(), role: 'user', content: '* super-admin reach' },
      },
    });
    assert.equal(
      adminOut.kind,
      'committed',
      `* admin should reach an ungranted scope via the access.scopeAdmin bypass, got kind=${adminOut.kind}`,
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
      `non-admin must be denied on an ungranted scope (proves the * success is the bypass), got kind=${controlOut.kind}`,
    );
  } finally {
    admin.wipe();
    admin.dispose();
    control.dispose();
  }
}
