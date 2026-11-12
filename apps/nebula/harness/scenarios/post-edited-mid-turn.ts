/**
 * A post edited while its turn runs is not acted on, and is not marked answered.
 *
 * Jennifer owns the app and posts a request. Austen, a collaborator with `write` at the chat
 * node, rewrites that post while the turn on it is still waiting for the model. A turn names the
 * snapshot of the post it read, by its `validFrom`, so a tool call made after the edit finds the
 * post moved on and stops the turn, and the turn's closing message looks once more. Either way
 * the message that turn posts answers no post, and the edited post waits again.
 *
 * The edit is sent as soon as Jennifer's post has committed. The commit starts the turn in the
 * same invocation, and the turn's first model call takes seconds, so the edit lands while the
 * turn waits. Nothing here is timed off a log line of a running turn, which deployed arrives
 * only when the turn ends.
 *
 * The model is the real one, so what it does next is its own choice: a decision may take the
 * edited post up, answer it in a message, or leave it. Each limb gates only on what holds
 * whichever it picks. `waiting-posts.test.ts` gates the choices, with the model scripted.
 *
 *  1. **The turn on the first words acted on nothing.** Its message records no tool call that
 *     ran. The request asks for a file to be read, so a turn that was not stopped would have
 *     one. Mutation: act under the post's current record whatever its `validFrom`, and the
 *     `read_file` runs and is recorded.
 *  2. **That turn's message answers no post.** It replies to nothing and names no post, and
 *     says in our own words that the post changed. Mutation: keep `replyTo` when the post
 *     moved on, and the message replies to Jennifer's post.
 *  3. **If a later turn took the edited post up, it ran under the editor.** Its `took up` line
 *     and each tool call's record name Austen, with the agent as actor. Recorded as not
 *     exercised when the model answered the post in a message or left it.
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

/** Chat and auth only: the requests ask for a file to be read and for a word, never for code. */
export const needsContainer = false;

const SCOPE = `${testSlug('moved')}.app`;
/** A real generation fits well inside this; silence past it is the failure. */
const TURN_TIMEOUT_MS = 240_000;
const chatQuery = { queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };
const LOOP_TOOLS = ['read_file', 'write_file', 'edit_file', 'build', 'invite'];
const MOVED = 'The post I was working on was changed while I worked';

type ToolCall = { name: string; error?: string; post?: string; claims?: { sub?: string; act?: { sub?: string } } };
type Value = { content?: string; replyTo?: string; answers?: string[]; codegen?: { toolCalls?: ToolCall[] } };

