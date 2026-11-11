/**
 * A post that arrives while a turn runs is read by that turn's closing step.
 *
 * Jennifer asks for one thing. While the agent works on it, Austen asks for something that
 * conflicts. A turn builds its history once, at its start, so without a closing step it would
 * never see Austen's post. With one, the turn ends by reading it, offered a message and no tool
 * that acts, and its one message may answer both people.
 *
 * The model is the real one. Whether its closing message answers Austen too, or leaves her post
 * for the decision that follows, is its own choice, so the scenario records which and gates on
 * neither. `held-posts.test.ts` gates both, with the model scripted. The scenario ends at the
 * turn's message.
 *
 *  1. **The turn closes by reading Austen's post.** A `closing step` line names it, for the turn
 *     that took Jennifer's post up. Mutation: skip the closing step, and no line appears.
 *  2. **The closing step is offered a message and no tool that acts.** Mutation: send it the
 *     loop's tools, and its request lists `write_file`.
 *  3. **The turn still ends in the agent's own message, answering the post it took up.**
 */
import assert from 'node:assert/strict';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import type { Snapshot } from '@lumenize/resources';
import { DEFAULT_CHAT_ID } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { chatCast } from '../lib/chat-cast';
import { waitForDebugLines, type DebugLine } from '../lib/stdio';
import { testSlug } from '../lib/test-scopes';

/** Chat and auth only: the requests ask for a plan in words, never for code. */
export const needsContainer = false;

const SCOPE = `${testSlug('close')}.app`;
/** A real generation fits well inside this; silence past it is the failure. */
const TURN_TIMEOUT_MS = 240_000;
const chatQuery = { queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };
type Value = { content?: string; replyTo?: string; answers?: string[] };

export async function run(stack: DevStack): Promise<void> {
  const cast = await chatCast(stack, SCOPE, readDevVar('TEST_TOKEN'));
  const { jennifer, austen } = cast;
  try {
    using thread = jennifer.client.resources.subscribeQuery(chatQuery); await thread.ready;
    const turnLines = (all: DebugLine[], message: string): DebugLine[] =>
      all.filter((l) => l.namespace === 'nebula.Galaxy.turn' && l.message === message && l.data.instanceName === SCOPE);

    const j1 = await jennifer.client.postUserMessage(
      'Plan only, no code yet: I want the wishlist sorted by when items were added. First read .platform/docs/coding-your-ui.md, then tell me your plan in two sentences.');
    // Austen posts once the turn has read the thread and sent its first request, so her post
    // arrives while the turn runs and is not part of the history it started with.
    await waitForDebugLines(stack, (all) => turnLines(all, 'request').some((l) => l.data.step === 'turn'), "the turn's first request");
    const a1 = await austen.client.postUserMessage('I would rather it were sorted by name. No code yet; tell me in one sentence what you will do.');

    // The turn's message, replying to Jennifer's post.
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    let reply: Snapshot | undefined;
    while (!reply) {
      for (const id of thread.resourceIds) {
        const snap = await jennifer.client.resources.read('Message', id) as Snapshot | null;
        if (snap && (snap.value as Value).replyTo === j1) reply = snap;
      }
      assert.ok(reply || Date.now() < deadline, "the turn on Jennifer's post never posted its message");
      if (!reply) await new Promise((r) => setTimeout(r, 1000));
    }
    const lines = await waitForDebugLines(stack, (all) => turnLines(all, 'closing step').length > 0 || turnLines(all, 'decision').length > 0,
      'the closing step, or the decision that would follow a turn without one');

    // ── LIMB 1: the turn closed by reading Austen's post ──
    const closing = turnLines(lines, 'closing step');
    assert.equal(closing.length, 1, `the turn must end with one closing step, and ${closing.length} ran: Austen's post did not arrive mid-turn, or the step was skipped`);
    assert.equal(closing[0]!.data.postId, j1, "the closing step belongs to the turn on Jennifer's post");
    assert.deepEqual(closing[0]!.data.posts, [a1], "it must read Austen's post, the one that arrived");
    console.error("  ✓ limb 1 — the turn on Jennifer's post closed by reading Austen's");

    // ── LIMB 2: the closing step is offered a message, and nothing that acts ──
    const requests = turnLines(lines, 'request').filter((l) => l.data.step === 'closing');
    assert.equal(requests.length, 1, 'the closing step makes one model request');
    assert.deepEqual(requests[0]!.data.tools, ['mark_complete']);
    console.error('  ✓ limb 2 — the closing step was offered mark_complete only');

    // ── LIMB 3: the turn's message is the agent's own, and answers the post it took up ──
    assert.equal(reply.meta.recordedClaims.sub, NEBULA_SUB);
    assert.equal(reply.meta.recordedClaims.act, undefined);
    const answers = (reply.value as Value).answers ?? [];
    assert.ok(answers.includes(j1), "the turn's message must answer Jennifer's post");
    console.error("  ✓ limb 3 — the turn's message is the agent's own and answers Jennifer's post");

    // ── Recorded, never gated: whether the one message answered Austen too ──
    console.error(`  · recorded — the closing message ${answers.includes(a1) ? 'answered both posts' : "answered Jennifer's alone, leaving Austen's for a decision"}: ${JSON.stringify(((reply.value as Value).content ?? '').slice(0, 160))}`);
  } finally {
    cast.dispose();
  }
}
