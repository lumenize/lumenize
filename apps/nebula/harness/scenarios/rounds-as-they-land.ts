/**
 * A turn's rounds are stored as the turn runs, each by the agent, before the turn's message.
 *
 * Jennifer founds the app and posts a request that asks for two reads in one reply. Austen, a
 * collaborator whose invite's `read` at `chat` covers the `rounds` node, takes the agent message's id from
 * the first progress chunk and subscribes to that message's rounds, so she sees each round as the
 * Galaxy stores it. The model is the real one, so what it calls is its own choice: each limb gates
 * only on what holds whatever it calls, and says when there was nothing to check.
 *
 *  1. **Every round arrives before the message.** Each push is stamped as it lands, the rounds' and
 *     the thread's alike, and both ride one socket, so they land in the order the Galaxy sent them.
 *     No one-line edit makes the Galaxy write its rounds after the message, so this limb has no
 *     mutation of its own.
 *  2. **Each round is the agent's, and the indexes run from 1 with no gap.**
 *  3. **Each call that ran ends with the message snapshot it acted for, its claims, and a result or an error.** A call
 *     refused before it ran, for its shape, has only its error. A turn that called no tool is
 *     reported as not exercised.
 *  4. **Each call's result is written as it lands.** For a round of two or more calls, the Worker's
 *     logs show the round written with one call resolved before it is written with the last.
 *     Mutation: store a round's results only once all of its calls have run, and no write with
 *     one resolved appears.
 *  5. **The provider takes a request rebuilt from stored rounds.** The turn's own rounds, with one
 *     call's outcome replaced by the interrupted error and a note for a cut-off model call after
 *     them, rebuilt by the loop's own `rebuildTurn` and posted to the Workers AI REST endpoint,
 *     answer 200 with a reply that parses. It needs `WORKERS_AI_TOKEN` and
 *     `CLOUDFLARE_ACCOUNT_ID` in `.dev.vars`.
 */
import assert from 'node:assert/strict';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import type { Snapshot } from '@lumenize/resources';
import { DEFAULT_CHAT_ID, roundsOf, turnCalls } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { chatCast } from '../lib/chat-cast';
import { debugLines, waitForDebugLines, LOG_WAIT_MS } from '../lib/stdio';
import type { DebugLine } from '../lib/stdio';
import { testSlug } from '../lib/test-scopes';
import {
  rebuildTurn, assembleCodegenPrompt, parseModelTurn, TOOL_CONTRACT, CODEGEN_TOOLS, DEFAULT_LOOP_CONFIG,
  INTERRUPTED_CALL_ERROR, type StoredRound,
} from '../../src/codegen-loop';
import { STUDIO_MODEL } from '../../src/studio-model';

/** Chat and reads only: the request asks for two files to be read, never for code. */
export const needsContainer = false;

const SCOPE = `${testSlug('rounds')}.app`;
/** A real generation fits well inside this; silence past it is the failure. */
const TURN_TIMEOUT_MS = 240_000;
const chatQuery = { typeName: 'Message', filter: { chat: DEFAULT_CHAT_ID } };
const LOOP_TOOLS = ['read_file', 'write_file', 'edit_file', 'build', 'invite', 'run_in_tab'];

