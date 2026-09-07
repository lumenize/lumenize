/**
 * The chat HISTORY in the prompt (`.claude/rules/studio-guidance.md`): an append-only
 * bundle projected from the chat's own ordered query — per message its speaker (`agent`,
 * or `human N` in first-appearance order), its `content`, and from an agent message only
 * the manifest of what that turn changed — never `toolCalls` (whole files ride their
 * args) and never `thought`. Driven through the REAL commit path on the baseline test app,
 * whose scripted model captures every prompt it is handed (`takeSeenMessagesForTest`).
 *
 *  - H-f  turn N+1 carries turn N's request text, speaker label, the agent's content and
 *         its appliedPaths; a turn that wrote 400 lines and a turn that wrote nothing yield
 *         bundles identical apart from the `applied=` entry — no toolCalls, no thought.
 *  - H-g  the triggering message is never in the history; the request bundle carries it once.
 *  - H-h  turn one emits no history bundle.
 *  - H-i  two messages posted during one generation, then a third turn: the skipped
 *         message rides the history with no reply after it.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { DEFAULT_CHAT_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, deriveKind } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { HISTORY_HEADER } from '../../../src/codegen-loop';
import { universeAdminClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const uniqueScope = () => `hb-${crypto.randomUUID().slice(0, 8)}.app`;
const chatQuery = { queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };

/** One text-only model round (→ the loop's `no-tool-calls` stop; the text is the reply). */
const round = (content: string) => ({ choices: [{ message: { content, reasoning_content: '', tool_calls: [] } }] });
/** A round that writes `src/App.vue` with `content`, then one that marks complete. */
const writeThenComplete = (content: string) => [
  { choices: [{ message: { content: '', reasoning_content: 'thinking hard', tool_calls: [
    { id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/App.vue', content }) } },
  ] } }] },
  { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'mark_complete', arguments: '{}' } },
  ] } }] },
];
const FOUR_HUNDRED_LINES = Array.from({ length: 400 }, (_, i) => `<!-- line ${i} of a long App.vue -->`).join('\n');

async function devClient(scope: string, email = 'admin@example.com') {
  return universeAdminClient(
    NebulaClientTest, new Browser(), scope, scope, email, CHAT_MESSAGE_ONTOLOGY_VERSION,
    { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
  );
}
async function seed(client: NebulaClientTest, scope: string, script: unknown[]) {
  client.callGalaxySeedChatScript(scope, script);
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));
  expect(client.lastError).toBeUndefined();
}
/** Drop every prompt captured so far, so the next read is the next turn's. */
async function drain(client: NebulaClientTest, scope: string): Promise<void> {
  client.callGalaxyTakeSeenMessages(scope);
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));
}
/** Drain, post, then wait for the agent's durable reply to it. */
async function postAndWait(client: NebulaClientTest, scope: string, sub: { resourceIds: readonly string[] }, text: string): Promise<string> {
  await drain(client, scope);
  const id = await client.postUserMessage(text);
  await vi.waitFor(async () => {
    for (const rid of sub.resourceIds) {
      const snap = await client.resources.read('Message', rid) as Snapshot | null;
      if (snap && deriveKind(snap.meta.actingToken) === 'agent' && (snap.value as { replyTo?: string }).replyTo === id) return;
    }
    throw new Error('no reply yet');
  }, { timeout: 15000 });
  return id;
}
/** The system layer (`messages[0]`) and the request (`messages[1]`) of the LAST turn's first round. */
async function lastTurnPrompt(client: NebulaClientTest, scope: string): Promise<{ system: string; request: string }> {
  client.callGalaxyTakeSeenMessages(scope);
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));
  const calls = client.lastResult as Array<Array<{ role: string; content: string }>>;
  expect(calls.length).toBeGreaterThan(0);
  const first = calls[0]!;
  return { system: first[0]!.content, request: first[1]!.content };
}
/** The history bundle alone, out of a system layer — from its header to the end. */
const historyOf = (system: string): string | undefined => {
  const at = system.indexOf(HISTORY_HEADER);
  return at < 0 ? undefined : system.slice(at);
};

