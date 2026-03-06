/**
 * DAG Tree access control tests
 *
 * Tests DagTree operations, authorization enforcement, permission resolution,
 * and Star DO integration through the baseline test-app.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { DagTreeState } from '@lumenize/nebula';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

// Helper: create a unique star scope per test to avoid cross-test interference
function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

// Helper: create admin client connected to a star
async function adminClient(star: string) {
  const browser = new Browser();
  return createAuthenticatedClient(NebulaClientTest, browser, star, star, 'admin@example.com');
}

// Helper: create a non-admin user client
async function userClient(star: string, adminToken: string, email = 'user@example.com') {
  const adminBrowser = new Browser();
  // Need a browser with the admin's cookies for createSubject
  const { accessToken } = await browserLogin(adminBrowser, star, 'admin@example.com', star);
  const userBrowser = new Browser();
  await createSubject(adminBrowser, star, accessToken, email);
  return createAuthenticatedClient(NebulaClientTest, userBrowser, star, star, email);
}

describe('dag-tree', () => {

  // ─── Schema & Root Node ───────────────────────────────────────────

  describe('schema and root node', () => {
    it('root node exists with nodeId 1, slug root, label Root after onStart', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarDagTreeGetState(star);
      await vi.waitFor(() => {
        expect(client.lastResult).toBeDefined();
      });

      const state = client.lastResult as DagTreeState;
      expect(state.nodes).toBeInstanceOf(Map);
      expect(state.nodes.size).toBe(1);

      const root = state.nodes.get(ROOT_NODE_ID);
      expect(root).toBeDefined();
      expect(root!.slug).toBe('root');
      expect(root!.label).toBe('Root');
      expect(root!.deleted).toBe(false);
      expect(root!.parentIds).toEqual([]);
      expect(root!.childIds).toEqual([]);

      expect(state.permissions).toBeInstanceOf(Map);
      expect(state.permissions.size).toBe(0);

      client[Symbol.dispose]();
    });

    it('deleteNode throws on root', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarDeleteNode(star, ROOT_NODE_ID);
      await vi.waitFor(() => {
        expect(client.lastError).toContain('Cannot delete root node');
      });

      client[Symbol.dispose]();
    });

    it('renameNode throws on root', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarRenameNode(star, ROOT_NODE_ID, 'new-root');
      await vi.waitFor(() => {
        expect(client.lastError).toContain('Cannot rename root node');
      });

      client[Symbol.dispose]();
    });

    it('relabelNode is allowed on root', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarRelabelNode(star, ROOT_NODE_ID, 'My Root');
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client.callStarDagTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as DagTreeState;
        expect(state.nodes.get(ROOT_NODE_ID)!.label).toBe('My Root');
      });

      client[Symbol.dispose]();
    });
  });

  // ─── Tree Construction ────────────────────────────────────────────

  describe('tree construction', () => {
    it('createNode returns new nodeId, stores slug and label', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'engineering', 'Engineering');
      await vi.waitFor(() => {
        expect(client.lastResult).toBeDefined();
        expect(client.lastError).toBeUndefined();
      });
      const engId = client.lastResult as number;
      expect(engId).toBeGreaterThan(ROOT_NODE_ID);

      // Verify via getState
      client.callStarDagTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as DagTreeState;
        const eng = state.nodes.get(engId);
        expect(eng).toBeDefined();
        expect(eng!.slug).toBe('engineering');
        expect(eng!.label).toBe('Engineering');
        expect(eng!.deleted).toBe(false);
        expect(eng!.parentIds).toEqual([ROOT_NODE_ID]);
      });

      client[Symbol.dispose]();
    });

    it('builds a multi-level tree and verifies structure via getState', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // root → A → C, root → B → C (diamond)
      client.callStarCreateNode(star, ROOT_NODE_ID, 'dept-a', 'Department A');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const aId = client.lastResult as number;

      client.callStarCreateNode(star, ROOT_NODE_ID, 'dept-b', 'Department B');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const bId = client.lastResult as number;

      client.callStarCreateNode(star, aId, 'team-c', 'Team C');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const cId = client.lastResult as number;

      // Add second parent edge: B → C (making a diamond)
      client.callStarAddEdge(star, bId, cId);
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      // Verify structure
      client.callStarDagTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as DagTreeState;
        const root = state.nodes.get(ROOT_NODE_ID)!;
        expect(root.childIds).toContain(aId);
        expect(root.childIds).toContain(bId);

        const nodeC = state.nodes.get(cId)!;
        expect(nodeC.parentIds).toContain(aId);
        expect(nodeC.parentIds).toContain(bId);
      });

      client[Symbol.dispose]();
    });
  });

  // ─── Node-Not-Found ───────────────────────────────────────────────

  describe('node-not-found', () => {
    it('operations on non-existent nodeId throw', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const bogusId = 9999;

      client.callStarDeleteNode(star, bogusId);
      await vi.waitFor(() => {
        expect(client.lastError).toContain(`Node ${bogusId} not found`);
      });

      client.callStarRenameNode(star, bogusId, 'nope');
      await vi.waitFor(() => {
        expect(client.lastError).toContain(`Node ${bogusId} not found`);
      });

      client.callStarCreateNode(star, bogusId, 'child', 'Child');
      await vi.waitFor(() => {
        expect(client.lastError).toContain(`Node ${bogusId} not found`);
      });

      client[Symbol.dispose]();
    });
  });

  // ─── Slug Validation ──────────────────────────────────────────────

  describe('slug validation', () => {
    it('rejects empty, too long, uppercase, underscores, leading/trailing hyphens', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // empty
      client.callStarCreateNode(star, ROOT_NODE_ID, '', 'Empty');
      await vi.waitFor(() => expect(client.lastError).toContain('empty'));

      // too long (101 chars)
      client.callStarCreateNode(star, ROOT_NODE_ID, 'a'.repeat(101), 'Long');
      await vi.waitFor(() => expect(client.lastError).toContain('100'));

      // uppercase
      client.callStarCreateNode(star, ROOT_NODE_ID, 'MyNode', 'Upper');
      await vi.waitFor(() => expect(client.lastError).toContain('lowercase'));

      // underscores
      client.callStarCreateNode(star, ROOT_NODE_ID, 'my_node', 'Underscore');
      await vi.waitFor(() => expect(client.lastError).toContain('lowercase'));

      // leading hyphen
      client.callStarCreateNode(star, ROOT_NODE_ID, '-leading', 'Leading');
      await vi.waitFor(() => expect(client.lastError).toContain('leading'));

      // trailing hyphen
      client.callStarCreateNode(star, ROOT_NODE_ID, 'trailing-', 'Trailing');
      await vi.waitFor(() => expect(client.lastError).toContain('trailing'));

      client[Symbol.dispose]();
    });

    it('accepts valid slugs: single char, max length, hyphens in middle', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // Single character
      client.callStarCreateNode(star, ROOT_NODE_ID, 'a', 'A');
      await vi.waitFor(() => {
        expect(client.lastResult).toBeDefined();
        expect(client.lastError).toBeUndefined();
      });

      // Max length (100 chars)
      const maxSlug = 'a' + 'b'.repeat(98) + 'c';
      client.callStarCreateNode(star, ROOT_NODE_ID, maxSlug, 'Max');
      await vi.waitFor(() => {
        expect(client.lastResult).toBeDefined();
        expect(client.lastError).toBeUndefined();
      });

      // Hyphens in middle
      client.callStarCreateNode(star, ROOT_NODE_ID, 'my-cool-node', 'Cool');
      await vi.waitFor(() => {
        expect(client.lastResult).toBeDefined();
        expect(client.lastError).toBeUndefined();
      });

      client[Symbol.dispose]();
    });
  });

  // ─── Slug Uniqueness ──────────────────────────────────────────────

  describe('slug uniqueness', () => {
    it('rejects duplicate slugs under same parent, allows same slug under different parents', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'sales', 'Sales');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const salesId = client.lastResult as number;

      // Duplicate under same parent → rejected
      client.callStarCreateNode(star, ROOT_NODE_ID, 'sales', 'Sales 2');
      await vi.waitFor(() => expect(client.lastError).toContain("Slug 'sales' already exists"));

      // Same slug under different parent → allowed
      client.callStarCreateNode(star, salesId, 'sales', 'Sub-Sales');
      await vi.waitFor(() => {
        expect(client.lastResult).toBeDefined();
        expect(client.lastError).toBeUndefined();
      });

      client[Symbol.dispose]();
    });
  });

  // ─── Cycle Detection ──────────────────────────────────────────────

  describe('cycle detection', () => {
    it('rejects cycles, allows diamonds', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // Build: root → A → B
      client.callStarCreateNode(star, ROOT_NODE_ID, 'node-a', 'A');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const aId = client.lastResult as number;

      client.callStarCreateNode(star, aId, 'node-b', 'B');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const bId = client.lastResult as number;

      // B → A would create a cycle → rejected
      client.callStarAddEdge(star, bId, aId);
      await vi.waitFor(() => expect(client.lastError).toContain('cycle'));

      // Diamond is fine: root → B (B already exists under A, adding from root is fine)
      client.callStarAddEdge(star, ROOT_NODE_ID, bId);
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client[Symbol.dispose]();
    });
  });

  // ─── Edge Idempotency ─────────────────────────────────────────────

  describe('edge idempotency', () => {
    it('addEdge on existing edge is a no-op', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'child', 'Child');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const childId = client.lastResult as number;

      // Add same edge again → no-op, no error
      client.callStarAddEdge(star, ROOT_NODE_ID, childId);
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client[Symbol.dispose]();
    });

    it('removeEdge on non-existent edge is a no-op', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'node-x', 'X');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const xId = client.lastResult as number;

      client.callStarCreateNode(star, ROOT_NODE_ID, 'node-y', 'Y');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const yId = client.lastResult as number;

      // No edge between X and Y → no-op
      client.callStarRemoveEdge(star, xId, yId);
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client[Symbol.dispose]();
    });
  });

  // ─── Reparent ─────────────────────────────────────────────────────

  describe('reparentNode', () => {
    it('moves a node from one parent to another', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'old-parent', 'Old');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const oldId = client.lastResult as number;

      client.callStarCreateNode(star, ROOT_NODE_ID, 'new-parent', 'New');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const newId = client.lastResult as number;

      client.callStarCreateNode(star, oldId, 'child', 'Child');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const childId = client.lastResult as number;

      client.callStarReparentNode(star, childId, oldId, newId);
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      // Verify: child now under newId, not oldId
      client.callStarDagTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as DagTreeState;
        expect(state.nodes.get(newId)!.childIds).toContain(childId);
        expect(state.nodes.get(oldId)!.childIds).not.toContain(childId);
        expect(state.nodes.get(childId)!.parentIds).toContain(newId);
        expect(state.nodes.get(childId)!.parentIds).not.toContain(oldId);
      });

      client[Symbol.dispose]();
    });

    it('throws if old edge does not exist', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'node-p', 'P');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const pId = client.lastResult as number;

      client.callStarCreateNode(star, ROOT_NODE_ID, 'node-q', 'Q');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const qId = client.lastResult as number;

      // pId → qId edge doesn't exist
      client.callStarReparentNode(star, qId, pId, ROOT_NODE_ID);
      await vi.waitFor(() => {
        expect(client.lastError).toContain('does not exist');
      });

      client[Symbol.dispose]();
    });
  });

  // ─── Soft Delete ──────────────────────────────────────────────────

  describe('soft delete', () => {
    it('deleteNode sets flag, undeleteNode restores, getState shows deleted: true', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'temp', 'Temp');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const tempId = client.lastResult as number;

      // Delete
      client.callStarDeleteNode(star, tempId);
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client.callStarDagTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as DagTreeState;
        expect(state.nodes.get(tempId)!.deleted).toBe(true);
      });

      // Undelete
      client.callStarUndeleteNode(star, tempId);
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client.callStarDagTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as DagTreeState;
        expect(state.nodes.get(tempId)!.deleted).toBe(false);
      });

      client[Symbol.dispose]();
    });

    it('deleteNode is idempotent — already deleted is a no-op', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'idem', 'Idem');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const id = client.lastResult as number;

      client.callStarDeleteNode(star, id);
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      // Delete again → no-op, no error
      client.callStarDeleteNode(star, id);
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client[Symbol.dispose]();
    });

    it('undeleteNode is idempotent — not deleted is a no-op', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'alive', 'Alive');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const id = client.lastResult as number;

      // Undelete a non-deleted node → no-op
      client.callStarUndeleteNode(star, id);
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client[Symbol.dispose]();
    });

    it('undeleteNode throws on root', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarUndeleteNode(star, ROOT_NODE_ID);
      await vi.waitFor(() => {
        expect(client.lastError).toContain('Cannot undelete root node');
      });

      client[Symbol.dispose]();
    });

    it('mutations on deleted nodes succeed', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'parent-del', 'Parent');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const parentId = client.lastResult as number;

      client.callStarDeleteNode(star, parentId);
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      // Create child under deleted parent → succeeds
      client.callStarCreateNode(star, parentId, 'child-of-del', 'Child');
      await vi.waitFor(() => {
        expect(client.lastResult).toBeDefined();
        expect(client.lastError).toBeUndefined();
      });
      const childId = client.lastResult as number;

      // Rename deleted node → succeeds
      client.callStarRenameNode(star, parentId, 'renamed-del');
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      // Relabel deleted node → succeeds
      client.callStarRelabelNode(star, parentId, 'Renamed Label');
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client[Symbol.dispose]();
    });

    it('permission climbing continues through deleted nodes', async () => {
      const star = uniqueStar();
      const { client, payload } = await adminClient(star);
      const adminSub = payload.sub;

      // Build: root → A → B
      client.callStarCreateNode(star, ROOT_NODE_ID, 'node-a', 'A');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const aId = client.lastResult as number;

      client.callStarCreateNode(star, aId, 'node-b', 'B');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const bId = client.lastResult as number;

      // Grant write on A, then delete A
      client.callStarSetPermission(star, aId, adminSub, 'write');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarDeleteNode(star, aId);
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      // Check permission on B — should still resolve write via deleted A
      client.callStarCheckPermission(star, bId, 'write');
      await vi.waitFor(() => {
        expect(client.lastResult).toBe(true);
      });

      client[Symbol.dispose]();
    });
  });

  // ─── Label Validation ─────────────────────────────────────────────

  describe('relabelNode validation', () => {
    it('rejects empty and >500 char labels', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'labeled', 'Label');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const nodeId = client.lastResult as number;

      client.callStarRelabelNode(star, nodeId, '');
      await vi.waitFor(() => expect(client.lastError).toContain('empty'));

      client.callStarRelabelNode(star, nodeId, 'x'.repeat(501));
      await vi.waitFor(() => expect(client.lastError).toContain('500'));

      client[Symbol.dispose]();
    });
  });

  // ─── Permission CRUD ──────────────────────────────────────────────

  describe('permission CRUD', () => {
    it('setPermission, checkPermission, getEffectivePermission, revokePermission', async () => {
      const star = uniqueStar();
      const { client, payload } = await adminClient(star);
      const adminSub = payload.sub;

      client.callStarCreateNode(star, ROOT_NODE_ID, 'secured', 'Secured');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const nodeId = client.lastResult as number;

      // Grant read
      client.callStarSetPermission(star, nodeId, adminSub, 'read');
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      // Check permission (self, no targetSub)
      client.callStarCheckPermission(star, nodeId, 'read');
      await vi.waitFor(() => expect(client.lastResult).toBe(true));

      client.callStarCheckPermission(star, nodeId, 'write');
      await vi.waitFor(() => expect(client.lastResult).toBe(false));

      // Get effective (self)
      client.callStarGetEffectivePermission(star, nodeId);
      await vi.waitFor(() => expect(client.lastResult).toBe('read'));

      // Upgrade to write via upsert
      client.callStarSetPermission(star, nodeId, adminSub, 'write');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarCheckPermission(star, nodeId, 'write');
      await vi.waitFor(() => expect(client.lastResult).toBe(true));

      // Revoke
      client.callStarRevokePermission(star, nodeId, adminSub);
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      // Star admin still bypasses DAG check
      client.callStarCheckPermission(star, nodeId, 'admin');
      // Note: checkPermission doesn't use Star admin bypass (it delegates to resolvePermission)
      // so with no grant this should return false for DAG check
      await vi.waitFor(() => expect(client.lastResult).toBe(false));

      client[Symbol.dispose]();
    });

    it('revokePermission is idempotent — no grant is a no-op', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'no-perm', 'No Perm');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const nodeId = client.lastResult as number;

      // Revoke non-existent grant → no-op
      client.callStarRevokePermission(star, nodeId, 'nobody-sub');
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client[Symbol.dispose]();
    });

    it('setPermission replaces existing tier (upsert)', async () => {
      const star = uniqueStar();
      const { client, payload } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'upsert-test', 'Upsert');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const nodeId = client.lastResult as number;

      // Grant admin, then downgrade to read
      client.callStarSetPermission(star, nodeId, payload.sub, 'admin');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarSetPermission(star, nodeId, payload.sub, 'read');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarGetEffectivePermission(star, nodeId);
      await vi.waitFor(() => expect(client.lastResult).toBe('read'));

      client[Symbol.dispose]();
    });
  });

  // ─── Permission Rolldown ──────────────────────────────────────────

  describe('permission rolldown', () => {
    it('grant on root → all descendants, highest from any path wins', async () => {
      const star = uniqueStar();
      const { client, payload } = await adminClient(star);
      const sub = payload.sub;

      // Build: root → A → C, root → B → C (diamond), C → D
      client.callStarCreateNode(star, ROOT_NODE_ID, 'branch-a', 'A');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const aId = client.lastResult as number;

      client.callStarCreateNode(star, ROOT_NODE_ID, 'branch-b', 'B');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const bId = client.lastResult as number;

      client.callStarCreateNode(star, aId, 'team-c', 'C');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const cId = client.lastResult as number;

      client.callStarAddEdge(star, bId, cId); // diamond
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarCreateNode(star, cId, 'project-d', 'D');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const dId = client.lastResult as number;

      // Grant write on A, read on B
      client.callStarSetPermission(star, aId, sub, 'write');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarSetPermission(star, bId, sub, 'read');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      // C: write via A (highest), read via B → effective: write
      client.callStarGetEffectivePermission(star, cId);
      await vi.waitFor(() => expect(client.lastResult).toBe('write'));

      // D: write rolls down from A through C
      client.callStarGetEffectivePermission(star, dId);
      await vi.waitFor(() => expect(client.lastResult).toBe('write'));

      // Grant on root → all descendants
      client.callStarSetPermission(star, ROOT_NODE_ID, sub, 'admin');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarGetEffectivePermission(star, dId);
      await vi.waitFor(() => expect(client.lastResult).toBe('admin'));

      client[Symbol.dispose]();
    });

    it('no grant on any ancestor → denied', async () => {
      const star = uniqueStar();
      const { client, payload } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'isolated', 'Isolated');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const nodeId = client.lastResult as number;

      // No grants at all → null effective, false check
      client.callStarGetEffectivePermission(star, nodeId);
      await vi.waitFor(() => expect(client.lastResult).toBeNull());

      client.callStarCheckPermission(star, nodeId, 'read');
      await vi.waitFor(() => expect(client.lastResult).toBe(false));

      client[Symbol.dispose]();
    });
  });

  // ─── getState permissions ─────────────────────────────────────────

  describe('getState includes permissions', () => {
    it('permissions map contains all direct grants for all subjects', async () => {
      const star = uniqueStar();
      const { client, payload } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'perms-node', 'Perms');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const nodeId = client.lastResult as number;

      client.callStarSetPermission(star, nodeId, payload.sub, 'write');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarSetPermission(star, nodeId, 'other-sub', 'read');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarDagTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as DagTreeState;
        const nodePerms = state.permissions.get(nodeId);
        expect(nodePerms).toBeInstanceOf(Map);
        expect(nodePerms!.get(payload.sub)).toBe('write');
        expect(nodePerms!.get('other-sub')).toBe('read');
      });

      client[Symbol.dispose]();
    });
  });

  // ─── Authorization Enforcement ────────────────────────────────────

  describe('authorization enforcement', () => {
    it('Star admin bypasses DAG checks', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // Star admin can create nodes without any DAG grants
      client.callStarCreateNode(star, ROOT_NODE_ID, 'admin-created', 'Admin');
      await vi.waitFor(() => {
        expect(client.lastResult).toBeDefined();
        expect(client.lastError).toBeUndefined();
      });

      client[Symbol.dispose]();
    });

    it('non-admin without DAG write cannot create nodes', async () => {
      const star = uniqueStar();
      const { client: admin, payload: adminPayload } = await adminClient(star);

      // Initialize tree with admin
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'dept', 'Dept');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      admin[Symbol.dispose]();

      // Create non-admin user
      const { client: user } = await userClient(star, '');
      user.callStarCreateNode(star, ROOT_NODE_ID, 'unauthorized', 'Nope');
      await vi.waitFor(() => {
        expect(user.lastError).toContain('write permission required');
      });

      user[Symbol.dispose]();
    });

    it('user with DAG write can create child nodes', async () => {
      const star = uniqueStar();
      const { client: admin } = await adminClient(star);

      // Create a node and grant write on it
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'writable', 'Writable');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      const nodeId = admin.lastResult as number;

      // Create non-admin user
      const adminBrowser = new Browser();
      const { accessToken: adminToken } = await browserLogin(adminBrowser, star, 'admin@example.com', star);
      const userBrowser = new Browser();
      await createSubject(adminBrowser, star, adminToken, 'writer@example.com');
      const { client: writer, payload: writerPayload } = await createAuthenticatedClient(
        NebulaClientTest, userBrowser, star, star, 'writer@example.com',
      );

      // Grant write on nodeId to the writer
      admin.callStarSetPermission(star, nodeId, writerPayload.sub, 'write');
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));

      // Writer creates child → succeeds
      writer.callStarCreateNode(star, nodeId, 'child-node', 'Child');
      await vi.waitFor(() => {
        expect(writer.lastResult).toBeDefined();
        expect(writer.lastError).toBeUndefined();
      });

      admin[Symbol.dispose]();
      writer[Symbol.dispose]();
    });

    it('write permission does not allow granting permissions (requires admin)', async () => {
      const star = uniqueStar();
      const { client: admin } = await adminClient(star);

      admin.callStarCreateNode(star, ROOT_NODE_ID, 'restricted', 'Restricted');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      const nodeId = admin.lastResult as number;

      // Create non-admin user with write access
      const adminBrowser = new Browser();
      const { accessToken: adminToken } = await browserLogin(adminBrowser, star, 'admin@example.com', star);
      const userBrowser = new Browser();
      await createSubject(adminBrowser, star, adminToken, 'writer2@example.com');
      const { client: writer, payload: writerPayload } = await createAuthenticatedClient(
        NebulaClientTest, userBrowser, star, star, 'writer2@example.com',
      );

      admin.callStarSetPermission(star, nodeId, writerPayload.sub, 'write');
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));

      // Writer tries to grant permissions → denied (needs admin)
      writer.callStarSetPermission(star, nodeId, 'someone-else', 'read');
      await vi.waitFor(() => {
        expect(writer.lastError).toContain('admin permission required');
      });

      admin[Symbol.dispose]();
      writer[Symbol.dispose]();
    });
  });

  // ─── Traversal ────────────────────────────────────────────────────

  describe('traversal', () => {
    it('getNodeAncestors and getNodeDescendants', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // Build: root → A → B → C
      client.callStarCreateNode(star, ROOT_NODE_ID, 'anc-a', 'A');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const aId = client.lastResult as number;

      client.callStarCreateNode(star, aId, 'anc-b', 'B');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const bId = client.lastResult as number;

      client.callStarCreateNode(star, bId, 'anc-c', 'C');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const cId = client.lastResult as number;

      // Ancestors of C = {B, A, root}
      client.callStarGetNodeAncestors(star, cId);
      await vi.waitFor(() => {
        const ancestors = client.lastResult as Set<number>;
        expect(ancestors).toBeInstanceOf(Set);
        expect(ancestors.has(bId)).toBe(true);
        expect(ancestors.has(aId)).toBe(true);
        expect(ancestors.has(ROOT_NODE_ID)).toBe(true);
        expect(ancestors.has(cId)).toBe(false); // excludes self
      });

      // Descendants of root = {A, B, C}
      client.callStarGetNodeDescendants(star, ROOT_NODE_ID);
      await vi.waitFor(() => {
        const descendants = client.lastResult as Set<number>;
        expect(descendants.has(aId)).toBe(true);
        expect(descendants.has(bId)).toBe(true);
        expect(descendants.has(cId)).toBe(true);
        expect(descendants.has(ROOT_NODE_ID)).toBe(false); // excludes self
      });

      client[Symbol.dispose]();
    });
  });

  // ─── Rename with Slug Uniqueness ──────────────────────────────────

  describe('renameNode slug uniqueness', () => {
    it('checks uniqueness under every parent of the node', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // root → A, root → B (sibling)
      client.callStarCreateNode(star, ROOT_NODE_ID, 'rename-a', 'A');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const aId = client.lastResult as number;

      client.callStarCreateNode(star, ROOT_NODE_ID, 'rename-b', 'B');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());

      // Rename A to B's slug → conflict under root
      client.callStarRenameNode(star, aId, 'rename-b');
      await vi.waitFor(() => {
        expect(client.lastError).toContain("Slug 'rename-b' already exists");
      });

      // Rename to a unique slug → succeeds
      client.callStarRenameNode(star, aId, 'renamed-a');
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client[Symbol.dispose]();
    });
  });

  // ─── Bootstrap Flow ───────────────────────────────────────────────

  describe('bootstrap flow', () => {
    it('Star admin builds tree and delegates via setPermission', async () => {
      const star = uniqueStar();
      const { client: admin } = await adminClient(star);

      // Star admin creates structure (no DAG grants needed — JWT admin bypasses)
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'org', 'Organization');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      const orgId = admin.lastResult as number;

      admin.callStarCreateNode(star, orgId, 'team', 'Team');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      const teamId = admin.lastResult as number;

      // Create a user and delegate admin on team subtree
      const adminBrowser = new Browser();
      const { accessToken: adminToken } = await browserLogin(adminBrowser, star, 'admin@example.com', star);
      const userBrowser = new Browser();
      await createSubject(adminBrowser, star, adminToken, 'lead@example.com');
      const { client: lead, payload: leadPayload } = await createAuthenticatedClient(
        NebulaClientTest, userBrowser, star, star, 'lead@example.com',
      );

      // Star admin grants admin on team to lead
      admin.callStarSetPermission(star, teamId, leadPayload.sub, 'admin');
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));

      // Lead can now create nodes under team (via DAG admin rolldown)
      lead.callStarCreateNode(star, teamId, 'project', 'Project');
      await vi.waitFor(() => {
        expect(lead.lastResult).toBeDefined();
        expect(lead.lastError).toBeUndefined();
      });
      const projectId = lead.lastResult as number;

      // Lead can grant permissions within their subtree
      lead.callStarSetPermission(star, projectId, 'dev-sub', 'write');
      await vi.waitFor(() => {
        expect(lead.callCompleted).toBe(true);
        expect(lead.lastError).toBeUndefined();
      });

      // Lead cannot create nodes outside their subtree (under org directly)
      lead.callStarCreateNode(star, orgId, 'rogue', 'Rogue');
      await vi.waitFor(() => {
        expect(lead.lastError).toContain('write permission required');
      });

      admin[Symbol.dispose]();
      lead[Symbol.dispose]();
    });
  });

  // ─── Universe Admin Cross-Access ──────────────────────────────────

  describe('universe admin (wildcard JWT) has full DAG access', () => {
    it('universe admin bypasses all DAG checks via Star admin flag', async () => {
      const universe = `uni-${generateUuid().slice(0, 8)}`;
      const star = `${universe}.app.tenant-a`;

      // Bootstrap at star level first to create the Star DO
      const starBrowser = new Browser();
      const { client: starAdmin } = await createAuthenticatedClient(
        NebulaClientTest, starBrowser, star, star, 'star-admin@example.com',
      );
      starAdmin.callStarCreateNode(star, ROOT_NODE_ID, 'star-node', 'Star Node');
      await vi.waitFor(() => expect(starAdmin.lastResult).toBeDefined());
      starAdmin[Symbol.dispose]();

      // Universe admin connects to the same star
      const uniBrowser = new Browser();
      const { client: uniAdmin } = await createAuthenticatedClient(
        NebulaClientTest, uniBrowser, universe, star, 'universe-admin@example.com',
      );

      // Universe admin can create nodes (Star admin bypass)
      uniAdmin.callStarCreateNode(star, ROOT_NODE_ID, 'uni-node', 'Universe Node');
      await vi.waitFor(() => {
        expect(uniAdmin.lastResult).toBeDefined();
        expect(uniAdmin.lastError).toBeUndefined();
      });

      uniAdmin[Symbol.dispose]();
    });
  });
});
