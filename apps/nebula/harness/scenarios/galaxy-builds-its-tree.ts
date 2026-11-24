/**
 * A Galaxy builds its own tree: the `chat` node with `messages` and `rounds` beneath it, and the
 * agent's `write` at `chat`, which an admin can revoke and the Galaxy writes back.
 *
 * The agent, `agent:lumenize`, holds no membership anywhere, so its `write` on the `chat` node is
 * the only thing that lets it read the thread, post and store its rounds (ADR-025). Nobody's
 * request creates the nodes or the grant: the Galaxy creates them at its start, as its own system
 * principal, which holds dominion over the app and no grant. Nothing in a tree is closed to an
 * admin, so the app's owner can revoke the agent's grant, and the next post finds it missing and
 * writes it back before the agent reads the thread.
 *
 * Every limb reads what the running stack answers a real person. The app is this run's own, since
 * the scenario revokes a grant every other scenario's chat relies on: a real signup claims its
 * universe, its app and a tenant Star, and the collaborator's grants come from the real node
 * invite, so nothing here is built for an assertion to be wrong about.
 *
 *  1. **A new Galaxy has its tree, and a Star's holds only a root.** `chat` hangs under the root,
 *     `messages` and `rounds` under `chat`, the agent holds `write` at `chat` and nothing at the
 *     root, and no grant names a system principal. The Galaxy logged no failed setup step.
 *     Mutations: drop a create from the Galaxy's start, and its node is missing; create `messages`
 *     under the root, and its edge is missing; write a grant for the system principal, and one
 *     shows; build a Star's tree as the Galaxy's, and `.dev` shows a chat node.
 *  2. **One invite brings both of a collaborator's grants, and one mail.** Mutation: write only
 *     an invite's first grant, and the `read` at `chat` is missing.
 *  3. **Only an admin can change the agent's grant.** The collaborator's revoke and their lowering
 *     of it are each refused for want of `admin` at `chat`, and the grant stays. So is their own
 *     invite naming `chat`, once they are `admin` at `messages`. Their own grants are then revoked,
 *     at `messages` and then at `chat`. Mutations: drop the permission check from
 *     `revokePermission`, and the collaborator's revoke lands; check `admin` at an invite's first
 *     node only, and their invite lands.
 *  4. **An admin's revoke lands.** The owner revokes the agent's grant and the tree shows none.
 *     Mutation: refuse a revoke of the agent's grant, as the tree once did, and the call throws.
 *  5. **The owner's next post restores it.** The tree pushed to the owner's open tab, whose
 *     listener was set before it connected, shows the agent's `write` again,
 *     the Galaxy logged one restore naming its system principal, and no read was refused the agent.
 *     Mutations: drop the restore from the post's trigger, and the grant never comes back; restore
 *     after the trigger reads the thread, and the agent's refused read is logged.
 *  6. **A create says what it found.** In the tenant Star the owner's create answers `'created'`,
 *     its repeat `'existing'`, and the same create after a rename `'differs'`, and a create under a
 *     slug a sibling holds is refused as `SlugTakenError`. Mutations: answer `'existing'` for every
 *     id found, and the rename case reds; throw a plain error for a taken slug, and its name reds.
 */
import assert from 'node:assert/strict';
import { uniqueTestEmail, waitForEmail } from '@lumenize/email-test/client';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import { ROOT_NODE_ID, makeEdgeKey } from '@lumenize/resources/client';
import type { NodeInviteAck, OrgTreeState } from '@lumenize/resources';
import { CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID, MESSAGES_NODE_ID, ROUNDS_NODE_ID, COLLABORATOR_GRANTS, DEFAULT_CHAT_ID } from '@lumenize/nebula/client';
import type { Galaxy, Star } from '@lumenize/nebula';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { debugLines, loggedAfter, settleForAbsence, waitForDebugLines, type DebugLine } from '../lib/stdio';
import { testSlug } from '../lib/test-scopes';
import { provisionAndLogin, refreshAccessToken, consumeLink, setCookieHeaders, refreshTokenForScope } from '../../test/lib/email-login';

/** Auth, the orgTree and one post, never a build, so the boot skips Docker. */
export const needsContainer = false;

