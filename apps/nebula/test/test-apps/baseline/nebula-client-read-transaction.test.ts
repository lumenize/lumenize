/**
 * NebulaClient.resources.read + .transaction — v3 (engine-wired).
 *
 * Covers:
 *   - `client.resources.read(rt, rid)` Promise correlation via requestId
 *   - `client.resources.transaction(ops, options?)` always-resolve contract
 *     with the two-level `TransactionOutcome` (top-level `committed` / `rejected`
 *     + per-resource `committed` / `validation-failed` / `permission-denied` /
 *     `use-server`)
 *   - Sequential transactions chain eTags in order
 *
 * Drives a REAL Star (the no-mock backing for the engine's unit suite).
 *
 * NOTE: the explicit-`newETag` idempotency-replay probes from the 5.3.3b shape
 * are removed — `newETag` is engine-internal in v3 (the queue generates it; a
 * reconnect re-sends the SAME one). That replay path is unit-tested by the
 * engine's connection-gated-rollback test (Mn8, "reconnect replays the SAME
 * newETag → committed") and the server short-circuit by star-resources Step
 * 4.5a; the full real-Star idempotency matrix is rebuilt in §5.3.8 (P10).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot, TransactionOutcome } from '@lumenize/nebula';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

/** Pull the committed eTag for `rid` out of a committed outcome. */
function committedETag(outcome: TransactionOutcome, rid: string): string {
  if (outcome.kind !== 'committed') throw new Error(`Expected committed, got ${outcome.kind}`);
  const r = outcome.resources[rid];
  if (r?.kind !== 'committed') throw new Error(`Expected committed resource, got ${r?.kind}`);
  return r.eTag;
}

/** Server snapshot from a per-resource `use-server` resolution. */
function useServerSnapshot(outcome: TransactionOutcome, rid: string): Snapshot {
  if (outcome.kind !== 'committed') throw new Error(`Expected committed, got ${outcome.kind}`);
  const r = outcome.resources[rid];
  if (r?.kind !== 'use-server') throw new Error(`Expected use-server, got ${r?.kind}`);
  return r.snapshot as unknown as Snapshot;
}

async function setupAdminClient(star: string) {
  const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  const galaxyName = star.split('.').slice(0, 2).join('.');
  a.client.callGalaxyAppendOntologyVersion(galaxyName, {
    version: ONTOLOGY_VERSION,
    types: TEST_TYPES,
  });
  await vi.waitFor(() => {
    expect(a.client.callCompleted).toBe(true);
  }, { timeout: 5000 });
  return a;
}

async function setupUserClient(star: string, adminAccessToken: string, email = 'user@example.com') {
  const adminBrowser = new Browser();
  await browserLogin(adminBrowser, star, 'admin@example.com', star);
  const userBrowser = new Browser();
  await createSubject(adminBrowser, star, adminAccessToken, email);
  return createAuthenticatedClient(NebulaClientTest, userBrowser, star, star, email);
}

describe('nebula-client.resources.read (v3)', () => {

  it('read() resolves with the snapshot for an existing resource', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    const created = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Read me' } },
    });
    const eTag = committedETag(created, resourceId);

    const snap = await client.resources.read('TestResource', resourceId);
    expect(snap).not.toBeNull();
    expect((snap!.value as { title: string }).title).toBe('Read me');
    expect(snap!.meta.eTag).toBe(eTag);

    client[Symbol.dispose]();
  });

  it('read() resolves with null for a non-existent resource', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);

    const snap = await client.resources.read('TestResource', generateUuid());
    expect(snap).toBeNull();

    client[Symbol.dispose]();
  });

  it('concurrent read() calls to the same resource are independently correlated', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Concurrent' } },
    });

    const [a, b, c] = await Promise.all([
      client.resources.read('TestResource', resourceId),
      client.resources.read('TestResource', resourceId),
      client.resources.read('TestResource', resourceId),
    ]);
    expect((a!.value as { title: string }).title).toBe('Concurrent');
    expect((b!.value as { title: string }).title).toBe('Concurrent');
    expect((c!.value as { title: string }).title).toBe('Concurrent');

    client[Symbol.dispose]();
  });
});

