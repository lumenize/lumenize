/**
 * Two people post in one chat while a turn runs, and each post is worked on under its own
 * poster's claims.
 *
 * Jennifer owns the app. Austen is a collaborator, enrolled by the real node invite with `write`
 * at the chat node and no admin bit. Jennifer posts, and Austen posts while Jennifer's turn is
 * still running. The Galaxy holds each post's call with the post, so when the agent gets to
 * Austen's post it works under Austen's claims, never under those of whoever happened to post
 * first. The agent itself posts every message as `agent:lumenize`.
 *
 * The model is the real one, and what it does with Austen's waiting post is its own choice: it
 * may take the post up, answer it in a message, or write a message that names nothing. So each
 * limb gates only on what holds whichever it picks, and the scenario records the choice without
 * gating on it. `held-posts.test.ts` gates the choices themselves, with the model scripted.
 *
 *  1. **Austen's post waits while Jennifer's turn runs.** The Galaxy logs it as waiting, and
 *     starts no second turn beside the first. This is timing, not the model's choice: a turn is
 *     at least one model call long.
 *  2. **Every turn's tools run under the poster of the post it took up, with the agent as
 *     actor.** Each `took up` line's claims name that post's recorded writer. Mutation: log the
 *     turn's ambient claims, and the line names the agent.
 *  3. **Every agent message records the agent as its subject, with no `act`.** Mutation: run the
 *     turns and their posts under the call that started them, and Jennifer is the subject.
 *  4. **A post a turn took up is answered by that turn's message, which names it in `answers`.**
 *     Jennifer's always is. Mutation: build `answers` without the post the turn took up, and
 *     Jennifer's post still waits.
 *  5. **The decision after Jennifer's turn is offered a pick and a message, and no tool that
 *     acts.** Mutation: send it the loop's tools, and its request lists `write_file`.
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

/** Chat and auth only: the requests ask for words, never for code. */
export const needsContainer = false;

const SCOPE = `${testSlug('held')}.app`;
/** A real generation fits well inside this; silence past it is the failure. */
const TURN_TIMEOUT_MS = 240_000;
const chatQuery = { queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };

type Value = { content?: string; replyTo?: string; answers?: string[] };

