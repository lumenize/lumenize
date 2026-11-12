/**
 * The agent invites people into an app, under the claims of whoever asked, and only an admin of
 * the app can.
 *
 * Jennifer owns the app. Austen is a collaborator: a plain member of it, enrolled by a real node
 * invite. P was invited earlier straight into the app's `.dev` workspace, without the admin bit.
 * Jennifer asks the agent, in chat, to invite three people. The agent's `invite` tool runs under
 * the claims of the post its turn took up, hers, with the agent as actor, so the Registry's
 * records name them both.
 *
 * The model is the real one, and whether it calls `invite` when asked is its choice. So no limb
 * waits on its wording. Each waits on what the invite leaves behind: the invitee's real email,
 * the memberships that email's link opens, or the post the Galaxy's handler writes.
 * `waiting-posts.test.ts` gates the refusals and the binding to the turn's own post, scripted.
 *
 *  1. **Each kind of invite lands as its kind.** A collaborator's link opens a plain membership
 *     in the app and an admin one in its `.dev` workspace. An admin's opens an admin membership
 *     in the app. Mutation: send the admin invite through the node invite, and that invitee is
 *     a plain member.
 *  2. **An admin invite's result is posted by the Galaxy, as the agent.** The post records
 *     `agent:lumenize` with no `act`, replies to nothing and answers nothing. Mutation: post it
 *     under the call it answers in, and it records Jennifer. That no turn takes the agent's
 *     own post up is not gated here: a post recorded as the agent is never a waiting post,
 *     which `chat-trigger.test.ts` T3 holds, and here every such post lands while a turn or a
 *     decision holds the latch, so a limb for it could not fail.
 *  3. **The invite link's host is this stack's own.** Mutation: drop the origin request from the
 *     chain the agent starts, and the link names the deployment's configured host.
 *  4. **P is promoted in the workspace through the one promotion path.** P's existing `.dev`
 *     session carries the admin bit on its next refresh, and the promotion's record names
 *     Jennifer with the agent as actor. Mutation: skip the promotion, and P's token stays plain.
 *  5. **A member of the app is refused at the facade.** Austen's own invite into the app is
 *     refused by the app rule's message. Mutation: let a member invite into an app as into a
 *     Star.
 *  6. **A node invite the facade refuses is posted to the chat.** Austen, given `admin` at the
 *     chat node and holding no dominion, calls the node invite herself: it acknowledges, the
 *     facade refuses it afterwards, and the Galaxy posts that. Mutation: drop that post.
 *
 * Recorded, never gated: what the model does when Austen, who is no admin, asks it for an invite.
 */
