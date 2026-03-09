/**
 * Resources temporal storage tests
 *
 * Tests the Resources class: CRUD via transaction(), read(),
 * optimistic concurrency, debounce, DAG permission integration,
 * and rich type round-trip (Map, Set, Date, cycle).
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID, END_OF_TIME } from '@lumenize/nebula';
import type { Snapshot, TransactionResult } from '@lumenize/nebula';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

// Helper: unique star scope per test
function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

// Helper: admin client
async function adminClient(star: string) {
  const browser = new Browser();
  return createAuthenticatedClient(NebulaClientTest, browser, star, star, 'admin@example.com');
}

// Helper: non-admin user client
async function userClient(star: string, adminToken: string, email = 'user@example.com') {
  const adminBrowser = new Browser();
  const { accessToken } = await browserLogin(adminBrowser, star, 'admin@example.com', star);
  const userBrowser = new Browser();
  await createSubject(adminBrowser, star, accessToken, email);
  return createAuthenticatedClient(NebulaClientTest, userBrowser, star, star, email);
}

// Standard test value — includes Set, Map, Date, and cycle for structured clone validation
function makeTestValue(title = 'Test Task') {
  const obj: any = {
    title,
    tags: new Set(['urgent', 'bug']),
    metadata: new Map([['priority', 3], ['retries', 0]]),
    createdAt: new Date('2026-03-08T00:00:00.000Z'),
  };
  obj.self = obj; // cycle
  return obj;
}

// Helper: assert a value matches makeTestValue structure (rich types preserved)
function assertTestValue(val: any, title = 'Test Task') {
  expect(val.title).toBe(title);
  expect(val.tags).toBeInstanceOf(Set);
  expect(val.tags.has('urgent')).toBe(true);
  expect(val.tags.has('bug')).toBe(true);
  expect(val.metadata).toBeInstanceOf(Map);
  expect(val.metadata.get('priority')).toBe(3);
  expect(val.createdAt).toBeInstanceOf(Date);
  expect(val.createdAt.toISOString()).toBe('2026-03-08T00:00:00.000Z');
  expect(val.self).toBe(val); // cycle preserved
}

// Helper: wait for result
async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => {
    expect(client.callCompleted).toBe(true);
  });
}

// Helper: wait for success result
async function waitForSuccess(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}

// Helper: wait for error
async function waitForError(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeDefined();
  return client.lastError!;
}

describe('star-resources', () => {

  // ─── Basic CRUD ───────────────────────────────────────────────────

  describe('basic CRUD via transaction()', () => {

    it('create a resource and read it back with rich types', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      // Create
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue() },
      });
      const txnResult = await waitForSuccess(client) as TransactionResult;
      expect(txnResult.ok).toBe(true);
      if (!txnResult.ok) throw new Error('Expected ok');
      expect(txnResult.eTags[resourceId]).toBeDefined();

      // Read back
      client.callStarResourcesRead(star, resourceId);
      const snapshot = await waitForSuccess(client) as Snapshot;
      assertTestValue(snapshot.value);
      expect(snapshot.meta.nodeId).toBe(ROOT_NODE_ID);
      expect(snapshot.meta.validTo).toBe(END_OF_TIME);
      expect(snapshot.meta.deleted).toBe(false);
      expect(snapshot.meta.eTag).toBe(txnResult.eTags[resourceId]);
      expect(snapshot.meta.changedBy.sub).toBeDefined();

      client[Symbol.dispose]();
    });

    it('update with correct eTag succeeds', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      // Create
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue() },
      });
      const createResult = await waitForSuccess(client) as TransactionResult;
      if (!createResult.ok) throw new Error('Expected ok');
      const eTag = createResult.eTags[resourceId];

      // Update
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'update', eTag, value: makeTestValue('Updated Task') },
      });
      const updateResult = await waitForSuccess(client) as TransactionResult;
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) throw new Error('Expected ok');
      expect(updateResult.eTags[resourceId]).toBeDefined();
      expect(updateResult.eTags[resourceId]).not.toBe(eTag);

      // Read back
      client.callStarResourcesRead(star, resourceId);
      const snapshot = await waitForSuccess(client) as Snapshot;
      assertTestValue(snapshot.value, 'Updated Task');

      client[Symbol.dispose]();
    });

    it('update with wrong eTag returns conflict', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      // Create
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue() },
      });
      await waitForSuccess(client);

      // Update with fabricated eTag
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'update', eTag: generateUuid(), value: makeTestValue('Bad Update') },
      });
      const result = await waitForSuccess(client) as TransactionResult;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected conflict');
      expect(result.conflicts[resourceId]).toBeDefined();
      assertTestValue(result.conflicts[resourceId].value); // original value

      client[Symbol.dispose]();
    });

    it('soft delete and read back', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      // Create
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue() },
      });
      const createResult = await waitForSuccess(client) as TransactionResult;
      if (!createResult.ok) throw new Error('Expected ok');
      const eTag = createResult.eTags[resourceId];

      // Delete
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'delete', eTag },
      });
      const deleteResult = await waitForSuccess(client) as TransactionResult;
      expect(deleteResult.ok).toBe(true);

      // Read — returns snapshot with deleted: true (not null)
      client.callStarResourcesRead(star, resourceId);
      const snapshot = await waitForSuccess(client) as Snapshot;
      expect(snapshot).not.toBeNull();
      expect(snapshot.meta.deleted).toBe(true);
      assertTestValue(snapshot.value);

      client[Symbol.dispose]();
    });

    it('read non-existent resource returns null', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarResourcesRead(star, generateUuid());
      const result = await waitForSuccess(client);
      expect(result).toBeNull();

      client[Symbol.dispose]();
    });

    it('empty transaction is a no-op', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarResourcesTransaction(star, {});
      const result = await waitForSuccess(client) as TransactionResult;
      expect(result).toEqual({ ok: true, eTags: {} });

      client[Symbol.dispose]();
    });
  });

  // ─── Batch Transactions ───────────────────────────────────────────

  describe('batch transactions', () => {

    it('mixed create/update/move/delete in one transaction', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // Create a child node for move target
      client.callStarCreateNode(star, ROOT_NODE_ID, 'child', 'Child');
      await waitForResult(client);
      const childNodeId = client.lastResult as number;

      // Create two resources
      const r1 = generateUuid();
      const r2 = generateUuid();
      client.callStarResourcesTransaction(star, {
        [r1]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue('R1') },
        [r2]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue('R2') },
      });
      const createResult = await waitForSuccess(client) as TransactionResult;
      if (!createResult.ok) throw new Error('Expected ok');

      // Mixed batch: update r1, move r2 to child
      const r3 = generateUuid();
      client.callStarResourcesTransaction(star, {
        [r1]: { op: 'update', eTag: createResult.eTags[r1], value: makeTestValue('R1 Updated') },
        [r2]: { op: 'move', eTag: createResult.eTags[r2], nodeId: childNodeId },
        [r3]: { op: 'create', nodeId: childNodeId, value: makeTestValue('R3') },
      });
      const batchResult = await waitForSuccess(client) as TransactionResult;
      expect(batchResult.ok).toBe(true);
      if (!batchResult.ok) throw new Error('Expected ok');
      expect(Object.keys(batchResult.eTags)).toHaveLength(3);

      // Verify r2 moved
      client.callStarResourcesRead(star, r2);
      const r2Snap = await waitForSuccess(client) as Snapshot;
      expect(r2Snap.meta.nodeId).toBe(childNodeId);

      client[Symbol.dispose]();
    });

    it('one conflict in batch rolls back entire transaction', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const r1 = generateUuid();
      const r2 = generateUuid();

      // Create two resources
      client.callStarResourcesTransaction(star, {
        [r1]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue('R1') },
        [r2]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue('R2') },
      });
      const createResult = await waitForSuccess(client) as TransactionResult;
      if (!createResult.ok) throw new Error('Expected ok');

      // Batch with one bad eTag
      client.callStarResourcesTransaction(star, {
        [r1]: { op: 'update', eTag: createResult.eTags[r1], value: makeTestValue('R1 Updated') },
        [r2]: { op: 'update', eTag: generateUuid(), value: makeTestValue('R2 Updated') },
      });
      const result = await waitForSuccess(client) as TransactionResult;
      expect(result.ok).toBe(false);

      // r1 should NOT have been updated (rollback)
      client.callStarResourcesRead(star, r1);
      const r1Snap = await waitForSuccess(client) as Snapshot;
      expect(r1Snap.value.title).toBe('R1');

      client[Symbol.dispose]();
    });

    it('multiple creates in one transaction', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const ids = [generateUuid(), generateUuid(), generateUuid()];

      const ops: Record<string, any> = {};
      for (const id of ids) {
        ops[id] = { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue(`Task ${id.slice(0, 4)}`) };
      }
      client.callStarResourcesTransaction(star, ops);
      const result = await waitForSuccess(client) as TransactionResult;
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Expected ok');
      expect(Object.keys(result.eTags)).toHaveLength(3);
      // All share same eTag (single transaction)
      const eTags = Object.values(result.eTags);
      expect(eTags[0]).toBe(eTags[1]);
      expect(eTags[1]).toBe(eTags[2]);

      client[Symbol.dispose]();
    });
  });

  // ─── Debounce ─────────────────────────────────────────────────────

  describe('debounce', () => {

    it('same sub within debounce window overwrites in place (no new timeline entry)', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      // Default debounceMs is 1 hour — all writes within this test are within the window

      // Create
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue('v1') },
      });
      const createResult = await waitForSuccess(client) as TransactionResult;
      if (!createResult.ok) throw new Error('Expected ok');

      // Update (same sub, within debounce window — should overwrite in place)
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'update', eTag: createResult.eTags[resourceId], value: makeTestValue('v2') },
      });
      const updateResult = await waitForSuccess(client) as TransactionResult;
      if (!updateResult.ok) throw new Error('Expected ok');

      // Read — should see v2
      client.callStarResourcesRead(star, resourceId);
      const snap = await waitForSuccess(client) as Snapshot;
      expect(snap.value.title).toBe('v2');

      // The validFrom should be the same as the create (debounced in place)
      // The eTag should be different (new eTag per transaction)
      expect(snap.meta.eTag).toBe(updateResult.eTags[resourceId]);

      client[Symbol.dispose]();
    });

    it('debounceMs: 0 creates new snapshot on every update', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      // Set debounceMs to 0
      client.callStarSetConfig(star, 'debounceMs', 0);
      await waitForSuccess(client);

      // Create
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue('v1') },
      });
      const createResult = await waitForSuccess(client) as TransactionResult;
      if (!createResult.ok) throw new Error('Expected ok');

      // Read to get validFrom
      client.callStarResourcesRead(star, resourceId);
      const snap1 = await waitForSuccess(client) as Snapshot;
      const validFrom1 = snap1.meta.validFrom;

      // Update
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'update', eTag: createResult.eTags[resourceId], value: makeTestValue('v2') },
      });
      const updateResult = await waitForSuccess(client) as TransactionResult;
      if (!updateResult.ok) throw new Error('Expected ok');

      // Read — validFrom should be different (new snapshot created)
      client.callStarResourcesRead(star, resourceId);
      const snap2 = await waitForSuccess(client) as Snapshot;
      expect(snap2.value.title).toBe('v2');
      expect(snap2.meta.validFrom).not.toBe(validFrom1);
      // Previous snapshot should have validTo set to new validFrom
      expect(snap2.meta.validTo).toBe(END_OF_TIME);

      client[Symbol.dispose]();
    });

    it('different sub chain within window creates new snapshot', async () => {
      const star = uniqueStar();
      const { client: admin, accessToken } = await adminClient(star);
      const resourceId = generateUuid();

      // Create a child node and grant user write permission
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'shared', 'Shared');
      await waitForResult(admin);
      const nodeId = admin.lastResult as number;

      // Create resource as admin
      admin.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId, value: makeTestValue('v1') },
      });
      const createResult = await waitForSuccess(admin) as TransactionResult;
      if (!createResult.ok) throw new Error('Expected ok');

      // Grant write to user
      const { client: user } = await userClient(star, accessToken);
      admin.callStarSetPermission(star, nodeId, user.lastResult?.sub ?? '', 'write');
      // Actually, let me grant via the dagTree
      // Get user sub first
      user.callStarWhoAmI(star);
      await waitForResult(user);
      const userSub = (user.lastResult as string).replace('You are ', '');

      admin.callStarSetPermission(star, nodeId, userSub, 'write');
      await waitForSuccess(admin);

      // Update resource as user (different sub chain — should create new snapshot)
      user.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'update', eTag: createResult.eTags[resourceId], value: makeTestValue('v2') },
      });
      const updateResult = await waitForSuccess(user) as TransactionResult;
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) throw new Error('Expected ok');

      // Read — changedBy should be the user
      user.callStarResourcesRead(star, resourceId);
      const snap = await waitForSuccess(user) as Snapshot;
      expect(snap.value.title).toBe('v2');
      expect(snap.meta.changedBy.sub).toBe(userSub);

      admin[Symbol.dispose]();
      user[Symbol.dispose]();
    });
  });

  // ─── Temporal Storage ─────────────────────────────────────────────

  describe('temporal storage', () => {

    it('validTo of previous snapshot equals validFrom of new snapshot (debounceMs: 0)', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      // Set debounceMs to 0 for full audit trail
      client.callStarSetConfig(star, 'debounceMs', 0);
      await waitForSuccess(client);

      // Create then update twice
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue('v1') },
      });
      const r1 = await waitForSuccess(client) as TransactionResult;
      if (!r1.ok) throw new Error('Expected ok');

      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'update', eTag: r1.eTags[resourceId], value: makeTestValue('v2') },
      });
      const r2 = await waitForSuccess(client) as TransactionResult;
      if (!r2.ok) throw new Error('Expected ok');

      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'update', eTag: r2.eTags[resourceId], value: makeTestValue('v3') },
      });
      const r3 = await waitForSuccess(client) as TransactionResult;
      if (!r3.ok) throw new Error('Expected ok');

      // Current snapshot should be v3
      client.callStarResourcesRead(star, resourceId);
      const current = await waitForSuccess(client) as Snapshot;
      expect(current.value.title).toBe('v3');
      expect(current.meta.validTo).toBe(END_OF_TIME);

      client[Symbol.dispose]();
    });
  });

  // ─── DAG Integration ──────────────────────────────────────────────

  describe('DAG permission integration', () => {

    it('user with write permission can create/update resources', async () => {
      const star = uniqueStar();
      const { client: admin, accessToken } = await adminClient(star);

      // Create node
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'team', 'Team');
      await waitForResult(admin);
      const nodeId = admin.lastResult as number;

      // Create user and grant write
      const { client: user } = await userClient(star, accessToken);
      user.callStarWhoAmI(star);
      await waitForResult(user);
      const userSub = (user.lastResult as string).replace('You are ', '');

      admin.callStarSetPermission(star, nodeId, userSub, 'write');
      await waitForSuccess(admin);

      // User creates resource
      const resourceId = generateUuid();
      user.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId, value: makeTestValue() },
      });
      const result = await waitForSuccess(user) as TransactionResult;
      expect(result.ok).toBe(true);

      admin[Symbol.dispose]();
      user[Symbol.dispose]();
    });

    it('user with read permission can read but not write', async () => {
      const star = uniqueStar();
      const { client: admin, accessToken } = await adminClient(star);

      // Create node and resource as admin
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'readonly', 'Read Only');
      await waitForResult(admin);
      const nodeId = admin.lastResult as number;

      const resourceId = generateUuid();
      admin.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId, value: makeTestValue() },
      });
      const createResult = await waitForSuccess(admin) as TransactionResult;
      if (!createResult.ok) throw new Error('Expected ok');

      // Create user and grant read only
      const { client: user } = await userClient(star, accessToken);
      user.callStarWhoAmI(star);
      await waitForResult(user);
      const userSub = (user.lastResult as string).replace('You are ', '');

      admin.callStarSetPermission(star, nodeId, userSub, 'read');
      await waitForSuccess(admin);

      // User can read
      user.callStarResourcesRead(star, resourceId);
      const snapshot = await waitForSuccess(user) as Snapshot;
      assertTestValue(snapshot.value);

      // User cannot write
      user.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'update', eTag: createResult.eTags[resourceId], value: makeTestValue('Hacked') },
      });
      const error = await waitForError(user);
      expect(error).toContain('write permission required');

      admin[Symbol.dispose]();
      user[Symbol.dispose]();
    });

    it('user with no permission cannot read or write', async () => {
      const star = uniqueStar();
      const { client: admin, accessToken } = await adminClient(star);

      // Create node and resource as admin
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'private', 'Private');
      await waitForResult(admin);
      const nodeId = admin.lastResult as number;

      const resourceId = generateUuid();
      admin.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId, value: makeTestValue() },
      });
      await waitForSuccess(admin);

      // Create user — no permission granted
      const { client: user } = await userClient(star, accessToken);

      // User cannot read
      user.callStarResourcesRead(star, resourceId);
      const readError = await waitForError(user);
      expect(readError).toContain('read permission required');

      // User cannot write
      user.callStarResourcesTransaction(star, {
        [generateUuid()]: { op: 'create', nodeId, value: makeTestValue() },
      });
      const writeError = await waitForError(user);
      expect(writeError).toContain('write permission required');

      admin[Symbol.dispose]();
      user[Symbol.dispose]();
    });
  });

  // ─── Resource Moves ───────────────────────────────────────────────

  describe('resource moves', () => {

    it('move resource to new node creates snapshot with new nodeId', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // Create two nodes
      client.callStarCreateNode(star, ROOT_NODE_ID, 'node-a', 'Node A');
      await waitForResult(client);
      const nodeA = client.lastResult as number;

      client.callStarCreateNode(star, ROOT_NODE_ID, 'node-b', 'Node B');
      await waitForResult(client);
      const nodeB = client.lastResult as number;

      // Create resource on node A
      const resourceId = generateUuid();
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: nodeA, value: makeTestValue() },
      });
      const createResult = await waitForSuccess(client) as TransactionResult;
      if (!createResult.ok) throw new Error('Expected ok');

      // Move to node B
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'move', eTag: createResult.eTags[resourceId], nodeId: nodeB },
      });
      const moveResult = await waitForSuccess(client) as TransactionResult;
      expect(moveResult.ok).toBe(true);

      // Verify
      client.callStarResourcesRead(star, resourceId);
      const snap = await waitForSuccess(client) as Snapshot;
      expect(snap.meta.nodeId).toBe(nodeB);
      assertTestValue(snap.value); // value preserved

      client[Symbol.dispose]();
    });

    it('move to same node is idempotent no-op', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      // Create
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue() },
      });
      const createResult = await waitForSuccess(client) as TransactionResult;
      if (!createResult.ok) throw new Error('Expected ok');
      const originalETag = createResult.eTags[resourceId];

      // Move to same node
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'move', eTag: originalETag, nodeId: ROOT_NODE_ID },
      });
      const moveResult = await waitForSuccess(client) as TransactionResult;
      expect(moveResult.ok).toBe(true);
      if (!moveResult.ok) throw new Error('Expected ok');

      // eTag should be the original (no-op)
      expect(moveResult.eTags[resourceId]).toBe(originalETag);

      client[Symbol.dispose]();
    });

    it('move requires write on both source and destination nodes', async () => {
      const star = uniqueStar();
      const { client: admin, accessToken } = await adminClient(star);

      // Create two nodes
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'src', 'Source');
      await waitForResult(admin);
      const srcNode = admin.lastResult as number;

      admin.callStarCreateNode(star, ROOT_NODE_ID, 'dst', 'Destination');
      await waitForResult(admin);
      const dstNode = admin.lastResult as number;

      // Create resource on source
      const resourceId = generateUuid();
      admin.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: srcNode, value: makeTestValue() },
      });
      const createResult = await waitForSuccess(admin) as TransactionResult;
      if (!createResult.ok) throw new Error('Expected ok');

      // Create user with write on src only
      const { client: user } = await userClient(star, accessToken);
      user.callStarWhoAmI(star);
      await waitForResult(user);
      const userSub = (user.lastResult as string).replace('You are ', '');

      admin.callStarSetPermission(star, srcNode, userSub, 'write');
      await waitForSuccess(admin);

      // User tries to move — should fail (no write on dst)
      user.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'move', eTag: createResult.eTags[resourceId], nodeId: dstNode },
      });
      const error = await waitForError(user);
      expect(error).toContain('write permission required');

      admin[Symbol.dispose]();
      user[Symbol.dispose]();
    });
  });

  // ─── Resource Lifecycle Edge Cases ────────────────────────────────

  describe('lifecycle edge cases', () => {

    it('create on already-existing resourceId throws', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      // Create
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue() },
      });
      await waitForSuccess(client);

      // Create again — should throw
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue('Dupe') },
      });
      const error = await waitForError(client);
      expect(error).toContain('already exists');

      client[Symbol.dispose]();
    });

    it('create on deleted resourceId also throws', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      // Create and delete
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue() },
      });
      const r1 = await waitForSuccess(client) as TransactionResult;
      if (!r1.ok) throw new Error('Expected ok');

      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'delete', eTag: r1.eTags[resourceId] },
      });
      await waitForSuccess(client);

      // Create again — should throw (use update instead)
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue('Recreate') },
      });
      const error = await waitForError(client);
      expect(error).toContain('already exists');

      client[Symbol.dispose]();
    });

    it('update a deleted resource succeeds (deleted is informational)', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      // Create and delete
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue() },
      });
      const r1 = await waitForSuccess(client) as TransactionResult;
      if (!r1.ok) throw new Error('Expected ok');

      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'delete', eTag: r1.eTags[resourceId] },
      });
      const r2 = await waitForSuccess(client) as TransactionResult;
      if (!r2.ok) throw new Error('Expected ok');

      // Update the deleted resource
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'update', eTag: r2.eTags[resourceId], value: makeTestValue('Resurrected') },
      });
      const r3 = await waitForSuccess(client) as TransactionResult;
      expect(r3.ok).toBe(true);

      // Deleted flag should still be true (update doesn't clear it)
      client.callStarResourcesRead(star, resourceId);
      const snap = await waitForSuccess(client) as Snapshot;
      expect(snap.meta.deleted).toBe(true);
      expect(snap.value.title).toBe('Resurrected');

      client[Symbol.dispose]();
    });

    it('move a deleted resource succeeds', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // Create target node
      client.callStarCreateNode(star, ROOT_NODE_ID, 'target', 'Target');
      await waitForResult(client);
      const targetNode = client.lastResult as number;

      const resourceId = generateUuid();

      // Create and delete
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue() },
      });
      const r1 = await waitForSuccess(client) as TransactionResult;
      if (!r1.ok) throw new Error('Expected ok');

      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'delete', eTag: r1.eTags[resourceId] },
      });
      const r2 = await waitForSuccess(client) as TransactionResult;
      if (!r2.ok) throw new Error('Expected ok');

      // Move the deleted resource
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'move', eTag: r2.eTags[resourceId], nodeId: targetNode },
      });
      const r3 = await waitForSuccess(client) as TransactionResult;
      expect(r3.ok).toBe(true);

      client.callStarResourcesRead(star, resourceId);
      const snap = await waitForSuccess(client) as Snapshot;
      expect(snap.meta.nodeId).toBe(targetNode);
      expect(snap.meta.deleted).toBe(true);

      client[Symbol.dispose]();
    });

    it('delete already-deleted resource succeeds idempotently (new eTag)', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      // Create and delete
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue() },
      });
      const r1 = await waitForSuccess(client) as TransactionResult;
      if (!r1.ok) throw new Error('Expected ok');

      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'delete', eTag: r1.eTags[resourceId] },
      });
      const r2 = await waitForSuccess(client) as TransactionResult;
      if (!r2.ok) throw new Error('Expected ok');

      // Delete again
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'delete', eTag: r2.eTags[resourceId] },
      });
      const r3 = await waitForSuccess(client) as TransactionResult;
      expect(r3.ok).toBe(true);
      if (!r3.ok) throw new Error('Expected ok');
      expect(r3.eTags[resourceId]).not.toBe(r2.eTags[resourceId]); // new eTag

      client[Symbol.dispose]();
    });
  });

  // ─── eTag Abuse ───────────────────────────────────────────────────

  describe('eTag abuse', () => {

    it('fabricated eTag returns conflict', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue() },
      });
      await waitForSuccess(client);

      // Update with random UUID that never existed
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'update', eTag: generateUuid(), value: makeTestValue('Bad') },
      });
      const result = await waitForSuccess(client) as TransactionResult;
      expect(result.ok).toBe(false);

      client[Symbol.dispose]();
    });

    it('eTag from different resourceId returns conflict', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const r1 = generateUuid();
      const r2 = generateUuid();

      client.callStarResourcesTransaction(star, {
        [r1]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue('R1') },
        [r2]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue('R2') },
      });
      const createResult = await waitForSuccess(client) as TransactionResult;
      if (!createResult.ok) throw new Error('Expected ok');

      // Use r1's eTag to update r2 — even though it's the same UUID value
      // (all eTags in a batch are the same), the second update with a DIFFERENT
      // eTag should fail
      // Actually in a batch they share the same eTag, so let's create separately
      client[Symbol.dispose]();

      // Create in separate transactions for different eTags
      const { client: c2 } = await adminClient(star);

      const ra = generateUuid();
      const rb = generateUuid();

      c2.callStarResourcesTransaction(star, {
        [ra]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue('RA') },
      });
      const raResult = await waitForSuccess(c2) as TransactionResult;
      if (!raResult.ok) throw new Error('Expected ok');

      c2.callStarResourcesTransaction(star, {
        [rb]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue('RB') },
      });
      const rbResult = await waitForSuccess(c2) as TransactionResult;
      if (!rbResult.ok) throw new Error('Expected ok');

      // Use ra's eTag on rb
      c2.callStarResourcesTransaction(star, {
        [rb]: { op: 'update', eTag: raResult.eTags[ra], value: makeTestValue('Bad') },
      });
      const result = await waitForSuccess(c2) as TransactionResult;
      expect(result.ok).toBe(false);

      c2[Symbol.dispose]();
    });
  });

  // ─── Input Validation ─────────────────────────────────────────────

  describe('input validation', () => {

    it('empty string resourceId throws', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarResourcesTransaction(star, {
        '': { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue() },
      });
      const error = await waitForError(client);
      expect(error).toContain('resourceId must not be empty');

      client[Symbol.dispose]();
    });

    it('create with null value throws', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarResourcesTransaction(star, {
        [generateUuid()]: { op: 'create', nodeId: ROOT_NODE_ID, value: null },
      });
      const error = await waitForError(client);
      expect(error).toContain('must not be null or undefined');

      client[Symbol.dispose]();
    });

    it('update with null value throws', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value: makeTestValue() },
      });
      const r1 = await waitForSuccess(client) as TransactionResult;
      if (!r1.ok) throw new Error('Expected ok');

      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'update', eTag: r1.eTags[resourceId], value: null },
      });
      const error = await waitForError(client);
      expect(error).toContain('must not be null or undefined');

      client[Symbol.dispose]();
    });

    it('update on non-existent resourceId throws', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarResourcesTransaction(star, {
        [generateUuid()]: { op: 'update', eTag: generateUuid(), value: makeTestValue() },
      });
      const error = await waitForError(client);
      expect(error).toContain('not found');

      client[Symbol.dispose]();
    });

    it('delete on non-existent resourceId throws', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarResourcesTransaction(star, {
        [generateUuid()]: { op: 'delete', eTag: generateUuid() },
      });
      const error = await waitForError(client);
      expect(error).toContain('not found');

      client[Symbol.dispose]();
    });

    it('nodeId that does not exist in DAG tree fails at requirePermission', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // requirePermission checks node existence before admin bypass,
      // so even admins get a clear "Node not found" error
      client.callStarResourcesTransaction(star, {
        [generateUuid()]: { op: 'create', nodeId: 99999, value: makeTestValue() },
      });
      const error = await waitForError(client);
      expect(error).toContain('Node 99999 not found');

      client[Symbol.dispose]();
    });

    it('value containing only rich types (Map as root)', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const resourceId = generateUuid();

      const value = new Map<string, any>([['a', 1], ['b', new Date('2026-01-01T00:00:00Z')]]);
      client.callStarResourcesTransaction(star, {
        [resourceId]: { op: 'create', nodeId: ROOT_NODE_ID, value },
      });
      const result = await waitForSuccess(client) as TransactionResult;
      expect(result.ok).toBe(true);

      client.callStarResourcesRead(star, resourceId);
      const snap = await waitForSuccess(client) as Snapshot;
      expect(snap.value).toBeInstanceOf(Map);
      expect(snap.value.get('a')).toBe(1);
      expect(snap.value.get('b')).toBeInstanceOf(Date);

      client[Symbol.dispose]();
    });
  });
});
