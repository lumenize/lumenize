/**
 * NebulaClient.resources.read + .transaction — v3 (engine-wired).
 *
 * Covers:
 *   - `client.resources.read(rt, rid)` Promise correlation via requestId
 *   - `client.resources.transaction(ops, options?)` always-resolve contract
 *     with the two-level `TransactionOutcome` (top-level `committed` / `rejected`
 *     + per-resource `committed` / `validation-failed` / `permission-denied` /
 *     `use-server`)
 *   - Sequential transactions chain versions in order
 *
 * Drives a REAL Star (the no-mock backing for the engine's unit suite).
 *
 * NOTE: the explicit-`moment` idempotency-replay probes from the 5.3.3b shape
 * are removed — `moment` is engine-internal in v3 (the queue generates it; a
 * reconnect re-sends the SAME one). That replay path is unit-tested by the
 * engine's connection-gated-rollback test (Mn8, "reconnect replays the SAME
 * moment → committed") and the server short-circuit by star-resources Step
 * 4.5a; the full real-Star idempotency matrix is rebuilt in §5.3.8 (P10).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/resources';
import type { Snapshot, TransactionOutcome } from '@lumenize/resources';
import { adminClientAt, createInvitedClient, foundAndLogin, createSubject, ownerOf } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

function uniqueStar(): string {
  return `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;
}

/** Pull the committed version for `rid` out of a committed outcome. */
function committedMoment(outcome: TransactionOutcome, rid: string): string {
  if (outcome.kind !== 'committed') throw new Error(`Expected committed, got ${outcome.kind}`);
  const r = outcome.resources[rid];
  if (r?.kind !== 'committed') throw new Error(`Expected committed resource, got ${r?.kind}`);
  return r.validFrom;
}

/** Server snapshot from a per-resource `use-server` resolution. */
function useServerSnapshot(outcome: TransactionOutcome, rid: string): Snapshot {
  if (outcome.kind !== 'committed') throw new Error(`Expected committed, got ${outcome.kind}`);
  const r = outcome.resources[rid];
  if (r?.kind !== 'use-server') throw new Error(`Expected use-server, got ${r?.kind}`);
  return r.snapshot as unknown as Snapshot;
}

