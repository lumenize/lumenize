/**
 * Child 2 Phase 2 — per-push read recheck (Flow 2 / D3) in the capability's
 * `#broadcast`. Closes the subscribe-time-only gap Child 1 carried into the
 * capability, so it protects Star AND DevStudio (tested here on Star; the
 * capability code is identical on both hosts — DevStudio composition is proven by
 * devstudio-resources-e2e).
 *
 * Two pinned behaviors:
 *   1. A subscriber whose read grant is REVOKED stops receiving content pushes but
 *      its sub row REMAINS (no drop — ADR-008 / D5).
 *   2. A `claims.access.admin` subscriber with NO DAG grant still receives pushes
 *      (the stored-accessAdmin bypass — D16).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { SubscriberRow } from '@lumenize/nebula';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

const uniqueUniverse = () => `u-${generateUuid().slice(0, 8)}`;

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));
}
async function waitForSuccess(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}
async function waitForUpdateCount(client: NebulaClientTest, n: number) {
  await vi.waitFor(() => expect(client.resourceUpdateCount).toBeGreaterThanOrEqual(n));
}

/** Founder star-admin: connects (seeds ROOT admin), installs the ontology. */
async function founder(star: string) {
  const f = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  f.client.callStarApplyOntology(star, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
  await waitForResult(f.client);
  return f;
}

describe('child2 per-push read recheck (Phase 2 / D3)', () => {
  it('revoked subscriber stops receiving content pushes; its sub row remains (D5 never-drop)', async () => {
    const star = `${uniqueUniverse()}.app.tenant-a`;
    const { client: admin, payload: adminPayload } = await founder(star);

    // Private node + a resource on it.
    admin.callStarCreateNode(star, ROOT_NODE_ID, 'priv', 'Private');
    await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
    const nodeId = admin.lastResult as number;
    const rid = generateUuid();
    admin.callStarTransaction(star, ONTOLOGY_VERSION, {
      [rid]: { op: 'create', typeName: 'TestResource', nodeId, value: { title: 'v0' } },
    });
    const created = await waitForSuccess(admin) as { ok: true; eTags: Record<string, string> };
    let eTag = created.eTags[rid];

    // A non-admin user, granted read on the node, subscribes.
    const adminBrowser = new Browser();
    const { accessToken } = await browserLogin(adminBrowser, star, 'admin@example.com', star);
    await createSubject(adminBrowser, star, accessToken, 'coach@example.com');
    const { client: user, payload: userPayload } =
      await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'coach@example.com');
    admin.callStarSetPermission(star, nodeId, userPayload.sub, 'read');
    await waitForSuccess(admin);

    user.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', rid);
    await waitForUpdateCount(user, 1); // initial push

    // A second always-granted subscriber (admin → accessAdmin bypass) acts as the
    // deterministic anchor: once IT receives a push, the broadcast loop for that
    // mutation has run, so the user's (non-)push has been decided — no setTimeout.
    const { client: anchor } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    anchor.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', rid);
    await waitForUpdateCount(anchor, 1);

    // Baseline: while granted, the user RECEIVES the fanout.
    admin.callStarTransaction(star, ONTOLOGY_VERSION, {
      [rid]: { op: 'put', eTag, value: { title: 'v1' } },
    });
    const r1 = await waitForSuccess(admin) as { ok: true; eTags: Record<string, string> };
    eTag = r1.eTags[rid];
    await waitForUpdateCount(user, 2);
    await waitForUpdateCount(anchor, 2);
    const userCountAfterGrant = user.resourceUpdateCount;

    // Revoke the user's read, then mutate again.
    admin.callStarRevokePermission(star, nodeId, userPayload.sub);
    await waitForSuccess(admin);
    admin.callStarTransaction(star, ONTOLOGY_VERSION, {
      [rid]: { op: 'put', eTag, value: { title: 'v2-after-revoke' } },
    });
    await waitForSuccess(admin);
    // Anchor (still granted) receives v2 → the broadcast loop for this mutation ran.
    await waitForUpdateCount(anchor, 3);
    expect((anchor.lastResourceUpdate?.snapshot?.value as { title?: string })?.title).toBe('v2-after-revoke');

    // The revoked user did NOT receive the post-revoke push (recheck skipped it).
    // Mutation: remove the recheck → user gets the push, count climbs → red.
    expect(user.resourceUpdateCount).toBe(userCountAfterGrant);

    // But the user's sub row REMAINS (never dropped — D5).
    admin.callStarInspectSubscribers(star);
    const rows = await waitForSuccess(admin) as SubscriberRow[];
    expect(rows.some((r) => r.clientId === user.lmz.instanceName && r.resourceId === rid)).toBe(true);

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
    anchor[Symbol.dispose]();
  });

  it('a claims.access.admin subscriber with NO DAG grant still receives pushes (D16)', async () => {
    const universe = uniqueUniverse();
    const star = `${universe}.app.tenant-a`;
    // Star-admin connects FIRST → becomes founder (the sole ROOT admin grant).
    const { client: admin } = await founder(star);
    const rid = generateUuid();
    admin.callStarTransaction(star, ONTOLOGY_VERSION, {
      [rid]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'v0' } },
    });
    const created = await waitForSuccess(admin) as { ok: true; eTags: Record<string, string> };
    const eTag = created.eTags[rid];

    // A UNIVERSE admin connects after the founder latch is set → access.admin: true
    // but NO DAG grant of its own. Its Subscribers row stores accessAdmin = 1.
    const { client: uni } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), universe, star, 'universe-admin@example.com');
    uni.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', rid);
    await waitForUpdateCount(uni, 1);

    // Founder mutates → the universe admin RECEIVES the push purely via the stored
    // accessAdmin bypass (it holds no DAG grant). Mutation: ignore stored
    // accessAdmin → evaluatePermissions denies it → no push → red.
    admin.callStarTransaction(star, ONTOLOGY_VERSION, {
      [rid]: { op: 'put', eTag, value: { title: 'v1' } },
    });
    await waitForSuccess(admin);
    await waitForUpdateCount(uni, 2);
    expect((uni.lastResourceUpdate?.snapshot?.value as { title?: string })?.title).toBe('v1');

    admin[Symbol.dispose]();
    uni[Symbol.dispose]();
  });
});
