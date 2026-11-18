/**
 * A turn's `run_in_tab` call leaves the Galaxy by its result handler, and nothing waits for it:
 * the run that sends it ends, and the tab's answer, written on the round, starts the next run.
 *
 * Two people share one chat, as in `run-in-tab.test.ts`: the app's owner, Jennifer, and a
 * collaborator, Austen, each with Studio open. Every test drives real clients, real Messages and
 * the real commit hook, with only the model scripted, and each Studio answers a run with a handler
 * the test holds, which is what lets a test act while a call is out. The real model cannot be made
 * to call `run_in_tab` on cue, so these run here; `cast-from-a-tab` runs the scene with the real
 * model, a real browser and real frames.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { NEBULA_SUB } from '@lumenize/mesh/auth';
import { CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, DEFAULT_CHAT_ID } from '@lumenize/nebula';
import type { Galaxy } from '@lumenize/nebula';
import type { Snapshot, QueryReadResult } from '@lumenize/resources';
import type { RunAnswer } from '@lumenize/resources/frontend';
import { roundsOf } from '../../../src/participants';
import { INTERRUPTED_CALL_ERROR, type StoredRound } from '../../../src/codegen-loop';
import { universeAdminClient, createSubject, createInvitedClient, addressOfClient, pageOf, ORIGIN } from '../../test-helpers';
import { StudioClientTest } from './index';
import type { GalaxyTest } from './index';

const V = CHAT_MESSAGE_ONTOLOGY_VERSION;
const uniqueScope = () => `tc-${crypto.randomUUID().slice(0, 8)}.app`;
const PAIR = (scope: string) => ({ resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope });
const chatQuery = { typeName: 'Message', filter: { chat: DEFAULT_CHAT_ID } };
const POST_MOVED = 'The post I was working on was changed while I worked, so I stopped. I will take it up again as it reads now.';
const ROUND_CONFLICT = 'Someone else changed my record of this turn while I worked, so I stopped. Ask again and I will start over.';
const DEADLINE = 'This ran past the time I am allowed, so I stopped. What I saved is kept: ask again and I will carry on from it.';

type SinkEntry = { namespace: string; level: string; message: string; data?: Record<string, unknown> };
let entries: SinkEntry[] = [];
beforeEach(() => { entries = []; setDebugSink((e) => entries.push(e as unknown as SinkEntry)); });
afterEach(() => clearDebugSink());
const lineAt = (namespace: string, message: string, match: (d: Record<string, unknown>) => boolean = () => true) =>
  entries.findIndex((e) => e.namespace === namespace && e.message === message && match(e.data ?? {}));

/** One model round that calls one tool, with `content` beside the call. */
const call = (name: string, args: object, content = '') => ({
  choices: [{ message: { content, reasoning_content: '', tool_calls: [
    { id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ] } }],
});
/** One model round that only speaks. */
const say = (content: string) => ({ choices: [{ message: { content, reasoning_content: '', tool_calls: [] } }] });

/** An answer a test lets go of when it chooses. */
function held<T>(value: () => T | Promise<T>): { answer: () => Promise<T>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { answer: async () => { await gate; return value(); }, release };
}

/** A Studio tab for the session `browser` holds, as a second window of the same person would be. */
async function studioTab(browser: Browser, scope: string): Promise<StudioClientTest> {
  const ctx = browser.context(pageOf(scope));
  const client = new StudioClientTest({
    baseUrl: pageOf(scope), platformOrigin: ORIGIN, ontologyVersion: V,
    fetch: ctx.fetch, WebSocket: ctx.WebSocket, sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
    ...PAIR(scope),
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'));
  return client;
}

/** Jennifer, who owns the app, and Austen, a collaborator with `write` at the chat node. */
async function cast(scope: string) {
  const jennifer = await universeAdminClient(
    StudioClientTest, new Browser(), scope, scope, `owner-${crypto.randomUUID().slice(0, 8)}@example.com`, V, PAIR(scope),
  );
  const austenEmail = `member-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await createSubject(new Browser(), scope, jennifer.accessToken, austenEmail);
  const austenBrowser = new Browser();
  const austen = await createInvitedClient(StudioClientTest, austenBrowser, scope, scope, austenEmail, V, PAIR(scope));
  await jennifer.client.lmz.callAsync('GALAXY', scope,
    jennifer.client.ctn<Galaxy>().resources.orgTree.setPermission(CHAT_NODE_ID, austen.payload.sub, 'write'));
  const j = jennifer.client;
  const a = austen.client;
  const ran: Array<[who: string, tab: string, code: string]> = [];
  /** Have `client`'s Studio answer a run as `who`, with `answer` or the value `{ from: who }`. */
  const answers = (client: StudioClientTest, who: string, answer?: () => Promise<RunAnswer>) =>
    client.setRunInTab(async (tab, code) => { ran.push([who, tab, code]); return answer ? answer() : { ok: true, value: { from: who } }; });
  answers(j, 'jennifer');
  answers(a, 'austen');
  const probe = async (remote: (g: any) => unknown): Promise<any> => {
    await vi.waitFor(() => expect(j.connectionState).toBe('connected'), { timeout: 15_000 });
    return j.lmz.callAsync('GALAXY', scope, remote(j.ctn<GalaxyTest>()) as never);
  };
  const thread = j.resources.subscribeQuery(chatQuery);
  await thread.ready;
  /** The agent message whose content is, or contains, `content`, once it has committed. */
  const message = async (content: string, timeout = 20_000): Promise<Snapshot & { id: string }> => {
    let found: (Snapshot & { id: string }) | undefined;
    await vi.waitFor(async () => {
      for (const id of thread.resourceIds) {
        const snap = await j.resources.read('Message', id) as Snapshot | null;
        if (snap && snap.meta.recordedClaims.sub === NEBULA_SUB && (snap.value as { content: string }).content.includes(content)) found = { ...snap, id };
      }
      expect(found).toBeDefined();
    }, { timeout, interval: 250 });
    return found!;
  };
  const rounds = async (id: string): Promise<Array<{ id: string; validFrom: string; round: StoredRound }>> =>
    ((await probe(() => j.ctn<Galaxy>().resources.query(V, roundsOf(id)))) as QueryReadResult).snapshots
      .map((s) => ({ id: s.resourceId, validFrom: s.meta.validFrom, round: s.value as StoredRound }))
      .sort((x, y) => x.round.index - y.round.index);
  return {
    j, a, ran, answers, austenBrowser, probe, thread, message, rounds,
    seed: (script: unknown[]) => probe((g) => g.seedChatScriptForTest(script)),
    calls: (): Promise<number> => probe((g) => g.modelCallsForTest()),
    row: (): Promise<{ message: string; interrupted: number[] } | undefined> => probe((g) => g.turnRowForTest()),
    dispose: () => { thread[Symbol.dispose](); j[Symbol.dispose](); a[Symbol.dispose](); },
  };
}

/** Wait until the tab call is out: the Studio tab has been asked to run the code. */
const asked = (c: { ran: unknown[] }, n = 1) => vi.waitFor(() => expect(c.ran.length).toBeGreaterThanOrEqual(n), { timeout: 15_000 });

describe('a tab call leaves by its result handler', { timeout: 120_000 }, () => {
  // MUTATION: let the trigger ignore the row → Austen's post starts a turn while the call is out.
  it('a second person\'s post waits while a tab call is out, and a decision takes it up once the first turn commits', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    const tab = held<RunAnswer>(() => ({ ok: true, value: 'ran' }));
    c.answers(c.j, 'jennifer', tab.answer);
    await c.seed([call('run_in_tab', { tab: 'me', code: 'return 1' })]);
    const j1 = await c.j.postUserMessage('Run something in my tab.');
    await asked(c);
    const a1 = await c.a.postUserMessage('And something for me, please.');
    await vi.waitFor(() => expect(lineAt('nebula.Galaxy.trigger', 'waiting: a turn\'s row is open', (d) => d.resourceId === a1)).toBeGreaterThan(-1), { timeout: 15_000 });
    expect(await c.calls()).toBe(1);

    await c.seed([
      call('mark_complete', {}, 'Ran it.'),
      // The closing step sees Austen's post and answers nobody.
      call('mark_complete', {}, 'Ran it, and saw your post, Austen.'),
      call('take_up', { postId: a1 }),
      call('mark_complete', {}, 'Done for Austen.'),
    ]);
    tab.release();
    const first = await c.message('Ran it, and saw your post, Austen.');
    expect((first.value as { replyTo?: string }).replyTo).toBe(j1);
    const second = await c.message('Done for Austen.');
    expect((second.value as { replyTo?: string }).replyTo).toBe(a1);
    expect(entries.filter((e) => e.namespace === 'nebula.Galaxy.turn' && e.message === 'decision').map((e) => e.data?.postId)).toEqual([a1]);
    expect(await c.calls()).toBe(5);
    c.dispose();
  });

  // MUTATION: ask the next tab without the post's check → the second tab runs the code.
  it('a post edited while its first tab shows no preview ends the turn in our line, and the second tab is never asked', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    const a2 = await studioTab(c.austenBrowser, scope);
    using s1 = c.a.resources.subscribeQuery(chatQuery); await s1.ready;
    using s2 = a2.resources.subscribeQuery(chatQuery); await s2.ready;
    const [first, second] = [c.a, a2].sort((x, y) => addressOfClient(x) < addressOfClient(y) ? -1 : 1);
    const noPreview = held<RunAnswer>(() => { throw Object.assign(new Error('no preview here'), { name: 'NoPreviewError' }); });
    c.answers(first!, 'first', noPreview.answer);
    c.answers(second!, 'second');
    await c.seed([call('run_in_tab', { tab: 'me', code: 'return 1' }), call('mark_complete', {}, 'never sent')]);
    const a1 = await second!.postUserMessage('Run something for me.');
    await asked(c);
    const current = await c.a.resources.read('Message', a1) as Snapshot;
    expect((await c.a.resources.transaction({
      [a1]: { op: 'put', typeName: 'Message', ifValidFromMatches: current.meta.validFrom, value: { chat: DEFAULT_CHAT_ID, content: 'Reworded while it ran.' } },
    })).kind).toBe('committed');
    noPreview.release();

    await c.message(POST_MOVED);
    expect(c.ran).toEqual([['first', 'me', 'return 1']]);
    a2[Symbol.dispose]();
    c.dispose();
  });

  // MUTATION: run the cut call again on the wake → Jennifer's tab is asked twice.
  it('a reset before the tab answers: the call holds the interrupted error, and the model is called once for the next round', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    c.answers(c.j, 'jennifer', () => new Promise<RunAnswer>(() => { /* never answers */ }));
    await c.seed([call('run_in_tab', { tab: 'me', code: 'return 1' }), call('mark_complete', {}, 'Done after the reset.')]);
    await c.probe((g) => g.holdModelCallForTest(2));
    await c.j.postUserMessage('Run something in my tab.');
    await asked(c);
    const { message } = (await c.row())!;
    await (runInDurableObject as any)(env.GALAXY.getByName(scope), (_i: unknown, ctx: DurableObjectState) => { ctx.abort('an eviction, in a test'); })
      .catch(() => { /* the abort rejects the call that made it */ });
    await vi.waitFor(() => expect(entries.some((e) => e.namespace === 'nebula.GalaxyTest.hold' && e.data?.call === 2)).toBe(true), { timeout: 15_000 });

    expect((await c.row())!.interrupted).toEqual([]);
    expect(await c.calls()).toBe(2);
    expect((await c.rounds(message))[0]!.round.calls[0]!.error).toBe(INTERRUPTED_CALL_ERROR);
    await c.probe((g) => g.releaseForTest());
    await c.message('Done after the reset.');
    expect(c.ran).toHaveLength(1);
    c.dispose();
  });

  // MUTATION: write the answer whatever the round's version → the repeat adds a snapshot.
  it('the same answer delivered twice adds one snapshot, and the model is called once', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    await c.seed([call('run_in_tab', { tab: 'me', code: 'return 1' }), call('mark_complete', {}, 'Answered once.')]);
    await c.probe((g) => g.holdModelCallForTest(2));
    await c.j.postUserMessage('Run something in my tab.');
    await vi.waitFor(() => expect(entries.some((e) => e.namespace === 'nebula.GalaxyTest.hold' && e.data?.call === 2)).toBe(true), { timeout: 15_000 });
    const { message } = (await c.row())!;
    const [round] = await c.rounds(message);

    await c.probe((g) => g.replayTabAnswerForTest());
    expect(await c.probe((g) => g.snapshotRowsForTest(round!.id))).toHaveLength(2);
    await c.probe((g) => g.releaseForTest());
    await c.message('Answered once.');
    expect(await c.calls()).toBe(2);
    expect(await c.probe((g) => g.snapshotRowsForTest(round!.id))).toHaveLength(2);
    c.dispose();
  });

  // MUTATION: drop the answer on a conflict → the turn never ends and its row stays.
  it('an admin who writes over the round while its tab call is out ends the turn in our line when the tab answers', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    const tab = held<RunAnswer>(() => ({ ok: true, value: 'ran' }));
    c.answers(c.j, 'jennifer', tab.answer);
    await c.seed([call('run_in_tab', { tab: 'me', code: 'return 1' }), call('mark_complete', {}, 'never sent')]);
    await c.j.postUserMessage('Run something in my tab.');
    await asked(c);
    const { message } = (await c.row())!;
    const [round] = await c.rounds(message);
    expect((await c.j.resources.transaction({
      [round!.id]: { op: 'put', typeName: 'Round', ifValidFromMatches: round!.validFrom, value: { chat: DEFAULT_CHAT_ID, message, ...round!.round, text: 'Written over by an admin.' } },
    })).kind).toBe('committed');
    tab.release();

    await c.message(ROUND_CONFLICT);
    expect(await c.row()).toBeUndefined();
    await c.seed([say('A fresh turn.')]);
    await c.j.postUserMessage('Start again.');
    await c.message('A fresh turn.');
    c.dispose();
  });

  // MUTATION: give the warm latch and the teardown to the turn rather than the run → run 1 keeps
  // the box through the tab call, and its teardown comes after the answer.
  it('run 1 warms and tears down before the tab answers, and run 2 tears down only', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    const tab = held<RunAnswer>(() => ({ ok: true, value: 'ran' }));
    c.answers(c.j, 'jennifer', tab.answer);
    await c.seed([
      call('write_file', { path: 'src/hello.txt', content: 'hello' }),
      call('run_in_tab', { tab: 'me', code: 'return 1' }),
      call('build', {}),
      call('mark_complete', {}, 'Wrote, ran and built.'),
    ]);
    await c.j.postUserMessage('Write, run, build.');
    await asked(c);
    const warms = () => entries.filter((e) => e.namespace === 'nebula.Galaxy.warm' && e.data?.instanceName === scope);
    await vi.waitFor(() => expect(warms()).toHaveLength(1));
    const run1 = warms()[0]!.data!.run as string;
    await vi.waitFor(() => expect(lineAt('nebula.Galaxy.teardown', 'build container destroyed', (d) => d.run === run1)).toBeGreaterThan(-1));
    tab.release();

    await c.message('Wrote, ran and built.');
    const answered = lineAt('nebula.Galaxy.runInTab', 'a tab answered');
    expect(answered).toBeGreaterThan(lineAt('nebula.Galaxy.teardown', 'build container destroyed', (d) => d.run === run1));
    const runs = new Set(entries.filter((e) => e.namespace === 'nebula.Galaxy.teardown' && e.data?.instanceName === scope && e.data?.run !== undefined)
      .map((e) => e.data!.run as string));
    const [run2, ...others] = [...runs].filter((r) => r !== run1);
    expect(others).toEqual([]);
    expect(run2).toBeDefined();
    expect(warms().map((e) => e.data!.run)).toEqual([run1]);
    c.dispose();
  });

  // MUTATIONS: measure the deadline from the turn's start → the two short runs end in the deadline
  // line; start the answer's run with no deadline → the long second run never ends.
  it('each run has a deadline of its own', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    await c.probe((g) => g.setGenerationDeadlineForTest(3_000));
    await c.seed([
      { __delayMs: 1_800 }, call('run_in_tab', { tab: 'me', code: 'return 1' }),
      { __delayMs: 1_800 }, call('mark_complete', {}, 'Two short runs.'),
    ]);
    await c.j.postUserMessage('Two short runs, please.');
    const short = await c.message('Two short runs.');
    expect((short.value as { codegen: { stop: string } }).codegen.stop).toBe('complete');

    await c.seed([
      call('run_in_tab', { tab: 'me', code: 'return 2' }),
      { __delayMs: 4_000 }, call('mark_complete', {}, 'never sent'),
    ]);
    const post = await c.j.postUserMessage('A short run, then a long one.');
    const long = await c.message(DEADLINE);
    expect((long.value as { replyTo?: string; codegen: { stop: string } }).replyTo).toBe(post);
    expect((long.value as { codegen: { stop: string } }).codegen.stop).toBe('deadline');
    c.dispose();
  });
});
