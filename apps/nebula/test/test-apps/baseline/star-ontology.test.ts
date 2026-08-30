/**
 * Ontology integration tests
 *
 * Tests Star cache hit/miss, version mismatch, and validation integration through
 * `callStarApplyOntology` (client-side compile → `Star.setOntology`). The old
 * "Galaxy ontology" registry block died with the Galaxy's test-install method
 * (tasks/archive/nebula-move-compilers-out-of-the-worker.md phase 3) — its duplicate-label /
 * index-listing / latest-round-trip assertions covered that method's own behaviour
 * and cannot outlive it; the surviving registry write path is the dev Apply
 * (`appendWorkspaceOntology`), covered in the dev-studio project.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot, TransactionResult, TransactionError } from '@lumenize/nebula';
import { adminClientAt, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

// ─── Helpers ─────────────────────────────────────────────────────────

function uniqueStar(): string {
  return `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;
}

function galaxyName(star: string): string {
  return star.split('.').slice(0, 2).join('.');
}

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => {
    expect(client.callCompleted).toBe(true);
  });
}

async function waitForSuccess(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}

async function waitForError(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeDefined();
  return client.lastError!;
}

/** A real STAR-scoped admin — exact-star pattern, inert at every ancestor. The default here. */
async function adminClient(star: string) {
  const browser = new Browser();
  return adminClientAt(NebulaClientTest, browser, star, star, 'admin@example.com');
}

const TODO_TYPES = `
  interface Todo { title: string; done: boolean; }
  interface Person { name: string; email: string; }
`;

const TODO_V2_TYPES = `
  interface Todo {
    title: string;
    done: boolean;
    /** @default "medium" */
    priority?: string;
  }
  interface Person { name: string; email: string; phone?: string; }
`;

// ─── Star Cache & Galaxy Fetch ───────────────────────────────────────

describe('Star ontology cache', () => {

  it('cache hit — transaction completes without Galaxy fetch (second call)', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);
    const resourceId = crypto.randomUUID();

    // Register ontology
    client.callStarApplyOntology(star, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    // First transaction — triggers Galaxy fetch (cache miss)
    client.callStarTransaction(star, 'v1', {
      [resourceId]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Fix bug', done: false } },
    });
    const r1 = await waitForSuccess(client) as TransactionResult;
    expect(r1.ok).toBe(true);

    // Second transaction — should use cache (no Galaxy fetch needed)
    const r2Id = crypto.randomUUID();
    client.callStarTransaction(star, 'v1', {
      [r2Id]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Write docs', done: false } },
    });
    const r2 = await waitForSuccess(client) as TransactionResult;
    expect(r2.ok).toBe(true);

    client[Symbol.dispose]();
  });

  it('unknown ontologyVersion — version-mismatch error delivered to client', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callStarApplyOntology(star, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    // Client tagged a version that doesn't exist on Galaxy. Star fetches latest
    // (v1) and rejects because the tag doesn't match.
    client.callStarTransaction(star, 'v999', {
      [crypto.randomUUID()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'X', done: false } },
    });
    const error = await waitForError(client);
    expect(error).toContain('version mismatch');
    expect(error).toContain("'v999'");
    expect(error).toContain("'v1'");

    client[Symbol.dispose]();
  });

  it('Star with no ontology set — stale signal (no current version) delivered to client', async () => {
    const star = uniqueStar();
    const { client } = await adminClient(star);

    // No ontology applied to the Star yet. Phase 4 retired the Galaxy lazy-pull, so a
    // versioned op against an ontology-less Star is a version mismatch (current = '')
    // rather than the old "not found" — the client is told to refresh.
    client.callStarTransaction(star, 'v1', {
      [crypto.randomUUID()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'X', done: false } },
    });
    const error = await waitForError(client);
    expect(error).toContain('version mismatch');
    expect(error).toContain("'v1'");

    client[Symbol.dispose]();
  });

  it('version mismatch — client sends stale version', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    // Register v1 and v2
    client.callStarApplyOntology(star, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);
    client.callStarApplyOntology(star, { version: 'v2', types: TODO_V2_TYPES });
    await waitForSuccess(client);

    // Force Star to fetch latest (v2) by sending v2 first
    client.callStarTransaction(star, 'v2', {
      [crypto.randomUUID()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Seed', done: false, priority: 'high' } },
    });
    await waitForSuccess(client);

    // Now send v1 — should get version mismatch
    client.callStarTransaction(star, 'v1', {
      [crypto.randomUUID()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Stale', done: false } },
    });
    const error = await waitForError(client);
    expect(error).toContain('version mismatch');
    expect(error).toContain('Refresh your schema');

    client[Symbol.dispose]();
  });
});

// ─── Validation Integration ──────────────────────────────────────────