export async function run(stack: DevStack): Promise<void> {
  const cast = await chatCast(stack, SCOPE, readDevVar('TEST_TOKEN'));
  const { jennifer, austen } = cast;
  try {
    using thread = jennifer.client.resources.subscribeQuery(chatQuery); await thread.ready;
    const agentMessages = async (): Promise<Snapshot[]> => {
      const out: Snapshot[] = [];
      for (const id of thread.resourceIds) {
        const snap = await jennifer.client.resources.read('Message', id) as Snapshot | null;
        if (snap && snap.meta.recordedClaims.sub === NEBULA_SUB) out.push(snap);
      }
      return out.sort((a, b) => a.meta.validFrom.localeCompare(b.meta.validFrom));
    };

    const j1 = await jennifer.client.postUserMessage(
      'Read AGENTS.md with read_file, then reply with the one word READY and nothing else. Do not change any code.');
    // Austen rewrites Jennifer's post while its turn waits on the model.
    const current = await austen.client.resources.read('Message', j1) as Snapshot;
    const edited = await austen.client.resources.transaction({
      [j1]: {
        op: 'put', typeName: 'Message', ifValidFromMatches: current.meta.validFrom,
        value: { chat: DEFAULT_CHAT_ID, content: 'Read AGENTS.md with read_file, then reply with the one word EDITED and nothing else. Do not change any code.' },
      },
    });
    assert.equal(edited.kind, 'committed', "Austen's edit of Jennifer's post must commit");
    const after = await austen.client.resources.read('Message', j1) as Snapshot;
    assert.equal(after.meta.recordedClaims.sub, cast.austenSub, 'the edited post must record Austen as its writer');

    // The stopped turn's message is the first the agent posts.
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    let first: Snapshot | undefined;
    while (!first) {
      first = (await agentMessages())[0];
      assert.ok(first || Date.now() < deadline, "the turn on Jennifer's post never posted a message");
      if (!first) await new Promise((r) => setTimeout(r, 1000));
    }
    const value = first.value as Value;

    // ── LIMB 1: the turn on the first words acted on nothing ──
    const ran = (value.codegen?.toolCalls ?? []).filter((tc) => LOOP_TOOLS.includes(tc.name) && tc.error === undefined);
    assert.deepEqual(ran.map((tc) => tc.name), [],
      'a turn whose post was edited before its first tool call must record no tool call that ran');
    console.error('  ✓ limb 1 — the turn on the first words ran no tool');

    // ── LIMB 2: its message answers no post ──
    assert.equal(value.replyTo, undefined, "the stopped turn's message must reply to no post");
    assert.ok(!(value.answers ?? []).includes(j1), "the stopped turn's message must not answer the edited post");
    assert.ok(value.content?.includes(MOVED), `the stopped turn's message must say the post changed; it reads: ${value.content}`);
    console.error('  ✓ limb 2 — its message answers no post, and says the post changed');

    // ── LIMB 3: a later turn on the edited post ran under its editor ──
    // The decision after the stopped turn is offered the edited post. Its line arrives when its
    // invocation ends, so this waits for it rather than reading the capture as it stands.
    const turnLines = (all: DebugLine[], message: string): DebugLine[] =>
      all.filter((l) => l.namespace === 'nebula.Galaxy.turn' && l.message === message && l.data.instanceName === SCOPE);
    const lines = await waitForDebugLines(stack, (all) => turnLines(all, 'decision').length > 0,
      'the decision that follows the stopped turn');
    const decision = turnLines(lines, 'decision')[0]!;
    if (decision.data.postId !== j1) {
      console.error(`  · limb 3 not exercised: the decision took up ${decision.data.postId ?? 'no post'}, answering ${JSON.stringify(decision.data.answers ?? [])}`);
      return;
    }
    let reply: Snapshot | undefined;
    for (const until = Date.now() + TURN_TIMEOUT_MS; !reply;) {
      reply = (await agentMessages()).find((snap) => (snap.value as Value).replyTo === j1);
      assert.ok(reply || Date.now() < until, 'the turn that took the edited post up never posted its message');
      if (!reply) await new Promise((r) => setTimeout(r, 1000));
    }
    const tookUp = (await waitForDebugLines(stack, (all) => turnLines(all, 'took up').filter((l) => l.data.postId === j1).length >= 2,
      'both took-up lines for the post'));
    const claims = turnLines(tookUp, 'took up').filter((l) => l.data.postId === j1).map((l) => (l.data.claims as { sub?: string } | null)?.sub);
    assert.ok(claims.includes(cast.austenSub), `a turn on the edited post must run under Austen; the took-up lines name ${JSON.stringify(claims)}`);
    const under = ((reply.value as Value).codegen?.toolCalls ?? []).filter((tc) => LOOP_TOOLS.includes(tc.name));
    for (const tc of under) {
      assert.deepEqual([tc.post, tc.claims?.sub, tc.claims?.act?.sub], [j1, cast.austenSub, NEBULA_SUB],
        `${tc.name} on the edited post must be recorded under Austen with the agent as actor`);
    }
    console.error(`  ✓ limb 3 — the edited post was taken up under Austen (${under.length} tool call(s) recorded)`);
  } finally {
    cast.dispose();
  }
}
