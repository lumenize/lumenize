/**
 * A post's claims are held with the post, and the agent decides which waiting post to take up.
 *
 * Two people share one chat: the app's owner, here Jennifer, and a collaborator holding `write`
 * at the chat node and no admin bit, here Austen. Every test drives real clients, real Messages
 * and the real commit hook, with only the model scripted (`GalaxyTest.seedChatScriptForTest`).
 * That is why these run here rather than against a running stack: the real model cannot be
 * made to pick a post, name another person's post in a tool call, hang, or leave a post
 * unanswered on demand, so a gate on any of those could not fail there. `held-post-answered`
 * runs the same two-person scene with the real model and gates on what holds whatever it picks.
 *
 * Each assertion reads a line the Galaxy logs in `nebula.Galaxy.turn`: `took up`, with the claims
 * a turn's tools run under; `decision`, with the post picked or none; and `request`, with the
 * tools one model request offered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { NEBULA_SUB } from '@lumenize/mesh/auth';
import { CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, DEFAULT_CHAT_ID } from '@lumenize/nebula';
import type { Galaxy } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/resources';
import { universeAdminClient, createSubject, createInvitedClient } from '../../test-helpers';
import { StudioClientTest } from './index';
import type { GalaxyTest } from './index';

const uniqueScope = () => `hpt-${crypto.randomUUID().slice(0, 8)}.app`;
const PAIR = (scope: string) => ({ resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope });
const chatQuery = { queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };
const AGENT = { sub: NEBULA_SUB, profileId: NEBULA_SUB };

type SinkEntry = { namespace: string; level: string; message: string; data?: Record<string, unknown> };
let entries: SinkEntry[] = [];
beforeEach(() => { entries = []; setDebugSink((e) => entries.push(e as unknown as SinkEntry)); });
afterEach(() => clearDebugSink());

/** One model round that only speaks. */
const say = (content: string) => ({ choices: [{ message: { content, reasoning_content: '', tool_calls: [] } }] });
/** One model round that calls tools, with `content` beside the calls. */
const calls = (toolCalls: Array<[name: string, args: object]>, content = '') => ({
  choices: [{ message: { content, reasoning_content: '', tool_calls: toolCalls.map(([name, args]) => (
    { id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }
  )) } }],
});
/** One model round that calls one tool. */
const call = (name: string, args: object, content = '') => calls([[name, args]], content);

/** Jennifer, who owns the app, and Austen, a collaborator with `write` at the chat node. */
async function cast(scope: string) {
  const jennifer = await universeAdminClient(
    StudioClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, PAIR(scope),
  );
  await createSubject(new Browser(), scope, jennifer.accessToken, 'member@example.com');
  const austen = await createInvitedClient(
    StudioClientTest, new Browser(), scope, scope, 'member@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, PAIR(scope),
  );
  expect(austen.payload.access?.scopeAdmin).toBeFalsy();
  await jennifer.client.lmz.callAsync('GALAXY', scope,
    jennifer.client.ctn<Galaxy>().resources.orgTree.setPermission(CHAT_NODE_ID, austen.payload.sub, 'write'));
  const j = jennifer.client;
  const a = austen.client;
  return {
    j, a,
    jSub: jennifer.payload.sub as string, aSub: austen.payload.sub as string,
    jProfile: jennifer.payload.profileId as string, aProfile: austen.payload.profileId as string,
    seed: (script: unknown[]) => j.lmz.callAsync('GALAXY', scope, j.ctn<GalaxyTest>().seedChatScriptForTest(script)),
    waiting: () => j.lmz.callAsync('GALAXY', scope, j.ctn<GalaxyTest>().waitingPostsForTest()) as Promise<string[]>,
    dispose: () => { j[Symbol.dispose](); a[Symbol.dispose](); },
  };
}

