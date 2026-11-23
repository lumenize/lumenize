/**
 * DAG Tree access control tests
 *
 * Tests OrgTree operations, authorization enforcement, permission resolution,
 * and Star DO integration through the baseline test-app.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/resources';
import type { OrgTreeState } from '@lumenize/resources';
import type { Star } from '@lumenize/nebula';
import {
  adminClientAt, universeAdminClient, createInvitedClient, foundAndLogin, createSubject, uniqueGalaxyScope, ownerOf,
} from '../../test-helpers';
import { NebulaClientTest } from './index';

/** Each universe's founder has its own address: one address may own at most MAX_GALAXIES_PER_OWNER
 *  galaxies, and every founding's claim writes one, so a shared address hits the cap mid-file. */
const adminOf = (scope: string) => `admin-${scope.split('.')[0]}@example.com`;

// Helper: create a unique star scope per test to avoid cross-test interference
function uniqueStar(): string {
  return `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;
}

// Helper: create admin client connected to a star
async function adminClient(star: string) {
  const browser = new Browser();
  return adminClientAt(NebulaClientTest, browser, star, star, adminOf(star));
}

// Helper: create a non-admin user client
async function userClient(star: string, adminToken: string, email = 'user@example.com') {
  const adminBrowser = new Browser();
  // Need a browser with the admin's cookies for createSubject
  const { accessToken } = await foundAndLogin(adminBrowser, star, ownerOf(adminOf(star)));
  const userBrowser = new Browser();
  await createSubject(adminBrowser, star, accessToken, email);
  return createInvitedClient(NebulaClientTest, userBrowser, star, star, email);
}

describe('org-tree', () => {

  // ─── Schema & Root Node ───────────────────────────────────────────

  describe('schema and root node', () => {
    it('root node exists with the root sentinel id, slug root, label Root after onStart', async () => {
      const star = uniqueStar();
      const { client, payload } = await adminClient(star);

      client.callStarOrgTreeGetState(star);
      await vi.waitFor(() => {
        expect(client.lastResult).toBeDefined();
      });

      const state = client.lastResult as OrgTreeState;
      expect(state.nodes).toBeInstanceOf(Map);
      expect(state.nodes.size).toBe(1);

      const root = state.nodes.get(ROOT_NODE_ID);
      expect(root).toBeDefined();
      expect(root!.slug).toBe('root');
      expect(root!.label).toBe('Root');
      expect(root!.deleted).toBe(false);

      expect(state.edges).toBeInstanceOf(Set);
      expect(state.edges.size).toBe(0);

      // The connecting admin acts through the scope-admin bypass and holds no grant in the tree.
      expect(state.permissions).toBeInstanceOf(Map);
      expect(state.permissions.size).toBe(0);
      expect(state.permissions.get(ROOT_NODE_ID)?.get(payload.sub)).toBeUndefined();

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

      client.callStarOrgTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as OrgTreeState;
        expect(state.nodes.get(ROOT_NODE_ID)!.label).toBe('My Root');
      });

      client[Symbol.dispose]();
    });
  });

  // ─── A star-level scopeAdmin acts through the bypass ──

  describe('a star-level scopeAdmin acts on its own tree with no DAG grant', () => {
    // The admin is the `.dev` one a galaxy invite co-mints with `scopeAdmin`, so their dominion is
    // exactly this Star: the bypass in `requirePermission` admits them on equality with the host.
    it('the co-minted .dev admin creates a node on its own Star, holding no grant there', async () => {
      const { galaxy, dev } = uniqueGalaxyScope();
      const adminBrowser = new Browser();
      const { accessToken } = await foundAndLogin(adminBrowser, galaxy, ownerOf(adminOf(galaxy)), galaxy);
      await createSubject(adminBrowser, galaxy, accessToken, 'devadmin@example.com');
      const { client: devAdmin, payload } = await createInvitedClient(
        NebulaClientTest, new Browser(), dev, dev, 'devadmin@example.com');
      // Fixture guard: the bit at exactly this Star, so only the equality arm can admit them.
      expect(payload.access).toEqual({ authScope: dev, scopeAdmin: true });

      devAdmin.callStarOrgTreeGetState(dev);
      await vi.waitFor(() => expect((devAdmin.lastResult as OrgTreeState).permissions.size).toBe(0));

      // Mutation: confine the bypass to an admin strictly above the host, and this is refused by
      // the DAG's message.
      devAdmin.callStarCreateNode(dev, ROOT_NODE_ID, 'own-tree', 'Own Tree');
      await vi.waitFor(() => expect(devAdmin.callCompleted).toBe(true));
      expect(devAdmin.lastError).toBeUndefined(); // a refusal shows its message here
      expect(devAdmin.lastResult).toBeDefined();

      devAdmin[Symbol.dispose]();
    });
  });

  // ─── Tree Construction ────────────────────────────────────────────

  describe('tree construction', () => {
    it('createNode stores the node under the id the caller minted, with its slug and label', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'engineering', 'Engineering');
      await vi.waitFor(() => {
        expect(client.lastResult).toBeDefined();
        expect(client.lastError).toBeUndefined();
      });
      const engId = client.lastResult as string;
      // nodeId is now a client-supplied UUID — the old numeric-ordering assert
      // (`> ROOT_NODE_ID`) is type-invalid and meaningless; identity is verified by
      // the getState lookup below.
      expect(engId).not.toBe(ROOT_NODE_ID);
      expect(engId).toMatch(/^[0-9a-f-]{36}$/);

      // Verify via getState
      client.callStarOrgTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as OrgTreeState;
        const eng = state.nodes.get(engId);
        expect(eng).toBeDefined();
        expect(eng!.slug).toBe('engineering');
        expect(eng!.label).toBe('Engineering');
        expect(eng!.deleted).toBe(false);
        expect(state.edges.has(`${ROOT_NODE_ID}:${engId}`)).toBe(true);
      });

      client[Symbol.dispose]();
    });

    it('builds a multi-level tree and verifies structure via getState', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // root → A → C, root → B → C (diamond)
      client.callStarCreateNode(star, ROOT_NODE_ID, 'dept-a', 'Department A');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const aId = client.lastResult as string;

      client.callStarCreateNode(star, ROOT_NODE_ID, 'dept-b', 'Department B');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const bId = client.lastResult as string;

      client.callStarCreateNode(star, aId, 'team-c', 'Team C');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const cId = client.lastResult as string;

      // Add second parent edge: B → C (making a diamond)
      client.callStarAddEdge(star, bId, cId);
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      // Verify structure
      client.callStarOrgTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as OrgTreeState;
        expect(state.edges.has(`${ROOT_NODE_ID}:${aId}`)).toBe(true);
        expect(state.edges.has(`${ROOT_NODE_ID}:${bId}`)).toBe(true);
        expect(state.edges.has(`${aId}:${cId}`)).toBe(true);
        expect(state.edges.has(`${bId}:${cId}`)).toBe(true);
      });

      client[Symbol.dispose]();
    });
  });

  // ─── createNode idempotency & client-supplied ids ────────────────

  describe('createNode idempotency & id-supply', () => {
    it('replays a client-supplied id: same id twice → one node, second returns it (idempotent)', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const nodeId = crypto.randomUUID();

      client.callStarCreateNodeWithId(star, nodeId, ROOT_NODE_ID, 'eng', 'Engineering');
      await vi.waitFor(() => expect(client.lastCreateOutcome).toBe('created'));

      // The same create again answers 'existing', with no error. An implementation that inserted
      // again would fail on the slug or the primary key.
      client.callStarCreateNodeWithId(star, nodeId, ROOT_NODE_ID, 'eng', 'Engineering');
      await vi.waitFor(() => {
        expect(client.lastCreateOutcome).toBe('existing');
        expect(client.lastError).toBeUndefined();
      });

      // Exactly ONE node with that slug — the replay created no duplicate.
      client.callStarOrgTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as OrgTreeState;
        expect(state.nodes.has(nodeId)).toBe(true);
        expect([...state.nodes.values()].filter((n) => n.slug === 'eng')).toHaveLength(1);
      });

      client[Symbol.dispose]();
    });

    it('B1 security gate: a replay by a caller who has LOST write fails — permission runs BEFORE the id-presence check', async () => {
      const star = uniqueStar();
      const { client: admin } = await adminClient(star);

      // Admin creates parent P.
      const parentId = crypto.randomUUID();
      admin.callStarCreateNodeWithId(star, parentId, ROOT_NODE_ID, 'dept', 'Dept');
      await vi.waitFor(() => expect(admin.lastResult).toBe(parentId));

      // A non-admin writer, granted 'write' on P.
      const adminBrowser = new Browser();
      const { accessToken } = await foundAndLogin(adminBrowser, star, ownerOf(adminOf(star)));
      const writerBrowser = new Browser();
      await createSubject(adminBrowser, star, accessToken, 'writer@example.com');
      const { client: writer, payload: writerPayload } =
        await createInvitedClient(NebulaClientTest, writerBrowser, star, star, 'writer@example.com');
      admin.callStarSetPermission(star, parentId, writerPayload.sub, 'write');
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));

      // Writer creates a child under P (succeeds — has write).
      const childId = crypto.randomUUID();
      writer.callStarCreateNodeWithId(star, childId, parentId, 'child', 'Child');
      await vi.waitFor(() => expect(writer.lastResult).toBe(childId));

      // Admin revokes the writer's write on P.
      admin.callStarRevokePermission(star, parentId, writerPayload.sub);
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));

      // Writer RETRIES the identical create (same childId). Because createNode runs
      // requirePermission BEFORE the id-presence replay short-circuit, this must FAIL
      // with PermissionDenied — NOT return the existing node (which would leak its
      // slug/label content to a now-unauthorized caller). Mutation: move the
      // id-presence short-circuit before requirePermission → replay-success → red.
      writer.callStarCreateNodeWithId(star, childId, parentId, 'child', 'Child');
      await vi.waitFor(() => expect(writer.lastError).toContain('write permission required'));

      admin[Symbol.dispose]();
      writer[Symbol.dispose]();
    });

    it('shape: a malformed id and a missing label are refused', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // Malformed (non-UUID) id → validateNodeId rejects it (the server does not trust
      // the client to send a well-formed id). Mutation: drop validateNodeId → no error → red.
      client.callStarCreateNodeWithId(star, 'not-a-uuid', ROOT_NODE_ID, 'slug-c', 'C');
      await vi.waitFor(() => expect(client.lastError).toContain('Invalid nodeId'));

      // A node with no label is refused by name. Mutation: drop the label check → no error → red.
      client.callStarCreateNodeWithId(star, crypto.randomUUID(), ROOT_NODE_ID, 'slug-d', undefined as unknown as string);
      await vi.waitFor(() => expect(client.lastError).toContain('A node needs a label'));

      client[Symbol.dispose]();
    });
  });

  // ─── createNode says what it found ────────────────────────────────

  describe('createNode answers created, existing or differs, and writes only when the id is absent', () => {
    /** Run one create and answer what came back, once the call has completed. */
    async function create(
      client: NebulaClientTest, star: string, nodeId: string, parentId: string, slug: string,
      grants?: Array<{ sub: string; tier: 'read' | 'write' | 'admin' }>,
    ) {
      client.callStarCreateNodeWithId(star, nodeId, parentId, slug, slug.toUpperCase(), grants);
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));
      return { outcome: client.lastCreateOutcome, error: client.lastError, name: client.lastErrorObject?.name };
    }
    async function settle(client: NebulaClientTest) {
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));
      expect(client.lastError).toBeUndefined();
    }
    async function treeOf(client: NebulaClientTest, star: string): Promise<OrgTreeState> {
      client.callStarOrgTreeGetState(star);
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      return client.lastResult as OrgTreeState;
    }

    // MUTATIONS: answer 'existing' for every id found, and the rename, move and delete cases red.
    // Compare the label too, and the relabel case answers 'differs'.
    it('a repeat leaves the tree as it stands, whatever an admin has done to the node since', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const other = crypto.randomUUID();
      expect((await create(client, star, other, ROOT_NODE_ID, 'other')).outcome).toBe('created');

      const node = crypto.randomUUID();
      expect((await create(client, star, node, ROOT_NODE_ID, 'team')).outcome).toBe('created');
      const asCreated = await treeOf(client, star);
      expect((await create(client, star, node, ROOT_NODE_ID, 'team')).outcome).toBe('existing');
      expect(await treeOf(client, star)).toEqual(asCreated);

      client.callStarRelabelNode(star, node, 'The Team');
      await settle(client);
      const relabeled = await treeOf(client, star);
      expect(relabeled.nodes.get(node)?.label).toBe('The Team');
      expect((await create(client, star, node, ROOT_NODE_ID, 'team')).outcome).toBe('existing');
      expect(await treeOf(client, star)).toEqual(relabeled);

      client.callStarRenameNode(star, node, 'crew');
      await settle(client);
      const renamed = await treeOf(client, star);
      expect((await create(client, star, node, ROOT_NODE_ID, 'team')).outcome).toBe('differs');
      expect(await treeOf(client, star)).toEqual(renamed);

      // Named as it was again, then moved under another parent.
      client.callStarRenameNode(star, node, 'team');
      await settle(client);
      client.callStarReparentNode(star, node, ROOT_NODE_ID, other);
      await settle(client);
      const moved = await treeOf(client, star);
      expect((await create(client, star, node, ROOT_NODE_ID, 'team')).outcome).toBe('differs');
      expect(await treeOf(client, star)).toEqual(moved);
      expect((await create(client, star, node, other, 'team')).outcome).toBe('existing');

      client.callStarDeleteNode(star, node);
      await settle(client);
      const deleted = await treeOf(client, star);
      expect((await create(client, star, node, other, 'team')).outcome).toBe('differs');
      expect(await treeOf(client, star)).toEqual(deleted);

      client[Symbol.dispose]();
    });

    // MUTATION: keep the plain Error for a taken slug, and both names red.
    it('a slug a sibling holds is refused by name, on a create and on a rename', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const first = crypto.randomUUID();
      expect((await create(client, star, first, ROOT_NODE_ID, 'sales')).outcome).toBe('created');

      const second = crypto.randomUUID();
      const taken = await create(client, star, second, ROOT_NODE_ID, 'sales');
      expect(taken.name).toBe('SlugTakenError');
      expect((await treeOf(client, star)).nodes.has(second)).toBe(false);

      expect((await create(client, star, second, ROOT_NODE_ID, 'support')).outcome).toBe('created');
      client.callStarRenameNode(star, second, 'sales');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));
      expect(client.lastErrorObject?.name).toBe('SlugTakenError');

      client[Symbol.dispose]();
    });

    // MUTATIONS: ask only `write` when grants are given, and the writer's node lands with its
    // grant. Ask for `admin` only once the node is found absent, and the refusal for a node that
    // exists turns into 'existing'. Write `grants` for a node that exists, and the revoked grant
    // comes back.
    it('starting grants take admin at the parent, and are written only with the node', async () => {
      const star = uniqueStar();
      const { client: admin } = await adminClient(star);
      const { client: user, payload } = await userClient(star, '', 'grantor@example.com');
      const GRANTEE = 'agent:helper';
      const parent = crypto.randomUUID();
      expect((await create(admin, star, parent, ROOT_NODE_ID, 'dept')).outcome).toBe('created');
      const there = crypto.randomUUID();
      expect((await create(admin, star, there, parent, 'there')).outcome).toBe('created');

      // No grant at all: refused whether or not the id exists.
      for (const id of [there, crypto.randomUUID()]) {
        const refused = await create(user, star, id, parent, 'there');
        expect(refused.name).toBe('PermissionDeniedError');
        expect(refused.error).toContain('write permission required');
      }

      admin.callStarSetPermission(star, parent, payload.sub, 'write');
      await settle(admin);
      const withGrant = crypto.randomUUID();
      for (const [id, slug] of [[withGrant, 'granted'], [there, 'there']]) {
        const refused = await create(user, star, id, parent, slug, [{ sub: GRANTEE, tier: 'read' }]);
        expect(refused.name).toBe('PermissionDeniedError');
        expect(refused.error).toContain('admin permission required');
      }
      expect((await treeOf(admin, star)).nodes.has(withGrant)).toBe(false);
      expect((await create(user, star, crypto.randomUUID(), parent, 'plain', [])).outcome).toBe('created');

      admin.callStarSetPermission(star, parent, payload.sub, 'admin');
      await settle(admin);
      expect((await create(user, star, withGrant, parent, 'granted', [{ sub: GRANTEE, tier: 'read' }])).outcome).toBe('created');
      expect((await treeOf(admin, star)).permissions.get(withGrant)?.get(GRANTEE)).toBe('read');

      admin.callStarRevokePermission(star, withGrant, GRANTEE);
      await settle(admin);
      expect((await create(user, star, withGrant, parent, 'granted', [{ sub: GRANTEE, tier: 'read' }])).outcome).toBe('existing');
      expect((await treeOf(admin, star)).permissions.get(withGrant)?.get(GRANTEE)).toBeUndefined();

      admin[Symbol.dispose]();
      user[Symbol.dispose]();
    });

    // MUTATION: drop any one shape check, and its row creates the node or fails on another message.
    it.each([
      ['grants that are no array', 'everyone', /this is no array/],
      ['a grant with no sub', [{ tier: 'read' }], /names who holds it/],
      ['a grant with an empty sub', [{ sub: '', tier: 'read' }], /names who holds it/],
      ['a tier outside the vocabulary', [{ sub: 'agent:helper', tier: 'owner' }], /"owner" is none of them/],
    ])('refuses %s, and creates no node', async (_what, grants, message) => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const node = crypto.randomUUID();
      const refused = await create(client, star, node, ROOT_NODE_ID, 'team', grants as any);
      expect(refused.error).toMatch(message);
      expect((await treeOf(client, star)).nodes.has(node)).toBe(false);
      client[Symbol.dispose]();
    });

    // MUTATION: write the grants after the node's transaction, and the node is left behind.
    it('grants that name one sub twice fail the whole create', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const node = crypto.randomUUID();
      const refused = await create(client, star, node, ROOT_NODE_ID, 'team',
        [{ sub: 'agent:helper', tier: 'read' }, { sub: 'agent:helper', tier: 'write' }]);
      expect(refused.error).toContain('name "agent:helper" twice');
      const tree = await treeOf(client, star);
      expect(tree.nodes.has(node)).toBe(false);
      expect(tree.permissions.has(node)).toBe(false);
      client[Symbol.dispose]();
    });
  });

  // ─── Node-Not-Found ───────────────────────────────────────────────

  describe('node-not-found', () => {
    it('operations on non-existent nodeId throw', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      const bogusId = crypto.randomUUID(); // a valid-shaped but non-existent nodeId

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

      // too long (31 chars)
      client.callStarCreateNode(star, ROOT_NODE_ID, 'northwind-traders-international', 'Long');
      await vi.waitFor(() => expect(client.lastError).toContain('30 characters or fewer'));

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

      // Max length (30 chars)
      const maxSlug = 'a' + 'b'.repeat(28) + 'c';
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

    it('caps a node slug at 30 characters, the scope grammar', async () => {
      // In-lane: the cap is the shared slug predicate, run before the tree is touched.
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'northwind-traders-international', 'Northwind'); // 31
      await vi.waitFor(() => expect(client.lastError).toContain('30 characters or fewer'));

      // Positive control. The initiator clears the previous error, so this cannot pass on it.
      client.callStarCreateNode(star, ROOT_NODE_ID, 'warehouse-management-system', 'Warehouse'); // 27
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
      const salesId = client.lastResult as string;

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
      const aId = client.lastResult as string;

      client.callStarCreateNode(star, aId, 'node-b', 'B');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const bId = client.lastResult as string;

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
      const childId = client.lastResult as string;

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
      const xId = client.lastResult as string;

      client.callStarCreateNode(star, ROOT_NODE_ID, 'node-y', 'Y');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const yId = client.lastResult as string;

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
      const oldId = client.lastResult as string;

      client.callStarCreateNode(star, ROOT_NODE_ID, 'new-parent', 'New');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const newId = client.lastResult as string;

      client.callStarCreateNode(star, oldId, 'child', 'Child');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const childId = client.lastResult as string;

      client.callStarReparentNode(star, childId, oldId, newId);
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      // Verify: child now under newId, not oldId
      client.callStarOrgTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as OrgTreeState;
        expect(state.edges.has(`${newId}:${childId}`)).toBe(true);
        expect(state.edges.has(`${oldId}:${childId}`)).toBe(false);
      });

      client[Symbol.dispose]();
    });

    it('throws if old edge does not exist', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'node-p', 'P');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const pId = client.lastResult as string;

      client.callStarCreateNode(star, ROOT_NODE_ID, 'node-q', 'Q');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const qId = client.lastResult as string;

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
      const tempId = client.lastResult as string;

      // Delete
      client.callStarDeleteNode(star, tempId);
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client.callStarOrgTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as OrgTreeState;
        expect(state.nodes.get(tempId)!.deleted).toBe(true);
      });

      // Undelete
      client.callStarUndeleteNode(star, tempId);
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client.callStarOrgTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as OrgTreeState;
        expect(state.nodes.get(tempId)!.deleted).toBe(false);
      });

      client[Symbol.dispose]();
    });

    it('deleteNode is idempotent — already deleted is a no-op', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'idem', 'Idem');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const id = client.lastResult as string;

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
      const id = client.lastResult as string;

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
      const parentId = client.lastResult as string;

      client.callStarDeleteNode(star, parentId);
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      // Create child under deleted parent → succeeds
      client.callStarCreateNode(star, parentId, 'child-of-del', 'Child');
      await vi.waitFor(() => {
        expect(client.lastResult).toBeDefined();
        expect(client.lastError).toBeUndefined();
      });
      const childId = client.lastResult as string;

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
      const aId = client.lastResult as string;

      client.callStarCreateNode(star, aId, 'node-b', 'B');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const bId = client.lastResult as string;

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
      const nodeId = client.lastResult as string;

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
      const { client } = await adminClient(star);
      // Resolve for a distinct, non-admin subject, so the tier under test is the grant this test
      // sets and nothing else. The Star's admin (caller) performs the grants, passing the DAG
      // through the dominion bypass rather than a grant of its own.
      const testSub = crypto.randomUUID();

      client.callStarCreateNode(star, ROOT_NODE_ID, 'secured', 'Secured');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const nodeId = client.lastResult as string;

      // Grant read
      client.callStarSetPermission(star, nodeId, testSub, 'read');
      await vi.waitFor(() => {
        expect(client.callCompleted).toBe(true);
        expect(client.lastError).toBeUndefined();
      });

      client.callStarCheckPermission(star, nodeId, 'read', testSub);
      await vi.waitFor(() => expect(client.lastResult).toBe(true));

      client.callStarCheckPermission(star, nodeId, 'write', testSub);
      await vi.waitFor(() => expect(client.lastResult).toBe(false));

      client.callStarGetEffectivePermission(star, nodeId, testSub);
      await vi.waitFor(() => expect(client.lastResult).toBe('read'));

      // Upgrade to write via upsert
      client.callStarSetPermission(star, nodeId, testSub, 'write');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarCheckPermission(star, nodeId, 'write', testSub);
      await vi.waitFor(() => expect(client.lastResult).toBe(true));

      // Revoke
      client.callStarRevokePermission(star, nodeId, testSub);
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      // No grant → checkPermission resolves false (it delegates to
      // resolvePermission and does NOT use the scope-admin bypass).
      client.callStarCheckPermission(star, nodeId, 'admin', testSub);
      await vi.waitFor(() => expect(client.lastResult).toBe(false));

      client[Symbol.dispose]();
    });

    it('revokePermission is idempotent — no grant is a no-op', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      client.callStarCreateNode(star, ROOT_NODE_ID, 'no-perm', 'No Perm');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const nodeId = client.lastResult as string;

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
      const { client } = await adminClient(star);
      // Distinct subject — see the CRUD test above.
      const testSub = crypto.randomUUID();

      client.callStarCreateNode(star, ROOT_NODE_ID, 'upsert-test', 'Upsert');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const nodeId = client.lastResult as string;

      // Grant admin, then downgrade to read
      client.callStarSetPermission(star, nodeId, testSub, 'admin');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarSetPermission(star, nodeId, testSub, 'read');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarGetEffectivePermission(star, nodeId, testSub);
      await vi.waitFor(() => expect(client.lastResult).toBe('read'));

      client[Symbol.dispose]();
    });
  });

  // ─── Permission Rolldown ──────────────────────────────────────────

  describe('permission rolldown', () => {
    it('grant on root → all descendants, highest from any path wins', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      // Resolve for a distinct subject, holding only the grants this test writes.
      const sub = crypto.randomUUID();

      // Build: root → A → C, root → B → C (diamond), C → D
      client.callStarCreateNode(star, ROOT_NODE_ID, 'branch-a', 'A');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const aId = client.lastResult as string;

      client.callStarCreateNode(star, ROOT_NODE_ID, 'branch-b', 'B');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const bId = client.lastResult as string;

      client.callStarCreateNode(star, aId, 'team-c', 'C');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const cId = client.lastResult as string;

      client.callStarAddEdge(star, bId, cId); // diamond
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarCreateNode(star, cId, 'project-d', 'D');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const dId = client.lastResult as string;

      // Grant write on A, read on B
      client.callStarSetPermission(star, aId, sub, 'write');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarSetPermission(star, bId, sub, 'read');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      // C: write via A (highest), read via B → effective: write
      client.callStarGetEffectivePermission(star, cId, sub);
      await vi.waitFor(() => expect(client.lastResult).toBe('write'));

      // D: write rolls down from A through C
      client.callStarGetEffectivePermission(star, dId, sub);
      await vi.waitFor(() => expect(client.lastResult).toBe('write'));

      // Grant on root → all descendants
      client.callStarSetPermission(star, ROOT_NODE_ID, sub, 'admin');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarGetEffectivePermission(star, dId, sub);
      await vi.waitFor(() => expect(client.lastResult).toBe('admin'));

      client[Symbol.dispose]();
    });

    it('no grant on any ancestor → denied', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);
      // Distinct subject — see the CRUD test above.
      const testSub = crypto.randomUUID();

      client.callStarCreateNode(star, ROOT_NODE_ID, 'isolated', 'Isolated');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const nodeId = client.lastResult as string;

      // No grants at all → null effective, false check
      client.callStarGetEffectivePermission(star, nodeId, testSub);
      await vi.waitFor(() => expect(client.lastResult).toBeNull());

      client.callStarCheckPermission(star, nodeId, 'read', testSub);
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
      const nodeId = client.lastResult as string;

      client.callStarSetPermission(star, nodeId, payload.sub, 'write');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarSetPermission(star, nodeId, 'other-sub', 'read');
      await vi.waitFor(() => expect(client.callCompleted).toBe(true));

      client.callStarOrgTreeGetState(star);
      await vi.waitFor(() => {
        const state = client.lastResult as OrgTreeState;
        const nodePerms = state.permissions.get(nodeId);
        expect(nodePerms).toBeInstanceOf(Map);
        expect(nodePerms!.get(payload.sub)).toBe('write');
        expect(nodePerms!.get('other-sub')).toBe('read');
      });

      client[Symbol.dispose]();
    });

    it('returns a COPY — editing what it hands back changes no permission decision', async () => {
      // `getState` is reachable from the wire past the `resources` door, and the walk past a gate runs any
      // method the returned value carries, `Map.prototype.set` included. Returned by reference, the
      // state IS the cache every permission decision reads, so a member could grant themselves admin
      // at the root inside one chain — and then pass `setPermission`'s own check to make it durable.
      const star = uniqueStar();
      const { client: admin } = await adminClient(star);
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'seed', 'Seed'); // the tree exists before the member arrives
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      admin[Symbol.dispose]();

      const { client: user, payload } = await userClient(star, '');
      user.resetResults();
      const edit = ((user.ctn<Star>() as any).resources.orgTree.getState().permissions as any)
        .set(ROOT_NODE_ID, new Map([[payload.sub, 'admin']]));
      user.lmz.call('STAR', star, edit, user.ctn().handleResult(edit));
      await vi.waitFor(() => expect(user.callCompleted).toBe(true));
      // The chain RAN — so the refusal below is the copy at work, not a walk rule refusing `set`.
      expect(user.lastError).toBeUndefined();

      user.callStarSetPermission(star, ROOT_NODE_ID, payload.sub, 'admin');
      await vi.waitFor(() => expect(user.callCompleted).toBe(true));
      expect(user.lastError ?? 'no error — the member granted themselves admin at the root')
        .toContain('admin permission required');

      user[Symbol.dispose]();
    });

    // Every other public read that hands back an object, edited the same way inside one chain. Each
    // edit is the one that would matter if the read returned what the tree decides with: a parent
    // added to B's ancestors would let the member's `admin` at A reach B, a child added to A's
    // descendants would change what the tree reports, and an id added to `allowed` would change the
    // next verdict if the sets were kept. The tree's own answers must not move.
    it.each([
      ['getNodeAncestors', (ot: any, a: string, b: string) => ot.getNodeAncestors(b).add(a)],
      ['getNodeDescendants', (ot: any, a: string, b: string) => ot.getNodeDescendants(a).add(b)],
      ['evaluatePermissions', (ot: any, _a: string, b: string, sub: string) => ot.evaluatePermissions([b], 'admin', sub, false).allowed.add(b)],
    ])('%s returns a COPY — editing it moves no verdict and no later answer', async (_name, edit) => {
      const star = uniqueStar();
      const { client: admin, accessToken } = await adminClient(star);
      const a = crypto.randomUUID();
      await admin.orgTree.createNode(a, ROOT_NODE_ID, 'a', 'A');
      const b = crypto.randomUUID();
      await admin.orgTree.createNode(b, ROOT_NODE_ID, 'b', 'B');
      // A child under A, so A's descendants are a set the tree keeps — an empty answer would be
      // built fresh whatever the read returned, and could not show an edit landing.
      const c = crypto.randomUUID();
      await admin.orgTree.createNode(c, a, 'c', 'C');
      const { client: user, payload } = await userClient(star, accessToken);
      await admin.orgTree.setPermission(a, payload.sub, 'admin');

      user.resetResults();
      const chain = edit((user.ctn<Star>() as any).resources.orgTree, a, b, payload.sub);
      user.lmz.call('STAR', star, chain, user.ctn().handleResult(chain));
      await vi.waitFor(() => expect(user.callCompleted).toBe(true));
      expect(user.lastError).toBeUndefined(); // the chain ran, so what follows is the copy at work

      // The verdict: the member's `admin` at A still does not reach its sibling B.
      user.callStarSetPermission(star, b, payload.sub, 'admin');
      await vi.waitFor(() => expect(user.callCompleted).toBe(true));
      expect(user.lastError ?? 'no error — the edit let the member grant itself admin at B')
        .toContain('admin permission required');
      // The later answers: B has no ancestor A, A no descendant B, and B is still denied.
      const tree = (admin.ctn<Star>() as any).resources.orgTree;
      expect([...await admin.lmz.callAsync('STAR', star, tree.getNodeAncestors(b)) as Set<string>]).toEqual([ROOT_NODE_ID]);
      expect([...await admin.lmz.callAsync('STAR', star, tree.getNodeDescendants(a)) as Set<string>]).toEqual([c]);
      const verdict = await admin.lmz.callAsync('STAR', star, tree.evaluatePermissions([b], 'admin', payload.sub, false)) as { allowed: Set<string>; denied: Set<string> };
      expect([...verdict.allowed]).toEqual([]);
      expect([...verdict.denied]).toEqual([b]);

      admin[Symbol.dispose](); user[Symbol.dispose]();
    });
  });

  // ─── Authorization Enforcement ────────────────────────────────────

  describe('authorization enforcement', () => {
    it('scope admin (claims.access.scopeAdmin) bypasses DAG checks', async () => {
      const star = uniqueStar();
      const { client } = await adminClient(star);

      // Scope admin can create nodes without any DAG grants
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
      const nodeId = admin.lastResult as string;

      // Create non-admin user
      const adminBrowser = new Browser();
      const { accessToken: adminToken } = await foundAndLogin(adminBrowser, star, ownerOf(adminOf(star)));
      const userBrowser = new Browser();
      await createSubject(adminBrowser, star, adminToken, 'writer@example.com');
      const { client: writer, payload: writerPayload } = await createInvitedClient(
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
      const nodeId = admin.lastResult as string;

      // Create non-admin user with write access
      const adminBrowser = new Browser();
      const { accessToken: adminToken } = await foundAndLogin(adminBrowser, star, ownerOf(adminOf(star)));
      const userBrowser = new Browser();
      await createSubject(adminBrowser, star, adminToken, 'writer2@example.com');
      const { client: writer, payload: writerPayload } = await createInvitedClient(
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

    it('addEdge requires admin on the child — write grant cannot self-promote via grafting', async () => {
      const star = uniqueStar();
      const { client: admin } = await adminClient(star);

      // Build: root → mallory-home; root → victim
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'mallory-home', 'Mallory Home');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      const homeId = admin.lastResult as string;

      admin.callStarCreateNode(star, ROOT_NODE_ID, 'victim', 'Victim');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      const victimId = admin.lastResult as string;

      // Mallory: non-admin, admin on her own node, write (Approach-1
      // collaborator tier) on victim
      const adminBrowser = new Browser();
      const { accessToken: adminToken } = await foundAndLogin(adminBrowser, star, ownerOf(adminOf(star)));
      const malloryBrowser = new Browser();
      await createSubject(adminBrowser, star, adminToken, 'mallory@example.com');
      const { client: mallory, payload: malloryPayload } = await createInvitedClient(
        NebulaClientTest, malloryBrowser, star, star, 'mallory@example.com',
      );

      admin.callStarSetPermission(star, homeId, malloryPayload.sub, 'admin');
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
      admin.callStarSetPermission(star, victimId, malloryPayload.sub, 'write');
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));

      // write on the child is NOT enough — the graft would cascade Mallory's
      // admin on mallory-home onto victim's subtree (write → admin promotion)
      mallory.callStarAddEdge(star, homeId, victimId);
      await vi.waitFor(() => {
        expect(mallory.lastError).toContain('admin permission required');
      });

      // admin on the child IS enough (the share-accept flow's accept step)
      admin.callStarSetPermission(star, victimId, malloryPayload.sub, 'admin');
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));

      mallory.callStarAddEdge(star, homeId, victimId);
      await vi.waitFor(() => {
        expect(mallory.callCompleted).toBe(true);
        expect(mallory.lastError).toBeUndefined();
      });

      admin[Symbol.dispose]();
      mallory[Symbol.dispose]();
    });

    it('reparentNode requires admin on the child — same access-widening as addEdge', async () => {
      const star = uniqueStar();
      const { client: admin } = await adminClient(star);

      // Build: root → mallory-home; root → src → child
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'mallory-home', 'Mallory Home');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      const homeId = admin.lastResult as string;

      admin.callStarCreateNode(star, ROOT_NODE_ID, 'src', 'Source');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      const srcId = admin.lastResult as string;

      admin.callStarCreateNode(star, srcId, 'child', 'Child');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      const childId = admin.lastResult as string;

      const adminBrowser = new Browser();
      const { accessToken: adminToken } = await foundAndLogin(adminBrowser, star, ownerOf(adminOf(star)));
      const malloryBrowser = new Browser();
      await createSubject(adminBrowser, star, adminToken, 'mallory@example.com');
      const { client: mallory, payload: malloryPayload } = await createInvitedClient(
        NebulaClientTest, malloryBrowser, star, star, 'mallory@example.com',
      );

      // Mallory: admin on her home (the new parent — admin ⊇ write), write on
      // the old parent. write@child cascades from write@src; she lacks admin@child.
      admin.callStarSetPermission(star, homeId, malloryPayload.sub, 'admin');
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
      admin.callStarSetPermission(star, srcId, malloryPayload.sub, 'write');
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));

      // write on both parents is NOT enough — the move would cascade Mallory's
      // admin on mallory-home onto child's subtree (write → admin promotion).
      mallory.callStarReparentNode(star, childId, srcId, homeId);
      await vi.waitFor(() => {
        expect(mallory.lastError).toContain('admin permission required');
      });

      // admin on the child IS enough.
      admin.callStarSetPermission(star, childId, malloryPayload.sub, 'admin');
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));

      mallory.callStarReparentNode(star, childId, srcId, homeId);
      await vi.waitFor(() => {
        expect(mallory.callCompleted).toBe(true);
        expect(mallory.lastError).toBeUndefined();
      });

      admin[Symbol.dispose]();
      mallory[Symbol.dispose]();
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
      const aId = client.lastResult as string;

      client.callStarCreateNode(star, aId, 'anc-b', 'B');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const bId = client.lastResult as string;

      client.callStarCreateNode(star, bId, 'anc-c', 'C');
      await vi.waitFor(() => expect(client.lastResult).toBeDefined());
      const cId = client.lastResult as string;

      // Ancestors of C = {B, A, root}
      client.callStarGetNodeAncestors(star, cId);
      await vi.waitFor(() => {
        const ancestors = client.lastResult as Set<string>;
        expect(ancestors).toBeInstanceOf(Set);
        expect(ancestors.has(bId)).toBe(true);
        expect(ancestors.has(aId)).toBe(true);
        expect(ancestors.has(ROOT_NODE_ID)).toBe(true);
        expect(ancestors.has(cId)).toBe(false); // excludes self
      });

      // Descendants of root = {A, B, C}
      client.callStarGetNodeDescendants(star, ROOT_NODE_ID);
      await vi.waitFor(() => {
        const descendants = client.lastResult as Set<string>;
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
      const aId = client.lastResult as string;

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
    it('scope admin builds tree and delegates via setPermission', async () => {
      const star = uniqueStar();
      const { client: admin } = await adminClient(star);

      // Scope admin creates structure (no DAG grants needed — the claims.access.scopeAdmin bypass)
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'org', 'Organization');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      const orgId = admin.lastResult as string;

      admin.callStarCreateNode(star, orgId, 'team', 'Team');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      const teamId = admin.lastResult as string;

      // Create a user and delegate admin on team subtree
      const adminBrowser = new Browser();
      const { accessToken: adminToken } = await foundAndLogin(adminBrowser, star, ownerOf(adminOf(star)));
      const userBrowser = new Browser();
      await createSubject(adminBrowser, star, adminToken, 'lead@example.com');
      const { client: lead, payload: leadPayload } = await createInvitedClient(
        NebulaClientTest, userBrowser, star, star, 'lead@example.com',
      );

      // Scope admin grants admin on team to lead
      admin.callStarSetPermission(star, teamId, leadPayload.sub, 'admin');
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));

      // Lead can now create nodes under team (via DAG admin rolldown)
      lead.callStarCreateNode(star, teamId, 'project', 'Project');
      await vi.waitFor(() => {
        expect(lead.lastResult).toBeDefined();
        expect(lead.lastError).toBeUndefined();
      });
      const projectId = lead.lastResult as string;

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
    // Two admins: the Star's own, then the universe's owner, whose client holds aud = the UNIVERSE
    // while acting on a STAR DO — admission via the *dominion* branch (its host's scope sits above
    // the callee), which is what "universe admin has full DAG access to a descendant Star" means.
    it('universe admin bypasses all DAG checks via the scope-admin claim', async () => {
      const universe = `uni-${crypto.randomUUID().slice(0, 8)}`;
      const star = `${universe}.app.tenant-a`;

      // Admin at the star aud — creates the Star DO.
      const starBrowser = new Browser();
      const { client: starAdmin } = await adminClientAt(
        NebulaClientTest, starBrowser, star, star, adminOf(star),
      );
      starAdmin.callStarCreateNode(star, ROOT_NODE_ID, 'star-node', 'Star Node');
      await vi.waitFor(() => expect(starAdmin.lastResult).toBeDefined());
      starAdmin[Symbol.dispose]();

      // The universe's own admin — who founded it above the star admin — with aud = the UNIVERSE,
      // reaching down into the Star.
      const uniBrowser = new Browser();
      const { client: uniAdmin, payload } = await universeAdminClient(
        NebulaClientTest, uniBrowser, universe, universe, ownerOf(adminOf(universe)),
      );
      // Guard the fixture: a star aud here would test the tenant branch, not cross-tier dominion.
      expect(payload.aud).toBe(universe);
      expect(payload.access?.authScope).toBe(`${universe}`);

      // Universe admin can create nodes (scope-admin bypass)
      uniAdmin.callStarCreateNode(star, ROOT_NODE_ID, 'uni-node', 'Universe Node');
      await vi.waitFor(() => {
        expect(uniAdmin.lastResult).toBeDefined();
        expect(uniAdmin.lastError).toBeUndefined();
      });

      uniAdmin[Symbol.dispose]();
    });
  });

  // ─── evaluatePermissions batch eval ───────────
  describe('evaluatePermissions', () => {
    it('complete denied set; grant flips one; dominionOverHostAtSubscribe bypasses; Star DAG admin resolves allow-all', async () => {
      const star = uniqueStar();
      const { client: admin } = await adminClient(star);

      // Two sibling nodes under root.
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'n-a', 'A');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      const nA = admin.lastResult as string;
      admin.callStarCreateNode(star, ROOT_NODE_ID, 'n-b', 'B');
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      const nB = admin.lastResult as string;

      // A real non-admin subject, no grants yet.
      const { client: user, payload: userPayload } = await userClient(star, '', 'coach@example.com');
      const userSub = userPayload.sub;

      type Eval = { allowed: Set<string>; denied: Set<string> };

      // Non-admin, no grants → BOTH denied. The denied set must be COMPLETE
      // (>=2 in one call). Mutation: short-circuit on first denial → only nA
      // appears, size 1 → red (n2).
      admin.callStarEvaluatePermissions(star, [nA, nB], 'read', userSub, false);
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      let res = admin.lastResult as Eval;
      expect(res.allowed.size).toBe(0);
      expect(res.denied.has(nA)).toBe(true);
      expect(res.denied.has(nB)).toBe(true);
      expect(res.denied.size).toBe(2);

      // Grant read on nA → matches resolvePermission per node: allowed={nA}, denied={nB}.
      admin.callStarSetPermission(star, nA, userSub, 'read');
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
      admin.callStarEvaluatePermissions(star, [nA, nB], 'read', userSub, false);
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      res = admin.lastResult as Eval;
      expect(res.allowed.has(nA)).toBe(true);
      expect(res.allowed.has(nB)).toBe(false);
      expect(res.denied.has(nB)).toBe(true);

      // dominionOverHostAtSubscribe:true → ALL allowed even with no grant on nB (Galaxy/Universe
      // scope-admin bypass replicated). Mutation: ignore dominionOverHostAtSubscribe → nB denied → red.
      admin.callStarEvaluatePermissions(star, [nA, nB], 'read', userSub, true);
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      res = admin.lastResult as Eval;
      expect(res.allowed.has(nB)).toBe(true);
      expect(res.denied.size).toBe(0);

      // A DAG `admin` grant on root resolves allow-all through resolvePermission with
      // dominionOverHostAtSubscribe:false (no JWT bypass needed).
      admin.callStarSetPermission(star, ROOT_NODE_ID, userSub, 'admin');
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
      admin.callStarEvaluatePermissions(star, [nA, nB], 'read', userSub, false);
      await vi.waitFor(() => expect(admin.lastResult).toBeDefined());
      res = admin.lastResult as Eval;
      expect(res.allowed.has(nA)).toBe(true);
      expect(res.allowed.has(nB)).toBe(true);
      expect(res.denied.size).toBe(0);

      admin[Symbol.dispose]();
      user[Symbol.dispose]();
    });
  });
});