/** Resolve with `read`'s first answer `done` accepts, or throw naming what never came. */
async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, what: string): Promise<T> {
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
  const galaxy = `${testSlug('tree')}.app`;
  const dev = `${galaxy}.dev`;
  const tenant = `${galaxy}.tenant`;

  // One real signup claims the universe, its app and the tenant Star. The owner's token for each
  // page comes from that page's own refresh.
  const login = await provisionAndLogin({ baseUrl: origin, scope: tenant, testToken });
  const drivers: Driver[] = [];
  const on = async (scope: string, onTree?: (tree: OrgTreeState) => void): Promise<Driver> => {
    const session = await refreshAccessToken(origin, login.session, scope);
    const driver = await connectDriver(stack, { scope, session, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION, ...(onTree ? { onTree } : {}) });
    drivers.push(driver);
    return driver;
  };
  /** This Galaxy's lines in the stack's logs. */
  const ours = (all: DebugLine[], namespace: string, message: string): DebugLine[] =>
    all.filter((line) => line.namespace === namespace && line.message === message && line.data.name === galaxy);

  let owner: Driver | undefined;
  try {
    // Every tree the Galaxy pushes the owner's tab, in the order they arrived.
    const pushed: OrgTreeState[] = [];
    owner = await on(galaxy, (tree) => { pushed.push(tree); });
    const agentTierIn = (tree: OrgTreeState) => tree.permissions.get(CHAT_NODE_ID)?.get(NEBULA_SUB);
    const galaxyTree = (): Promise<OrgTreeState> => owner!.client.lmz.callAsync('GALAXY', galaxy,
      owner!.client.ctn<Galaxy>().resources.orgTree.getState());
    const agentTier = async () => (await galaxyTree()).permissions.get(CHAT_NODE_ID)?.get(NEBULA_SUB);

    // ── LIMB 1: the Galaxy's tree has `chat`, its children and the agent's grant; a Star's has none ──
    {
      const tree = await galaxyTree();
      assert.equal(tree.nodes.get(CHAT_NODE_ID)?.slug, 'chat', 'the Galaxy\'s tree must hold its chat node');
      assert.ok(tree.edges.has(makeEdgeKey(ROOT_NODE_ID, CHAT_NODE_ID)), 'the chat node must hang under the root');
      for (const [child, slug] of [[MESSAGES_NODE_ID, 'messages'], [ROUNDS_NODE_ID, 'rounds']] as const) {
        assert.equal(tree.nodes.get(child)?.slug, slug, `the Galaxy's tree must hold its ${slug} node`);
        assert.ok(tree.edges.has(makeEdgeKey(CHAT_NODE_ID, child)), `the ${slug} node must hang under chat`);
      }
      assert.equal(tree.permissions.get(CHAT_NODE_ID)?.get(NEBULA_SUB), 'write', 'the agent must hold write on chat');
      assert.equal(tree.permissions.get(ROOT_NODE_ID)?.get(NEBULA_SUB), undefined, 'the agent holds nothing on the root');
      const grantees = [...tree.permissions.values()].flatMap((held) => [...held.keys()]);
      assert.deepEqual(grantees.filter((sub) => sub.startsWith('system:')), [], 'the Galaxy\'s own principal holds no grant: it acts through dominion');

      for (const star of [dev, tenant]) {
        const atStar = await on(star);
        const starTree = await atStar.client.lmz.callAsync('STAR', star,
          atStar.client.ctn<Star>().resources.orgTree.getState());
        assert.deepEqual([...starTree.nodes.keys()], [ROOT_NODE_ID], `${star}'s tree must hold only its root`);
        assert.equal([...starTree.permissions.values()].filter((held) => held.size > 0).length, 0, `${star}'s tree must hold no grant`);
      }

      // The Galaxy started before this read, so a failed step is logged by now. The restore the
      // first start makes is the barrier: the absence is read only once that line has arrived.
      const all = await waitForDebugLines(stack, (lines) => ours(lines, 'nebula.Galaxy.agentGrant', 'restored').length > 0,
        'the first start\'s write of the agent\'s grant');
      await settleForAbsence();
      assert.deepEqual(ours(debugLines(stack.logs()), 'nebula.Galaxy.onStart', 'tree setup failed'), [], 'the Galaxy\'s start must log no failed step');
      assert.equal(ours(all, 'nebula.Galaxy.agentGrant', 'restored')[0]!.data.recordedClaims?.sub, `system:${galaxy}`, 'the grant\'s first write names the Galaxy\'s system principal');
      console.error('  ✓ limb 1 — the Galaxy built chat over messages and rounds, with the agent\'s write and no grant of its own; .dev and a tenant Star have only a root');
    }

    // ── LIMB 2: one invite brings both grants, and one mail ───────────────────────────────────
    const collaboratorEmail = uniqueTestEmail();
    const waiter = waitForEmail({ testToken, instance: galaxy, to: collaboratorEmail, timeout: 60_000 });
    let collaborator: Driver;
    try {
      const ack = await owner.client.lmz.callAsync('GALAXY', galaxy,
        owner.client.ctn<Galaxy>().resources.invite(CHAT_MESSAGE_ONTOLOGY_VERSION, [{ email: collaboratorEmail, grants: COLLABORATOR_GRANTS }])) as NodeInviteAck;
      assert.deepEqual(ack, { accepted: 1, errors: [] }, `invite ack: ${JSON.stringify(ack)}`);
      const mail = await waiter.emailPromise;
      const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(mail.html ?? '')?.[1];
      assert.ok(href, 'the invite email carried no accept link');
      const clicked = await consumeLink(href!.replace(/&amp;/g, '&'), fetch, { nickname: 'Collaborator' });
      const refreshToken = refreshTokenForScope(setCookieHeaders(clicked), galaxy);
      assert.ok(refreshToken, `acceptance set no cookie for the app (${clicked.status})`);
      const session = await refreshAccessToken(origin, { refreshToken: refreshToken!, authScope: galaxy }, galaxy, fetch);
      collaborator = await connectDriver(stack, { scope: galaxy, session, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION });
      drivers.push(collaborator);
      // Two grants, one mail: Resend reports each send it made to this address under an id of
      // its own, and by now both grants are written, so a second send would have been made.
      await until(galaxyTree, (tree) => tree.permissions.get(CHAT_NODE_ID)?.has(session.sub) === true, 'the collaborator\'s read at chat');
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const sends = new Set(waiter.deliveryEvents.map((event) => event.emailId));
      assert.equal(sends.size, 1, `one invite must send one mail, and Resend reports ${sends.size} sends to this address`);
    } finally {
      waiter.cleanup();
    }
    const collaboratorSub = collaborator.client.claims.sub;
    {
      const granted = await galaxyTree();
      assert.equal(granted.permissions.get(MESSAGES_NODE_ID)?.get(collaboratorSub), 'write', 'the invite must grant write at messages');
      assert.equal(granted.permissions.get(CHAT_NODE_ID)?.get(collaboratorSub), 'read', 'the invite must grant read at chat, which it names');
      console.error('  ✓ limb 2 — one invite brought the collaborator write at messages and read at chat, with one mail');
    }

    // ── LIMB 3: only an admin can change the agent's grant ────────────────────────────────────
    {
      const adminAtChat = `admin permission required on node ${CHAT_NODE_ID}`;
      for (const [what, call] of [
        ['the collaborator\'s revoke of the agent\'s grant', collaborator.client.orgTree.revokePermission(CHAT_NODE_ID, NEBULA_SUB)],
        ['the collaborator\'s lowering of the agent\'s grant', collaborator.client.orgTree.setPermission(CHAT_NODE_ID, NEBULA_SUB, 'read')],
      ] as const) {
        const error = await refusal(call, what);
        assert.equal(error.name, 'PermissionDeniedError', `${what} was refused as ${error.name}: ${error.message}`);
        assert.equal(error.message, adminAtChat);
      }
      assert.equal(await agentTier(), 'write', 'the agent\'s grant must stand after a member\'s refused changes');

      // The door asks `admin` at every node an invite names. The owner makes the collaborator
      // `admin` at `messages`, and their own invite naming `chat` too is refused there.
      await owner.client.orgTree.setPermission(MESSAGES_NODE_ID, collaboratorSub, 'admin');
      const refused = await refusal(collaborator.client.lmz.callAsync('GALAXY', galaxy,
        collaborator.client.ctn<Galaxy>().resources.invite(CHAT_MESSAGE_ONTOLOGY_VERSION, [{ email: uniqueTestEmail(), grants: COLLABORATOR_GRANTS }])),
        'an invite naming a node its inviter does not administer');
      assert.equal(refused.name, 'PermissionDeniedError', `the invite was refused as ${refused.name}: ${refused.message}`);
      assert.equal(refused.message, adminAtChat);

      // A revoke at `messages` takes posting away and leaves the reading, which a revoke at `chat` ends.
      await owner.client.orgTree.revokePermission(MESSAGES_NODE_ID, collaboratorSub);
      const afterMessages = await galaxyTree();
      assert.equal(afterMessages.permissions.get(MESSAGES_NODE_ID)?.get(collaboratorSub), undefined, 'a collaborator\'s grant on messages must be revocable');
      assert.equal(afterMessages.permissions.get(CHAT_NODE_ID)?.get(collaboratorSub), 'read', 'a revoke at messages must leave the read at chat');
      await owner.client.orgTree.revokePermission(CHAT_NODE_ID, collaboratorSub);
      assert.equal((await galaxyTree()).permissions.get(CHAT_NODE_ID)?.get(collaboratorSub), undefined, 'a collaborator\'s read at chat must be revocable');
      console.error('  ✓ limb 3 — a member\'s changes to the agent\'s grant and their invite past their own nodes were refused, and the owner revoked both of their grants');
    }

    // ── LIMB 4: an admin's revoke lands ───────────────────────────────────────────────────────
    const restoresBefore = ours(debugLines(stack.logs()), 'nebula.Galaxy.agentGrant', 'restored');
    {
      const pushedBefore = pushed.length;
      await owner.client.orgTree.revokePermission(CHAT_NODE_ID, NEBULA_SUB);
      assert.equal(await agentTier(), undefined, 'the owner\'s revoke of the agent\'s grant must land');
      await until(() => pushed.slice(pushedBefore), (trees) => trees.some((tree) => agentTierIn(tree) === undefined),
        'a pushed tree without the agent\'s grant');
      console.error('  ✓ limb 4 — the owner revoked the agent\'s grant, and the tree shows none');
    }

    // ── LIMB 5: the owner's next post restores it ─────────────────────────────────────────────
    {
      const pushedAtPost = pushed.length;
      const post = crypto.randomUUID();
      const posted = await owner.client.resources.transaction({
        [post]: { op: 'create', typeName: 'Message', nodeId: MESSAGES_NODE_ID, value: { chat: DEFAULT_CHAT_ID, content: 'Are you there? Change no code.' } },
      });
      assert.equal(posted.kind, 'committed', `the owner's post must commit: ${JSON.stringify(posted)}`);
      // The restore runs as the Galaxy's system principal, so its tree leaves on a chain with no
      // claims, and the owner's open tab still hears it.
      await until(() => pushed.slice(pushedAtPost), (trees) => trees.some((tree) => agentTierIn(tree) === 'write'),
        'a pushed tree with the agent\'s write at chat back');
      assert.equal(await agentTier(), 'write', 'the agent\'s write at chat must be back in the tree');

      // Lines are told apart by when they were logged: a deployed capture can deliver one twice.
      const barrier = restoresBefore.at(-1)!;
      const since = (lines: DebugLine[]) => ours(lines, 'nebula.Galaxy.agentGrant', 'restored').filter((line) => line.at > barrier.at);
      const all = await waitForDebugLines(stack, (lines) => since(lines).length > 0, 'the restore\'s record');
      const restored = since(all);
      const restores = new Set(restored.map((line) => line.at)).size;
      assert.equal(restores, 1, `one post must restore the grant once, and the Galaxy logged ${restores}`);
      assert.equal(restored[0]!.data.recordedClaims?.sub, `system:${galaxy}`, 'the restore must name the Galaxy\'s system principal');
      assert.equal(restored[0]!.data.grantee, NEBULA_SUB);
      // The agent reads the thread only after the restore, so no read of its is refused. The
      // restore's own line is the barrier this absence is read behind.
      await settleForAbsence();
      const refusedReads = debugLines(stack.logs()).filter((line) => line.namespace === 'nebula.Resources.doRead'
        && line.message === 'handler threw' && loggedAfter(line, restoresBefore.at(-1)!));
      assert.deepEqual(refusedReads.map((line) => line.data), [], 'no read may be refused the agent once the post has restored its grant');
      console.error('  ✓ limb 5 — the owner\'s next post wrote the agent\'s grant back, as the Galaxy\'s system principal, before the agent read the thread');
    }

    // ── LIMB 6: a create says what it found ───────────────────────────────────────────────────
    {
      // In the tenant Star, so the nodes sit apart from the chat's.
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
      console.error('  ✓ limb 6 — a create answered created, then existing, then differs after a rename, and a taken slug was refused by name');
    }
  } finally {
    // Leave the app as the next reader expects it, whatever limb stopped the run.
    await owner?.client.orgTree.setPermission(CHAT_NODE_ID, NEBULA_SUB, 'write').catch(() => { /* the run's own failure is the one to report */ });
    for (const driver of drivers) driver.dispose();
  }
}