/** Post a Message at an id the test chose, so a script written beforehand can name it. */
async function post(client: StudioClientTest, id: string, content: string, extra: Record<string, unknown> = {}): Promise<void> {
  const out = await client.resources.transaction({
    [id]: { op: 'create', typeName: 'Message', nodeId: CHAT_NODE_ID, value: { chat: DEFAULT_CHAT_ID, content, ...extra } },
  });
  expect(out.kind).toBe('committed');
}

/** Every agent message in the thread, by its content. */
async function agentMessages(client: StudioClientTest, ids: readonly string[]): Promise<Map<string, Snapshot>> {
  const out = new Map<string, Snapshot>();
  for (const id of ids) {
    const snap = await client.resources.read('Message', id) as Snapshot | null;
    if (snap && snap.meta.recordedClaims.sub === NEBULA_SUB) out.set((snap.value as { content: string }).content, snap);
  }
  return out;
}

/** The Galaxy's `nebula.Galaxy.turn` lines of one kind at `scope`, in order. */
const turnLines = (scope: string, message: string): Array<Record<string, unknown>> => entries
  .filter((e) => e.namespace === 'nebula.Galaxy.turn' && e.message === message && e.data?.instanceName === scope)
  .map((e) => e.data!);

describe('a post\'s claims are held with it, and a decision takes waiting posts up', () => {
  // Mutations: hold a post's call when the decision picks it, not when it commits → the pick
  // finds nothing held and Austen's post is never taken up; validate a tool's `postId` and then
  // run under the turn's own post → the file written for Jennifer logs Austen; send the decision
  // the loop's tools → its request lists `write_file`; keep a post's claims after its answer →
  // the write naming Jennifer's answered post lands; log the turn's ambient claims, or the
  // caller's from the chain's origin → the `took up` and commit lines name the wrong claims.
  it('Austen\'s post, sent during Jennifer\'s turn, is taken up after it under her own claims, and a tool can name Jennifer\'s held post', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const [j1, a1, j2] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await c.seed([
      { __delayMs: 1500 }, say('Done, Jennifer.'),
      call('take_up', { postId: a1 }),
      call('write_file', { path: 'src/austen.txt', content: 'asked for by Austen' }),
      call('write_file', { path: 'src/jennifer.txt', content: 'asked for by Jennifer', postId: j2 }),
      // Jennifer's first post is answered by now, so her claims for it are released.
      call('write_file', { path: 'src/late.txt', content: 'under claims already released', postId: j1 }),
      call('mark_complete', {}, 'Done, Austen.'),
      call('mark_complete', { answers: [j2] }, 'Jennifer, your file is written too.'),
    ]);

    await post(c.j, j1, 'Add a shared lists page.');
    await post(c.a, a1, 'Can I get a file of my own?');
    await post(c.j, j2, 'And one for me.');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(3), { timeout: 20_000 });

    // Each turn's tools run under the poster of the post it took up, with the agent as actor.
    expect(turnLines(scope, 'took up').map((l) => [l.postId, l.claims])).toEqual([
      [j1, { sub: c.jSub, profileId: c.jProfile, act: AGENT }],
      [a1, { sub: c.aSub, profileId: c.aProfile, act: AGENT }],
    ]);
    // The first decision picked Austen's post; the second only answered, naming Jennifer's.
    expect(turnLines(scope, 'decision').map((l) => [l.postId, l.answers])).toEqual([[a1, undefined], [null, [j2]]]);
    // A decision is offered a pick and a message, and no tool that acts.
    const decisionRequests = turnLines(scope, 'request').filter((l) => l.step === 'decision');
    expect(decisionRequests.map((l) => l.tools)).toEqual([['take_up', 'mark_complete'], ['take_up', 'mark_complete']]);
    // Each commit records whose claims it ran under: Austen's by default in her turn, and
    // Jennifer's for the call that named Jennifer's held post.
    const commits = entries.filter((e) => e.namespace === 'nebula.Galaxy.writeSource' && e.data?.instanceName === scope)
      .map((e) => [e.data!.path, (e.data!.recordedClaims as { sub: string }).sub, (e.data!.recordedClaims as { act?: { sub: string } }).act?.sub]);
    expect(commits).toEqual([['src/austen.txt', c.aSub, NEBULA_SUB], ['src/jennifer.txt', c.jSub, NEBULA_SUB]]);

    // What each agent message answers: the post its turn took up, and what the model named.
    const messages = await agentMessages(c.j, sub.resourceIds);
    const value = (content: string) => messages.get(content)!.value as { replyTo?: string; answers?: string[] };
    expect(value('Done, Jennifer.')).toMatchObject({ replyTo: j1, answers: [j1] });
    expect(value('Done, Austen.')).toMatchObject({ replyTo: a1, answers: [a1] });
    // The write that named Jennifer's answered post was refused, and the model was told why.
    const late = (messages.get('Done, Austen.')!.value as { codegen: { toolCalls: Array<{ args: { path?: string }; error?: string }> } })
      .codegen.toolCalls.find((tc) => tc.args.path === 'src/late.txt')!;
    expect(late.error).toBe(`post ${j1} is not held, so nothing can run under its poster's claims: name a post the held list shows, or ask that person`);
    expect(value('Jennifer, your file is written too.').answers).toEqual([j2]);
    expect(value('Jennifer, your file is written too.').replyTo).toBeUndefined();
    expect(await c.waiting()).toEqual([]);
    c.dispose();
  });

  // Mutation: decide after every turn, waiting posts or not → the decision's request appears,
  // and the spare round becomes a second agent message.
  it('a lone post\'s turn ends with no decision', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    await c.seed([say('Here you go.'), say('a round only a needless decision would use')]);
    await c.j.postUserMessage('What does this app do?');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(1), { timeout: 15_000 });
    // A decision would follow the turn's final message, so the absence is read past an idle window.
    await new Promise((r) => setTimeout(r, 1200));
    expect(turnLines(scope, 'decision')).toEqual([]);
    expect(turnLines(scope, 'request').map((l) => l.step)).toEqual(['turn']);
    expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(1);
    c.dispose();
  });

  // Mutation: count `answers` on any message, whoever wrote it → Austen's message answers
  // Jennifer's post, and the first waiting list loses it.
  it('only the agent\'s own message answers a post: a person naming one, or editing the agent\'s message, leaves it waiting', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    const [j1, a1, agentMessage] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    // No script is seeded, so no turn runs and the posts simply wait.
    await post(c.j, j1, 'Please add a page.');
    await post(c.a, a1, 'I am answering that for you.', { answers: [j1] });
    expect(await c.waiting()).toEqual([j1, a1]);

    // The positive control: the agent's own message, naming Austen's post, answers it.
    await c.j.lmz.callAsync('GALAXY', scope,
      c.j.ctn<GalaxyTest>().commitAgentForTest(DEFAULT_CHAT_ID, agentMessage, 'Thanks, Austen.', CHAT_NODE_ID, a1));
    expect(await c.waiting()).toEqual([j1]);

    // Austen edits the agent's message to name Jennifer's post too. The message's current
    // snapshot now records Austen, so it answers nothing, her own post included, and by its
    // record it is a person's post now, waiting like any other.
    const current = await c.a.resources.read('Message', agentMessage) as Snapshot;
    const edited = await c.a.resources.transaction({
      [agentMessage]: {
        op: 'put', typeName: 'Message', ifValidFromMatches: current.meta.validFrom,
        value: { ...(current.value as object), answers: [a1, j1] },
      },
    });
    expect(edited.kind).toBe('committed');
    expect(await c.waiting()).toEqual([j1, a1, agentMessage]);
    c.dispose();
  });

  // Mutations: hold a post's call only when it is created → the line names Austen; drop the
  // check that a post is still waiting → Jennifer's edit of her answered post starts a turn.
  it('a person who edits a waiting post becomes the one its turn runs under, and an edit to an answered post starts nothing', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const [j1, a1] = [crypto.randomUUID(), crypto.randomUUID()];
    await c.seed([
      { __delayMs: 1500 }, say('Done, Jennifer.'),
      call('take_up', { postId: a1 }), say('Done with the edited request.'),
      say('a round only a turn on an answered post would use'),
    ]);
    await post(c.j, j1, 'First request.');
    await post(c.a, a1, 'Austen\'s request.');
    // Jennifer rewrites Austen's waiting post: a `put` needs only `write` at the chat node.
    const waitingPost = await c.j.resources.read('Message', a1) as Snapshot;
    const rewritten = await c.j.resources.transaction({
      [a1]: { op: 'put', typeName: 'Message', ifValidFromMatches: waitingPost.meta.validFrom, value: { chat: DEFAULT_CHAT_ID, content: 'Jennifer\'s words now.' } },
    });
    expect(rewritten.kind).toBe('committed');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(2), { timeout: 20_000 });
    // The words the agent read for that post were Jennifer's, so its turn ran under her claims.
    expect(turnLines(scope, 'took up').map((l) => [l.postId, (l.claims as { sub: string }).sub])).toEqual([[j1, c.jSub], [a1, c.jSub]]);

    // Jennifer edits her first post, which "Done, Jennifer." already answered.
    const answered = await c.j.resources.read('Message', j1) as Snapshot;
    const out = await c.j.resources.transaction({
      [j1]: { op: 'put', typeName: 'Message', ifValidFromMatches: answered.meta.validFrom, value: { chat: DEFAULT_CHAT_ID, content: 'First request, reworded.' } },
    });
    expect(out.kind).toBe('committed');
    await new Promise((r) => setTimeout(r, 1200));
    expect(turnLines(scope, 'took up')).toHaveLength(2);
    expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(2);
    c.dispose();
  });
});

