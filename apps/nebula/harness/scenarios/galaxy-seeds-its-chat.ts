/**
 * A Galaxy's tree is born with its `chat` node, `messages` and `turns` beneath it, and the agent's
 * grant on `chat`, and that grant cannot be revoked or lowered.
 *
 * The agent, `agent:lumenize`, holds no membership anywhere, so its `write` on the `chat` node is
 * the only thing that lets it read the thread, post and store its rounds (ADR-025). Nobody's request creates the node
 * or the grant: the Galaxy declares both and its tree creates them with itself. With the grant
 * revoked the agent could not hear a request to restore it, so the tree refuses that one change
 * to everyone alike, the app's owner included (ADR-015's skeleton).
 *
 * Every limb reads what the running stack answers a real person. The app comes from the real
 * signup, the tenant Star from its own founder's claim, and the collaborator's grant from the real
 * node invite, so nothing here is built for an assertion to be wrong about.
 *
 *  1. **The Galaxy's tree holds `chat` under the root, with the agent's `write`, and `messages` and
 *     `turns` under `chat`, and a Star's holds only its root**, the `.dev` Star's and a tenant
 *     Star's alike. Mutations: drop the Galaxy's seed, and `chat` is missing; hang `messages` under
 *     the root, and its edge is missing; give a Star the seed, and `.dev` shows a chat node.
 *  2. **The owner's revoke of the agent's grant is refused**, by name and message, and the grant
 *     stays. Mutation: drop the check in `revokePermission`, and it lands.
 *  3. **Lowering it to `read` is refused** the same way. Mutation: drop the check in
 *     `setPermission`, and the grant reads `read`.
 *  4. **What the refusal does not cover still works.** Setting the agent's grant to `write` again
 *     passes. A real invite at `messages` grants the collaborator `write` there and `read` at
 *     `chat`; a revoke at `messages` takes the first and leaves the second, which a revoke at `chat`
 *     then takes. Mutations: refuse every `setPermission` naming the agent, and the first reds;
 *     drop the seed's `inviteAlso`, and the `read` at `chat` is missing; treat every grant on `chat`
 *     as protected, and its revoke reds.
 *  5. **A create says what it found.** In the tenant Star the owner's create answers `'created'`,
 *     its repeat `'existing'`, and the same create after a rename `'differs'`, and a create under a
 *     slug a sibling holds is refused as `SlugTakenError`. Mutations: answer `'existing'` for every
 *     id found, and the rename case reds; throw a plain error for a taken slug, and its name reds.
 */
import assert from 'node:assert/strict';
import { uniqueTestEmail } from '@lumenize/email-test/client';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import { ROOT_NODE_ID, makeEdgeKey } from '@lumenize/resources/client';
import type { NodeInviteAck, OrgTreeState } from '@lumenize/resources';
import { CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID, MESSAGES_NODE_ID, TURNS_NODE_ID } from '@lumenize/nebula/client';
import type { Galaxy, Star } from '@lumenize/nebula';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { sharedApp } from '../lib/shared-app';
import { testSlug } from '../lib/test-scopes';
import { provisionAndLogin, refreshAccessToken } from '../../test/lib/email-login';

/** Auth and the orgTree only, never a build, so the boot skips Docker. */
export const needsContainer = false;

