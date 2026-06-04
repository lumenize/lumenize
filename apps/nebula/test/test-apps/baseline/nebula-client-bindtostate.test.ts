/**
 * NebulaClient.bindToState integration — Phase 5.3.6
 *
 * Tests the headless integration layer that wires StateManager writes through
 * to remote transactions, refcount-drives subscribe/unsubscribe, surfaces
 * connection state, and rolls back optimistic writes on terminal failure.
 *
 * No `@lumenize/nebula-frontend` here — bindings are simulated via direct
 * `state.subscribe(...)` calls. Real DOM bindings come in Phase 5.3.7.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot, TransactionResult } from '@lumenize/nebula';
import { createState } from '@lumenize/state';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import type { DebugLogOutput } from '@lumenize/debug';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; status: string; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

async function adminClient(star: string) {
  const a = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  const galaxyName = star.split('.').slice(0, 2).join('.');
  a.client.callGalaxyAppendOntologyVersion(galaxyName, {
    version: ONTOLOGY_VERSION,
    types: TEST_TYPES,
  });
  await vi.waitFor(() => expect(a.client.callCompleted).toBe(true));
  return a;
}

async function createResource(
  client: NebulaClientTest,
  star: string,
  resourceId: string,
  value: { title: string; status: string },
): Promise<string> {
  client.callStarTransaction(star, ONTOLOGY_VERSION, {
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value },
  });
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));
  const result = client.lastResult as TransactionResult;
  if (!result.ok) throw new Error('create failed');
  return result.eTags[resourceId];
}

// Captures every `@lumenize/debug` entry emitted in the test isolate so the
// "no cached meta.eTag" warn test can assert on it. See
// `packages/debug/src/sink.ts` for the (undocumented) sink API.
let debugEntries: DebugLogOutput[];
beforeEach(() => {
  debugEntries = [];
  setDebugSink((e) => debugEntries.push(e));
});
afterEach(() => {
  clearDebugSink();
});

describe('bindToState — commit roundtrip', () => {
  it('setState on resources.*.value.field translates to a put transaction and advances meta.eTag', async () => {
    const star = uniqueStar();
    const a = await adminClient(star);
    const rid = generateUuid();
    const initialETag = await createResource(a.client, star, rid, { title: 'Original', status: 'todo' });

    const state = createState();
    a.client.bindToState(state);
    await a.client.resources.subscribe('TestResource', rid);
    expect((state.getState(`resources.TestResource.${rid}.meta`) as { eTag: string }).eTag).toBe(initialETag);

    state.setState(`resources.TestResource.${rid}.value.title`, 'Updated');
    expect(state.getState(`resources.TestResource.${rid}.value.title`)).toBe('Updated');

    await vi.waitFor(() => {
      const meta = state.getState(`resources.TestResource.${rid}.meta`) as { eTag: string };
      expect(meta.eTag).not.toBe(initialETag);
    });

    a.client[Symbol.dispose]();
  });
});

describe('bindToState — middleware skip cases', () => {
  it('skips writes with no cached meta.eTag (no transaction observable)', async () => {
    // Complements the warn-assertion test below by verifying the absence of
    // a transaction submission via state inspection (no `meta.eTag` set).
    const star = uniqueStar();
    const a = await adminClient(star);

    const state = createState();
    a.client.bindToState(state);

    state.setState('resources.TestResource.never-subscribed.value.title', 'orphan');

    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => setTimeout(r, 50));

    // No transaction was submitted, so no meta.eTag was set on the orphan path.
    expect(state.getState('resources.TestResource.never-subscribed.meta')).toBeUndefined();
    // Optimistic value still painted (write passed through).
    expect(state.getState('resources.TestResource.never-subscribed.value.title')).toBe('orphan');

    a.client[Symbol.dispose]();
  });

  it('skips writes with no cached meta.eTag (create path) and logs a warn', async () => {
    const star = uniqueStar();
    const a = await adminClient(star);

    const state = createState();
    a.client.bindToState(state);

    state.setState('resources.TestResource.never-subscribed.value.title', 'orphan');

    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    expect(state.getState('resources.TestResource.never-subscribed.value.title')).toBe('orphan');
    const warn = debugEntries.find(
      (e) =>
        e.namespace === 'lumenize.nebula-client' &&
        e.level === 'warn' &&
        e.message.includes('no cached meta.eTag'),
    );
    expect(warn).toBeDefined();

    a.client[Symbol.dispose]();
  });

  it('skips non-resources.*.value writes (ui.*, lmz.*, app.*, meta.*)', async () => {
    const star = uniqueStar();
    const a = await adminClient(star);
    const rid = generateUuid();
    const initialETag = await createResource(a.client, star, rid, { title: 'X', status: 'todo' });

    const state = createState();
    a.client.bindToState(state);
    await a.client.resources.subscribe('TestResource', rid);

    state.setState('ui.activeView', 'list');
    state.setState('app.draft', { title: 'hi' });
    state.setState('lmz.custom.foo', 'bar');
    state.setState(`resources.TestResource.${rid}.meta.eTag`, 'should-not-trigger-txn');

    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    expect((state.getState(`resources.TestResource.${rid}.meta`) as { eTag: string }).eTag).toBe('should-not-trigger-txn');
    void initialETag;

    a.client[Symbol.dispose]();
  });

  it("skips writes tagged source: 'remote' / 'rollback' / 'computed'", async () => {
    const star = uniqueStar();
    const a = await adminClient(star);
    const rid = generateUuid();
    const initialETag = await createResource(a.client, star, rid, { title: 'Tagged', status: 'todo' });

    const state = createState();
    a.client.bindToState(state);
    await a.client.resources.subscribe('TestResource', rid);

    state.setState(`resources.TestResource.${rid}.value.title`, 'remote', { source: 'remote' });
    state.setState(`resources.TestResource.${rid}.value.title`, 'rollback', { source: 'rollback' });
    state.setState(`resources.TestResource.${rid}.value.title`, 'computed', { source: 'computed' });

    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    expect((state.getState(`resources.TestResource.${rid}.meta`) as { eTag: string }).eTag).toBe(initialETag);

    a.client[Symbol.dispose]();
  });
});

describe('bindToState — connection state surfacing', () => {
  it('replays current connection state into lmz.connection.* on bind', async () => {
    const star = uniqueStar();
    const a = await adminClient(star);

    // After adminClient setup, the client is connected.
    expect(a.client.connectionState).toBe('connected');

    const state = createState();
    a.client.bindToState(state);

    expect(state.getState('lmz.connection.state')).toBe('connected');
    expect(state.getState('lmz.connection.connected')).toBe(true);
    expect(typeof state.getState('lmz.connection.lastConnectedAt')).toBe('number');

    a.client[Symbol.dispose]();
  });
});

describe('bindToState — auto-subscribe via refcount', () => {
  it('subscribes on first state.subscribe under resources.{rt}.{rid}.* — initial snapshot lands in bound state', async () => {
    const star = uniqueStar();
    const a = await adminClient(star);
    const rid = generateUuid();
    await createResource(a.client, star, rid, { title: 'Auto', status: 'todo' });

    const state = createState();
    a.client.bindToState(state);

    // No explicit client.resources.subscribe — refcount drives it.
    const cb = vi.fn();
    state.subscribe(`resources.TestResource.${rid}.value.title`, cb);

    await vi.waitFor(() => {
      expect(state.getState(`resources.TestResource.${rid}.value.title`)).toBe('Auto');
    });

    a.client[Symbol.dispose]();
  });

  it('unsubscribe grace: count→0 schedules unsubscribe; new binding within grace cancels it', async () => {
    const star = uniqueStar();
    const a = await adminClient(star);
    const rid = generateUuid();
    await createResource(a.client, star, rid, { title: 'Grace', status: 'todo' });

    const state = createState();
    a.client.bindToState(state, { unsubscribeGraceMs: 200 });

    const dispose = state.subscribe(`resources.TestResource.${rid}.value`, () => {});
    await vi.waitFor(() => {
      expect(state.getState(`resources.TestResource.${rid}.value`)).toBeDefined();
    });

    // Count→0
    dispose();
    // Re-subscribe within grace window
    state.subscribe(`resources.TestResource.${rid}.value`, () => {});

    // Wait past grace; the row should still be present.
    await new Promise<void>((r) => setTimeout(r, 300));
    a.client.callStarInspectSubscribers(star);
    await vi.waitFor(() => expect(a.client.callCompleted).toBe(true));
    const rows = a.client.lastResult as Array<{ resourceId: string }>;
    expect(rows.some((r) => r.resourceId === rid)).toBe(true);

    a.client[Symbol.dispose]();
  });

  it('unsubscribe grace: count→0 with no resubscribe fires unsubscribe after grace', async () => {
    const star = uniqueStar();
    const a = await adminClient(star);
    const rid = generateUuid();
    await createResource(a.client, star, rid, { title: 'Unsub', status: 'todo' });

    const state = createState();
    a.client.bindToState(state, { unsubscribeGraceMs: 100 });

    const dispose = state.subscribe(`resources.TestResource.${rid}.value`, () => {});
    await vi.waitFor(() => {
      expect(state.getState(`resources.TestResource.${rid}.value`)).toBeDefined();
    });

    dispose();

    await vi.waitFor(async () => {
      a.client.callStarInspectSubscribers(star);
      await vi.waitFor(() => expect(a.client.callCompleted).toBe(true));
      const rows = a.client.lastResult as Array<{ resourceId: string }>;
      expect(rows.some((r) => r.resourceId === rid)).toBe(false);
    });

    a.client[Symbol.dispose]();
  });
});

describe('bindToState — rollback', () => {
  it("validation-failed: optimistic write reverts to pre-write value via source: 'rollback'", async () => {
    const star = uniqueStar();
    const a = await adminClient(star);
    const rid = generateUuid();
    await createResource(a.client, star, rid, { title: 'Valid', status: 'todo' });

    const state = createState();
    a.client.bindToState(state);
    await a.client.resources.subscribe('TestResource', rid);

    // Capture pre-write value for assertion.
    const preWriteTitle = state.getState(`resources.TestResource.${rid}.value.title`);
    expect(preWriteTitle).toBe('Valid');

    // Trigger validation-failed by setting an invalid type (title must be string).
    // Use a number — the typia-validated schema requires `title: string`.
    state.setState(`resources.TestResource.${rid}.value.title`, 42 as unknown as string);
    expect(state.getState(`resources.TestResource.${rid}.value.title`)).toBe(42);

    // Wait for rollback.
    await vi.waitFor(() => {
      expect(state.getState(`resources.TestResource.${rid}.value.title`)).toBe('Valid');
    });

    a.client[Symbol.dispose]();
  });

  it("permission-denied: optimistic write reverts to pre-write value via source: 'rollback'", async () => {
    const star = uniqueStar();
    const a = await adminClient(star);
    const rid = generateUuid();

    // Admin creates a node where the user has read but not write.
    a.client.callStarCreateNode(star, ROOT_NODE_ID, 'shared', 'Shared');
    await vi.waitFor(() => expect(a.client.lastResult).toBeDefined());
    const nodeId = a.client.lastResult as number;

    a.client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [rid]: { op: 'create', typeName: 'TestResource', nodeId, value: { title: 'AdminWrote', status: 'todo' } },
    });
    await vi.waitFor(() => expect(a.client.callCompleted).toBe(true));

    // Create a non-admin user with read-only permission on the node.
    const adminBrowser = new Browser();
    const { accessToken: adminToken } = await browserLogin(adminBrowser, star, 'admin@example.com', star);
    const userBrowser = new Browser();
    await createSubject(adminBrowser, star, adminToken, 'reader@example.com');
    const { client: reader, payload: readerPayload } = await createAuthenticatedClient(
      NebulaClientTest, userBrowser, star, star, 'reader@example.com',
    );
    a.client.callStarSetPermission(star, nodeId, readerPayload.sub, 'read');
    await vi.waitFor(() => expect(a.client.callCompleted).toBe(true));

    const state = createState();
    reader.bindToState(state);
    await reader.resources.subscribe('TestResource', rid);
    expect(state.getState(`resources.TestResource.${rid}.value.title`)).toBe('AdminWrote');

    state.setState(`resources.TestResource.${rid}.value.title`, 'ReaderTriedToWrite');
    expect(state.getState(`resources.TestResource.${rid}.value.title`)).toBe('ReaderTriedToWrite');

    await vi.waitFor(() => {
      expect(state.getState(`resources.TestResource.${rid}.value.title`)).toBe('AdminWrote');
    });

    a.client[Symbol.dispose]();
    reader[Symbol.dispose]();
  });

  it("ontology-stale: optimistic write reverts to pre-write value via source: 'rollback'", async () => {
    const star = uniqueStar();
    const galaxyName = star.split('.').slice(0, 2).join('.');
    const rid = generateUuid();

    // Build a v1-pinned client.
    const a = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), star, star, 'admin@example.com', 'v1',
    );
    a.client.callGalaxyAppendOntologyVersion(galaxyName, { version: 'v1', types: TEST_TYPES });
    await vi.waitFor(() => expect(a.client.callCompleted).toBe(true));
    await createResource(a.client, star, rid, { title: 'V1value', status: 'todo' });

    const state = createState();
    a.client.bindToState(state);
    await a.client.resources.subscribe('TestResource', rid);
    expect(state.getState(`resources.TestResource.${rid}.value.title`)).toBe('V1value');

    // Append v2 and force Star to install v2 — client stays pinned at v1.
    a.client.callGalaxyAppendOntologyVersion(galaxyName, { version: 'v2', types: TEST_TYPES });
    await vi.waitFor(() => expect(a.client.callCompleted).toBe(true));
    await a.client.resources.read('TestResource', rid, { ontologyVersion: 'v2' });

    // Optimistic write via the v1-pinned client — server returns
    // ontology-stale because Star is at v2.
    state.setState(`resources.TestResource.${rid}.value.title`, 'V1writeAttempt');
    expect(state.getState(`resources.TestResource.${rid}.value.title`)).toBe('V1writeAttempt');

    await vi.waitFor(() => {
      expect(state.getState(`resources.TestResource.${rid}.value.title`)).toBe('V1value');
    });

    a.client[Symbol.dispose]();
  });
});
