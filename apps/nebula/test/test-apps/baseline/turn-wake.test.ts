/**
 * A turn an eviction cut off continues when anything next constructs the Galaxy, or says in a line
 * of ours that it cannot, and every turn that has a row ends in an agent `Message`.
 *
 * vitest-plugin with the model scripted, for what the real model and a real eviction cannot be made
 * to do on cue: a reply held at a chosen round, a build held while the Galaxy is reset, a deadline a
 * few seconds long. A reset is `ctx.abort()`, which this lane survives with storage kept, as a
 * deployed eviction does, and which ends whatever the Galaxy held in memory. Every person here logs
 * in through the real Registry (ADR-009 rung 2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import type { Snapshot, QueryReadResult } from '@lumenize/resources';
import { CHAT_MESSAGE_ONTOLOGY_VERSION, MESSAGES_NODE_ID, DEFAULT_CHAT_ID, deriveKind } from '@lumenize/nebula';
import type { Galaxy } from '@lumenize/nebula';
import { roundsOf } from '../../../src/participants';
import { INTERRUPTED_CALL_ERROR, INTERRUPTED_ROUND_NOTE, type StoredRound } from '../../../src/codegen-loop';
import { TURN_ROW_KEY } from '../../../src/galaxy';
import { universeAdminClient, createInvitedClient } from '../../test-helpers';
import { StudioClientTest } from './index';
import type { GalaxyTest } from './index';

const V = CHAT_MESSAGE_ONTOLOGY_VERSION;
const uniqueGalaxy = () => `tw-${crypto.randomUUID().slice(0, 8)}.app`;
const email = (tag: string) => `${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const chatQuery = { typeName: 'Message', filter: { chat: DEFAULT_CHAT_ID } };
const toolCall = (name: string, args: unknown, id: string) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (calls: unknown[], content = '') => ({ choices: [{ message: { content, reasoning_content: '', tool_calls: calls } }] });
const INTERRUPTED_LINE = 'I was interrupted twice at the same step, so I stopped. What I saved is kept: ask again and I will carry on from it.';
const DEADLINE_LINE = 'This ran past the time I am allowed, so I stopped. What I saved is kept: ask again and I will carry on from it.';
const TURN_FAILED_LINE = 'Something went wrong on my side, so I stopped. What I saved is kept: ask again and I will carry on from it.';

type Row = { messageSnapshot: { id: string; validFrom: string }; message: string; sourceCommit?: string; interrupted: number[] };
type Codegen = { stop: string; rounds: number; appliedPaths: string[]; sourceCommit?: string };

const entries: Array<{ namespace: string; message: string; data?: Record<string, unknown> }> = [];
beforeEach(() => { entries.length = 0; setDebugSink((entry) => { entries.push(entry as never); }); });
afterEach(() => clearDebugSink());
const lines = (scope: string, namespace: string, message: string) =>
  entries.filter((e) => e.namespace === namespace && e.message === message && e.data?.instanceName === scope);
const held = (scope: string, what: 'model call held' | 'build held', call?: number) => vi.waitFor(() => expect(lines(scope, 'nebula.GalaxyTest.hold', what)
  .some((e) => call === undefined || e.data?.call === call)).toBe(true), { timeout: 15_000 });
const woke = (scope: string) => lines(scope, 'nebula.Galaxy.wake', 'woke');

/** Reset the Galaxy, as an eviction would: storage stays, and what it held in memory goes. */
const reset = (scope: string): Promise<void> => (runInDurableObject as any)(env.GALAXY.getByName(scope), (_i: unknown, ctx: DurableObjectState) => {
  ctx.abort('an eviction, in a test');
}).catch(() => { /* the abort rejects the call that made it */ });