describe('a post left without its held call', () => {
  // Mutations: let a decision consider only posts whose call is held → the orphaned post is
  // never answered; send the decision the loop's tools → its request lists `write_file`; let a
  // decision take up a post whose call is not held → the pick is not refused, and a turn starts
  // on Jennifer's post with nobody's claims.
  it('after an eviction, the decision that follows the next post\'s turn answers the orphaned post, and is offered no tool that acts', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    const [j1, a1] = [crypto.randomUUID(), crypto.randomUUID()];
    await c.seed([{ __delayMs: 60_000 }]);
    await post(c.j, j1, 'Build me a wishlist.');
    await vi.waitFor(() => expect(turnLines(scope, 'took up')).toHaveLength(1));

    // The Galaxy is reset mid-turn: its storage stays, and everything it held in memory goes,
    // the hung turn, the latch and Jennifer's held call among them.
    await (runInDurableObject as any)(env.GALAXY.getByName(scope), (_instance: unknown, ctx: DurableObjectState) => { ctx.abort('an eviction, in a test'); })
      .catch(() => { /* the abort rejects the call that made it */ });
    await vi.waitFor(() => { expect(c.j.connectionState).toBe('connected'); expect(c.a.connectionState).toBe('connected'); }, { timeout: 15_000 });
    await vi.waitFor(async () => expect(await c.waiting()).toEqual([j1]), { timeout: 15_000 });
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;

    await c.seed([
      say('Hello, Austen.'),
      // The decision tries to take the orphaned post up, and answers it in the same round.
      calls([['take_up', { postId: j1 }], ['mark_complete', { answers: [j1] }]], 'Jennifer, your wishlist request was cut off. Ask again and I will build it.'),
    ]);
    await post(c.a, a1, 'Hello?');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(2), { timeout: 20_000 });

    const messages = await agentMessages(c.j, sub.resourceIds);
    const answer = messages.get('Jennifer, your wishlist request was cut off. Ask again and I will build it.')!.value as { answers?: string[]; replyTo?: string };
    expect(answer.answers).toEqual([j1]);
    expect(answer.replyTo).toBeUndefined();
    // Since the reset, one turn took a post up: Austen's. Jennifer's was answered, never taken up.
    expect(turnLines(scope, 'took up').map((l) => l.postId)).toEqual([j1, a1]);
    expect(turnLines(scope, 'decision').map((l) => [l.postId, l.answers, l.refusedPick])).toEqual([[null, [j1], j1]]);
    expect(turnLines(scope, 'request').filter((l) => l.step === 'decision').map((l) => l.tools)).toEqual([['take_up', 'mark_complete']]);
    expect(await c.waiting()).toEqual([]);
    c.dispose();
  });

  // Mutation: offer the loop's tools whether or not the turn's post is held → the request
  // lists `write_file`.
  it('a turn with nothing held is offered no tool that acts, and a write it tries anyway is refused', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const unheld = crypto.randomUUID();
    await c.j.lmz.callAsync('GALAXY', scope, c.j.ctn<GalaxyTest>().chatScriptedForTest(unheld, 'write a file', [
      call('write_file', { path: 'src/unheld.txt', content: 'nobody asked' }),
      say('I can only answer here.'),
    ], { held: false }));
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(1), { timeout: 15_000 });

    expect(turnLines(scope, 'took up').map((l) => [l.postId, l.claims])).toEqual([[unheld, null]]);
    expect(turnLines(scope, 'request').map((l) => l.tools)).toEqual([['mark_complete'], ['mark_complete']]);
    const reply = (await agentMessages(c.j, sub.resourceIds)).get('I can only answer here.')!;
    const [attempt] = (reply.value as { codegen: { toolCalls: Array<{ name: string; error?: string }> } }).codegen.toolCalls;
    expect(attempt).toMatchObject({ name: 'write_file', error: `post ${unheld} is not held, so nothing can run under its poster's claims: name a post the held list shows, or ask that person` });
    await expect(c.j.lmz.callAsync('GALAXY', scope, c.j.ctn<Galaxy>().readSource('src/unheld.txt'))).rejects.toThrow();
    c.dispose();
  });
});