export async function run(stack: DevStack): Promise<void> {
  const cast = await chatCast(stack, SCOPE, readDevVar('TEST_TOKEN'));
  const { jennifer, austen } = cast;
  try {
    using thread = austen.client.resources.subscribeQuery(chatQuery); await thread.ready;
    const seen = new Map<string, number>(); // round id → when Austen first saw it
    let messageId: string | undefined;
    let rounds: ReturnType<typeof austen.client.resources.subscribeQuery> | undefined;
    const chunk = new Promise<string>((resolve) => {
      austen.client.setOnStreamChunk((id) => { resolve(id); });
    });
    const posted = await jennifer.client.postUserMessage(
      'In ONE reply, call read_file on AGENTS.md and read_file on src/App.vue together. Then reply with the one word READ and nothing else. Do not change any code.');

    messageId = await Promise.race([chunk, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no progress chunk arrived for the turn')), TURN_TIMEOUT_MS))]);
    rounds = austen.client.resources.subscribeQuery(roundsOf(messageId));
    rounds.onChange(() => { for (const id of rounds!.resourceIds) if (!seen.has(id)) seen.set(id, performance.now()); });
    await rounds.ready;
    for (const id of rounds.resourceIds) if (!seen.has(id)) seen.set(id, performance.now());

    // The message is committed when the turn ends, stamped as its push lands.
    let messageAt: number | undefined;
    const stampMessage = (): void => { if (messageAt === undefined && thread.resourceIds.includes(messageId!)) messageAt = performance.now(); };
    thread.onChange(stampMessage);
    stampMessage();
    for (const until = Date.now() + TURN_TIMEOUT_MS; messageAt === undefined;) {
      assert.ok(Date.now() < until, `the turn never committed its message ${messageId}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    const message = await austen.client.resources.read('Message', messageId) as Snapshot;
    assert.equal((message.value as { replyTo?: string }).replyTo, posted, 'the message must reply to the post its turn took up');

    // ── LIMB 1: every round arrives before the message ──
    const { snapshots } = await austen.client.resources.query(roundsOf(messageId));
    assert.ok(snapshots.length > 0, 'a turn must store at least one round');
    for (const s of snapshots) {
      const at = seen.get(s.resourceId);
      assert.ok(at !== undefined && at < messageAt, `round ${(s.value as StoredRound).index} must arrive before the message`);
    }
    console.error(`  ✓ limb 1 — all ${snapshots.length} round(s) arrived before the message`);

    // ── LIMB 2: each is the agent's, indexes from 1 with no gap ──
    const indexes = snapshots.map((s) => (s.value as StoredRound).index).sort((a, b) => a - b);
    assert.deepEqual(indexes, indexes.map((_, i) => i + 1), `the rounds' indexes must run from 1 with no gap: ${JSON.stringify(indexes)}`);
    for (const s of snapshots) assert.equal(s.meta.recordedClaims.sub, NEBULA_SUB, 'every round must be written by the agent');
    console.error('  ✓ limb 2 — every round is the agent\'s, indexes 1..' + indexes.length);

    // ── LIMB 3: each call that ran ends with its message snapshot, claims, and an outcome ──
    const calls = turnCalls(snapshots);
    const ran = calls.filter((c) => LOOP_TOOLS.includes(c.name) && (c.result !== undefined || c.claims !== undefined));
    for (const c of ran) {
      assert.ok(c.messageSnapshot?.id === posted && c.claims?.sub && (c.result !== undefined || c.error !== undefined),
        `call ${c.round}.${c.call} (${c.name}) must end with its message snapshot, its claims and an outcome: ${JSON.stringify({ messageSnapshot: c.messageSnapshot, claims: c.claims, error: c.error })}`);
    }
    if (ran.length === 0) console.error('  · limb 3 not exercised: the turn ran no tool');
    else console.error(`  ✓ limb 3 — ${ran.length} call(s) ran, each with its message snapshot, claims and outcome`);

    // ── LIMB 4: a round's results are written as each lands ──
    const multi = snapshots.map((s) => s.value as StoredRound).filter((r) => r.calls.length >= 2);
    if (multi.length === 0) {
      console.error('  · limb 4 not exercised: no round had two or more calls');
    } else {
      // Each round's resolved counts, from the store's write lines. The wait holds out for every
      // multi-call round's lines, not the first line in: deployed, a capture arrives one invocation
      // at a time and out of order, and on 2026-11-18 round 2's line came in before round 1's.
      const resolvedOf = (lines: DebugLine[], index: number): number[] => lines
        .filter((l) => l.namespace === 'nebula.Galaxy.rounds' && l.data.message === messageId && l.data.index === index)
        .map((l) => l.data.resolved as number);
      const landedOneByOne = (resolved: number[]): boolean => resolved.includes(1) && Math.max(...resolved) > 1;
      const written = await waitForDebugLines(stack, (all) => multi.every((r) => landedOneByOne(resolvedOf(all, r.index))),
        'every multi-call round\'s writes as its calls landed', LOG_WAIT_MS).catch(() => debugLines(stack.logs()));
      for (const r of multi) {
        const resolved = resolvedOf(written, r.index);
        assert.ok(landedOneByOne(resolved),
          `round ${r.index}, with ${r.calls.length} calls, must be written once its first call ran and again after; resolved counts ${JSON.stringify(resolved)}`);
      }
      console.error(`  ✓ limb 4 — each of ${multi.length} multi-call round(s) was written as its calls landed`);
    }

    // ── LIMB 5: the provider takes a request rebuilt from these rounds ──
    const stored = snapshots.map((s) => s.value as StoredRound).sort((a, b) => a.index - b.index);
    const prefix: StoredRound[] = [];
    for (const r of stored) {
      const settled = r.calls.length > 0 && r.calls.every((c) => c.result !== undefined || c.error !== undefined)
        && !r.calls.some((c) => (c.raw as { function?: { name?: string } }).function?.name === 'mark_complete');
      if (!settled || r.closing) break;
      prefix.push(structuredClone(r));
    }
    if (prefix.length === 0) {
      console.error('  · limb 5 not exercised: no round ran every call and went on');
      return;
    }
    const last = prefix.at(-1)!;
    const cut = last.calls.findIndex((c) => c.result !== undefined);
    if (cut >= 0) last.calls[cut] = { raw: last.calls[cut]!.raw, error: INTERRUPTED_CALL_ERROR };
    const blobs = new Map<string, string>();
    for (const c of turnCalls(prefix.map((value) => ({ value, meta: { recordedClaims: { sub: NEBULA_SUB } } })))) {
      const oid = (c.result as { oid?: string } | undefined)?.oid;
      if (c.name === 'read_file' && oid) blobs.set(oid, '(the file as the model read it)');
    }
    const initial = assembleCodegenPrompt({ systemBundles: [TOOL_CONTRACT], userRequest: 'Read two files, then say READ.' });
    const rebuilt = rebuildTurn({
      prompt: [initial.system, initial.user], rounds: prefix, interrupted: [last.index + 1], blobs, config: DEFAULT_LOOP_CONFIG,
    });
    assert.deepEqual(rebuilt.next, { kind: 'model', index: last.index + 1 }, 'the rebuilt turn must be ready for its next model call');
    const account = readDevVar('CLOUDFLARE_ACCOUNT_ID');
    const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${STUDIO_MODEL}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readDevVar('WORKERS_AI_TOKEN')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: rebuilt.messages, tools: CODEGEN_TOOLS, ...rebuilt.params }),
    });
    const body = await resp.text();
    assert.equal(resp.status, 200, `the provider must accept a rebuilt request; it answered ${resp.status}: ${body.slice(0, 600)}`);
    const json = JSON.parse(body) as { success?: boolean; result?: unknown };
    assert.ok(json.success, `the provider's answer must succeed: ${body.slice(0, 600)}`);
    const reply = parseModelTurn(json.result);
    assert.ok(reply.text.length > 0 || reply.toolCalls.length > 0, `the provider's reply must parse to text or a call: ${body.slice(0, 600)}`);
    console.error(`  ✓ limb 5 — the provider took a request rebuilt from ${prefix.length} round(s), with an interrupted call and a note`);
    rounds[Symbol.dispose]();
  } finally {
    cast.dispose();
  }
}
