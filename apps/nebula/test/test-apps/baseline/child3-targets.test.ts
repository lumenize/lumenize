/**
 * Child 3 Phase 2 — `targetsForQuery` per-operand accessor test (Stage-2 M4).
 *
 * `targetsForQuery(query, nodeId)` filters the query's subscribers by
 * `evaluatePermissions([nodeId], 'read', sub, accessAdmin).allowed.size > 0` — a
 * COMPOUND gate (`accessAdmin || resolvePermission`). testing.md:29 requires each
 * operand be exercised + mutation-checked independently. Three subscribers on
 * DevStudio's session query, all on ONE node:
 *   - admin@example.com  → access.admin, NO DAG grant → IN via the accessAdmin operand
 *   - granted (non-admin) → explicit read grant       → IN via the resolvePermission operand
 *   - denied  (non-admin) → no grant                  → OUT (the negative)
 *
 * Mutation-checks (run by the verifier / by hand against resource-data-plane.ts):
 *   - force `.allowed.size > 0` always-true → `denied` leaks into targets → red
 *   - force `Boolean(r.accessAdmin)` → false → `admin` drops out → red
 * `targetsForQuery` only inspects SUBSCRIBERS + their permission on `nodeId` (not query
 * membership), so no Messages are created — the query `value` is arbitrary.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { QueryDescriptor } from '@lumenize/nebula';
import { adminClientAt, createInvitedClient, browserLogin, foundAndLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const uniqueDevScope = () => `c3t-${generateUuid().slice(0, 8)}.app.dev`;

function devClient(scope: string, email = 'admin@example.com') {
  return adminClientAt(
    NebulaClientTest, new Browser(), scope, scope, email, 'v1',
    { resourceHostBinding: 'DEV_STUDIO' },
  );
}

describe('child3 Phase 2 — targetsForQuery per-operand (M4)', () => {
  it('includes the accessAdmin-bypass + read-granted subscribers, excludes the read-denied one', async () => {
    const scope = uniqueDevScope();
    const { client: admin, accessToken } = await devClient(scope);
    const S = generateUuid();
    const query: QueryDescriptor = { queryType: 'parentChild', typeName: 'Message', field: 'session', value: S };

    // A node the admin has NO explicit grant on (DevStudio seeds no root admin — the
    // admin acts purely via the access.admin bypass), so the admin subscriber exercises
    // the accessAdmin operand in isolation.
    const node = await admin.orgTree.createNode(crypto.randomUUID(), ROOT_NODE_ID, 'sess', 'Session node');

    // Non-admin "granted": explicit read on `node`.
    const adminBrowser = new Browser();
    await foundAndLogin(adminBrowser, scope, 'admin@example.com', scope);
    await createSubject(adminBrowser, scope, accessToken, 'granted@example.com');
    const { client: granted, payload: grantedP } = await createInvitedClient(
      NebulaClientTest, new Browser(), scope, scope, 'granted@example.com', 'v1', { resourceHostBinding: 'DEV_STUDIO' });
    await admin.orgTree.setPermission(node, grantedP.sub, 'read');

    // Non-admin "denied": no grant anywhere.
    await createSubject(adminBrowser, scope, accessToken, 'denied@example.com');
    const { client: denied } = await createInvitedClient(
      NebulaClientTest, new Browser(), scope, scope, 'denied@example.com', 'v1', { resourceHostBinding: 'DEV_STUDIO' });

    // All three subscribe the SAME session query → three QuerySubs rows (each carrying
    // its own sub + accessAdmin flag). subscribeQuery always succeeds (no gate at
    // subscribe); permission is enforced per-push / per-target.
    using sa = admin.resources.subscribeQuery(query); await sa.ready;
    using sg = granted.resources.subscribeQuery(query); await sg.ready;
    using sd = denied.resources.subscribeQuery(query); await sd.ready;

    // The accessor, evaluated against `node`.
    admin.callDevStudioInspectQueryTargets(scope, query, node);
    await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
    expect(admin.lastError).toBeUndefined();
    const targets = admin.lastResult as string[];

    expect(targets).toContain(admin.lmz.instanceName);    // accessAdmin operand
    expect(targets).toContain(granted.lmz.instanceName);  // resolvePermission operand
    expect(targets).not.toContain(denied.lmz.instanceName); // neither → excluded
    expect(targets.length).toBe(2);

    admin[Symbol.dispose](); granted[Symbol.dispose](); denied[Symbol.dispose]();
  });
});
