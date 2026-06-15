/**
 * Conflict resolution through the conflict-outcome engine — v3.
 *
 * Tests `client.resources.onTransactionResourceResolution(rt, handler, options?)`
 * registration, the per-call override (a map keyed by `resourceId`), and the
 * handler verdicts on `'conflict-pending'` (`use-server` / `use-this` /
 * `human-in-the-loop`) including recursive `use-this` bounded by `maxRetries`.
 * Drives a REAL Star — this is the no-mock backing for the engine's unit suite
 * (the test-fidelity obligation in tasks/nebula-frontend.md).
 *
 * Two-level outcome (v3): the await-site sees the transaction-wide
 * `TransactionOutcome.kind` (`committed` whenever every op landed — even via
 * `use-server`; `rejected` for a per-op failure / human-in-the-loop /
 * retries-exhausted); per-resource detail is delivered to the handler and
 * mirrored on `outcome.resources[rid]`.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot, TransactionOutcome, ResourceHandler } from '@lumenize/nebula';
import { createAuthenticatedClient, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;
/** Two-type ontology for the cross-type shadow-impossibility probe. */
const TWO_TYPES = `interface TestResource { title: string; }\ninterface Note { body: string; }`;

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

/** Server snapshot from a per-resource `use-server` / `human-in-the-loop` resolution. */
function resolutionSnapshot(outcome: TransactionOutcome, rid: string): Snapshot {
  if (outcome.kind !== 'committed' && outcome.kind !== 'rejected') {
    throw new Error(`Expected committed/rejected, got ${outcome.kind}`);
  }
  const r = outcome.resources[rid];
  if (r?.kind !== 'use-server' && r?.kind !== 'human-in-the-loop') {
    throw new Error(`Expected use-server/human-in-the-loop, got ${r?.kind}`);
  }
  return r.snapshot as unknown as Snapshot;
}

async function setupAdminClient(star: string) {
  const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  const galaxyName = star.split('.').slice(0, 2).join('.');
  a.client.callGalaxyAppendOntologyVersion(galaxyName, {
    version: ONTOLOGY_VERSION,
    types: TEST_TYPES,
  });
  await vi.waitFor(() => { expect(a.client.callCompleted).toBe(true); });
  return a;
}

/** Two independent admin clients on the same Star, sharing the same scope. */
async function twoAdminClients(star: string) {
  const a = await setupAdminClient(star);
  const b = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  return { a, b };
}

/** A non-admin user (invited by `admin`) authenticated on the same Star. Starts
 *  with NO DAG grants — the caller grants what it needs via `setPermission`. */
async function setupNonAdminUser(star: string, adminAccessToken: string, email = 'user@example.com') {
  await createSubject(new Browser(), star, adminAccessToken, email);
  return createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, email);
}

/** Wait for a `callStarXxx` initiator to complete and return its `lastResult`. */
async function awaitCall(client: NebulaClientTest): Promise<unknown> {
  await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
  return client.lastResult;
}

/**
 * A creates resource X at title 'V1', updates it to 'V2-by-A', and returns the
 * stale (V1) eTag B should submit against to force a conflict.
 */
async function setupConflict(star: string, a: { client: NebulaClientTest }, b: { client: NebulaClientTest }) {
  const resourceId = generateUuid();

  const created = await a.client.resources.transaction({
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'V1' } },
  });
  const staleETag = committedETag(created, resourceId);

  const updated = await a.client.resources.transaction({
    [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-A' } },
  });
  if (updated.kind !== 'committed') throw new Error('Expected committed');

  void b; // b just needs to exist for follow-on test code
  return { resourceId, staleETag };
}