import assert from 'node:assert/strict';
import { waitForEmail } from '@lumenize/email-test/client';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import type { Snapshot, NodeInviteAck } from '@lumenize/resources';
import { DEFAULT_CHAT_ID, CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { Galaxy } from '@lumenize/nebula';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { chatCast } from '../lib/chat-cast';
import { waitForDebugLines } from '../lib/stdio';
import { testSlug } from '../lib/test-scopes';
import { refreshAccessToken, refreshTokenForScope, setCookieHeaders, consumeLink } from '../../test/lib/email-login';

/** Chat, auth and mail only: nothing asks for code. */
export const needsContainer = false;

const SCOPE = `${testSlug('invt')}.app`;
const DEV = `${SCOPE}.dev`;
/** A real generation, and the mail it sends, fit well inside this. */
const TURN_TIMEOUT_MS = 240_000;
const chatQuery = { queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };
const address = (who: string) => `test-${who}-${crypto.randomUUID().slice(0, 8)}@lumenize-test.dev`;
type Value = { content?: string; replyTo?: string; answers?: string[]; codegen?: { toolCalls?: Array<{ name: string; error?: string; result?: unknown }> } };

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const cast = await chatCast(stack, SCOPE, testToken);
  const { jennifer, austen } = cast;
  try {
    /** The accept link in the invite mail sent to `email`, which `send` causes. */
    const inviteLinkFor = async (email: string, scope: string, send: () => Promise<unknown>): Promise<string> => {
      const waiter = waitForEmail({ testToken, instance: scope, to: email, timeout: TURN_TIMEOUT_MS });
      try {
        await send();
        const mail = await waiter.emailPromise;
        const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(mail.html ?? '')?.[1];
        assert.ok(href, `the invite mail to ${email} carried no accept link`);
        return href.replace(/&amp;/g, '&');
      } finally {
        waiter.cleanup();
      }
    };
    /** Accept an invite as sent, and answer whether the session it opens at `scope` is an admin's. */
    const acceptedAs = async (link: string, scopes: string[]): Promise<Record<string, { admin: boolean; refreshToken: string }>> => {
      const cookies = setCookieHeaders(await consumeLink(link, fetch, { nickname: 'Invitee' }));
      const out: Record<string, { admin: boolean; refreshToken: string }> = {};
      for (const scope of scopes) {
        const refreshToken = refreshTokenForScope(cookies, scope);
        assert.ok(refreshToken, `the acceptance set no cookie for ${scope}`);
        const { accessToken } = await refreshAccessToken(origin, { refreshToken, authScope: scope }, scope, fetch);
        out[scope] = { admin: (parseJwtUnsafe(accessToken)!.payload as { access?: { scopeAdmin?: boolean } }).access?.scopeAdmin === true, refreshToken };
      }
      return out;
    };
    using thread = jennifer.client.resources.subscribeQuery(chatQuery); await thread.ready;
    const agentPosts = async (): Promise<Array<{ id: string; snap: Snapshot }>> => {
      const out: Array<{ id: string; snap: Snapshot }> = [];
      for (const id of thread.resourceIds) {
        const snap = await jennifer.client.resources.read('Message', id) as Snapshot | null;
        if (snap && snap.meta.recordedClaims.sub === NEBULA_SUB) out.push({ id, snap });
      }
      return out;
    };
    const postSaying = async (what: string, has: (content: string) => boolean): Promise<{ id: string; snap: Snapshot }> => {
      for (const deadline = Date.now() + TURN_TIMEOUT_MS; ;) {
        const found = (await agentPosts()).find(({ snap }) => has((snap.value as Value).content ?? ''));
        if (found) return found;
        assert.ok(Date.now() < deadline, `the chat never showed ${what}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    };

    // ── P: invited straight into the workspace, with no bit, and signed in there ──
    const pEmail = address('p');
    const pLink = await inviteLinkFor(pEmail, DEV, async () => {
      const summary = await jennifer.client.invite(DEV, [{ email: pEmail }]);
      assert.equal(summary.errors.length, 0, `P's workspace invite was refused: ${JSON.stringify(summary.errors)}`);
    });
    const p = (await acceptedAs(pLink, [DEV]))[DEV]!;
    assert.equal(p.admin, false, 'P must start as a plain member of the workspace');

    // ── Jennifer asks the agent for three invites; each arrives as real mail ──
    const [collaborator, admin] = [address('collab'), address('admin')];
    const mail = { collaborator: '', admin: '' };
    const adminWaiter = waitForEmail({ testToken, instance: SCOPE, to: admin, timeout: TURN_TIMEOUT_MS });
    try {
      mail.collaborator = await inviteLinkFor(collaborator, SCOPE, () => jennifer.client.postUserMessage(
        `Use the invite tool three times, and change no code: invite ${collaborator} as a collaborator, ` +
        `invite ${admin} as an admin of this app, and invite ${pEmail} as a collaborator.`));
      const adminMail = await adminWaiter.emailPromise;
      mail.admin = (/href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(adminMail.html ?? '')?.[1] ?? '').replace(/&amp;/g, '&');
      assert.ok(mail.admin, 'the admin invite mail carried no accept link');
    } finally {
      adminWaiter.cleanup();
    }

    // ── LIMB 3: the link names this stack ──
    for (const link of [mail.collaborator, mail.admin]) {
      assert.equal(new URL(link).host, new URL(pLink).host, 'an invite the agent sends must name the same host as one Jennifer sends herself');
      assert.equal(new URL(link).port, new URL(origin).port, 'and that host is this stack\'s');
    }
    console.error(`  ✓ limb 3 — the agent's invite links name this stack's own host, ${new URL(mail.admin).host}`);

    // ── LIMB 1: each kind lands as its kind ──
    const asCollaborator = await acceptedAs(mail.collaborator, [SCOPE, DEV]);
    assert.deepEqual([asCollaborator[SCOPE]!.admin, asCollaborator[DEV]!.admin], [false, true],
      'a collaborator is a plain member of the app and the admin of its workspace');
    const asAdmin = await acceptedAs(mail.admin, [SCOPE]);
    assert.equal(asAdmin[SCOPE]!.admin, true, 'an admin invite must open an admin membership in the app');
    console.error('  ✓ limb 1 — the collaborator is a plain member with an admin workspace; the admin is an admin of the app');

    // ── LIMB 2: the admin invite's result is the Galaxy's post, as the agent ──
    const outcome = await postSaying("the admin invite's result", (content) => content.includes(admin) && /admin of this app/.test(content) && !/Use the invite tool/.test(content));
    const outcomeValue = outcome.snap.value as Value;
    if (outcomeValue.replyTo === undefined) {
      assert.equal(outcome.snap.meta.recordedClaims.act, undefined, 'nobody acts for the agent on its own post');
      assert.equal(outcomeValue.answers, undefined, "the handler's post answers nothing");
    } else {
      // The turn's own message can name the address too. The handler's is the one that replies to nothing.
      const handlers = (await agentPosts()).filter(({ snap }) => (snap.value as Value).replyTo === undefined && ((snap.value as Value).content ?? '').includes(admin));
      assert.equal(handlers.length, 1, "the Galaxy's handler must post the admin invite's result once, replying to nothing");
      assert.equal(handlers[0]!.snap.meta.recordedClaims.act, undefined);
      assert.equal((handlers[0]!.snap.value as Value).answers, undefined);
    }
    console.error("  ✓ limb 2 — the admin invite's result was posted as the agent, replying to and answering nothing");

    // ── LIMB 4: P is promoted in the workspace, on Jennifer's authority with the agent as actor ──
    for (const deadline = Date.now() + TURN_TIMEOUT_MS; ;) {
      const { accessToken } = await refreshAccessToken(origin, { refreshToken: p.refreshToken, authScope: DEV }, DEV, fetch);
      if ((parseJwtUnsafe(accessToken)!.payload as { access?: { scopeAdmin?: boolean } }).access?.scopeAdmin === true) break;
      assert.ok(Date.now() < deadline, "P's existing workspace session never gained the admin bit");
      await new Promise((r) => setTimeout(r, 1000));
    }
    // P's own promotion: the record names whose bit changed, and other promotions may share the capture.
    const pSub = (parseJwtUnsafe((await refreshAccessToken(origin, { refreshToken: p.refreshToken, authScope: DEV }, DEV, fetch)).accessToken)!.payload as { sub: string }).sub;
    const isPsPromotion = (l: { namespace: string; data: Record<string, any> }): boolean =>
      l.namespace === 'nebula-auth.Registry.identity.roleUpdated' && l.data.scopeAdmin === true && l.data.sub === pSub;
    const promoted = await waitForDebugLines(stack, (all) => all.some(isPsPromotion), "P's promotion's record");
    const record = promoted.find(isPsPromotion)!.data.recordedClaims as { sub?: string; act?: { sub?: string } };
    assert.equal(record.sub, jennifer.sub, "the promotion's record must name Jennifer, whose authority it used");
    assert.equal(record.act?.sub, NEBULA_SUB, 'with the agent as actor');
    console.error("  ✓ limb 4 — P's existing workspace session is an admin's now, and the record names Jennifer with the agent as actor");

    // ── LIMB 5: a member of the app is refused at the facade ──
    const refused = await austen.client.invite(SCOPE, [{ email: address('refused') }]).then(() => undefined, (e: Error) => e);
    assert.ok(refused, "Austen's invite into the app must be refused, and it landed");
    assert.equal(refused.message, `Inviting into the app "${SCOPE}" needs dominion over it, which a member of it does not hold: ask one of its admins`);
    console.error("  ✓ limb 5 — Austen's own invite into the app was refused by the app rule");

    // ── LIMB 6: a node invite the facade refuses is posted to the chat ──
    await jennifer.client.orgTree.setPermission(CHAT_NODE_ID, cast.austenSub, 'admin');
    const viaNode = address('node');
    const ack = await austen.client.lmz.callAsync('GALAXY', SCOPE,
      austen.client.ctn<Galaxy>().resources.invite(CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID, [{ email: viaNode, tier: 'write' }])) as NodeInviteAck;
    assert.deepEqual(ack, { accepted: 1, errors: [] }, 'the node invite acknowledges: its own gate is admin at the node, which Austen holds');
    const failure = await postSaying("the refused node invite", (content) => content.includes(viaNode));
    assert.match((failure.snap.value as Value).content ?? '', /^I could not invite .* needs dominion over it/);
    assert.equal((failure.snap.value as Value).replyTo, undefined);
    console.error('  ✓ limb 6 — the node invite the facade refused was posted to the chat, as the agent');

    // ── Recorded, never gated: Austen, who is no admin, asks the agent for an invite ──
    const asked = address('asked');
    const a1 = await austen.client.postUserMessage(`Please invite ${asked} to this app as a collaborator. Change no code.`);
    let answer: Snapshot | undefined;
    for (const deadline = Date.now() + TURN_TIMEOUT_MS; !answer && Date.now() < deadline;) {
      answer = (await agentPosts()).find(({ snap }) => ((snap.value as Value).answers ?? []).includes(a1))?.snap;
      if (!answer) await new Promise((r) => setTimeout(r, 1000));
    }
    const tried = (answer?.value as Value | undefined)?.codegen?.toolCalls?.filter((tc) => tc.name === 'invite') ?? [];
    console.error(`  · recorded — asked by Austen, the agent ${tried.length === 0 ? 'did not call invite' : tried.some((tc) => tc.error) ? 'called invite and was refused within the turn' : 'called invite and it LANDED'}: ${JSON.stringify(((answer?.value as Value | undefined)?.content ?? '(no answer)').slice(0, 200))}`);
    assert.ok(!tried.some((tc) => !tc.error), "an invite in Austen's turn must never land: she is no admin of the app");

  } finally {
    cast.dispose();
  }
}
