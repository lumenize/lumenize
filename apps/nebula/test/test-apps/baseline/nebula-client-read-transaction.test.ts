/**
 * NebulaClient.resources.read + .transaction — Phase 5.3.3b
 *
 * Covers:
 *   - `client.resources.read(rt, rid)` Promise correlation via requestId
 *   - `client.resources.transaction(ops, options?)` always-resolve contract
 *     with `TransactionResolution` (committed / validation-failed /
 *     permission-denied / use-server / timeout)
 *   - Serial in-flight queue (sequential transactions applied in order)
 *   - Idempotency: retrying with the same `newETag` returns `committed`
 *     without double-writing
 *   - Per-transaction `newETag` (lifted from internal to API surface in 5.3.3b)
 *
 * Conflict-resolver-driven outcomes (`use-this`, `retries-exhausted`,
 * `human-in-the-loop`) land in Phase 5.3.3c.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
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

describe('nebula-client.resources.read (5.3.3b)', () => {

  it('read() resolves with the snapshot for an existing resource', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    // Use the new client.resources.transaction to create
    const created = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Read me' } },
    });
    expect(created.resolution).toBe('committed');
    if (created.resolution !== 'committed') throw new Error('Expected committed');

    const snap = await client.resources.read('TestResource', resourceId);
    expect(snap).not.toBeNull();
    expect(snap!.value.title).toBe('Read me');
    expect(snap!.meta.eTag).toBe(created.eTag);

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
    expect(a!.value.title).toBe('Concurrent');
    expect(b!.value.title).toBe('Concurrent');
    expect(c!.value.title).toBe('Concurrent');

    client[Symbol.dispose]();
  });
});

describe('nebula-client.resources.transaction (5.3.3b)', () => {

  it('committed: happy-path create resolves with committed outcome + eTag', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Hi' } },
    });
    expect(outcome.resolution).toBe('committed');
    if (outcome.resolution !== 'committed') throw new Error('Expected committed');
    expect(outcome.eTag).toBeDefined();

    // Verify by reading back
    const snap = await client.resources.read('TestResource', resourceId);
    expect(snap!.value.title).toBe('Hi');
    expect(snap!.meta.eTag).toBe(outcome.eTag);

    client[Symbol.dispose]();
  });

  it('validation-failed: bad value resolves with validation-failed', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    // title must be string per TEST_TYPES; pass a number instead
    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 42 as unknown as string } },
    });
    expect(outcome.resolution).toBe('validation-failed');
    if (outcome.resolution !== 'validation-failed') throw new Error('Expected validation-failed');
    expect(outcome.errors[resourceId]).toBeDefined();

    client[Symbol.dispose]();
  });

  it('validation-failed: bad value on put resolves with validation-failed (regression probe for hypothesis 1)', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    const created = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Valid' } },
    });
    if (created.resolution !== 'committed') throw new Error('Expected committed');

    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'put', eTag: created.eTag, value: { title: 42 as unknown as string } },
    });
    expect(outcome.resolution).toBe('validation-failed');
    if (outcome.resolution !== 'validation-failed') throw new Error('Expected validation-failed');
    expect(outcome.errors[resourceId]).toBeDefined();

    client[Symbol.dispose]();
  });

  it('permission-denied: non-admin user write resolves with permission-denied', async () => {
    const star = uniqueStar();
    const { client: admin, accessToken } = await setupAdminClient(star);
    const resourceId = generateUuid();

    // Create resource at private node
    admin.callStarCreateNode(star, ROOT_NODE_ID, 'private', 'Private');
    await vi.waitFor(() => { expect(admin.callCompleted).toBe(true); }, { timeout: 5000 });
    const nodeId = admin.lastResult as number;

    const createOutcome = await admin.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId, value: { title: 'Secret' } },
    });
    if (createOutcome.resolution !== 'committed') throw new Error('Expected committed');

    // User with no permission tries to overwrite
    const { client: user } = await setupUserClient(star, accessToken);
    const outcome = await user.resources.transaction({
      [resourceId]: { op: 'put', eTag: createOutcome.eTag, value: { title: 'Hacked' } },
    });
    expect(outcome.resolution).toBe('permission-denied');
    if (outcome.resolution !== 'permission-denied') throw new Error('Expected permission-denied');
    expect(outcome.resources).toContain(resourceId);

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });

  it('no-disclosure: unauthorized put with a WRONG eTag resolves permission-denied — never a snapshot', async () => {
    const star = uniqueStar();
    const { client: admin, accessToken } = await setupAdminClient(star);
    const resourceId = generateUuid();

    // Resource at a private node the user holds no grant on
    admin.callStarCreateNode(star, ROOT_NODE_ID, 'private', 'Private');
    await vi.waitFor(() => { expect(admin.callCompleted).toBe(true); }, { timeout: 5000 });
    const nodeId = admin.lastResult as number;

    const createOutcome = await admin.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId, value: { title: 'Secret-v1' } },
    });
    if (createOutcome.resolution !== 'committed') throw new Error('Expected committed');

    // Unauthorized user probes with a deliberately WRONG eTag. A conflict
    // decided before the permission gate (an early-return at Step 4.5b) would
    // hand back the full currentSnapshot — a permission-free read. Correct
    // behavior: permission wins (Step 8 precedes Step 9) and the outcome
    // carries no resource value/meta.
    const { client: user } = await setupUserClient(star, accessToken);
    const outcome = await user.resources.transaction({
      [resourceId]: { op: 'put', eTag: crypto.randomUUID(), value: { title: 'probe' } },
    });
    expect(outcome.resolution).toBe('permission-denied');
    if (outcome.resolution !== 'permission-denied') throw new Error('Expected permission-denied, never conflict/use-server');
    expect(JSON.stringify(outcome)).not.toContain('Secret-v1');

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });

  it('conflict + invalid value co-occurring resolves as conflict (use-server), not validation-failed', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    const created = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'V1' } },
    });
    if (created.resolution !== 'committed') throw new Error('Expected committed');
    const eTag1 = created.eTag;

    const update = await client.resources.transaction({
      [resourceId]: { op: 'put', eTag: eTag1, value: { title: 'V2' } },
    });
    if (update.resolution !== 'committed') throw new Error('Expected committed');

    // STALE eTag AND an invalid value (title must be a string). The Step-4.5b
    // skip-hint excludes the doomed op from the validator batch, so the
    // conflict surfaces at Step 9 and the resolver (default use-server)
    // decides — not validation-failed. Gut the skip and this test fails.
    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'put', eTag: eTag1, value: { title: 42 as unknown as string } },
    });
    expect(outcome.resolution).toBe('use-server');
    if (outcome.resolution !== 'use-server') throw new Error('Expected use-server (conflict wins over validation)');
    expect(outcome.resources[resourceId].value.title).toBe('V2');

    client[Symbol.dispose]();
  });

  it('idempotency: retrying the identical create op with the same newETag returns committed (not "already exists")', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();
    const sharedETag = crypto.randomUUID();

    // The identical op the client replays on a dropped-response retry.
    const createOp = { op: 'create' as const, typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'V1' } };

    // First submission with explicit newETag → creates the resource at sharedETag.
    const first = await client.resources.transaction({ [resourceId]: createOp }, { newETag: sharedETag });
    expect(first.resolution).toBe('committed');
    if (first.resolution !== 'committed') throw new Error('Expected committed');
    expect(first.eTag).toBe(sharedETag);

    const snap1 = await client.resources.read('TestResource', resourceId);
    expect(snap1!.meta.validFrom).toBeDefined();
    const firstValidFrom = snap1!.meta.validFrom;

    // Retry the IDENTICAL create with the SAME newETag — the real network-drop
    // replay shape (B3). Idempotency (the pre-validator fast-fail + the
    // authoritative in-txn re-check) must short-circuit to committed BEFORE op
    // validation, which would otherwise throw "Resource already exists" and
    // surface as infrastructure-error, rolling back a write that landed.
    const second = await client.resources.transaction({ [resourceId]: createOp }, { newETag: sharedETag });
    expect(second.resolution).toBe('committed');
    if (second.resolution !== 'committed') throw new Error('Expected committed (idempotent create replay)');
    expect(second.eTag).toBe(sharedETag);

    // No rewrite happened — value + validFrom unchanged.
    const snap2 = await client.resources.read('TestResource', resourceId);
    expect(snap2!.value.title).toBe('V1');
    expect(snap2!.meta.validFrom).toBe(firstValidFrom);

    client[Symbol.dispose]();
  });

  it('idempotency: partial-churn multi-resource replay still returns committed (.some, not .every)', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const idA = generateUuid();
    const idB = generateUuid();
    const batchETag = crypto.randomUUID();

    const batch = {
      [idA]: { op: 'create' as const, typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'A1' } },
      [idB]: { op: 'create' as const, typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'B1' } },
    };

    // Original atomic batch lands → both A and B at batchETag.
    const first = await client.resources.transaction(batch, { newETag: batchETag });
    expect(first.resolution).toBe('committed');

    // A third party mutates B alone, moving B's eTag off batchETag.
    const churn = await client.resources.transaction(
      { [idB]: { op: 'put', eTag: batchETag, value: { title: 'B2-by-other' } } },
      { newETag: crypto.randomUUID() },
    );
    expect(churn.resolution).toBe('committed');

    // Retry the IDENTICAL original batch with the same batchETag. A is still at
    // batchETag, B is not. `.some` detects the replay via A (the whole batch
    // committed atomically); `.every` would miss it and the create on A would
    // throw "already exists".
    const replay = await client.resources.transaction(batch, { newETag: batchETag });
    expect(replay.resolution).toBe('committed');
    if (replay.resolution !== 'committed') throw new Error('Expected committed (partial-churn replay)');

    // The replay wrote nothing — B keeps the third party's value, A unchanged.
    const snapB = await client.resources.read('TestResource', idB);
    expect(snapB!.value.title).toBe('B2-by-other');
    const snapA = await client.resources.read('TestResource', idA);
    expect(snapA!.value.title).toBe('A1');

    client[Symbol.dispose]();
  });

  it('sequential transactions chain eTags in order', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = generateUuid();

    // Create resource first (serial — wait for completion)
    const created = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Initial' } },
    });
    if (created.resolution !== 'committed') throw new Error('Expected committed');
    let currentETag = created.eTag;

    // Three sequential updates, each chaining off the previous outcome's eTag.
    // This proves sequential eTag chaining only — the true concurrent-buffering
    // property (submit-before-resolve buffers and chains) lands with the
    // per-resource serial queue (tasks/debounce-serial-queue.md D0 / v3).
    const out1Promise = client.resources.transaction({
      [resourceId]: { op: 'put', eTag: currentETag, value: { title: 'Update 1' } },
    });
    // out2 uses the eTag from out1's outcome — but we want concurrency, so
    // we'd need the eTag *after* out1. With serial queueing, out2 submitted
    // before out1 resolves would carry the original eTag and conflict.
    // For this test we verify ordering through await-then-await chaining.
    const out1 = await out1Promise;
    expect(out1.resolution).toBe('committed');
    if (out1.resolution !== 'committed') throw new Error('Expected committed');
    currentETag = out1.eTag;

    const out2 = await client.resources.transaction({
      [resourceId]: { op: 'put', eTag: currentETag, value: { title: 'Update 2' } },
    });
    expect(out2.resolution).toBe('committed');
    if (out2.resolution !== 'committed') throw new Error('Expected committed');
    currentETag = out2.eTag;

    const out3 = await client.resources.transaction({
      [resourceId]: { op: 'put', eTag: currentETag, value: { title: 'Update 3' } },
    });
    expect(out3.resolution).toBe('committed');

    const final = await client.resources.read('TestResource', resourceId);
    expect(final!.value.title).toBe('Update 3');

    client[Symbol.dispose]();
  });

  it('use-server (5.3.3b default): eTag conflict resolves with use-server + writes server.value to bound state', async () => {
    const star = uniqueStar();
    const { client: a, accessToken } = await setupAdminClient(star);
    const b = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const resourceId = generateUuid();

    // a creates and gets eTag-1
    const created = await a.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'V1' } },
    });
    if (created.resolution !== 'committed') throw new Error('Expected committed');
    const eTag1 = created.eTag;

    // a updates → eTag-2
    const update = await a.resources.transaction({
      [resourceId]: { op: 'put', eTag: eTag1, value: { title: 'V2-by-A' } },
    });
    if (update.resolution !== 'committed') throw new Error('Expected committed');

    // b tries to update with the STALE eTag-1 — should conflict
    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', eTag: eTag1, value: { title: 'V2-by-B' } },
    });
    expect(outcome.resolution).toBe('use-server');
    if (outcome.resolution !== 'use-server') throw new Error('Expected use-server');
    expect(outcome.resources[resourceId]).toBeDefined();
    expect(outcome.resources[resourceId].value.title).toBe('V2-by-A');

    // Track that accessToken is unused; just verify b has same admin scope
    void accessToken;

    a[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });
});