/** An app's admin in Studio on its Galaxy's page, with the chat ontology installed and a chat subscription. */
async function app() {
  const scope = uniqueGalaxy();
  const { client: admin } = await universeAdminClient(
    StudioClientTest, new Browser(), scope, scope, email('admin'), V,
    { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
  );
  const probe = async (remote: (g: any) => unknown): Promise<any> => {
    await vi.waitFor(() => expect(admin.connectionState).toBe('connected'), { timeout: 15_000 });
    return admin.lmz.callAsync('GALAXY', scope, remote(admin.ctn<GalaxyTest>()) as never);
  };
  const thread = admin.resources.subscribeQuery(chatQuery);
  await thread.ready;
  const agentMessages = async (): Promise<Array<Snapshot & { id: string }>> => {
    const out: Array<Snapshot & { id: string }> = [];
    for (const id of thread.resourceIds) {
      const snap = await admin.resources.read('Message', id) as Snapshot | null;
      if (snap && deriveKind(snap.meta.recordedClaims) === 'agent') out.push({ ...snap, id });
    }
    return out;
  };
  /** The agent message that replies to `post`, once it has committed. */
  const replyTo = async (post: string, timeout = 20_000): Promise<Snapshot & { id: string }> => {
    let found: (Snapshot & { id: string }) | undefined;
    await vi.waitFor(async () => {
      found = (await agentMessages()).find((m) => (m.value as { replyTo?: string }).replyTo === post);
      expect(found).toBeDefined();
    }, { timeout });
    return found!;
  };
  const rounds = async (message: string): Promise<StoredRound[]> => ((await probe((g) => g.resources.query(V, roundsOf(message)))) as QueryReadResult)
    .snapshots.map((s) => s.value as StoredRound).sort((x, y) => x.index - y.index);
  const row = (): Promise<Row | undefined> => probe((g) => g.turnRowForTest());
  const calls = (): Promise<number> => probe((g) => g.modelCallsForTest());
  const source = (path: string): Promise<string> => probe(() => admin.ctn<Galaxy>().readSource(path));
  /** A collaborator who can post, on the Galaxy's page in Studio. */
  const collaborator = async () => {
    const address = email('collab');
    expect(await probe(() => admin.ctn<Galaxy>().resources.invite(V, MESSAGES_NODE_ID, [{ email: address, tier: 'write' }])))
      .toEqual({ accepted: 1, errors: [] });
    return (await createInvitedClient(StudioClientTest, new Browser(), scope, scope, address, V,
      { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope })).client;
  };
  return {
    scope, admin, probe, thread, agentMessages, replyTo, rounds, row, calls, source, collaborator,
    dispose: () => { thread[Symbol.dispose](); admin[Symbol.dispose](); },
  };
}

/** Rounds 1 to 3, then round 4's model call: the turn the first tests cut off there. */
const FOUR_ROUNDS = [
  reply([toolCall('read_file', { path: 'src/App.vue' }, 'r1')], 'Reading the app.'),
  reply([toolCall('write_file', { path: 'src/App.vue', content: '<template><p>rewritten</p></template>\n' }, 'w1')], 'Rewriting it.'),
  reply([toolCall('read_file', { path: 'AGENTS.md' }, 'r2')], 'Checking the conventions.'),
];

/** Post a request whose turn runs rounds 1 to 3 and is held at round 4's model call, the 4th. */
async function heldAtRound4(a: Awaited<ReturnType<typeof app>>, rest: unknown[]): Promise<string> {
  await a.probe((g) => g.seedChatScriptForTest([...FOUR_ROUNDS, ...rest]));
  await a.probe((g) => g.holdModelCallForTest(4));
  const posted = await a.admin.postUserMessage('Rewrite the app.');
  await held(a.scope, 'model call held', 4);
  return posted;
}

describe('a turn cut off at a model call', { timeout: 120_000 }, () => {
  // MUTATIONS: record the cut round on the row after the repeated call starts → the reset below
  // finds `interrupted` empty; send the file as it reads now, not by its blob → the round-1 tool
  // message holds the rewrite; rebuild without the note → the request does not end in it.
  it('makes that call again once the Galaxy is constructed again, sending each file as the model first read it', async () => {
    const a = await app();
    const original = await a.source('src/App.vue');
    const posted = await heldAtRound4(a, [reply([toolCall('mark_complete', {}, 'c1')], 'Rewrote the app.')]);
    await a.probe((g) => g.takeSeenMessagesForTest());
    await a.probe((g) => g.holdModelCallForTest(5));
    await reset(a.scope);
    await held(a.scope, 'model call held', 5);

    expect((await a.row())!.interrupted).toEqual([4]);
    expect(await a.calls()).toBe(5);
    const [request] = await a.probe((g) => g.takeSeenMessagesForTest()) as Array<Array<{ role: string; tool_call_id?: string; content: string }>>;
    const readFirst = request!.find((m) => m.role === 'tool' && m.tool_call_id === 'r1')!;
    expect((JSON.parse(readFirst.content) as { content: string }).content).toBe(original);
    expect(request!.at(-1)).toEqual({ role: 'user', content: INTERRUPTED_ROUND_NOTE });

    await a.probe((g) => g.releaseForTest());
    const message = await a.replyTo(posted);
    expect((message.value as { content: string }).content).toBe('Rewrote the app.');
    expect(await a.row()).toBeUndefined();
    expect(woke(a.scope)).toHaveLength(1);
    a.dispose();
  });

  // MUTATIONS: end the turn at any second interruption, whatever its round → the next test fails;
  // never end it → a third call is made for round 4.
  it('ends in a line of ours, keeping the turn\'s summary, when the same call is cut off twice', async () => {
    const a = await app();
    const posted = await heldAtRound4(a, [reply([toolCall('mark_complete', {}, 'c1')], 'never sent')]);
    const before = (await a.row())!;
    await a.probe((g) => g.holdModelCallForTest(5));
    await reset(a.scope);
    await held(a.scope, 'model call held', 5);
    await a.probe((g) => g.holdModelCallForTest(6));
    await reset(a.scope);

    const message = await a.replyTo(posted);
    const value = message.value as { content: string; codegen: Codegen };
    expect(value.content.endsWith(INTERRUPTED_LINE)).toBe(true);
    expect([value.codegen.stop, value.codegen.rounds, value.codegen.appliedPaths, value.codegen.sourceCommit])
      .toEqual(['interrupted', 3, ['src/App.vue'], before.sourceCommit]);
    expect(await a.row()).toBeUndefined();
    expect(await a.calls()).toBe(5);
    expect(woke(a.scope)).toHaveLength(2);
    a.dispose();
  });

  it('goes on past a second interruption at a later round, and commits the model\'s own message', async () => {
    const a = await app();
    const posted = await heldAtRound4(a, [
      reply([toolCall('read_file', { path: 'src/App.vue' }, 'r3')], 'Reading it again.'),
      reply([toolCall('write_file', { path: 'src/notes.txt', content: 'round five' }, 'w2')], 'Taking a note.'),
      reply([toolCall('mark_complete', {}, 'c1')], 'Done, twice over.'),
    ]);
    await a.probe((g) => g.holdModelCallForTest(7));
    await reset(a.scope);
    await held(a.scope, 'model call held', 7);
    await a.probe((g) => g.holdModelCallForTest(8));
    await reset(a.scope);
    await held(a.scope, 'model call held', 8);
    expect((await a.row())!.interrupted).toEqual([4, 6]);

    await a.probe((g) => g.releaseForTest());
    const message = await a.replyTo(posted);
    expect((message.value as { content: string; codegen: Codegen }).content).toBe('Done, twice over.');
    expect((message.value as { codegen: Codegen }).codegen.rounds).toBe(6);
    a.dispose();
  });
});

describe('a turn cut off while one of its calls ran', { timeout: 120_000 }, () => {
  // MUTATION: run the cut call again → the replacement, which holds its own anchor, appears twice.
  it('answers that call as interrupted and never runs it again, and calls the model for the next round', async () => {
    const a = await app();
    await a.probe((g) => g.seedChatScriptForTest([
      reply([toolCall('write_file', { path: 'src/App.vue', content: 'hello world' }, 'w1')], 'Writing.'),
      reply([toolCall('edit_file', { path: 'src/App.vue', anchor: 'hello', replacement: 'hello hello' }, 'e1'), toolCall('build', {}, 'b1')], 'Editing, then building.'),
      reply([toolCall('mark_complete', {}, 'c1')], 'Edited once.'),
    ]));
    await a.probe((g) => g.holdNextBuildForTest());
    const posted = await a.admin.postUserMessage('Say hello twice.');
    await held(a.scope, 'build held');
    const { message } = (await a.row())!;
    await a.probe((g) => g.holdModelCallForTest(3));
    await reset(a.scope);
    await held(a.scope, 'model call held', 3);

    expect(await a.source('src/App.vue')).toBe('hello hello world');
    expect((await a.row())!.interrupted).toEqual([]);
    const round2 = (await a.rounds(message))[1]!;
    expect(round2.calls.map((c) => [c.error, c.result === undefined])).toEqual([[undefined, false], [INTERRUPTED_CALL_ERROR, true]]);
    expect(await a.calls()).toBe(3);

    await a.probe((g) => g.releaseForTest());
    expect(((await a.replyTo(posted)).value as { content: string }).content).toBe('Edited once.');
    a.dispose();
  });

  // MUTATION: answer every call with no outcome as interrupted → the write after the build never runs.
  it('runs the calls after the one that was cut off', async () => {
    const a = await app();
    await a.probe((g) => g.seedChatScriptForTest([
      reply([toolCall('read_file', { path: 'AGENTS.md' }, 'r1'), toolCall('build', {}, 'b1'), toolCall('write_file', { path: 'src/after.txt', content: 'after the build' }, 'w1')], 'Three calls.'),
      reply([toolCall('mark_complete', {}, 'c1')], 'Wrote after the build.'),
    ]));
    await a.probe((g) => g.holdNextBuildForTest());
    const posted = await a.admin.postUserMessage('Read, build, then write.');
    await held(a.scope, 'build held');
    const { message } = (await a.row())!;
    await reset(a.scope);

    expect(((await a.replyTo(posted)).value as { content: string }).content).toBe('Wrote after the build.');
    expect(await a.source('src/after.txt')).toBe('after the build');
    const round1 = (await a.rounds(message))[0]!;
    expect(round1.calls.map((c) => c.error)).toEqual([undefined, INTERRUPTED_CALL_ERROR, undefined]);
    a.dispose();
  });
});

describe('a turn cut off at its closing step', { timeout: 120_000 }, () => {
  /** A turn that finishes in round 1 while a second post arrives, held at its closing call, the 2nd. */
  async function heldAtClosing(a: Awaited<ReturnType<typeof app>>, closing: unknown[]) {
    await a.probe((g) => g.seedChatScriptForTest([reply([toolCall('mark_complete', {}, 'c1')], 'First, done.'), ...closing]));
    await a.probe((g) => g.holdModelCallForTest(1));
    const first = await a.admin.postUserMessage('The first thing.');
    await held(a.scope, 'model call held', 1);
    const second = await a.admin.postUserMessage('And a second thing.');
    await a.probe((g) => g.holdModelCallForTest(2));
    await a.probe((g) => g.releaseForTest(1));
    await held(a.scope, 'model call held', 2);
    return { first, second };
  }

  // MUTATION: skip the closing step on a wake → the message answers only the first post.
  it('makes the closing call again, once, and commits one message answering both posts', async () => {
    const a = await app();
    const { first, second } = await heldAtClosing(a, []);
    await a.probe((g) => g.seedChatScriptForTest([reply([toolCall('mark_complete', { answers: [second] }, 'c2')], 'Both, done.')]));
    await a.probe((g) => g.holdModelCallForTest(3));
    await reset(a.scope);
    await held(a.scope, 'model call held', 3);
    expect((await a.row())!.interrupted).toEqual([2]);
    expect(await a.calls()).toBe(3);

    await a.probe((g) => g.releaseForTest());
    const message = await a.replyTo(first);
    // `answers` names every post the message answers, its `replyTo` among them.
    expect((message.value as { content: string; answers?: string[] }).answers).toEqual([first, second]);
    expect(await a.agentMessages()).toHaveLength(1);
    a.dispose();
  });

  // MUTATION: make the closing call again whatever the row says → a fourth call closes the turn.
  it('commits the turn\'s own last reply when the closing call is cut off twice, and the arrived post waits', async () => {
    const a = await app();
    const { first, second } = await heldAtClosing(a, []);
    await a.probe((g) => g.holdModelCallForTest(3));
    await reset(a.scope);
    await held(a.scope, 'model call held', 3);
    // The decision the woken turn ends in is held too: nothing is scripted for it.
    await a.probe((g) => g.holdModelCallForTest(4));
    await reset(a.scope);

    const message = await a.replyTo(first);
    expect((message.value as { content: string; answers?: string[] }).content).toBe('First, done.');
    expect((message.value as { answers?: string[] }).answers).toEqual([first]);
    expect(await a.probe((g) => g.waitingPostsForTest())).toEqual([second]);
    a.dispose();
  });
});

describe('a turn that had ended when the Galaxy went away', { timeout: 120_000 }, () => {
  // MUTATION: make a model call on every wake → the count moves.
  it('commits its message with no model call when no closing step is due', async () => {
    const a = await app();
    await a.probe((g) => g.seedChatScriptForTest([reply([toolCall('mark_complete', {}, 'c1')], 'All done.')]));
    await a.probe((g) => g.holdNextAgentCommitForTest());
    const posted = await a.admin.postUserMessage('Finish quickly.');
    await vi.waitFor(() => expect(lines(a.scope, 'nebula.GalaxyTest.commit', 'agent commit held')).toHaveLength(1), { timeout: 15_000 });
    await reset(a.scope);

    expect(((await a.replyTo(posted)).value as { content: string }).content).toBe('All done.');
    expect(await a.calls()).toBe(1);
    expect(await a.row()).toBeUndefined();
    a.dispose();
  });

  // MUTATION: drop the check for a committed message → the wake runs the seeded turn and calls the model.
  it('deletes a row beside its committed message, and does nothing else', async () => {
    const a = await app();
    const posted = await a.admin.postUserMessage('Answered already.');
    const snap = await a.admin.resources.read('Message', posted) as Snapshot;
    const message = crypto.randomUUID();
    await a.probe((g) => g.commitAgentForTest(DEFAULT_CHAT_ID, message, 'An answer from before the reset.', MESSAGES_NODE_ID, posted));
    await a.probe((g) => g.seedTurnRowForTest(message, { id: posted, validFrom: snap.meta.validFrom }));
    await reset(a.scope);

    await vi.waitFor(() => expect(lines(a.scope, 'nebula.Galaxy.wake', 'woke beside its committed message')).toHaveLength(1), { timeout: 15_000 });
    expect(await a.row()).toBeUndefined();
    expect(await a.calls()).toBe(0);
    await vi.waitFor(async () => expect((await a.agentMessages()).map((m) => m.id)).toEqual([message]));
    a.dispose();
  });
});

describe('a run that cannot go on', { timeout: 120_000 }, () => {
  // MUTATION: let a run's rejection go unhandled, as before → no message, and the row stays.
  it('ends its turn in a line of ours, with no row left, when a round write throws', async () => {
    const a = await app();
    await a.probe((g) => g.setStoreFaultsForTest({ roundWrite: true }));
    await a.probe((g) => g.seedChatScriptForTest([reply([toolCall('read_file', { path: 'AGENTS.md' }, 'r1')], 'Reading.')]));
    const posted = await a.admin.postUserMessage('Read the conventions.');
    const value = (await a.replyTo(posted)).value as { content: string; codegen: Codegen };
    expect(value.content.endsWith(TURN_FAILED_LINE)).toBe(true);
    expect(value.codegen.stop).toBe('error');
    expect(await a.row()).toBeUndefined();
    a.dispose();
  });

  // A blob is read back only by a run that did not write it, so this one takes a reset: the wake
  // reads the file round 1 read, and the read throws.
  it('ends its turn in a line of ours, with no row left, when a blob read throws', async () => {
    const a = await app();
    await a.probe((g) => g.seedChatScriptForTest([
      reply([toolCall('read_file', { path: 'AGENTS.md' }, 'r1')], 'Reading.'),
      reply([toolCall('mark_complete', {}, 'c1')], 'never sent'),
    ]));
    await a.probe((g) => g.holdModelCallForTest(2));
    const posted = await a.admin.postUserMessage('Read the conventions.');
    await held(a.scope, 'model call held', 2);
    await a.probe((g) => g.setStoreFaultsForTest({ blobRead: true }));
    await reset(a.scope);

    const value = (await a.replyTo(posted)).value as { content: string; codegen: Codegen };
    expect(value.content.endsWith(TURN_FAILED_LINE)).toBe(true);
    expect([value.codegen.stop, value.codegen.rounds]).toEqual(['error', 1]);
    expect(await a.row()).toBeUndefined();
    expect(await a.calls()).toBe(2);
    a.dispose();
  });

  // MUTATION: drop the trigger's look at the row → the post starts a turn of its own.
  it('starts no second turn for a post beside a row whose run is not live here', async () => {
    const a = await app();
    const earlier = await a.admin.postUserMessage('A request whose turn is gone.');
    const snap = await a.admin.resources.read('Message', earlier) as Snapshot;
    const message = crypto.randomUUID();
    await a.probe((g) => g.seedTurnRowForTest(message, { id: earlier, validFrom: snap.meta.validFrom }));
    await a.probe((g) => g.seedChatScriptForTest([reply([], 'a second turn')]));
    const later = await a.admin.postUserMessage('A request beside it.');
    // The trigger's lines name the post, which is this test's alone.
    await vi.waitFor(() => expect(entries.some((e) => e.namespace === 'nebula.Galaxy.trigger'
      && e.message === 'waiting: a turn\'s row is open' && e.data?.resourceId === later)).toBe(true), { timeout: 15_000 });
    expect(lines(a.scope, 'nebula.Galaxy.turn', 'took up')).toEqual([]);
    expect(await a.calls()).toBe(0);
    expect((await a.row())!.message).toBe(message);
    a.dispose();
  });
});

describe('two Clients reaching a reset Galaxy at once', { timeout: 120_000 }, () => {
  // A reconnect and a post at once: the construction the reconnect makes wakes the turn once, and
  // the post waits beside its row for the decision after it.
  it('wake it once, record the cut round once, and the turn commits the model\'s own message', async () => {
    const a = await app();
    const member = await a.collaborator();
    await a.probe((g) => g.seedChatScriptForTest([
      reply([toolCall('mark_complete', {}, 'c1')], 'Done.'),
      reply([toolCall('mark_complete', {}, 'c2')], 'Done, and seen.'),
    ]));
    await a.probe((g) => g.holdModelCallForTest(1));
    const posted = await a.admin.postUserMessage('Do the thing.');
    await held(a.scope, 'model call held', 1);
    await a.probe((g) => g.holdModelCallForTest(2));
    await reset(a.scope);
    await vi.waitFor(() => expect(member.connectionState).toBe('connected'), { timeout: 15_000 });
    await member.postUserMessage('Me too, as soon as I am back.');
    await held(a.scope, 'model call held', 2);
    expect((await a.row())!.interrupted).toEqual([1]);

    await a.probe((g) => g.releaseForTest());
    const value = (await a.replyTo(posted)).value as { content: string };
    expect(value.content.includes(INTERRUPTED_LINE)).toBe(false);
    expect(woke(a.scope)).toHaveLength(1);
    member[Symbol.dispose]();
    a.dispose();
  });
});

describe('a run past its deadline', { timeout: 120_000 }, () => {
  // MUTATIONS: drop the stopped run's check on the row → the late reply stores its round and
  // writes its file; end no turn past its deadline → no line of ours. Deleting the row by its
  // presence passes here, since the stopped run returns before its commit's delete.
  it('ends its turn in a line of ours, and its run, released later, touches nothing of the next turn', async () => {
    const a = await app();
    const member = await a.collaborator();
    await a.probe((g) => g.setGenerationDeadlineForTest(2_000));
    await a.probe((g) => g.seedChatScriptForTest([
      reply([toolCall('write_file', { path: 'src/late.txt', content: 'too late' }, 'w1')], 'Writing late.'),
      reply([toolCall('mark_complete', {}, 'c1')], 'The second turn, done.'),
    ]));
    await a.probe((g) => g.holdModelCallForTest(1));
    const first = await a.admin.postUserMessage('A request whose reply comes late.');
    await held(a.scope, 'model call held', 1);
    const cut = await a.replyTo(first);
    const cutValue = cut.value as { content: string; codegen: Codegen };
    expect(cutValue.content.endsWith(DEADLINE_LINE)).toBe(true);
    expect(cutValue.codegen.stop).toBe('deadline');

    // The second turn has time to wait on its held call.
    await a.probe((g) => g.setGenerationDeadlineForTest(60_000));
    await a.probe((g) => g.holdModelCallForTest(2));
    const second = await member.postUserMessage('A request after the deadline.');
    await held(a.scope, 'model call held', 2);
    const next = (await a.row())!;
    expect(next.messageSnapshot.id).toBe(second);

    await a.probe((g) => g.releaseForTest(1));
    await vi.waitFor(() => expect(lines(a.scope, 'nebula.Galaxy.turn', 'stopped: the row names another turn')
      .some((e) => e.data?.message === cut.id)).toBe(true), { timeout: 15_000 });
    expect((await a.row())!.message).toBe(next.message);
    expect(await a.rounds(cut.id)).toEqual([]);
    await expect(a.source('src/late.txt')).rejects.toThrow();
    expect(entries.filter((e) => e.namespace === 'nebula.Galaxy.writeSource' && e.data?.instanceName === a.scope)).toEqual([]);

    await a.probe((g) => g.releaseForTest(2));
    expect(((await a.replyTo(second)).value as { content: string }).content).toBe('The second turn, done.');
    expect(await a.row()).toBeUndefined();
    member[Symbol.dispose]();
    a.dispose();
  });
});

describe('a decision the deadline cuts off', { timeout: 120_000 }, () => {
  // MUTATION: drop the decision's check that it is still live → its late pick writes a row over
  // the next turn's, and that turn never commits.
  it('starts nothing when its model call returns late, so the next turn keeps its row', async () => {
    const a = await app();
    const member = await a.collaborator();
    // A script is seeded so the post starts a turn; the whole script follows once the second
    // post's id is known, and the held first call has consumed nothing of it.
    await a.probe((g) => g.seedChatScriptForTest([reply([], 'placeholder')]));
    await a.probe((g) => g.holdModelCallForTest(1));
    const first = await a.admin.postUserMessage('The first request.');
    await held(a.scope, 'model call held', 1);
    const waiting = await a.admin.postUserMessage('A request that waits for a decision.');
    await a.probe((g) => g.seedChatScriptForTest([
      reply([], 'The first, done.'),
      reply([], 'Seen your second request.'),
      reply([toolCall('take_up', { postId: waiting }, 't1')], ''),
      reply([toolCall('mark_complete', {}, 'c1')], 'The next turn, done.'),
    ]));
    // The decision after the first turn has a short deadline of its own, and its call is held past it.
    await a.probe((g) => g.setGenerationDeadlineForTest(3_000));
    await a.probe((g) => g.holdModelCallForTest(3));
    await a.probe((g) => g.releaseForTest(1));
    await a.replyTo(first);
    await held(a.scope, 'model call held', 3);
    await vi.waitFor(() => expect(entries.some((e) => e.namespace === 'nebula.Galaxy.trigger'
      && e.message === 'turn failed: generation exceeded the deadline')).toBe(true), { timeout: 15_000 });

    await a.probe((g) => g.setGenerationDeadlineForTest(60_000));
    await a.probe((g) => g.holdModelCallForTest(4));
    const next = await member.postUserMessage('A request after the decision was cut off.');
    await held(a.scope, 'model call held', 4);
    const row = (await a.row())!;
    expect(row.messageSnapshot.id).toBe(next);

    await a.probe((g) => g.releaseForTest(3));
    await vi.waitFor(() => expect(entries.filter((e) => e.namespace === 'nebula.Galaxy.turn' && e.message === 'took up')
      .some((e) => e.data?.postId === waiting)).toBe(false));
    expect((await a.row())!.message).toBe(row.message);
    await a.probe((g) => g.releaseForTest(4));
    expect(((await a.replyTo(next)).value as { content: string }).content).toBe('The next turn, done.');
    expect(await a.probe((g) => g.waitingPostsForTest())).toEqual([waiting]);
    member[Symbol.dispose]();
    a.dispose();
  });
});

describe('a Galaxy with a cut-off turn that no Client reaches', { timeout: 120_000 }, () => {
  // MUTATION: drop the wake from `onStart` → nothing continues the turn, and its row stays.
  it('continues it when anything constructs the object, and the turn commits its message', async () => {
    const a = await app();
    await a.probe((g) => g.seedChatScriptForTest([reply([toolCall('mark_complete', {}, 'c1')], 'Done, with nobody here.')]));
    await a.probe((g) => g.holdModelCallForTest(1));
    await a.admin.postUserMessage('A request nobody comes back for.');
    await held(a.scope, 'model call held', 1);
    const { message } = (await a.row())!;
    a.dispose();
    await reset(a.scope);

    // A read from inside the object is no Client's call, and its construction wakes the turn. A
    // stub made before the reset answers with the reset itself, so each read takes a fresh one.
    const rowNow = (): Promise<unknown> => (runInDurableObject as any)(env.GALAXY.getByName(a.scope),
      (_i: unknown, ctx: DurableObjectState) => ctx.storage.kv.get(TURN_ROW_KEY));
    await vi.waitFor(async () => expect(await rowNow()).toBeUndefined(), { timeout: 20_000 });
    expect(woke(a.scope)).toHaveLength(1);
    expect(entries.some((e) => e.namespace === 'nebula.Galaxy.stream' && e.message === 'commit' && e.data?.messageId === message)).toBe(true);
  });
});