describe('nebula-client.resources.onTransactionResourceResolution (v3)', () => {

  it('per-type "use-server" handler: top-level committed, per-resource use-server writes server.value', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let conflictCalls = 0;
    b.client.resources.onTransactionResourceResolution('TestResource', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      conflictCalls++;
      return { kind: 'use-server' };
    });

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    expect(conflictCalls).toBe(1);
    expect(outcome.kind).toBe('committed'); // use-server is below the bucket
    expect(outcome.kind === 'committed' && outcome.resources[resourceId]?.kind).toBe('use-server');
    expect((resolutionSnapshot(outcome, resourceId).value as { title: string }).title).toBe('V2-by-A');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('per-type "use-this" handler retries with the server eTag + merged value (single retry succeeds)', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let conflictCalls = 0;
    b.client.resources.onTransactionResourceResolution('TestResource', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      conflictCalls++;
      const local = res.local.value as { title: string };
      const server = res.server.value as { title: string };
      return { kind: 'use-this', value: { title: `merged(${local.title} | ${server.title})` } };
    });

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    expect(conflictCalls).toBe(1);
    expect(outcome.kind).toBe('committed');

    const final = await b.client.resources.read('TestResource', resourceId);
    expect((final!.value as { title: string }).title).toBe('merged(V2-by-B | V2-by-A)');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('retries-exhausted: handler always returns use-this, A keeps mutating, B caps at maxRetries', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    // Force perpetual conflict: A races a fresh write in from inside B's
    // handler, so B's retry baseline is stale again every round.
    let conflictCalls = 0;
    const currentSnap = await a.client.resources.read('TestResource', resourceId);
    let aETag = currentSnap!.meta.eTag;

    b.client.resources.onTransactionResourceResolution('TestResource', async (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      conflictCalls++;
      const out = await a.client.resources.transaction({
        [resourceId]: { op: 'put', typeName: 'TestResource', eTag: aETag, value: { title: `A-attempt-${conflictCalls}` } },
      });
      if (out.kind === 'committed') aETag = committedETag(out, resourceId);
      return { kind: 'use-this', value: { title: `B-attempt-${conflictCalls}` } };
    }, { maxRetries: 3 });

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    // v3 maxRetries semantics: `maxRetries: 3` permits 3 RETRIES after the
    // initial submission → 4 submissions, 4 conflict-pending firings (the 4th's
    // use-this verdict is discarded when the cap is hit), `attempts: 3`. (The
    // engine fires the handler to learn the verdict before it can know whether
    // to honor it — so the exhausting attempt still fires the handler once.)
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.retryable).toBe(true);
    const r = outcome.kind === 'rejected' ? outcome.resources[resourceId] : undefined;
    expect(r?.kind).toBe('retries-exhausted');
    expect(r?.kind === 'retries-exhausted' && r.attempts).toBe(3);
    expect(conflictCalls).toBe(4);

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('human-in-the-loop: top-level rejected; optimistic state stays painted (no write-through)', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    b.client.resources.onTransactionResourceResolution('TestResource', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      return { kind: 'human-in-the-loop' };
    });

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.resources[resourceId]?.kind).toBe('human-in-the-loop');
    expect((resolutionSnapshot(outcome, resourceId).value as { title: string }).title).toBe('V2-by-A');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('per-call override (keyed by resourceId) beats per-type registration', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let perTypeCalls = 0;
    b.client.resources.onTransactionResourceResolution('TestResource', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      perTypeCalls++;
      return { kind: 'use-server' };
    });

    let perCallCalls = 0;
    const perCallHandler: ResourceHandler = (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      perCallCalls++;
      return { kind: 'human-in-the-loop' };
    };

    const outcome = await b.client.resources.transaction(
      { [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } } },
      { onTransactionResourceResolution: { [resourceId]: perCallHandler } },
    );

    expect(perTypeCalls).toBe(0); // the keyed per-call entry handled this rid; per-type never saw conflict-pending
    expect(perCallCalls).toBe(1);
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.resources[resourceId]?.kind).toBe('human-in-the-loop');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('async handler: queue timeout suspended during await (handler can take longer than the txn timeout)', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let resolverCompleted = false;
    b.client.resources.onTransactionResourceResolution('TestResource', async (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      await new Promise((r) => setTimeout(r, 200));
      resolverCompleted = true;
      return { kind: 'use-server' };
    });

    const start = Date.now();
    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });
    const elapsed = Date.now() - start;

    expect(resolverCompleted).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(outcome.kind).toBe('committed');
    expect(outcome.kind === 'committed' && outcome.resources[resourceId]?.kind).toBe('use-server');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('framework default (no registration, no override): use-server', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    expect(outcome.kind).toBe('committed');
    expect(outcome.kind === 'committed' && outcome.resources[resourceId]?.kind).toBe('use-server');
    expect((resolutionSnapshot(outcome, resourceId).value as { title: string }).title).toBe('V2-by-A');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('handler receives the originally-attempted local value + server snapshot at conflict-pending', async () => {
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let capturedLocal: { value: unknown; eTag: string } | undefined;
    let capturedServer: Snapshot | undefined;
    b.client.resources.onTransactionResourceResolution('TestResource', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      capturedLocal = res.local;
      capturedServer = res.server as unknown as Snapshot;
      return { kind: 'use-server' };
    });

    await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    expect(capturedLocal).toBeDefined();
    expect((capturedLocal!.value as { title: string }).title).toBe('V2-by-B');
    expect(capturedLocal!.eTag).toBe(staleETag);
    expect(capturedServer).toBeDefined();
    expect((capturedServer!.value as { title: string }).title).toBe('V2-by-A');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('use-this recursion: a re-conflict on the retry re-fires the handler, then succeeds', async () => {
    // The existing use-this test commits on the FIRST retry. Here A races a fresh
    // write in during the FIRST conflict handler, so B's first retry conflicts
    // AGAIN (re-anchored to A's new server snapshot) and the handler fires a 2nd
    // time before the 3rd submission lands — exercising the recursive use-this
    // chain, not just a single retry.
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let aETag = (await a.client.resources.read('TestResource', resourceId))!.meta.eTag;
    let conflictCalls = 0;
    b.client.resources.onTransactionResourceResolution('TestResource', async (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      conflictCalls++;
      if (conflictCalls === 1) {
        // Re-anchor: advance the server again so B's first retry is stale too.
        const out = await a.client.resources.transaction({
          [resourceId]: { op: 'put', typeName: 'TestResource', eTag: aETag, value: { title: 'V3-by-A' } },
        });
        aETag = committedETag(out, resourceId);
      }
      return { kind: 'use-this', value: { title: `B-merged-${conflictCalls}` } };
    });

    const outcome = await b.client.resources.transaction({
      [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } },
    });

    // Two conflict-pending firings (initial + the re-conflict), then the 3rd
    // submission commits. A single-retry-only engine would fire once and the
    // re-conflict would surface as use-server / rejected instead.
    expect(conflictCalls).toBe(2);
    expect(outcome.kind).toBe('committed');
    const final = await b.client.resources.read('TestResource', resourceId);
    expect((final!.value as { title: string }).title).toBe('B-merged-2');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('per-call override returning undefined on conflict-pending falls through to the per-type handler', async () => {
    // Distinct from "per-call beats per-type": here the per-call entry EXISTS but
    // returns undefined, so resolution must fall through to the per-type handler
    // (first non-undefined verdict wins). A "presence shadows per-type" impl would
    // leave perType at 0 and resolve via the framework default instead.
    const star = uniqueStar();
    const { a, b } = await twoAdminClients(star);
    const { resourceId, staleETag } = await setupConflict(star, a, b);

    let perTypeCalls = 0;
    b.client.resources.onTransactionResourceResolution('TestResource', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      perTypeCalls++;
      return { kind: 'use-server' };
    });

    let perCallCalls = 0;
    const outcome = await b.client.resources.transaction(
      { [resourceId]: { op: 'put', typeName: 'TestResource', eTag: staleETag, value: { title: 'V2-by-B' } } },
      {
        onTransactionResourceResolution: {
          [resourceId]: (_rid, res) => {
            if (res.kind !== 'conflict-pending') return;
            perCallCalls++;
            return undefined; // explicitly defer to the per-type handler
          },
        },
      },
    );

    expect(perCallCalls).toBe(1); // per-call fired...
    expect(perTypeCalls).toBe(1); // ...returned undefined, so per-type resolved it
    expect(outcome.kind).toBe('committed');
    expect(outcome.kind === 'committed' && outcome.resources[resourceId]?.kind).toBe('use-server');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('shadow-impossibility: a per-call entry for one rid never shadows an unlisted sibling of a different type', async () => {
    // Mixed-type batch { TestResource conflict, Note conflict } with a per-call
    // handler for the TestResource rid ONLY. The keyed (not positional) per-call
    // map means the unlisted Note rid falls through to its per-type handler. A
    // positional all-resources per-call form would apply the TestResource handler
    // to the Note too (shadowing its per-type), which this probe forbids.
    const star = uniqueStar();
    const galaxyName = star.split('.').slice(0, 2).join('.');
    const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    a.client.callGalaxyAppendOntologyVersion(galaxyName, { version: ONTOLOGY_VERSION, types: TWO_TYPES });
    await awaitCall(a.client);
    const b = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');

    // Set up a stale-eTag conflict for one resource of EACH type.
    const todoId = generateUuid();
    const noteId = generateUuid();
    const todoCreate = await a.client.resources.transaction({
      [todoId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'T1' } },
    });
    const noteCreate = await a.client.resources.transaction({
      [noteId]: { op: 'create', typeName: 'Note', nodeId: ROOT_NODE_ID, value: { body: 'N1' } },
    });
    const todoStale = committedETag(todoCreate, todoId);
    const noteStale = committedETag(noteCreate, noteId);
    // Advance both so B's eTags are stale.
    await a.client.resources.transaction({
      [todoId]: { op: 'put', typeName: 'TestResource', eTag: todoStale, value: { title: 'T2-by-A' } },
    });
    await a.client.resources.transaction({
      [noteId]: { op: 'put', typeName: 'Note', eTag: noteStale, value: { body: 'N2-by-A' } },
    });

    let notePerTypeCalls = 0;
    b.client.resources.onTransactionResourceResolution('Note', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      notePerTypeCalls++;
      return { kind: 'use-server' };
    });

    let todoPerCallCalls = 0;
    const outcome = await b.client.resources.transaction(
      {
        [todoId]: { op: 'put', typeName: 'TestResource', eTag: todoStale, value: { title: 'T2-by-B' } },
        [noteId]: { op: 'put', typeName: 'Note', eTag: noteStale, value: { body: 'N2-by-B' } },
      },
      {
        onTransactionResourceResolution: {
          [todoId]: (_rid, res) => {
            if (res.kind !== 'conflict-pending') return;
            todoPerCallCalls++;
            return { kind: 'use-this', value: { title: 'T2-merged-by-B' } };
          },
        },
      },
    );

    // The Note (unlisted in the per-call map) resolved via its per-type handler,
    // NOT the TestResource per-call handler and NOT the framework default.
    expect(todoPerCallCalls).toBe(1);
    expect(notePerTypeCalls).toBe(1);
    expect(outcome.kind).toBe('committed');
    expect(outcome.kind === 'committed' && outcome.resources[todoId]?.kind).toBe('committed'); // use-this landed
    expect(outcome.kind === 'committed' && outcome.resources[noteId]?.kind).toBe('use-server');
    const finalNote = await b.client.resources.read('Note', noteId);
    expect((finalNote!.value as { body: string }).body).toBe('N2-by-A'); // server value, via per-type
    const finalTodo = await b.client.resources.read('TestResource', todoId);
    expect((finalTodo!.value as { title: string }).title).toBe('T2-merged-by-B');

    a.client[Symbol.dispose]();
    b.client[Symbol.dispose]();
  });

  it('atomic-batch precedence: a permission-denied batchmate hides the sibling conflict (never disclosed)', async () => {
    // Security probe. A two-op batch where, had it committed, ridA would conflict
    // (use-server-resolvable) and ridB is permission-denied. The server is atomic
    // all-or-nothing and permission PRECEDES conflict in its step order, so the
    // whole batch fails on permission and ridA's conflict snapshot is NEVER
    // disclosed — a cross-user read of ridA via a wrong-eTag put is impossible.
    const star = uniqueStar();
    const admin = await setupAdminClient(star);
    const user = await setupNonAdminUser(star, admin.accessToken);
    const userSub = user.payload.sub;

    // N1: user gets write. N2: user gets nothing.
    admin.client.callStarCreateNode(star, ROOT_NODE_ID, 'shared', 'Shared');
    const n1 = (await awaitCall(admin.client)) as number;
    admin.client.callStarCreateNode(star, ROOT_NODE_ID, 'locked', 'Locked');
    const n2 = (await awaitCall(admin.client)) as number;
    admin.client.callStarSetPermission(star, n1, userSub, 'write');
    await awaitCall(admin.client);

    // ridA on N1 (user CAN write) — advance it so the user's eTag is stale → conflict.
    const ridA = generateUuid();
    const ridB = generateUuid();
    const aCreate = await admin.client.resources.transaction({
      [ridA]: { op: 'create', typeName: 'TestResource', nodeId: n1, value: { title: 'A-v1' } },
    });
    const ridAStale = committedETag(aCreate, ridA);
    await admin.client.resources.transaction({
      [ridA]: { op: 'put', typeName: 'TestResource', eTag: ridAStale, value: { title: 'A-v2' } },
    });
    // ridB on N2 (user CANNOT write).
    const bCreate = await admin.client.resources.transaction({
      [ridB]: { op: 'create', typeName: 'TestResource', nodeId: n2, value: { title: 'B-v1' } },
    });
    const ridBETag = committedETag(bCreate, ridB);

    // The user registers a use-server handler; if ridA's conflict were disclosed
    // it would fire. It must NOT — the batch dies on ridB's permission failure.
    let conflictCalls = 0;
    user.client.resources.onTransactionResourceResolution('TestResource', (_rid, res) => {
      if (res.kind !== 'conflict-pending') return;
      conflictCalls++;
      return { kind: 'use-server' };
    });

    const outcome = await user.client.resources.transaction({
      [ridA]: { op: 'put', typeName: 'TestResource', eTag: ridAStale, value: { title: 'A-by-user' } },
      [ridB]: { op: 'put', typeName: 'TestResource', eTag: ridBETag, value: { title: 'B-by-user' } },
    });

    // Whole batch rejected on permission (non-retryable); ridB is permission-denied.
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.retryable).toBe(false);
    expect(outcome.kind === 'rejected' && outcome.resources[ridB]?.kind).toBe('permission-denied');
    // ridA's conflict was NEVER disclosed: the handler never fired, and ridA is
    // not surfaced as a resolvable conflict (use-server / conflict-pending).
    expect(conflictCalls).toBe(0);
    const ridAResolution = outcome.kind === 'rejected' ? outcome.resources[ridA] : undefined;
    expect(ridAResolution?.kind).not.toBe('use-server');
    expect(ridAResolution?.kind).not.toBe('conflict-pending');
    expect(ridAResolution?.kind).not.toBe('committed');

    // Nothing landed (atomic): ridA still A-v2, ridB still B-v1.
    const finalA = await admin.client.resources.read('TestResource', ridA);
    expect((finalA!.value as { title: string }).title).toBe('A-v2');
    const finalB = await admin.client.resources.read('TestResource', ridB);
    expect((finalB!.value as { title: string }).title).toBe('B-v1');

    admin.client[Symbol.dispose]();
    user.client[Symbol.dispose]();
  });
});
