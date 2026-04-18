/**
 * Ontology integration tests
 *
 * Tests Galaxy ontology management, Star cache hit/miss, version mismatch,
 * validation integration, and the full continuation-based flow
 * (Client → Star → Galaxy → Star → Client).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot, TransactionResult, TransactionError, OntologyVersionConfig } from '@lumenize/nebula';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

// ─── Helpers ─────────────────────────────────────────────────────────

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
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

async function adminClient(star: string) {
  const browser = new Browser();
  return createAuthenticatedClient(NebulaClientTest, browser, star, star, 'admin@example.com');
}

const TODO_TYPES = `
  interface Todo { title: string; done: boolean; }
  interface Person { name: string; email: string; }
`;

const TODO_V2_TYPES = `
  interface Todo { title: string; done: boolean; priority: string; }
  interface Person { name: string; email: string; phone?: string; }
`;

// ─── Galaxy Ontology Management ──────────────────────────────────────

describe('Galaxy ontology', () => {

  it('appendOntologyVersion + getOntology round-trip', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    client.callGalaxyGetOntology(galaxy);
    const ontology = await waitForSuccess(client) as OntologyVersionConfig[];
    expect(ontology).toHaveLength(1);
    expect(ontology[0].version).toBe('v1');

    client[Symbol.dispose]();
  });

  it('append-only enforcement — duplicate version label throws', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_V2_TYPES });
    const error = await waitForError(client);
    expect(error).toContain('already exists');

    // Original unchanged
    client.callGalaxyGetOntology(galaxy);
    const ontology = await waitForSuccess(client) as OntologyVersionConfig[];
    expect(ontology).toHaveLength(1);

    client[Symbol.dispose]();
  });

  it('eager validation — unparseable TypeScript throws', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: 'interface Bad {' });
    const error = await waitForError(client);
    expect(error).toContain('parse');

    client[Symbol.dispose]();
  });

  it('multiple versions appended in order', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v2', types: TODO_V2_TYPES });
    await waitForSuccess(client);

    client.callGalaxyGetOntology(galaxy);
    const ontology = await waitForSuccess(client) as OntologyVersionConfig[];
    expect(ontology).toHaveLength(2);
    expect(ontology[0].version).toBe('v1');
    expect(ontology[1].version).toBe('v2');

    client[Symbol.dispose]();
  });
});

// ─── Star Cache & Galaxy Fetch ───────────────────────────────────────

describe('Star ontology cache', () => {

  it('cache hit — transaction completes without Galaxy fetch (second call)', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);
    const resourceId = generateUuid();

    // Register ontology
    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    // First transaction — triggers Galaxy fetch (cache miss)
    client.callStarTransaction(star, 'v1', {
      [resourceId]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Fix bug', done: false } },
    });
    const r1 = await waitForSuccess(client) as TransactionResult;
    expect(r1.ok).toBe(true);

    // Second transaction — should use cache (no Galaxy fetch needed)
    const r2Id = generateUuid();
    client.callStarTransaction(star, 'v1', {
      [r2Id]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Write docs', done: false } },
    });
    const r2 = await waitForSuccess(client) as TransactionResult;
    expect(r2.ok).toBe(true);

    client[Symbol.dispose]();
  });

  it('unknown ontologyVersion — error delivered to client', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    client.callStarTransaction(star, 'v999', {
      [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'X', done: false } },
    });
    const error = await waitForError(client);
    expect(error).toContain("'v999' not found");

    client[Symbol.dispose]();
  });

  it('version mismatch — client sends stale version', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    // Register v1 and v2
    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);
    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v2', types: TODO_V2_TYPES, defaults: { Todo: { priority: 'medium' } } });
    await waitForSuccess(client);

    // Force Star to fetch latest (v2) by sending v2 first
    client.callStarTransaction(star, 'v2', {
      [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Seed', done: false, priority: 'high' } },
    });
    await waitForSuccess(client);

    // Now send v1 — should get version mismatch
    client.callStarTransaction(star, 'v1', {
      [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Stale', done: false } },
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

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    client.callStarTransaction(star, 'v1', {
      [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Fix bug', done: false } },
    });
    const result = await waitForSuccess(client) as TransactionResult;
    expect(result.ok).toBe(true);

    client[Symbol.dispose]();
  });

  it('invalid create returns validation errors', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    // Missing required field 'done', wrong type for 'title'
    client.callStarTransaction(star, 'v1', {
      [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 123 } },
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

    client.callGalaxyAppendOntologyVersion(galaxy, {
      version: 'v1',
      types: TODO_V2_TYPES,
      defaults: { Todo: { priority: 'medium' } },
    });
    await waitForSuccess(client);

    const resourceId = generateUuid();
    // Omit 'priority' — default should be applied
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

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    const resourceId = generateUuid();
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

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    const resourceId = generateUuid();
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

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    const r1 = generateUuid();
    const r2 = generateUuid();
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

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    const resourceId = generateUuid();
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

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    const resourceId = generateUuid();
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

    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);

    // Need at least one transaction to cache the ontology on the Star
    client.callStarTransaction(star, 'v1', {
      [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'Seed', done: false } },
    });
    await waitForSuccess(client);

    client.callStarRead(star, 'v1', generateUuid());
    const snap = await waitForSuccess(client);
    expect(snap).toBeNull();

    client[Symbol.dispose]();
  });

  it('version mismatch on read returns error', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    // Register v1 and v2
    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v1', types: TODO_TYPES });
    await waitForSuccess(client);
    client.callGalaxyAppendOntologyVersion(galaxy, { version: 'v2', types: TODO_V2_TYPES });
    await waitForSuccess(client);

    // Force Star to fetch v2
    client.callStarTransaction(star, 'v2', {
      [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'X', done: false, priority: 'high' } },
    });
    await waitForSuccess(client);

    // Read with stale version
    client.callStarRead(star, 'v1', generateUuid());
    const error = await waitForError(client);
    expect(error).toContain('version mismatch');

    client[Symbol.dispose]();
  });
});
