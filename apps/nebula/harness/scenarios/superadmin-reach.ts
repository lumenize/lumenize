/**
 * Phase-3a acceptance B2-(i), realized via the Phase-1 client (the natural home for "drive a real
 * resource op") — `tasks/claude-live-verification.md`.
 *
 * Capable-of-failing on the ENFORCEMENT path (not just the isAdmin flag): a `*` super-admin token
 * (issued by `nebula-platform` → `access.authScopePattern: '*'`, admin) reaches a scope it has NO
 * DAG grant on and SUCCEEDS via the `access.admin` bypass (dag-tree.ts:159); a non-`*` non-admin
 * token for the SAME scope is DENIED the same op — proving the success is the bypass, not an open
 * scope. (The bypass itself is also unit-covered in dag-tree.test.ts with its own mutation-check;
 * this is the end-to-end, real-WS confirmation the bootstrap-array `*` promotion feeds it.)
 */
import assert from 'node:assert/strict';
import { ROOT_NODE_ID } from '@lumenize/nebula/client';
import { generateUuid } from '@lumenize/auth/client';
import type { DevStack } from '../lib/harness';
import { connectDriver } from '../lib/harness';

/** A `.dev` scope neither identity founded or holds a grant on. */
const TARGET = 'claude-reach.sandbox.dev';

export async function run(stack: DevStack): Promise<void> {
  // A `*` super-admin: token issued by nebula-platform → authScopePattern '*', admin. Its aud is
  // TARGET (covered by '*'), but it holds no DAG grant there.
  const admin = await connectDriver(stack, {
    scope: TARGET,
    issuerInstanceName: 'nebula-platform',
    email: 'claude@lumenize.io',
  });
  // A non-`*` non-admin for the SAME scope: authScopePattern TARGET, no admin, no grant.
  const control = await connectDriver(stack, {
    scope: TARGET,
    issuerInstanceName: TARGET,
    isAdmin: false,
    email: 'nobody@lumenize.io',
  });

  try {
    const adminOut = await admin.client.resources.transaction({
      [generateUuid()]: {
        op: 'create',
        typeName: 'Message',
        nodeId: ROOT_NODE_ID,
        value: { session: generateUuid(), role: 'user', content: '* super-admin reach' },
      },
    });
    assert.equal(
      adminOut.kind,
      'committed',
      `* admin should reach an ungranted scope via the access.admin bypass, got kind=${adminOut.kind}`,
    );

    const controlOut = await control.client.resources.transaction({
      [generateUuid()]: {
        op: 'create',
        typeName: 'Message',
        nodeId: ROOT_NODE_ID,
        value: { session: generateUuid(), role: 'user', content: 'should be denied' },
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
