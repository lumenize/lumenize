/**
 * THE codegen trigger (collapse Phase 4): the committed human `Message` starts the turn,
 * and the DAG `write` check on that commit is the ONLY door.
 *
 *  - T1 the trigger e2e: a real `postUserMessage` commit → the Galaxy's commit hook runs
 *    a (scripted) generation → the agent reply lands durably, `replyTo`-linked,
 *    Nebula-attributed, observed on the SUBSCRIPTION (the product's own shape).
 *  - T2 single-flight: two human Messages committed during ONE generation → exactly one
 *    reply; the second sits in the thread untriggered.
 *  - T3 the human-only predicate, BOUNDED: one human message yields exactly one agent
 *    message past an idle window (never asserted by watching for non-termination —
 *    dropping the predicate makes Nebula answer itself).
 *  - T4 the DAG door: an ungranted member's post is REFUSED at the DAG (the MESSAGE is
 *    matched — a boundary refusal and a DAG refusal are indistinguishable as booleans)
 *    with zero trigger markers (no AI spend), alongside the positive control (the same
 *    member reaches the query surface; the denial is DISCLOSED, ADR-008).
 *  - T5a–d the container WARM LATCH (T5's successor — the fork is gone): the turn's first
 *    write warms, before the build cycle; the hint warms a no-tool-calls turn and a
 *    teardown follows; a verdict landing after the turn warms nothing; hint plus write is
 *    still one warm. T8: the reply is the model's own text, the fixed strings only when
 *    it is empty.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { DEFAULT_CHAT_ID, CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, deriveKind, ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { NEBULA_SUB } from '@lumenize/nebula-auth';
import { universeAdminClient, foundAndLogin, createSubject, createInvitedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const uniqueChatScope = () => `ctr-${crypto.randomUUID().slice(0, 8)}.app`;
const chatQuery = {
  queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID,
};

function devClient(scope: string, email = 'admin@example.com') {
  return universeAdminClient(
    NebulaClientTest, new Browser(), scope, scope, email, CHAT_MESSAGE_ONTOLOGY_VERSION,
    { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
  );
}

/** One OpenAI-shaped text-only model round (→ the loop's safe no-tool-calls stop). */
const round = (content: string) => ({
  choices: [{ message: { content, reasoning_content: '', tool_calls: [] } }],
});

async function seedScript(client: NebulaClientTest, scope: string, script: unknown[]) {
  client.callGalaxySeedChatScript(scope, script);
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));
  expect(client.lastError).toBeUndefined();
}

/** The agent replies currently in the thread, replyTo → snapshot. */
async function agentReplies(client: NebulaClientTest, ids: readonly string[]): Promise<Map<string, Snapshot>> {
  const out = new Map<string, Snapshot>();
  for (const id of ids) {
    const snap = await client.resources.read('Message', id) as Snapshot | null;
    if (!snap) continue;
    if (deriveKind(snap.meta.actingToken) === 'agent') {
      out.set((snap.value as { replyTo?: string }).replyTo ?? '', snap);
    }
  }
  return out;
}

type SinkEntry = { namespace: string; level: string; message: string; data?: Record<string, unknown> };
let entries: SinkEntry[] = [];
beforeEach(() => { entries = []; setDebugSink((e) => entries.push(e as unknown as SinkEntry)); });
afterEach(() => clearDebugSink());