describe('validation integration', () => {

  it('valid create passes validation', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callStarApplyOntology(star, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    client.callStarTransaction(star, 'v1', {
      [crypto.randomUUID()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Fix bug', done: false } },
    });
    const result = await waitForSuccess(client) as TransactionResult;
    expect(result.ok).toBe(true);

    client[Symbol.dispose]();
  });

  it('invalid create returns validation errors', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callStarApplyOntology(star, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    // Missing required field 'done', wrong type for 'title'
    client.callStarTransaction(star, 'v1', {
      [crypto.randomUUID()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 123 } },
    });
    const result = await waitForSuccess(client) as TransactionResult;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const errors = Object.values(result.errors);
      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe('validation');
      if (errors[0].type === 'validation') {
        expect(errors[0].errors.length).toBeGreaterThan(0);
      }
    }

    client[Symbol.dispose]();
  });

  it('defaults applied on create', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callStarApplyOntology(star, {
      version: 'v1',
      types: TODO_V2_TYPES,
    });
    await waitForSuccess(client);

    const resourceId = crypto.randomUUID();
    // Omit 'priority' — `@default "medium"` JSDoc tag should fill it
    client.callStarTransaction(star, 'v1', {
      [resourceId]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Fix bug', done: false } },
    });
    const result = await waitForSuccess(client) as TransactionResult;
    expect(result.ok).toBe(true);

    // Read back — priority should be 'medium'
    client.callStarRead(star, 'v1', resourceId);
    const snap = await waitForSuccess(client) as Snapshot;
    expect(snap.value.priority).toBe('medium');

    client[Symbol.dispose]();
  });

  it('put validation — full value checked', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callStarApplyOntology(star, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    const resourceId = crypto.randomUUID();
    client.callStarTransaction(star, 'v1', {
      [resourceId]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Fix', done: false } },
    });
    const r1 = await waitForSuccess(client) as TransactionResult;
    if (!r1.ok) throw new Error('Expected ok');

    // Put with invalid value
    client.callStarTransaction(star, 'v1', {
      [resourceId]: { op: 'put', eTag: r1.eTags[resourceId], value: { title: 123, done: 'not-a-bool' } },
    });
    const r2 = await waitForSuccess(client) as TransactionResult;
    expect(r2.ok).toBe(false);

    client[Symbol.dispose]();
  });

  it('delete skips validation', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callStarApplyOntology(star, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    const resourceId = crypto.randomUUID();
    client.callStarTransaction(star, 'v1', {
      [resourceId]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'To delete', done: false } },
    });
    const r1 = await waitForSuccess(client) as TransactionResult;
    if (!r1.ok) throw new Error('Expected ok');

    client.callStarTransaction(star, 'v1', {
      [resourceId]: { op: 'delete', eTag: r1.eTags[resourceId] },
    });
    const r2 = await waitForSuccess(client) as TransactionResult;
    expect(r2.ok).toBe(true);

    client[Symbol.dispose]();
  });

  it('batch with mixed valid/invalid — all errors collected, nothing written', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callStarApplyOntology(star, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    const r1 = crypto.randomUUID();
    const r2 = crypto.randomUUID();
    client.callStarTransaction(star, 'v1', {
      [r1]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Valid', done: false } },
      [r2]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 123 } }, // invalid
    });
    const result = await waitForSuccess(client) as TransactionResult;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Only the invalid resource has an error
      expect(result.errors[r2]).toBeDefined();
      expect(result.errors[r2].type).toBe('validation');
    }

    // r1 should NOT have been written (batch is all-or-nothing for validation)
    client.callStarRead(star, 'v1', r1);
    const snap = await waitForSuccess(client) as Snapshot | null;
    expect(snap).toBeNull();

    client[Symbol.dispose]();
  });

  it('snapshot metadata includes typeName and ontologyVersion', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callStarApplyOntology(star, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    const resourceId = crypto.randomUUID();
    client.callStarTransaction(star, 'v1', {
      [resourceId]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Meta', done: false } },
    });
    await waitForSuccess(client);

    client.callStarRead(star, 'v1', resourceId);
    const snap = await waitForSuccess(client) as Snapshot;
    expect(snap.meta.typeName).toBe('Todo');
    expect(snap.meta.ontologyVersion).toBe('v1');

    client[Symbol.dispose]();
  });
});

// ─── Read Integration ────────────────────────────────────────────────

describe('read integration', () => {

  it('successful read returns snapshot', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callStarApplyOntology(star, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    const resourceId = crypto.randomUUID();
    client.callStarTransaction(star, 'v1', {
      [resourceId]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Read me', done: true } },
    });
    await waitForSuccess(client);

    client.callStarRead(star, 'v1', resourceId);
    const snap = await waitForSuccess(client) as Snapshot;
    expect(snap.value.title).toBe('Read me');
    expect(snap.value.done).toBe(true);

    client[Symbol.dispose]();
  });

  it('read not-found returns null', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callStarApplyOntology(star, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    // Need at least one transaction to cache the ontology on the Star
    client.callStarTransaction(star, 'v1', {
      [crypto.randomUUID()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Seed', done: false } },
    });
    await waitForSuccess(client);

    client.callStarRead(star, 'v1', crypto.randomUUID());
    const snap = await waitForSuccess(client);
    expect(snap).toBeNull();

    client[Symbol.dispose]();
  });

  it('version mismatch on read returns error', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    // Register v1 and v2
    client.callStarApplyOntology(star, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);
    client.callStarApplyOntology(star, { version: 'v2', types: TODO_V2_TYPES });
    await waitForSuccess(client);

    // Force Star to fetch v2
    client.callStarTransaction(star, 'v2', {
      [crypto.randomUUID()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'X', done: false, priority: 'high' } },
    });
    await waitForSuccess(client);

    // Read with stale version
    client.callStarRead(star, 'v1', crypto.randomUUID());
    const error = await waitForError(client);
    expect(error).toContain('version mismatch');

    client[Symbol.dispose]();
  });
});