export async function run(stack: DevStack): Promise<void> {
  const cast = await chatCast(stack, SCOPE, readDevVar('TEST_TOKEN'));
  const { jennifer, austen } = cast;
  const austenSession = { sub: cast.austenSub };
  try {
    using thread = jennifer.client.resources.subscribeQuery(chatQuery); await thread.ready;
    const messages = async (): Promise<Array<{ id: string; snap: Snapshot }>> => {
      const out: Array<{ id: string; snap: Snapshot }> = [];
      for (const id of thread.resourceIds) {
        const snap = await jennifer.client.resources.read('Message', id) as Snapshot | null;
        if (snap) out.push({ id, snap });
      }
      return out;
    };
    const here = (line: DebugLine): boolean => line.data.instanceName === SCOPE;
    const turnLines = (all: DebugLine[], message: string): DebugLine[] =>
      all.filter((l) => l.namespace === 'nebula.Galaxy.turn' && l.message === message && here(l));

    // ── The two posts: Austen's lands while Jennifer's turn is running ──
    const j1 = await jennifer.client.postUserMessage('Reply with the one word READY and nothing else. Do not change any code.');
    const a1 = await austen.client.postUserMessage('When you get to me, reply with the one word SET and nothing else. Do not change any code.');

    // The loop is idle again once the decision that follows Jennifer's turn is over: it either
    // took Austen's post up, whose turn then ends in a message replying to it, or it did not.
    const decided = await waitForDebugLines(stack, (all) => turnLines(all, 'decision').length > 0,
      "the decision after Jennifer's turn", TURN_TIMEOUT_MS);
    const [decision] = turnLines(decided, 'decision');
    const tookAustenUp = decision!.data.postId === a1;
    if (tookAustenUp) {
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      while (!(await messages()).some(({ snap }) => (snap.value as Value).replyTo === a1)) {
        assert.ok(Date.now() < deadline, "the turn that took Austen's post up never posted its message");
        await new Promise((r) => setTimeout(r, 1000));
      }
    } else {
      // A decision that picks nothing logs its line before it posts its message, if it has one.
      await new Promise((r) => setTimeout(r, 3000));
    }
    const all = await messages();
    const lines = await waitForDebugLines(stack, () => true, 'the capture');
    const writerOf = (id: string): string | undefined => all.find((m) => m.id === id)?.snap.meta.recordedClaims.sub;
    const agentMessages = all.filter(({ snap }) => snap.meta.recordedClaims.sub === NEBULA_SUB);
    const answered = new Set(agentMessages.flatMap(({ snap }) => (snap.value as Value).answers ?? []));

    // ── LIMB 1: Austen's post waited ──
    assert.ok(lines.some((l) => l.namespace === 'nebula.Galaxy.trigger' && l.message === 'waiting: a turn is in flight' && l.data.resourceId === a1),
      "Austen's post must be logged as waiting behind Jennifer's turn: the two posts did not overlap");
    console.error("  ✓ limb 1 — Austen's post waited while Jennifer's turn ran");

    // ── LIMB 2: each turn ran under the poster of the post it took up, with the agent as actor ──
    const tookUp = turnLines(lines, 'took up');
    assert.ok(tookUp.length >= 1 && tookUp[0]!.data.postId === j1, "the first turn must take Jennifer's post up");
    assert.equal(writerOf(j1), jennifer.sub);
    assert.equal(writerOf(a1), austenSession.sub);
    for (const line of tookUp) {
      const claims = line.data.claims as { sub?: string; act?: { sub?: string } } | null;
      assert.equal(claims?.sub, writerOf(line.data.postId), `the turn on ${line.data.postId} must run under its poster's claims, and ran under ${JSON.stringify(claims)}`);
      assert.equal(claims?.act?.sub, NEBULA_SUB, 'the agent must be the actor on those claims');
    }
    console.error(`  ✓ limb 2 — ${tookUp.length} turn(s), each under the poster of the post it took up, with the agent as actor`);

    // ── LIMB 3: the agent posts as itself ──
    assert.ok(agentMessages.length >= 1, 'the agent must have posted');
    for (const { id, snap } of all) {
      if (id === j1 || id === a1) continue;
      assert.equal(snap.meta.recordedClaims.sub, NEBULA_SUB, `message ${id} must be the agent's own`);
      assert.equal(snap.meta.recordedClaims.act, undefined, 'nobody acts for the agent on its own post');
    }
    console.error(`  ✓ limb 3 — ${agentMessages.length} agent message(s), each recorded as the agent with no act`);

    // ── LIMB 4: a post a turn took up is answered by a message naming it ──
    for (const line of tookUp) {
      const reply = agentMessages.find(({ snap }) => (snap.value as Value).replyTo === line.data.postId);
      assert.ok(reply, `the turn on ${line.data.postId} must end in a message replying to it`);
      assert.ok((reply.snap.value as Value).answers?.includes(line.data.postId), 'that message must name the post in answers');
    }
    assert.ok(answered.has(j1), "Jennifer's post must be answered");
    console.error('  ✓ limb 4 — each post a turn took up is answered by that turn\'s message');

    // ── LIMB 5: the decision is offered a pick and a message, and nothing that acts ──
    const decisionRequests = turnLines(lines, 'request').filter((l) => l.data.step === 'decision');
    assert.ok(decisionRequests.length >= 1, 'the decision must have made a model request');
    for (const request of decisionRequests) assert.deepEqual(request.data.tools, ['take_up', 'mark_complete']);
    console.error('  ✓ limb 5 — the decision was offered take_up and mark_complete only');

    // ── Recorded, never gated: what the real model did with Austen's waiting post ──
    const how = tookAustenUp ? 'the decision took her post up, and its turn answered it'
      : answered.has(a1) ? 'the decision answered it in a message that named it'
      : 'the decision named no post, so it still waits for the next post\'s turn';
    console.error(`  · recorded — Austen's waiting post: ${how}`);
  } finally {
    cast.dispose();
  }
}