describe('the commit IS the codegen trigger (Phase 4)', () => {
  it('T1: a real postUserMessage commit triggers a generation; the reply lands durably, replyTo-linked, Nebula-attributed', async () => {
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);
    await seedScript(client, scope, [round('Here is your change.')]);

    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;
    const posted = await client.postUserMessage('add a counter');

    await vi.waitFor(async () => {
      const replies = await agentReplies(client, sub.resourceIds);
      expect(replies.get(posted)).toBeTruthy();
    }, { timeout: 15000 });
    const reply = (await agentReplies(client, sub.resourceIds)).get(posted)!;
    expect((reply.value as { content?: string }).content).toBe('Here is your change.');
    expect(reply.meta.actingToken.act).toMatchObject({ sub: NEBULA_SUB, profileId: NEBULA_SUB });
    // The turn ran under the POSTER's own authority (the participant model): the
    // reply's subject IS the poster.
    expect(reply.meta.actingToken.sub).toBe(client.claims.sub);

    client[Symbol.dispose]();
  });

  it('T2: SINGLE-FLIGHT — two human Messages during one generation yield exactly ONE reply', async () => {
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);
    // Rounds for TWO turns (so the MUTATED world — latch dropped — can generate twice
    // and red the exactly-one assertion): a slow first generation spanning both commits.
    await seedScript(client, scope, [
      { __delayMs: 1500 }, round('reply one'),
      round('reply two'),
    ]);

    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;
    const m1 = await client.postUserMessage('first');
    const m2 = await client.postUserMessage('second (during the generation)');

    // The first turn completes…
    await vi.waitFor(async () => {
      const replies = await agentReplies(client, sub.resourceIds);
      expect(replies.get(m1)).toBeTruthy();
    }, { timeout: 15000 });
    // …then, past an idle window, there is STILL exactly one reply: m2 fired nothing
    // (the skipped message sits in the thread; a participant re-prompts).
    await new Promise((r) => setTimeout(r, 1200));
    const replies = await agentReplies(client, sub.resourceIds);
    expect(replies.size).toBe(1);
    expect(replies.get(m2)).toBeUndefined();

    client[Symbol.dispose]();
  });

  it('T3: the human-only predicate, BOUNDED — an agent Message committed with the latch FREE fires nothing', async () => {
    // ⚠️ The shape matters: INSIDE a turn the single-flight latch already blocks the
    // self-trigger (measured — dropping the predicate alone cannot red the in-turn
    // path), so the predicate's LIVE case is an agent commit landing while no turn is
    // in flight: a deadline-abandoned turn's late commit, or any direct agent commit.
    // Drive that exact shape and assert BOUNDED (never by watching for
    // non-termination): the thread past an idle window holds ONLY the agent message.
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);
    // A round available ON PURPOSE: with the predicate dropped, the latch-free agent
    // commit triggers a generation that CAN complete — that is what reds the count.
    await seedScript(client, scope, [round('self-answer'), round('self-answer 2')]);

    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;
    const a1 = crypto.randomUUID();
    client.callGalaxyCommitAgent(scope, DEFAULT_CHAT_ID, a1, 'agent says something', CHAT_NODE_ID, crypto.randomUUID());
    await vi.waitFor(() => expect(client.callCompleted).toBe(true));
    expect(client.lastError).toBeUndefined();
    await vi.waitFor(() => expect(sub.resourceIds).toContain(a1));
    await new Promise((r) => setTimeout(r, 1200)); // the idle window
    expect(sub.resourceIds).toHaveLength(1); // the agent message alone — no self-answer

    client[Symbol.dispose]();
  });

  it('T4: the DAG door — an ungranted member is refused at the DAG (message matched), zero AI spend; the denial is DISCLOSED', async () => {
    const scope = uniqueChatScope();
    const { client: admin, accessToken } = await devClient(scope);
    // Put REAL content at the chat node first (the admin's own turn), so the member's
    // denial below withholds something that exists — an empty node reports nothing.
    await seedScript(admin, scope, [round('seeded reply')]);
    using adminSub = admin.resources.subscribeQuery(chatQuery); await adminSub.ready;
    const seeded = await admin.postUserMessage('seed the thread');
    await vi.waitFor(async () => {
      expect((await agentReplies(admin, adminSub.resourceIds)).get(seeded)).toBeTruthy();
    }, { timeout: 15000 });

    // A real non-admin member at the scope: passage yes, session-node grant NO.
    const adminBrowser = new Browser();
    await foundAndLogin(adminBrowser, scope, 'admin@example.com', scope);
    await createSubject(adminBrowser, scope, accessToken, 'member@example.com');
    const { client: member } = await createInvitedClient(
      NebulaClientTest, new Browser(), scope, scope, 'member@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION,
      { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
    );

    // POSITIVE CONTROL first: the member REACHES the chat query surface (passage +
    // the subscribe op are theirs) — and the chat node's denial is DISCLOSED there
    // (ADR-008: the denied-node set is always disclosed, never hidden).
    using memberSub = member.resources.subscribeQuery(chatQuery);
    await memberSub.ready;
    expect(memberSub.deniedNodes.length).toBeGreaterThan(0);

    // THE DOOR: the post is refused at the DAG — match the MESSAGE (a boundary refusal
    // and a DAG refusal are indistinguishable as booleans).
    entries = [];
    await expect(member.postUserMessage('let me in')).rejects.toThrow(/permission/i);
    // No AI spend: zero trigger markers (asserted as a marker COUNT, not silence).
    const triggerMarkers = entries.filter((e) => e.namespace === 'nebula.Galaxy.trigger');
    expect(triggerMarkers).toHaveLength(0);

    admin[Symbol.dispose](); member[Symbol.dispose]();
  });

  // ── T5 (retired 2026-09-05): the classifier FORK — a plain question took an answer path
  // with no tools and ZERO warms. The fork is deleted (one assembly, every tool, the model
  // decides); the container warm is STRUCTURAL — the turn's first write — and the
  // classifier's last job, an earlier warm hint, was deleted on 2026-09-06 after five real
  // turns showed the write warm hiding the cold start on its own. The successors below
  // assert the latch, as MARKER ORDER: one warm per turn however many writes, a teardown
  // on every turn, and no warm at all on a turn that never writes.

  /** Marker indices, in emission order, for the namespaces the latch tests read — filtered
   *  by the Galaxy's `instanceName`, the discriminator every marker carries (`testing.md`),
   *  so a marker from another scope's turn cannot enter a window. Order is then asserted
   *  WITHIN one Galaxy's markers, which is the property under test. (`testing.md`'s "call
   *  order MUST NOT be relied on" is about telling one unit's markers from another's, which
   *  the stamp does; the order inside one turn is causal — the warm fires before the write it
   *  wraps, the cycle after the build call, the teardown in the `finally` — and is the thing
   *  asserted, never a stand-in for a count.) */
  const markerIndices = (scope: string, ns: string, message?: string) =>
    entries.map((e, i) => (e.namespace === ns && e.data?.instanceName === scope && (message === undefined || e.message === message) ? i : -1)).filter((i) => i >= 0);
  const warmMarkers = (scope: string) => entries.filter((e) => e.namespace === 'nebula.Galaxy.warm' && e.data?.instanceName === scope);
  const WRITE_THEN_BUILD = [
    { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
      { id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/App.vue', content: '<template><p>x</p></template>' }) } },
    ] } }] },
    { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
      { id: 'b1', type: 'function', function: { name: 'build', arguments: '{}' } },
    ] } }] },
    { choices: [{ message: { content: 'Wrote and built it.', reasoning_content: '', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'mark_complete', arguments: '{}' } },
    ] } }] },
  ];

  it('T5a: the FIRST WRITE warms — exactly one warm marker before the build cycle starts', async () => {
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);
    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;
    await seedScript(client, scope, WRITE_THEN_BUILD);
    entries = [];
    const q = await client.postUserMessage('build it');
    await vi.waitFor(async () => {
      expect((await agentReplies(client, sub.resourceIds)).get(q)).toBeTruthy();
    }, { timeout: 15000 });
    // Mutation: remove the write warm → zero markers. Remove the latch → two (T5d).
    const warms = warmMarkers(scope);
    expect(warms).toHaveLength(1);
    expect(warms[0]!.data).toMatchObject({ instanceName: scope });
    const [warmAt] = markerIndices(scope, 'nebula.Galaxy.warm');
    const [cycleAt] = markerIndices(scope, 'nebula.Galaxy.build', 'cycle start');
    expect(cycleAt).toBeGreaterThan(warmAt!);
    // The reply carries the record on every turn now — there is no fork to leave it off.
    const reply = (await agentReplies(client, sub.resourceIds)).get(q)!;
    expect('codegen' in (reply.value as Record<string, unknown>)).toBe(true);

    client[Symbol.dispose]();
  });

  it('T5b: a no-tool-calls turn never warms, and its teardown still runs exactly once — every turn owes one', async () => {
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);
    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;
    await seedScript(client, scope, [round('It already does that.')]);
    entries = [];
    const q = await client.postUserMessage('does it already do that?');
    await vi.waitFor(async () => {
      expect((await agentReplies(client, sub.resourceIds)).get(q)).toBeTruthy();
    }, { timeout: 15000 });
    // Mutation: remove the `finally` teardown → no marker; the turn's `finally` is the only
    // destroy on a turn with no build. Only a write warms, so a question's turn has none.
    await vi.waitFor(() => expect(markerIndices(scope, 'nebula.Galaxy.teardown')).toHaveLength(1), { timeout: 5000 });
    expect(warmMarkers(scope)).toHaveLength(0);
    // …and the reply is the model's own text (the single path answers a question).
    const reply = (await agentReplies(client, sub.resourceIds)).get(q)!;
    expect((reply.value as { content?: string }).content).toBe('It already does that.');

    client[Symbol.dispose]();
  });

  it('T5d: TWO writes in one turn — the latch admits exactly one warm', async () => {
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);
    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;
    const secondWrite = { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
      { id: 'w2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/nebula.ts', content: 'export const x = 1;' }) } },
    ] } }] };
    await seedScript(client, scope, [WRITE_THEN_BUILD[0], secondWrite, WRITE_THEN_BUILD[1], WRITE_THEN_BUILD[2]]);
    entries = [];
    const q = await client.postUserMessage('build it again');
    await vi.waitFor(async () => {
      expect((await agentReplies(client, sub.resourceIds)).get(q)).toBeTruthy();
    }, { timeout: 15000 });
    expect(warmMarkers(scope)).toHaveLength(1); // mutation: remove the latch → two

    client[Symbol.dispose]();
  });

  it('T9: ONE assembly for a plain question — the current source rides the user message and the FULL tool set rides the call', async () => {
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);
    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;
    // Drain the captures, then a question the model answers in prose (no tools used).
    client.callGalaxyTakeSeenMessages(scope); await vi.waitFor(() => expect(client.callCompleted).toBe(true));
    client.callGalaxyTakeSeenToolNames(scope); await vi.waitFor(() => expect(client.callCompleted).toBe(true));
    await seedScript(client, scope, [round('It shows a warming-up placeholder.')]);
    const q = await client.postUserMessage('what does it do so far?');
    await vi.waitFor(async () => {
      expect((await agentReplies(client, sub.resourceIds)).get(q)).toBeTruthy();
    }, { timeout: 15000 });
    client.callGalaxyTakeSeenMessages(scope); await vi.waitFor(() => expect(client.callCompleted).toBe(true));
    const calls = client.lastResult as Array<Array<{ role: string; content: string }>>;
    expect(calls).toHaveLength(1); // one model round for a prose answer
    // Mutation: withhold the current source from the assembly → red. The seed App.vue is
    // what a fresh Galaxy holds, so its text is the witness.
    expect(calls[0]![1]!.content).toContain('Your app is warming up…');
    expect(calls[0]![1]!.content).toContain('User request (human 1): what does it do so far?');
    client.callGalaxyTakeSeenToolNames(scope); await vi.waitFor(() => expect(client.callCompleted).toBe(true));
    const tools = client.lastResult as string[][];
    // The full tool set on a question's turn — no answer fork strips it (the deleted
    // `#answerTurn` sent no tools at all).
    expect(tools).toEqual([['read_file', 'write_file', 'edit_file', 'build', 'mark_complete']]);

    client[Symbol.dispose]();
  });

  it('T8: the reply is the model\'s own final text on every stop, and the fixed string only when it is empty', async () => {
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);
    using sub = client.resources.subscribeQuery(chatQuery); await sub.ready;
    const complete = (content: string, applied: boolean) => [
      ...(applied ? [{ choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
        { id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/App.vue', content: `<template><p>${content.length}</p></template>` }) } },
      ] } }] }] : []),
      { choices: [{ message: { content, reasoning_content: '', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'mark_complete', arguments: '{}' } },
      ] } }] },
    ];
    const contentOf = async (q: string) => (((await agentReplies(client, sub.resourceIds)).get(q)!).value as { content?: string }).content;
    const turn = async (script: unknown[], text: string) => {
      await seedScript(client, scope, script);
      const q = await client.postUserMessage(text);
      await vi.waitFor(async () => { expect((await agentReplies(client, sub.resourceIds)).get(q)).toBeTruthy(); }, { timeout: 15000 });
      return contentOf(q);
    };
    // Mutation: keep the hardwired "Updated the preview." → the first two red.
    expect(await turn(complete('Added the counter you asked for.', true), 'add a counter')).toBe('Added the counter you asked for.');
    expect(await turn(complete('Nothing to change here.', false), 'anything to fix?')).toBe('Nothing to change here.');
    expect(await turn(complete('', true), 'add another')).toBe('Updated the preview.');
    expect(await turn(complete('', false), 'and now?')).toBe('Done — no changes.');
    expect(await turn([round('Just chatting.')], 'hi')).toBe('Just chatting.');
    // The failure stops too — "every stop": a `loop-detected` turn (identical text twice,
    // each round with a distinct write so only the text detector trips) replies with its
    // last text, not the fixed apology. Mutation: hardwire the failure branch → red.
    const looped = [
      { choices: [{ message: { content: 'Still tweaking it.', reasoning_content: '', tool_calls: [
        { id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/App.vue', content: '<template><p>a</p></template>' }) } },
      ] } }] },
      { choices: [{ message: { content: 'Still tweaking it.', reasoning_content: '', tool_calls: [
        { id: 'w2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/App.vue', content: '<template><p>b</p></template>' }) } },
      ] } }] },
    ];
    expect(await turn(looped, 'keep going')).toBe('Still tweaking it.');
    const loopedSilent = [
      { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
        { id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/App.vue', content: '<template><p>c</p></template>' }) } },
      ] } }] },
      { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
        { id: 'w2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/App.vue', content: '<template><p>c</p></template>' }) } },
      ] } }] },
    ];
    expect(await turn(loopedSilent, 'and again')).toBe("I couldn't finish cleanly — see the thought process.");

    client[Symbol.dispose]();
  });

  it('T7: RECONNECT is a DISTINCT path from reload — the in-heap walk re-registers the thread query', async () => {
    // The RELOAD path (a fresh heap rebuilding from the durable thread) is child3-e2e's
    // late-joiner test; THIS is the other path: the same heap's re-subscribe walk after a
    // reconnect. The idempotent end-state would hide a broken walk (testing.md), so the
    // server is given AMNESIA first — only the walk can restore fanout.
    const scope = uniqueChatScope();
    const { client: a } = await devClient(scope);
    const { client: b } = await devClient(scope);
    await seedScript(a, scope, []); // no generation in this test — raw posts only
    using subA = a.resources.subscribeQuery(chatQuery); await subA.ready;

    // Baseline: A receives B's post via the fanout.
    await seedScript(b, scope, []);
    const m1 = crypto.randomUUID();
    let out = await b.resources.transaction({
      [m1]: { op: 'create', typeName: 'Message', nodeId: CHAT_NODE_ID, value: { chat: DEFAULT_CHAT_ID, content: 'one' } },
    });
    expect(out.kind).toBe('committed');
    await vi.waitFor(() => expect(subA.resourceIds).toContain(m1));

    // SERVER AMNESIA, then the walk. Without the walk (mutation: gut #resubscribeAll's
    // query loop) the next post never reaches A.
    a.callGalaxyClearQuerySubscribers(scope);
    await vi.waitFor(() => expect(a.callCompleted).toBe(true));
    a._resubscribeAllForTest();

    const m2 = crypto.randomUUID();
    out = await b.resources.transaction({
      [m2]: { op: 'create', typeName: 'Message', nodeId: CHAT_NODE_ID, value: { chat: DEFAULT_CHAT_ID, content: 'two' } },
    });
    expect(out.kind).toBe('committed');
    await vi.waitFor(() => expect(subA.resourceIds).toContain(m2), { timeout: 10000 });

    a[Symbol.dispose](); b[Symbol.dispose]();
  });

  it('T6: a Message committed at a NON-chat node fires NO trigger (the nodeId operand)', async () => {
    const scope = uniqueChatScope();
    const { client } = await devClient(scope);
    await seedScript(client, scope, [round('should never generate')]);

    const nodeId = await client.orgTree.createNode(crypto.randomUUID(), ROOT_NODE_ID, 'side', 'Side');
    entries = [];
    const out = await client.resources.transaction({
      [crypto.randomUUID()]: {
        op: 'create', typeName: 'Message', nodeId,
        value: { chat: DEFAULT_CHAT_ID, content: 'off-node note' },
      },
    });
    expect(out.kind).toBe('committed');
    await new Promise((r) => setTimeout(r, 800));
    expect(entries.filter((e) => e.namespace === 'nebula.Galaxy.trigger')).toHaveLength(0);

    client[Symbol.dispose]();
  });
});