async function setupAdminClient(star: string) {
  const a = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  const galaxyName = star.split('.').slice(0, 2).join('.');
  a.client.callStarInstallOntology(star, {
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
  await foundAndLogin(adminBrowser, star, ownerOf('admin@example.com'));
  const userBrowser = new Browser();
  await createSubject(adminBrowser, star, adminAccessToken, email);
  return createInvitedClient(NebulaClientTest, userBrowser, star, star, email);
}

describe('nebula-client.resources.read (v3)', () => {

  it('read() resolves with the snapshot for an existing resource', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = crypto.randomUUID();

    const created = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Read me' } },
    });
    const version = committedMoment(created, resourceId);

    const snap = await client.resources.read('TestResource', resourceId);
    expect(snap).not.toBeNull();
    expect((snap!.value as { title: string }).title).toBe('Read me');
    expect(snap!.meta.validFrom).toBe(version);

    client[Symbol.dispose]();
  });

  it('read() resolves with null for a non-existent resource', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);

    const snap = await client.resources.read('TestResource', crypto.randomUUID());
    expect(snap).toBeNull();

    client[Symbol.dispose]();
  });

  it('concurrent read() calls to the same resource are independently correlated', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = crypto.randomUUID();

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

  it('retired submit-gate (D7/M2): two transactions to DIFFERENT resources are concurrently in-flight', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const ridA = crypto.randomUUID();
    const ridB = crypto.randomUUID();

    // Fire two transactions to DISTINCT resources WITHOUT awaiting. With the submit-gate RETIRED (D7),
    // both submit immediately, so both `callAsync` Promises sit in `#pendingAsyncCalls` at once. This
    // asserts the TRANSIENT surface (M2), not a self-healing "both committed" end-state. Capable-of-
    // failing: re-add a serial client gate (or the old #inFlightSubmit) and the 2nd transaction queues →
    // the count never reaches 2 → this `vi.waitFor` times out.
    const pA = client.resources.transaction({
      [ridA]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'A' } },
    });
    const pB = client.resources.transaction({
      [ridB]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'B' } },
    });

    await vi.waitFor(() => {
      expect(client.getPendingAsyncCallCount()).toBeGreaterThanOrEqual(2);
    }, { timeout: 3000 });

    const [oA, oB] = await Promise.all([pA, pB]);
    expect(oA.kind).toBe('committed');
    expect(oB.kind).toBe('committed');
    expect(client.getPendingAsyncCallCount()).toBe(0); // both settled + cleaned up (no leak)

    client[Symbol.dispose]();
  });

  it('committed: happy-path create resolves top-level committed + per-resource version', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = crypto.randomUUID();

    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Hi' } },
    });
    expect(outcome.kind).toBe('committed');
    const version = committedMoment(outcome, resourceId);

    const snap = await client.resources.read('TestResource', resourceId);
    expect((snap!.value as { title: string }).title).toBe('Hi');
    expect(snap!.meta.validFrom).toBe(version);

    client[Symbol.dispose]();
  });

  it('an empty transaction settles at once as committed with no resources', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    // Raced, because the failure this guards is a Promise that never settles. Mutation: send the
    // empty batch through the queue → it occupies no key, never concludes, and the race times out.
    const outcome = await Promise.race([
      client.resources.transaction({}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the empty transaction never settled')), 3000)),
    ]);
    expect(outcome).toEqual({ kind: 'committed', resources: {} });
    client[Symbol.dispose]();
  });

  it('validation-failed: bad value resolves rejected + per-resource validation-failed', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = crypto.randomUUID();

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
    const resourceId = crypto.randomUUID();

    const created = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Valid' } },
    });
    const version = committedMoment(created, resourceId);

    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', ifValidFromMatches: version, value: { title: 42 as unknown as string } },
    });
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.resources[resourceId]?.kind).toBe('validation-failed');

    client[Symbol.dispose]();
  });

  it('permission-denied: non-admin user write resolves rejected + permission-denied', async () => {
    const star = uniqueStar();
    const { client: admin, accessToken } = await setupAdminClient(star);
    const resourceId = crypto.randomUUID();

    admin.callStarCreateNode(star, ROOT_NODE_ID, 'private', 'Private');
    await vi.waitFor(() => { expect(admin.callCompleted).toBe(true); }, { timeout: 5000 });
    const nodeId = admin.lastResult as string;

    const createOutcome = await admin.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId, value: { title: 'Secret' } },
    });
    const version = committedMoment(createOutcome, resourceId);

    const { client: user } = await setupUserClient(star, accessToken);
    const outcome = await user.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', ifValidFromMatches: version, value: { title: 'Hacked' } },
    });
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.resources[resourceId]?.kind).toBe('permission-denied');

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });

  it('no-disclosure: unauthorized put with a WRONG version resolves permission-denied — never a snapshot', async () => {
    const star = uniqueStar();
    const { client: admin, accessToken } = await setupAdminClient(star);
    const resourceId = crypto.randomUUID();

    admin.callStarCreateNode(star, ROOT_NODE_ID, 'private', 'Private');
    await vi.waitFor(() => { expect(admin.callCompleted).toBe(true); }, { timeout: 5000 });
    const nodeId = admin.lastResult as string;

    const createOutcome = await admin.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId, value: { title: 'Secret-v1' } },
    });
    committedMoment(createOutcome, resourceId);

    // Unauthorized user probes with a deliberately WRONG version. A conflict
    // decided before the permission gate (Step 4.5b early-return) would hand
    // back the full currentSnapshot — a permission-free read. Correct behavior:
    // permission wins (Step 8 precedes Step 9) and the outcome carries no value.
    const { client: user } = await setupUserClient(star, accessToken);
    const outcome = await user.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', ifValidFromMatches: crypto.randomUUID(), value: { title: 'probe' } },
    });
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.resources[resourceId]?.kind).toBe('permission-denied');
    expect(JSON.stringify(outcome)).not.toContain('Secret-v1');

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });

  it('a stale put with an invalid value: the conflict wins when another writer moved the resource on', async () => {
    const star = uniqueStar();
    const { client, accessToken } = await setupAdminClient(star);
    const { client: other, payload } = await setupUserClient(star, accessToken, 'other@example.com');
    await client.orgTree.setPermission(ROOT_NODE_ID, payload.sub, 'write');
    const resourceId = crypto.randomUUID();

    const created = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'V1' } },
    });
    const v1 = committedMoment(created, resourceId);
    const update = await other.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', ifValidFromMatches: v1, value: { title: 'V2' } },
    });
    if (update.kind !== 'committed') throw new Error('Expected committed');

    // A stale version AND an invalid value. Someone else wrote what followed v1, so this cannot be
    // a repeat: the Step-4.5b hint keeps it out of the validator, the conflict surfaces at Step 9,
    // and the default resolver (use-server) decides. Mutation: validate every suspect → this reads
    // validation-failed.
    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', ifValidFromMatches: v1, value: { title: 42 as unknown as string } },
    });
    expect(outcome.kind).toBe('committed'); // use-server is below the bucket
    expect(outcome.kind === 'committed' && outcome.resources[resourceId]?.kind).toBe('use-server');
    expect((useServerSnapshot(outcome, resourceId).value as { title: string }).title).toBe('V2');

    client[Symbol.dispose](); other[Symbol.dispose]();
  });

  it('a stale put with an invalid value from the writer of the newer version is validated, so validation-failed wins', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const resourceId = crypto.randomUUID();

    const created = await client.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'V1' } },
    });
    const v1 = committedMoment(created, resourceId);
    const update = await client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', ifValidFromMatches: v1, value: { title: 'V2' } },
    });
    if (update.kind !== 'committed') throw new Error('Expected committed');

    // The same writer wrote what followed v1, so this might be a repeat of that write, whose value
    // recognition compares after the validator fills it: it reaches the validator, and the invalid
    // value answers first. Mutation: let Step 4.5b skip every suspect → this resolves use-server.
    const outcome = await client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', ifValidFromMatches: v1, value: { title: 42 as unknown as string } },
    });
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.resources[resourceId]?.kind).toBe('validation-failed');

    client[Symbol.dispose]();
  });


  it('throws synchronously when the version cannot be auto-derived (resource not in local store)', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);

    // A put naming no version, for a resource the client never created/subscribed —
    // a programming error surfaced as a synchronous throw, NOT a server reject
    // or an opaque outcome.
    expect(() =>
      client.resources.transaction({
        [crypto.randomUUID()]: { op: 'put', typeName: 'TestResource', value: { title: 'orphan' } },
      }),
    ).toThrow(/can't auto-derive ifValidFromMatches/);

    client[Symbol.dispose]();
  });

  it('explicit version bypasses auto-derive (works even when the resource is absent from the local store)', async () => {
    const star = uniqueStar();
    const { client: a } = await setupAdminClient(star);
    const b = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    const resourceId = crypto.randomUUID();

    const created = await a.resources.transaction({
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'V1' } },
    });
    const version = committedMoment(created, resourceId);

    // b never created/subscribed this resource, so its local store is empty —
    // an OMITTED version would throw. The EXPLICIT version bypasses the store lookup.
    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', ifValidFromMatches: version, value: { title: 'V2-by-B' } },
    });
    expect(outcome.kind).toBe('committed');

    a[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('multi-resource batch mixes auto-derived and explicit versions', async () => {
    const star = uniqueStar();
    const { client } = await setupAdminClient(star);
    const ridAuto = crypto.randomUUID();
    const ridExplicit = crypto.randomUUID();

    const created = await client.resources.transaction({
      [ridAuto]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'A1' } },
      [ridExplicit]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'B1' } },
    });
    const explicitVersion = committedMoment(created, ridExplicit);

    const outcome = await client.resources.transaction({
      [ridAuto]: { op: 'put', typeName: 'TestResource', value: { title: 'A2' } },                 // auto-derived
      [ridExplicit]: { op: 'put', typeName: 'TestResource', ifValidFromMatches: explicitVersion, value: { title: 'B2' } }, // explicit
    });
    expect(outcome.kind).toBe('committed');
    expect((await client.resources.read('TestResource', ridAuto))!.value).toMatchObject({ title: 'A2' });
    expect((await client.resources.read('TestResource', ridExplicit))!.value).toMatchObject({ title: 'B2' });

    client[Symbol.dispose]();
  });
});
