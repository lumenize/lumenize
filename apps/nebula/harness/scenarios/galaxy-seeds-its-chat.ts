/**
 * A Galaxy's tree is born with its `chat` node and the agent's grant on it, and that grant cannot
 * be revoked or lowered.
 *
 * The agent, `agent:lumenize`, holds no membership anywhere, so its `write` on the `chat` node is
 * the only thing that lets it read the thread and post (ADR-025). Nobody's request creates the node
 * or the grant: the Galaxy declares both and its tree creates them with itself. With the grant
 * revoked the agent could not hear a request to restore it, so the tree refuses that one change
 * to everyone alike, the app's owner included (ADR-015's skeleton).
 *
 * Every limb reads what the running stack answers a real person. The app comes from the real
 * signup, the tenant Star from its own founder's claim, and the collaborator's grant from the real
 * node invite, so nothing here is built for an assertion to be wrong about.
 *
 *  1. **The Galaxy's tree holds `chat` under the root, with the agent's `write`, and a Star's holds
 *     only its root**, the `.dev` Star's and a tenant Star's alike. Mutations: drop the Galaxy's
 *     seed, and `chat` is missing; give a Star the seed, and `.dev` shows a chat node.
 *  2. **The owner's revoke of the agent's grant is refused**, by name and message, and the grant
 *     stays. Mutation: drop the check in `revokePermission`, and it lands.
 *  3. **Lowering it to `read` is refused** the same way. Mutation: drop the check in
 *     `setPermission`, and the grant reads `read`.
 *  4. **What the refusal does not cover still works.** Setting the agent's grant to `write` again
 *     passes, and a collaborator's grant on the same node, written by a real invite, is revoked.
 *     Mutations: refuse every `setPermission` naming the agent, and the first reds; treat every
 *     grant on the node as protected, and the second reds.
 */
import assert from 'node:assert/strict';
import { uniqueTestEmail } from '@lumenize/email-test/client';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import { ROOT_NODE_ID, makeEdgeKey } from '@lumenize/resources/client';
import type { NodeInviteAck, OrgTreeState } from '@lumenize/resources';
import { CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID } from '@lumenize/nebula/client';
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

    // ── LIMB 1: the Galaxy's tree has the chat node and the agent's grant; a Star's has neither ──
    {
      const tree = await galaxyTree();
      assert.equal(tree.nodes.get(CHAT_NODE_ID)?.slug, 'chat', 'the Galaxy\'s tree must hold its chat node');
      assert.ok(tree.edges.has(makeEdgeKey(ROOT_NODE_ID, CHAT_NODE_ID)), 'the chat node must hang under the root');
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
      console.error('  ✓ limb 1 — the Galaxy\'s tree has chat and the agent\'s write; .dev and a tenant Star have only a root');
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
        [...(tree.permissions.get(CHAT_NODE_ID)?.keys() ?? [])].filter((sub) => sub !== NEBULA_SUB);
      // The shared app's chat may hold other scenarios' collaborators, so the new one is told apart.
      const before = others(await galaxyTree());
      const ack = await owner.client.lmz.callAsync('GALAXY', galaxy,
        owner.client.ctn<Galaxy>().resources.invite(CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID, [{ email: collaborator, tier: 'write' }])) as NodeInviteAck;
      assert.deepEqual(ack, { accepted: 1, errors: [] }, `invite ack: ${JSON.stringify(ack)}`);
      const added = (tree: OrgTreeState): string[] => others(tree).filter((sub) => !before.includes(sub));
      const granted = await until(galaxyTree, (tree) => added(tree).length === 1, 'the collaborator\'s grant on chat');
      const [collaboratorSub] = added(granted);
      assert.equal(granted.permissions.get(CHAT_NODE_ID)?.get(collaboratorSub), 'write');

      await owner.client.orgTree.revokePermission(CHAT_NODE_ID, collaboratorSub);
      assert.equal((await galaxyTree()).permissions.get(CHAT_NODE_ID)?.get(collaboratorSub), undefined,
        'a collaborator\'s grant on chat must be revocable');
      assert.equal(await agentTier(), 'write', 'the agent\'s grant is untouched by the collaborator\'s revoke');
      console.error('  ✓ limb 4 — re-setting the agent\'s write passed, and a collaborator\'s grant on chat was revoked');
    }
  } finally {
    for (const driver of drivers) driver.dispose();
  }
}