describe('nebula-client.resources.transaction (v3)', () => {

  it('committed: happy-path create resolves top-level committed + per-resource eTag', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Hi' } },
    });
    expect(outcome.kind).toBe('committed');
    const eTag = committedETag(outcome, resourceId);

    const snap = await client.resources.read('TestResource', resourceId);
    expect((snap!.value as { title: string }).title).toBe('Hi');
    expect(snap!.meta.eTag).toBe(eTag);

    client[Symbol.dispose]();
  });

  it('validation-failed: bad value resolves rejected + per-resource validation-failed', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    // title must be string per TEST_TYPES; pass a number instead
    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 42 as unknown as string } },
    });
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.resources[resourceId]?.kind).toBe('validation-failed');
    const r = outcome.kind === 'rejected' ? outcome.resources[resourceId] : undefined;
    expect(r?.kind === 'validation-failed' && r.errors).toBeDefined();

    client[Symbol.dispose]();
  });

  it('validation-failed: bad value on put resolves rejected + validation-failed', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    const created = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Valid' } },
    });
    const eTag = committedETag(created, resourceId);

    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag, value: { title: 42 as unknown as string } },
    });
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.resources[resourceId]?.kind).toBe('validation-failed');

    client[Symbol.dispose]();
  });

  it('permission-denied: non-admin user write resolves rejected + permission-denied', async () => {
    const star = uniqueStar();
    const { client: admin, accessToken } = await setupAdminClient(star);
    const resourceId = generateUuid();

    admin.callStarCreateNode(star, ROOT_NODE_ID, 'private', 'Private');
    await vi.waitFor(() => { expect(admin.callCompleted).toBe(true); }, { timeout: 5000 });
    const nodeId = admin.lastResult as number;

    const createOutcome = await admin.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId, value: { title: 'Secret' } },
    });
    const eTag = committedETag(createOutcome, resourceId);

    const { client: user } = await setupUserClient(star, accessToken);
    const outcome = await user.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag, value: { title: 'Hacked' } },
    });
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.resources[resourceId]?.kind).toBe('permission-denied');

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });

  it('no-disclosure: unauthorized put with a WRONG eTag resolves permission-denied — never a snapshot', async () => {
    const star = uniqueStar();
    const { client: admin, accessToken } = await setupAdminClient(star);
    const resourceId = generateUuid();

    admin.callStarCreateNode(star, ROOT_NODE_ID, 'private', 'Private');
    await vi.waitFor(() => { expect(admin.callCompleted).toBe(true); }, { timeout: 5000 });
    const nodeId = admin.lastResult as number;

    const createOutcome = await admin.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId, value: { title: 'Secret-v1' } },
    });
    committedETag(createOutcome, resourceId);

    // Unauthorized user probes with a deliberately WRONG eTag. A conflict
    // decided before the permission gate (Step 4.5b early-return) would hand
    // back the full currentSnapshot — a permission-free read. Correct behavior:
    // permission wins (Step 8 precedes Step 9) and the outcome carries no value.
    const { client: user } = await setupUserClient(star, accessToken);
    const outcome = await user.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: crypto.randomUUID(), value: { title: 'probe' } },
    });
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.resources[resourceId]?.kind).toBe('permission-denied');
    expect(JSON.stringify(outcome)).not.toContain('Secret-v1');

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });

  it('conflict + invalid value co-occurring resolves committed via use-server, not validation-failed', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    const created = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'V1' } },
    });
    const eTag1 = committedETag(created, resourceId);

    const update = await client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: eTag1, value: { title: 'V2' } },
    });
    if (update.kind !== 'committed') throw new Error('Expected committed');

    // STALE eTag AND an invalid value. The Step-4.5b skip-hint excludes the
    // doomed op from validation, so the conflict surfaces at Step 9 and the
    // default resolver (use-server) decides — not validation-failed.
    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: eTag1, value: { title: 42 as unknown as string } },
    });
    expect(outcome.kind).toBe('committed'); // use-server is below the bucket
    expect(outcome.kind === 'committed' && outcome.resources[resourceId]?.kind).toBe('use-server');
    expect((useServerSnapshot(outcome, resourceId).value as { title: string }).title).toBe('V2');

    client[Symbol.dispose]();
  });

  it('sequential transactions chain eTags in order', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    const created = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Initial' } },
    });
    let currentETag = committedETag(created, resourceId);

    const out1 = await client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: currentETag, value: { title: 'Update 1' } },
    });
    currentETag = committedETag(out1, resourceId);

    const out2 = await client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: currentETag, value: { title: 'Update 2' } },
    });
    currentETag = committedETag(out2, resourceId);

    const out3 = await client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: currentETag, value: { title: 'Update 3' } },
    });
    expect(out3.kind).toBe('committed');

    const final = await client.resources.read('TestResource', resourceId);
    expect((final!.value as { title: string }).title).toBe('Update 3');

    client[Symbol.dispose]();
  });

  it('default resolver: eTag conflict resolves committed via use-server (server value wins)', async () => {
    const star = uniqueStar();
    const { client: a, accessToken } = await setupAdminClient(star);
    const b = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const resourceId = generateUuid();

    const created = await a.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'V1' } },
    });
    const eTag1 = committedETag(created, resourceId);

    const update = await a.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: eTag1, value: { title: 'V2-by-A' } },
    });
    if (update.kind !== 'committed') throw new Error('Expected committed');

    // b tries to update with the STALE eTag-1 — should conflict → use-server.
    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: eTag1, value: { title: 'V2-by-B' } },
    });
    expect(outcome.kind).toBe('committed');
    expect(outcome.kind === 'committed' && outcome.resources[resourceId]?.kind).toBe('use-server');
    expect((useServerSnapshot(outcome, resourceId).value as { title: string }).title).toBe('V2-by-A');

    void accessToken;
    a[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });
});