describe('the chat history in the prompt', () => {
  it('H-h + H-g + H-f: turn one carries no history; turn two carries turn one — request, label, reply, applied — and never the trigger', async () => {
    const scope = uniqueScope();
    const { client } = await devClient(scope);
    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;

    await seed(client, scope, writeThenComplete(FOUR_HUNDRED_LINES));
    await postAndWait(client, scope, sub, 'Build me a wishlist app.');
    const t1 = await lastTurnPrompt(client, scope);
    // (h) turn one: no history bundle at all — omitted, not rendered empty.
    expect(historyOf(t1.system)).toBeUndefined();
    expect(t1.request).toContain('User request (human 1): Build me a wishlist app.');

    await seed(client, scope, [round('Sure — what else?')]);
    const m2 = await postAndWait(client, scope, sub, 'Now add a remove button.');
    const t2 = await lastTurnPrompt(client, scope);
    const history = historyOf(t2.system);
    expect(history).toBeDefined();
    // (f) turn one's request text, its speaker label, the agent's content and its appliedPaths.
    expect(history).toContain('- human 1: Build me a wishlist app.');
    expect(history).toMatch(/- agent: Updated the preview\. \[stop=complete rounds=2 applied=src\/App\.vue sourceCommit=[0-9a-f]{7}\]/);
    // Never the tool calls' args (400 lines of App.vue) and never the thought panel.
    expect(t2.system).not.toContain('line 7 of a long App.vue');
    expect(t2.system).not.toContain('thinking hard');
    expect(t2.system).not.toContain('toolCalls');
    // (g) the triggering message is not in the history, and the request bundle carries it once.
    expect(history).not.toContain('Now add a remove button.');
    expect(t2.request.split('Now add a remove button.').length - 1).toBe(1);
    expect(t2.request).toContain('User request (human 1): Now add a remove button.');
    void m2;

    client[Symbol.dispose]();
  });

  it('H-f: a turn that wrote 400 lines and a turn that wrote nothing yield history bundles identical apart from the applied entry', async () => {
    // Two Galaxies, same conversation; only turn one's tool use differs. Mutation: include
    // `toolCalls` in the projection → bundle A carries 400 lines and the diff is not one
    // entry → red. Drop the speaker → the owner's line and a peer's aside are one string.
    const [a, b] = [uniqueScope(), uniqueScope()];
    const bundles: string[] = [];
    for (const [scope, script] of [[a, writeThenComplete(FOUR_HUNDRED_LINES)], [b, [round('Updated the preview.')]]] as const) {
      const { client } = await devClient(scope);
      using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;
      await seed(client, scope, [...script]);
      await postAndWait(client, scope, sub, 'Build me a wishlist app.');
      await seed(client, scope, [round('ok')]);
      await postAndWait(client, scope, sub, 'And then?');
      const { system } = await lastTurnPrompt(client, scope);
      bundles.push(historyOf(system)!);
      client[Symbol.dispose]();
    }
    const [withWrite, withoutWrite] = bundles;
    expect(withWrite).not.toBe(withoutWrite);
    // Strip the manifest bracket from both: what remains is identical — the speakers, the
    // texts, the order — so the 400 lines never entered the bundle.
    const stripManifest = (s: string) => s.replace(/ \[stop=[^\]]*\]/g, '');
    expect(stripManifest(withWrite)).toBe(stripManifest(withoutWrite));
    expect(withWrite).toMatch(/applied=src\/App\.vue/);
    expect(withoutWrite).not.toMatch(/applied=/);
    expect(withWrite.length).toBeLessThan(600); // a few hundred bytes a turn, not four hundred lines
  });

  it('H-i: two messages posted during one generation, then a third turn — the skipped message rides the history with no reply after it', async () => {
    const scope = uniqueScope();
    const { client } = await devClient(scope);
    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;

    // A slow first generation spanning both commits: m2 lands while m1's turn runs and is
    // skipped by single-flight (never answered).
    await seed(client, scope, [{ __delayMs: 1500 }, round('reply to the first')]);
    const m1 = await client.postUserMessage('first');
    const m2 = await client.postUserMessage('second, during the generation');
    await vi.waitFor(async () => {
      for (const rid of sub.resourceIds) {
        const snap = await client.resources.read('Message', rid) as Snapshot | null;
        if (snap && deriveKind(snap.meta.actingToken) === 'agent' && (snap.value as { replyTo?: string }).replyTo === m1) return;
      }
      throw new Error('no reply yet');
    }, { timeout: 15000 });
    void m2;

    // The third turn's history: m1, its reply, then m2 — and NOTHING after m2 (the third
    // message is the trigger and is excluded). Mutation: project only replied-to pairs →
    // m2 vanishes → red.
    await seed(client, scope, [round('third reply')]);
    await postAndWait(client, scope, sub, 'third');
    const { system } = await lastTurnPrompt(client, scope);
    const history = historyOf(system)!;
    const lines = history.split('\n').slice(1); // drop the header
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('- human 1: first');
    expect(lines[1]).toMatch(/^- agent: reply to the first \[stop=no-tool-calls rounds=1 sourceCommit=[0-9a-f]{7}\]$/);
    expect(lines[2]).toBe('- human 1: second, during the generation');

    client[Symbol.dispose]();
  });
});