describe('a turn the generation deadline cuts off', () => {
  // Mutations: start a decision when the deadline cuts a turn off → a decision's request follows
  // the deadline; forget which posts still have a turn running → a second turn starts on the
  // hung post, inside the call it is already running in.
  it('starts no decision, and no later decision takes its post up again while it still runs', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const [j1, a1, a2] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await c.j.lmz.callAsync('GALAXY', scope, c.j.ctn<GalaxyTest>().setGenerationDeadlineForTest(800));
    await c.seed([{ __delayMs: 60_000 }]);
    await post(c.j, j1, 'A request whose turn hangs.');
    await post(c.a, a1, 'Sent while it hangs.');
    const cutOff = () => entries.findIndex((e) => e.namespace === 'nebula.Galaxy.trigger' && e.message === 'turn failed: generation exceeded the deadline');
    await vi.waitFor(() => expect(cutOff()).toBeGreaterThan(-1), { timeout: 10_000 });
    // Past the deadline the latch is free and Austen's post still waits, with nothing started.
    await new Promise((r) => setTimeout(r, 600));
    expect(turnLines(scope, 'request').filter((l) => l.step === 'decision')).toEqual([]);

    await c.seed([
      say('Reply to the second.'),
      call('take_up', { postId: a1 }), say('Reply to the first.'),
      call('take_up', { postId: j1 }), say('a second turn on the hung post'),
    ]);
    await post(c.a, a2, 'A second post from Austen.');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(2), { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 600));
    expect(turnLines(scope, 'took up').map((l) => l.postId)).toEqual([j1, a2, a1]);
    expect(turnLines(scope, 'decision').map((l) => l.postId)).toEqual([a1]);
    c.dispose();
  });
});
