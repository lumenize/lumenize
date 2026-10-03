/**
 * Per-push read recheck in the capability's `#broadcast`. Closes the gap of
 * checking a read only at subscribe time, so it protects Star AND Galaxy (tested here on Star; the
 * capability code is identical on both hosts — Galaxy composition is proven by
 * devstudio-resources-e2e).
 *
 * Two pinned behaviors:
 *   1. A subscriber whose read grant is REVOKED is told so — the next update carries
 *      `{ deniedNodes: [nodeId] }`, never the content — and its row REMAINS (no drop,
 *      ADR-008). Asserted on the RAW frame, since the client drops keys it does not read.
 *   2. A `claims.access.scopeAdmin` subscriber with NO DAG grant still receives pushes
 *      (the stored-dominionOverHostAtSubscribe bypass).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { SubscriberRow } from '@lumenize/nebula';
import {
  adminClientAt, createInvitedClient, createPlatformAdminClient, foundAndLogin, createSubject, ownerOf,
} from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

const uniqueUniverse = () => `u-${crypto.randomUUID().slice(0, 8)}`;

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

/** Star-scoped admin: connects, installs the ontology. */
async function starAdmin(star: string) {
  const f = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  f.client.callStarInstallOntology(star, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
  await waitForResult(f.client);
  return f;
}

describe('per-push read recheck', () => {
  it('revoked subscriber is told the node it lost, never the content; its row remains (never-drop)', async () => {
    const star = `${uniqueUniverse()}.app.tenant-a`;
    const { client: admin, payload: adminPayload } = await starAdmin(star);

    // Private node + a resource on it.
    admin.callStarCreateNode(star, ROOT_NODE_ID, 'priv', 'Private');
    await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
    const nodeId = admin.lastResult as string;
    const rid = crypto.randomUUID();
    admin.callStarTransaction(star, ONTOLOGY_VERSION, {
      [rid]: { op: 'create', typeName: 'TestResource', nodeId, value: { title: 'v0' } },
    });
    const created = await waitForSuccess(admin) as { ok: true; eTags: Record<string, string> };
    let eTag = created.eTags[rid];

    // A non-admin user, granted read on the node, subscribes.
    const adminBrowser = new Browser();
    const { accessToken } = await foundAndLogin(adminBrowser, star, ownerOf('admin@example.com'), star);
    await createSubject(adminBrowser, star, accessToken, 'coach@example.com');
    const { client: user, payload: userPayload } =
      await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'coach@example.com');
    admin.callStarSetPermission(star, nodeId, userPayload.sub, 'read');
    await waitForSuccess(admin);

    user.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', rid);
    await waitForUpdateCount(user, 1); // initial push

    // A second always-granted subscriber (admin → dominionOverHostAtSubscribe bypass) acts as the
    // deterministic anchor: once IT receives a push, the broadcast loop for that
    // mutation has run, so the user's (non-)push has been decided — no setTimeout.
    const { client: anchor } = await adminClientAt(
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

    // The revoked user is told it lost read, and gets nothing from the snapshot. Asserted on
    // CONTENT, not a count: a leak and a denial are both one push. Mutations: remove the recheck
    // (it gets `v2-after-revoke`), restore the skip (nothing arrives), send the denial as an
    // Error, or attach the snapshot to it → each reds here.
    await vi.waitFor(() => expect(user.resourceUpdateCount).toBeGreaterThan(userCountAfterGrant));
    expect(user.lastResourceResult).toEqual({ deniedNodes: [nodeId] });

    // But the user's sub row REMAINS (never dropped, ADR-008).
    admin.callStarInspectSubscribers(star);
    const rows = await waitForSuccess(admin) as SubscriberRow[];
    expect(rows.some((r) => r.clientId === user.lmz.instanceName && r.resourceId === rid)).toBe(true);

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
    anchor[Symbol.dispose]();
  });

  it('a claims.access.scopeAdmin subscriber with NO DAG grant still receives pushes', async () => {
    const universe = uniqueUniverse();
    const star = `${universe}.app.tenant-a`;
    // The Star's admin connects and writes the resource.
    const { client: admin } = await starAdmin(star);
    const rid = crypto.randomUUID();
    admin.callStarTransaction(star, ONTOLOGY_VERSION, {
      [rid]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'v0' } },
    });
    const created = await waitForSuccess(admin) as { ok: true; eTags: Record<string, string> };
    const eTag = created.eTags[rid];

    // A second admin subscribes: access.scopeAdmin true, and no DAG grant, as no scope admin is
    // given one by being an admin. Its resource row stores dominionOverHostAtSubscribe = 1. It is
    // the platform bootstrap admin, on this Star's page.
    const { client: uni, payload: uniPayload } = await createPlatformAdminClient(
      NebulaClientTest, new Browser(), star);
    // Fixture guards — BOTH premises this test rests on, neither previously pinned:
    //   (1) it really is a scope-admin whose pattern covers this Star (else the stored verdict is
    //       0 and the push below would be explained by something other than the bypass);
    //   (2) it really holds NO DAG grant. If this identity ever acquired a root grant, the test
    //       would stay green while the bypass it exists to prove went untested.
    expect(uniPayload.access?.scopeAdmin).toBe(true);
    expect(uniPayload.access?.authScope).toBe('_platform');
    admin.callStarGetEffectivePermission(star, ROOT_NODE_ID, uniPayload.sub);
    expect(await waitForSuccess(admin)).toBeNull(); // no DAG grant of its own
    uni.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', rid);
    await waitForUpdateCount(uni, 1);

    // The star-scoped admin mutates → the universe admin RECEIVES the push purely via the stored
    // dominionOverHostAtSubscribe bypass (it holds no DAG grant). Mutation: ignore stored
    // dominionOverHostAtSubscribe → evaluatePermissions denies it → no push → red.
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