/** Resolve with `read`'s first answer `done` accepts, or throw naming what never came. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = performance.now() + 30_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** What a refused call rejected with, or a failure if it was allowed. */
async function refusal(call: Promise<unknown>, what: string): Promise<Error> {
  const outcome = await call.then(() => undefined, (error: Error) => error);
  assert.ok(outcome, `${what} must be refused, and it landed`);
  return outcome;
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const app = await sharedApp(stack, testToken);
  const galaxy = app.galaxy;
  const dev = `${galaxy}.dev`;
  const tenant = `${galaxy}.${testSlug('seed')}`;

  // One real login as the app's owner, which also founds the tenant Star by its own claimer. The
  // owner's token for each page comes from that page's own refresh.
  const login = await provisionAndLogin({ baseUrl: origin, scope: tenant, email: app.ownerEmail, testToken });
  const drivers: Driver[] = [];
  const on = async (scope: string): Promise<Driver> => {
    const session = await refreshAccessToken(origin, login.session, scope);
    const driver = await connectDriver(stack, { scope, session, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION });
    drivers.push(driver);
    return driver;
  };

  try {
    const owner = await on(galaxy);
    const galaxyTree = (): Promise<OrgTreeState> => owner.client.lmz.callAsync('GALAXY', galaxy,
      owner.client.ctn<Galaxy>().resources.orgTree.getState());
    const agentTier = async () => (await galaxyTree()).permissions.get(CHAT_NODE_ID)?.get(NEBULA_SUB);

    // ── LIMB 1: the Galaxy's tree has `chat`, its children and the agent's grant; a Star's has none ──
    {
      const tree = await galaxyTree();
      assert.equal(tree.nodes.get(CHAT_NODE_ID)?.slug, 'chat', 'the Galaxy\'s tree must hold its chat node');
      assert.ok(tree.edges.has(makeEdgeKey(ROOT_NODE_ID, CHAT_NODE_ID)), 'the chat node must hang under the root');
      for (const [child, slug] of [[MESSAGES_NODE_ID, 'messages'], [TURNS_NODE_ID, 'turns']] as const) {
        assert.equal(tree.nodes.get(child)?.slug, slug, `the Galaxy's tree must hold its ${slug} node`);
        assert.ok(tree.edges.has(makeEdgeKey(CHAT_NODE_ID, child)), `the ${slug} node must hang under chat`);
      }
      assert.equal(tree.permissions.get(CHAT_NODE_ID)?.get(NEBULA_SUB), 'write', 'the agent must hold write on chat');
      assert.equal(tree.permissions.get(ROOT_NODE_ID)?.get(NEBULA_SUB), undefined, 'the agent holds nothing on the root');

      for (const star of [dev, tenant]) {
        const atStar = await on(star);
        const starTree = await atStar.client.lmz.callAsync('STAR', star,
          atStar.client.ctn<Star>().resources.orgTree.getState());
        assert.equal(starTree.nodes.has(CHAT_NODE_ID), false, `${star}'s tree must hold no chat node`);
        // The tenant Star is this run's own. The shared app's `.dev` Star is every scenario's on a
        // deployed target, so only a stack this scenario booted is known to hold nothing else.
        if (star === tenant || process.env.HARNESS_TARGET_URL === undefined) {
          assert.deepEqual([...starTree.nodes.keys()], [ROOT_NODE_ID], `${star}'s tree must hold only its root`);
        }
        const agentGrants = [...starTree.permissions.values()].filter((grants) => grants.has(NEBULA_SUB));
        assert.equal(agentGrants.length, 0, `the agent must hold no grant in ${star}`);
      }
      console.error('  ✓ limb 1 — the Galaxy\'s tree has chat over messages and turns, and the agent\'s write; .dev and a tenant Star have only a root');
    }

    const protectedMessage =
      `The grant of "${NEBULA_SUB}" on node ${CHAT_NODE_ID} is protected: its host seeds it, so it cannot be revoked or lowered below write`;

    // ── LIMB 2: the owner cannot revoke it ────────────────────────────────────────────────────
    {
      const error = await refusal(owner.client.orgTree.revokePermission(CHAT_NODE_ID, NEBULA_SUB), 'the revoke');
      assert.equal(error.name, 'ProtectedGrantError', `the revoke was refused as ${error.name}: ${error.message}`);
      assert.equal(error.message, protectedMessage);
      assert.equal(await agentTier(), 'write', 'the agent\'s grant must survive the refused revoke');
      console.error('  ✓ limb 2 — the owner\'s revoke of the agent\'s grant was refused, and the grant stayed');
    }

    // ── LIMB 3: nor lower it ──────────────────────────────────────────────────────────────────
    {
      const error = await refusal(owner.client.orgTree.setPermission(CHAT_NODE_ID, NEBULA_SUB, 'read'), 'the lowering');
      assert.equal(error.name, 'ProtectedGrantError', `the lowering was refused as ${error.name}: ${error.message}`);
      assert.equal(error.message, protectedMessage);
      assert.equal(await agentTier(), 'write', 'the agent\'s grant must still read write');
      console.error('  ✓ limb 3 — lowering the agent\'s grant to read was refused, and it still reads write');
    }

    // ── LIMB 4: what the refusal does not cover ───────────────────────────────────────────────
    {
      await owner.client.orgTree.setPermission(CHAT_NODE_ID, NEBULA_SUB, 'write');
      assert.equal(await agentTier(), 'write');

      // A collaborator's grant, written the way production writes one: the node invite mints the
      // person and grants them at the node. Nobody needs to accept for the grant to exist.
      const collaborator = uniqueTestEmail();
      const others = (tree: OrgTreeState): string[] =>
        [...(tree.permissions.get(MESSAGES_NODE_ID)?.keys() ?? [])].filter((sub) => sub !== NEBULA_SUB);
      // The shared app's chat may hold other scenarios' collaborators, so the new one is told apart.
      const before = others(await galaxyTree());
      const ack = await owner.client.lmz.callAsync('GALAXY', galaxy,
        owner.client.ctn<Galaxy>().resources.invite(CHAT_MESSAGE_ONTOLOGY_VERSION, MESSAGES_NODE_ID, [{ email: collaborator, tier: 'write' }])) as NodeInviteAck;
      assert.deepEqual(ack, { accepted: 1, errors: [] }, `invite ack: ${JSON.stringify(ack)}`);
      const added = (tree: OrgTreeState): string[] => others(tree).filter((sub) => !before.includes(sub));
      // The invite's grant at `messages` and the `read` at `chat` the seed pairs with it are waited for together.
      const granted = await until(galaxyTree, (tree) => added(tree).length === 1
        && tree.permissions.get(CHAT_NODE_ID)?.has(added(tree)[0]!) === true, 'the collaborator\'s grants at messages and chat');
      const [collaboratorSub] = added(granted);
      assert.equal(granted.permissions.get(MESSAGES_NODE_ID)?.get(collaboratorSub), 'write');

      assert.equal(granted.permissions.get(CHAT_NODE_ID)?.get(collaboratorSub), 'read', 'an invite at messages must bring read at chat');

      // A revoke at `messages` takes posting away and leaves the reading, which a revoke at `chat` ends.
      await owner.client.orgTree.revokePermission(MESSAGES_NODE_ID, collaboratorSub);
      const afterMessages = await galaxyTree();
      assert.equal(afterMessages.permissions.get(MESSAGES_NODE_ID)?.get(collaboratorSub), undefined,
        'a collaborator\'s grant on messages must be revocable');
      assert.equal(afterMessages.permissions.get(CHAT_NODE_ID)?.get(collaboratorSub), 'read', 'a revoke at messages must leave the read at chat');
      await owner.client.orgTree.revokePermission(CHAT_NODE_ID, collaboratorSub);
      assert.equal((await galaxyTree()).permissions.get(CHAT_NODE_ID)?.get(collaboratorSub), undefined,
        'a collaborator\'s read at chat must be revocable');
      assert.equal(await agentTier(), 'write', 'the agent\'s grant is untouched by the collaborator\'s revokes');
      console.error('  ✓ limb 4 — re-setting the agent\'s write passed, and the collaborator\'s grants at messages and then chat were revoked');
    }

    // ── LIMB 5: a create says what it found ───────────────────────────────────────────────────
    {
      // In the tenant Star, which is this run's own, so the nodes disturb no other scenario.
      const atTenant = await on(tenant);
      const tree = atTenant.client.orgTree;
      const node = crypto.randomUUID();
      assert.deepEqual(await tree.createNode(node, ROOT_NODE_ID, 'team', 'Team'), { outcome: 'created' });
      assert.deepEqual(await tree.createNode(node, ROOT_NODE_ID, 'team', 'Team'), { outcome: 'existing' },
        'a repeat of the same create must find the node there');
      await tree.renameNode(node, 'crew');
      assert.deepEqual(await tree.createNode(node, ROOT_NODE_ID, 'team', 'Team'), { outcome: 'differs' },
        'a create of a node an admin renamed must say it differs');
      const error = await refusal(tree.createNode(crypto.randomUUID(), ROOT_NODE_ID, 'crew', 'Crew'), 'a create under a taken slug');
      assert.equal(error.name, 'SlugTakenError', `the create was refused as ${error.name}: ${error.message}`);
      console.error('  ✓ limb 5 — a create answered created, then existing, then differs after a rename, and a taken slug was refused by name');
    }
  } finally {
    for (const driver of drivers) driver.dispose();
  }
}
