/**
 * A waiting post is worked under the claims its write recorded, and the agent decides which
 * waiting post to take up.
 *
 * Two people share one chat: the app's owner, here Jennifer, and a collaborator holding `write`
 * at the chat node and no admin bit, here Austen. Every test drives real clients, real Messages
 * and the real commit hook, with only the model scripted (`GalaxyTest.seedChatScriptForTest`).
 * That is why these run here rather than against a running stack: the real model cannot be
 * made to pick a post, hang, or leave a post unanswered on demand, so a gate on any of those
 * could not fail there. The eviction case is here for a second reason: a local stack's
 * `ctx.abort()` wipes storage, where this lane's keeps it, as a deployed eviction does.
 * `waiting-posts-answered` runs the two-person scene with the real model and gates on what holds
 * whatever it picks.
 *
 * Each assertion reads a line the Galaxy logs in `nebula.Galaxy.turn`: `took up`, with the claims
 * a turn's tools run under; `decision`, with the post picked or none; and `request`, with the
 * tools one model request offered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { NEBULA_SUB, REGISTRY_INSTANCE_NAME } from '@lumenize/mesh/auth';
import type { AuthFacade } from '@lumenize/mesh/auth/facade';
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
  // An address of their own per test, for both. With one address shared by every test in this
  // file, an Accept or a refresh answered 401 once that address held about two dozen
  // memberships: Austen's from the thirteenth test on, and the owner's once the file passed
  // twenty tests. With an address per test neither does. Why is not established.
  const jennifer = await universeAdminClient(
    StudioClientTest, new Browser(), scope, scope, `owner-${crypto.randomUUID().slice(0, 8)}@example.com`, CHAT_MESSAGE_ONTOLOGY_VERSION, PAIR(scope),
  );
  const austenEmail = `member-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await createSubject(new Browser(), scope, jennifer.accessToken, austenEmail);
  const austen = await createInvitedClient(
    StudioClientTest, new Browser(), scope, scope, austenEmail, CHAT_MESSAGE_ONTOLOGY_VERSION, PAIR(scope),
  );
  expect(austen.payload.access?.scopeAdmin).toBeFalsy();
  await jennifer.client.lmz.callAsync('GALAXY', scope,
    jennifer.client.ctn<Galaxy>().resources.orgTree.setPermission(CHAT_NODE_ID, austen.payload.sub, 'write'));
  const j = jennifer.client;
  const a = austen.client;
  return {
    j, a,
    jSub: jennifer.payload.sub as string, aSub: austen.payload.sub as string, jToken: jennifer.accessToken,
    jProfile: jennifer.payload.profileId as string, aProfile: austen.payload.profileId as string,
    seed: (script: unknown[]) => j.lmz.callAsync('GALAXY', scope, j.ctn<GalaxyTest>().seedChatScriptForTest(script)),
    waiting: () => j.lmz.callAsync('GALAXY', scope, j.ctn<GalaxyTest>().waitingPostsForTest()) as Promise<string[]>,
    dispose: () => { j[Symbol.dispose](); a[Symbol.dispose](); },
  };
}

/** The memberships the Registry holds for `email`: each scope, and whether it carries the admin bit. */
async function membershipsOf(email: string): Promise<Array<[scope: string, admin: boolean]>> {
  return (runInDurableObject as any)(env.AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME), (_i: unknown, ctx: DurableObjectState) =>
    ctx.storage.sql.exec(
      `SELECT m.universeGalaxyStarId AS scope, m.scopeAdmin AS admin FROM Emails e JOIN Memberships m ON m.emailId = e.emailId
       WHERE e.email = ? ORDER BY m.universeGalaxyStarId`, email,
    ).toArray().map((r) => [r.scope as string, Boolean(r.admin)] as [string, boolean]));
}
const someone = () => `friend-${crypto.randomUUID().slice(0, 8)}@example.com`;
/** What the Galaxy's own check tells a turn working for someone who is not an admin of the app. */
/** What a turn's message says when the post it took up changed while it worked. */
const POST_MOVED = 'The post I was working on was changed while I worked, so I stopped. I will take it up again as it reads now.';
const NOT_AN_ADMIN = 'Inviting into this app needs one of its admins, and the person this turn is working for is not one. Say so, and ask an admin in the chat to ask for the invite.';
type ToolCalls = { codegen: { toolCalls: Array<{ name: string; args?: Record<string, unknown>; result?: Record<string, unknown>; error?: string; post?: string; claims?: { sub: string } }> } };

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

/**
 * Resolve once the turn now starting at `scope` has read the thread and sent its first request.
 * A post sent before that is in the turn's history; one sent after it arrived while the turn
 * ran, which is what a closing step reads, so a test that means the second waits for this.
 */
const turnUnderWay = (scope: string, turns = 1) =>
  vi.waitFor(() => expect(turnLines(scope, 'request').filter((l) => l.step === 'turn').length).toBeGreaterThanOrEqual(turns));

/** The Galaxy's `nebula.Galaxy.turn` lines of one kind at `scope`, in order. */
const turnLines = (scope: string, message: string): Array<Record<string, unknown>> => entries
  .filter((e) => e.namespace === 'nebula.Galaxy.turn' && e.message === message && e.data?.instanceName === scope)
  .map((e) => e.data!);

describe('a waiting post is worked under its own poster\'s recorded claims, and a decision takes waiting posts up', () => {
  // Mutations: act under the record of the post the first turn took up → Austen's file logs
  // Jennifer; send the decision the loop's tools → its request lists `write_file`; log the
  // turn's ambient claims, or the caller's from the chain's origin → the `took up` and commit
  // lines name the wrong claims.
  it('Austen\'s post, sent during Jennifer\'s turn, is taken up after it under her own claims', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const [j1, a1, j2] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await c.seed([
      { __delayMs: 1500 }, say('A draft for Jennifer.'),
      // Two posts arrived while that turn ran, so it ends with a closing step, which here
      // answers only the post the turn took up.
      say('Done, Jennifer.'),
      call('take_up', { postId: a1 }),
      call('write_file', { path: 'src/austen.txt', content: 'asked for by Austen' }),
      call('mark_complete', {}, 'Done, Austen.'),
      call('mark_complete', { answers: [j2] }, 'Jennifer, your file is written too.'),
    ]);

    await post(c.j, j1, 'Add a shared lists page.');
    await turnUnderWay(scope);
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
    // The commit records whose claims it ran under: Austen's, in the turn that took up her post,
    // though Jennifer's second post was waiting too.
    const commits = entries.filter((e) => e.namespace === 'nebula.Galaxy.writeSource' && e.data?.instanceName === scope)
      .map((e) => [e.data!.path, (e.data!.recordedClaims as { sub: string }).sub, (e.data!.recordedClaims as { act?: { sub: string } }).act?.sub]);
    expect(commits).toEqual([['src/austen.txt', c.aSub, NEBULA_SUB]]);

    // What each agent message answers: the post its turn took up, and what the model named.
    const messages = await agentMessages(c.j, sub.resourceIds);
    const value = (content: string) => messages.get(content)!.value as { replyTo?: string; answers?: string[] };
    expect(value('Done, Jennifer.')).toMatchObject({ replyTo: j1, answers: [j1] });
    expect(value('Done, Austen.')).toMatchObject({ replyTo: a1, answers: [a1] });
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
    // Nor a closing step: no post arrived while the turn ran. Mutation: close every turn → a
    // closing request follows the turn's own.
    expect(turnLines(scope, 'closing step')).toEqual([]);
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

  // Mutations: act under the record of a post's first snapshot → the line names Austen; drop the
  // check that a post is still waiting → Jennifer's edit of her answered post starts a turn.
  it('a person who edits a waiting post becomes the one its turn runs under, and an edit to an answered post starts nothing', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const [j1, a1] = [crypto.randomUUID(), crypto.randomUUID()];
    await c.seed([
      { __delayMs: 1500 }, say('A draft for Jennifer.'), say('Done, Jennifer.'),
      call('take_up', { postId: a1 }), say('Done with the edited request.'),
      say('a round only a turn on an answered post would use'),
    ]);
    await post(c.j, j1, 'First request.');
    await turnUnderWay(scope);
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

describe('a post edited while its turn runs', () => {
  /** Rewrite `id` as `client`, as an edit in Studio would. */
  async function rewrite(client: StudioClientTest, id: string, content: string): Promise<void> {
    const current = await client.resources.read('Message', id) as Snapshot;
    const out = await client.resources.transaction({
      [id]: { op: 'put', typeName: 'Message', ifValidFromMatches: current.meta.validFrom, value: { chat: DEFAULT_CHAT_ID, content } },
    });
    expect(out.kind).toBe('committed');
  }
  const valueOf = (snap: Snapshot) => snap.value as { content: string; replyTo?: string; answers?: string[] } & ToolCalls;

  // Mutations: act under the post's current record whatever its `validFrom` → the turn's write
  // lands, under Austen; drop the trigger's check on a taken-up post → the edit starts a second
  // turn beside the first; keep `replyTo` after a conflict → the stopped turn's message answers
  // the post and the edited words are never worked.
  it('stops the turn at its next tool call, which writes nothing and answers no post; a decision then takes the edited post up under its editor', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const j1 = crypto.randomUUID();
    await c.seed([
      { __delayMs: 1500 }, call('write_file', { path: 'src/jennifer.txt', content: 'asked for by Jennifer' }),
      // The loop stops at that call, so the next round is the decision's.
      call('take_up', { postId: j1 }),
      call('write_file', { path: 'src/austen.txt', content: 'asked for in the edit' }),
      call('mark_complete', {}, 'Done with the edited request.'),
    ]);
    await post(c.j, j1, 'Write me a file.');
    await turnUnderWay(scope);
    // Austen rewrites Jennifer's post while Jennifer's turn waits on the model.
    await rewrite(c.a, j1, 'Austen\'s words now.');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(2), { timeout: 20_000 });

    const messages = await agentMessages(c.j, sub.resourceIds);
    // The stopped turn's message: our own line, answering nothing.
    const stopped = valueOf(messages.get(POST_MOVED)!);
    expect([stopped.replyTo, stopped.answers]).toEqual([undefined, undefined]);
    expect(stopped.codegen.toolCalls).toEqual([]);
    await expect(c.j.lmz.callAsync('GALAXY', scope, c.j.ctn<Galaxy>().readSource('src/jennifer.txt'))).rejects.toThrow();
    // The edit started nothing of its own: the one turn after it came from the decision.
    expect(turnLines(scope, 'took up').map((l) => [l.postId, (l.claims as { sub: string }).sub])).toEqual([[j1, c.jSub], [j1, c.aSub]]);
    expect(turnLines(scope, 'decision').map((l) => l.postId)).toEqual([j1]);
    // The edited post, worked under its editor, and answered.
    const done = valueOf(messages.get('Done with the edited request.')!);
    expect(done.codegen.toolCalls.filter((tc) => tc.name === 'write_file').map((tc) => [tc.post, tc.claims?.sub])).toEqual([[j1, c.aSub]]);
    expect([done.replyTo, done.answers]).toEqual([j1, [j1]]);
    expect(await c.waiting()).toEqual([]);
    c.dispose();
  });

  // The tools never look when a turn calls none, so the close does.
  // Mutation: skip the comparison as the closing message commits → the turn's message answers
  // the post, and the decision's spare round is never used.
  it('is caught at the close when the turn called no tool: its message answers nothing, though the model named the post', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const j1 = crypto.randomUUID();
    await c.seed([
      { __delayMs: 1500 }, call('mark_complete', { answers: [j1] }, 'Here is my answer.'),
      call('mark_complete', { answers: [j1] }, 'And to what you wrote instead.'),
    ]);
    await post(c.j, j1, 'A question.');
    await turnUnderWay(scope);
    await rewrite(c.j, j1, 'A different question.');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(2), { timeout: 20_000 });

    const messages = await agentMessages(c.j, sub.resourceIds);
    const first = valueOf(messages.get(`Here is my answer.\n\n${POST_MOVED}`)!);
    expect([first.replyTo, first.answers]).toEqual([undefined, undefined]);
    // The decision that followed answered the post as it now reads.
    expect(valueOf(messages.get('And to what you wrote instead.')!).answers).toEqual([j1]);
    expect(await c.waiting()).toEqual([]);
    c.dispose();
  });

  // Mutation: compare only at tool calls → the write before the edit lands, and the message that
  // follows answers a post whose words changed after it.
  it('is caught at the close when the edit came after the turn\'s last tool call', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const j1 = crypto.randomUUID();
    await c.seed([
      call('write_file', { path: 'src/first.txt', content: 'before the edit' }),
      { __delayMs: 1500 }, call('mark_complete', {}, 'Done.'),
      call('mark_complete', { answers: [j1] }, 'Noted, as it reads now.'),
    ]);
    await post(c.j, j1, 'Write me a file.');
    const wrote = () => entries.some((e) => e.namespace === 'nebula.Galaxy.writeSource' && e.data?.instanceName === scope && e.data?.path === 'src/first.txt');
    await vi.waitFor(() => expect(wrote()).toBe(true), { timeout: 10_000 });
    await rewrite(c.j, j1, 'Write me two files.');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(2), { timeout: 20_000 });

    const first = valueOf((await agentMessages(c.j, sub.resourceIds)).get(`Done.\n\n${POST_MOVED}`)!);
    expect([first.replyTo, first.answers]).toEqual([undefined, undefined]);
    // The write made before the edit stands: it ran under the snapshot the turn had read.
    expect(first.codegen.toolCalls.map((tc) => [tc.name, tc.error])).toContainEqual(['write_file', undefined]);
    c.dispose();
  });

  // A deleted post has no words left to answer, and nothing waits.
  // Mutation: treat a missing post as unchanged at the close → the message replies to a post
  // that is gone.
  it('a post deleted while its turn runs is answered by nothing, and no decision follows', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const j1 = crypto.randomUUID();
    await c.seed([{ __delayMs: 1500 }, say('Here is my answer.'), say('a round only a needless decision would use')]);
    await post(c.j, j1, 'A question.');
    await turnUnderWay(scope);
    const current = await c.j.resources.read('Message', j1) as Snapshot;
    expect((await c.j.resources.transaction({ [j1]: { op: 'delete', typeName: 'Message', ifValidFromMatches: current.meta.validFrom } })).kind).toBe('committed');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(1), { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 1200));

    const [[text, only]] = [...(await agentMessages(c.j, sub.resourceIds))];
    expect(text).toBe(`Here is my answer.\n\n${POST_MOVED}`);
    expect([valueOf(only!).replyTo, valueOf(only!).answers]).toEqual([undefined, undefined]);
    expect(turnLines(scope, 'decision')).toEqual([]);
    c.dispose();
  });

  // The decision reads the thread once, and the snapshot it offers is the one its turn names.
  // Mutation: read the thread again for the `validFrom` after the pick → the stale write lands.
  it('an edit while the decision\'s model call is pending stops the picked turn at its first tool call', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const [j1, a1] = [crypto.randomUUID(), crypto.randomUUID()];
    await c.seed([
      { __delayMs: 1500 }, say('A draft for Jennifer.'), say('Done, Jennifer.'),
      { __delayMs: 1500 }, call('take_up', { postId: a1 }),
      call('write_file', { path: 'src/stale.txt', content: 'for words since replaced' }),
      call('take_up', { postId: a1 }),
      call('write_file', { path: 'src/fresh.txt', content: 'for the words as they read now' }),
      call('mark_complete', {}, 'Done, Austen.'),
    ]);
    await post(c.j, j1, 'First request.');
    await turnUnderWay(scope);
    await post(c.a, a1, 'Austen\'s request.');
    // The decision's request has gone out and its model call is pending.
    await vi.waitFor(() => expect(turnLines(scope, 'request').filter((l) => l.step === 'decision')).toHaveLength(1), { timeout: 15_000 });
    await rewrite(c.a, a1, 'Austen\'s request, reworded.');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).has('Done, Austen.')).toBe(true), { timeout: 25_000 });

    await expect(c.j.lmz.callAsync('GALAXY', scope, c.j.ctn<Galaxy>().readSource('src/stale.txt'))).rejects.toThrow();
    expect(await c.j.lmz.callAsync('GALAXY', scope, c.j.ctn<Galaxy>().readSource('src/fresh.txt'))).toBe('for the words as they read now');
    expect(turnLines(scope, 'decision').map((l) => l.postId)).toEqual([a1, a1]);
    c.dispose();
  });
});

describe('a decision may pick only a post it was offered', () => {
  // Mutation: pass the model's id on without checking it against the waiting posts → a turn
  // starts on a post already answered, and then on the agent's own message.
  it('a pick of an answered post, or of the agent\'s own message, is refused and starts no turn', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const [j1, a1, a2] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await c.seed([
      { __delayMs: 1500 }, say('A draft for Jennifer.'), say('Done, Jennifer.'),
      // Austen's post waits; the decision names Jennifer's, which "Done, Jennifer." answered.
      call('take_up', { postId: j1 }),
    ]);
    await post(c.j, j1, 'First request.');
    await turnUnderWay(scope);
    await post(c.a, a1, 'Austen\'s request.');
    await vi.waitFor(() => expect(turnLines(scope, 'decision')).toHaveLength(1), { timeout: 20_000 });
    expect(turnLines(scope, 'decision').map((l) => [l.postId, l.refusedPick])).toEqual([[null, j1]]);

    // A second decision, which names the agent's own message.
    const agentMessage = [...(await agentMessages(c.j, sub.resourceIds)).values()][0]!;
    const agentMessageId = sub.resourceIds.find((id) => id !== j1 && id !== a1)!;
    expect(agentMessage.meta.recordedClaims.sub).toBe(NEBULA_SUB);
    await c.seed([say('Hello again, Austen.'), call('take_up', { postId: agentMessageId })]);
    await post(c.a, a2, 'Hello?');
    await vi.waitFor(() => expect(turnLines(scope, 'decision')).toHaveLength(2), { timeout: 20_000 });
    expect(turnLines(scope, 'decision')[1]).toMatchObject({ postId: null, refusedPick: agentMessageId });
    // Two turns took a post up, one for each post that started one. Neither refused pick did.
    expect(turnLines(scope, 'took up').map((l) => l.postId)).toEqual([j1, a2]);
    c.dispose();
  });
});

describe('a turn that ends after posts arrived mid-turn closes by reading them', () => {
  // Mutations: skip the closing step → no line, and the turn's draft is its message; send the
  // step the loop's tools → its request lists `write_file`; drop the posts the closing message
  // names → Austen's post still waits, and a decision uses the spare round.
  it('a closing message that names both posts answers both, and no decision follows', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const [j1, a1] = [crypto.randomUUID(), crypto.randomUUID()];
    await c.seed([
      { __delayMs: 1500 }, say('A draft for Jennifer.'),
      call('mark_complete', { answers: [a1] }, 'Done, Jennifer. Austen, yours conflicts with it, so I held it.'),
      say('a round only a needless decision would use'),
    ]);
    await post(c.j, j1, 'Sort by when items were added.');
    await turnUnderWay(scope);
    await post(c.a, a1, 'Sort by name instead.');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(1), { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 1200));

    // The step names the post that arrived, and is offered a message and nothing that acts.
    expect(turnLines(scope, 'closing step').map((l) => [l.postId, l.posts])).toEqual([[j1, [a1]]]);
    expect(turnLines(scope, 'request').map((l) => [l.step, l.tools])).toEqual([
      ['turn', ['read_file', 'write_file', 'edit_file', 'build', 'invite', 'mark_complete']],
      ['closing', ['mark_complete']],
    ]);
    // Its message replaced the draft, and answers the post the turn took up and the one it named.
    const messages = await agentMessages(c.j, sub.resourceIds);
    expect([...messages.keys()]).toEqual(['Done, Jennifer. Austen, yours conflicts with it, so I held it.']);
    expect(messages.values().next().value!.value).toMatchObject({ replyTo: j1, answers: [j1, a1] });
    expect(await c.waiting()).toEqual([]);
    expect(turnLines(scope, 'decision')).toEqual([]);
    c.dispose();
  });

  // Mutation: count every post the closing step read as answered → nothing waits, no decision
  // runs, and Austen's post is never taken up.
  it('a closing message that names only the turn\'s own post leaves the other waiting, and a decision takes it up', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const [j1, a1] = [crypto.randomUUID(), crypto.randomUUID()];
    await c.seed([
      { __delayMs: 1500 }, say('A draft for Jennifer.'), say('Done, Jennifer.'),
      call('take_up', { postId: a1 }), say('Done, Austen.'),
    ]);
    await post(c.j, j1, 'Sort by when items were added.');
    await turnUnderWay(scope);
    await post(c.a, a1, 'Add a search box.');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(2), { timeout: 20_000 });

    expect(turnLines(scope, 'closing step').map((l) => l.posts)).toEqual([[a1]]);
    expect(turnLines(scope, 'decision').map((l) => l.postId)).toEqual([a1]);
    expect(turnLines(scope, 'took up').map((l) => l.postId)).toEqual([j1, a1]);
    const messages = await agentMessages(c.j, sub.resourceIds);
    expect((messages.get('Done, Jennifer.')!.value as { answers?: string[] }).answers).toEqual([j1]);
    expect((messages.get('Done, Austen.')!.value as { answers?: string[] }).answers).toEqual([a1]);
    c.dispose();
  });
});

describe('a closing step that names a post and writes no message', () => {
  // Mutation: take the posts a wordless closing step names as answered → Austen's post is
  // answered by a draft written before the model saw it, and no decision takes it up.
  it('answers nothing more: the turn\'s own reply stands, and the named post waits for a decision', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const [j1, a1] = [crypto.randomUUID(), crypto.randomUUID()];
    await c.seed([
      { __delayMs: 1500 }, say('A draft for Jennifer.'),
      call('mark_complete', { answers: [a1] }),
      call('take_up', { postId: a1 }), say('Done, Austen.'),
    ]);
    await post(c.j, j1, 'Sort by when items were added.');
    await turnUnderWay(scope);
    await post(c.a, a1, 'Add a search box.');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(2), { timeout: 20_000 });

    expect(turnLines(scope, 'closing step').map((l) => l.posts)).toEqual([[a1]]);
    const messages = await agentMessages(c.j, sub.resourceIds);
    expect((messages.get('A draft for Jennifer.')!.value as { answers?: string[] }).answers).toEqual([j1]);
    expect(turnLines(scope, 'decision').map((l) => l.postId)).toEqual([a1]);
    expect((messages.get('Done, Austen.')!.value as { answers?: string[] }).answers).toEqual([a1]);
    c.dispose();
  });
});

describe('each source commit names whose authority it used', () => {
  // Mutations: leave the claims off a tool call's record → the entry has no `claims`; record the
  // full projection → `access` and `aud` reach every subscriber; commit a turn's write as the
  // person alone → the committer is Austen; commit every write as the agent → her direct write
  // names the agent as its committer.
  it('a turn\'s write records the post and the claims it ran under, and its commit names the person and the agent; a direct write names its caller alone', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const a1 = crypto.randomUUID();
    const head = () => c.j.lmz.callAsync('GALAXY', scope, c.j.ctn<GalaxyTest>().headCommitForTest()) as Promise<{ oid: string; author: string; committer: string }>;
    await c.seed([
      call('write_file', { path: 'src/austen.txt', content: 'asked for by Austen' }),
      call('mark_complete', {}, 'Done, Austen.'),
    ]);
    await post(c.a, a1, 'Write me a file.');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(1), { timeout: 15_000 });

    // The record on the agent's message: which post the call acted for, and whose claims it ran
    // under, with nothing a client must not be sent.
    const reply = (await agentMessages(c.j, sub.resourceIds)).get('Done, Austen.')!;
    const [write] = (reply.value as { codegen: { toolCalls: Array<{ name: string; post?: string; claims?: object; result?: { oid?: string } }> } }).codegen.toolCalls;
    expect(write!.post).toBe(a1);
    expect(write!.claims).toEqual({ sub: c.aSub, profileId: c.aProfile, act: AGENT });
    // The commit that call made: Austen's authority, the agent's hand.
    const turnCommit = await head();
    expect(turnCommit.oid).toBe(write!.result!.oid);
    expect(turnCommit.author).toBe(`${c.aProfile}@profiles.lumenize.invalid`);
    expect(turnCommit.committer).toBe('agent@lumenize.invalid');

    // Austen's own direct write: she is both.
    const direct = await c.a.lmz.callAsync('GALAXY', scope, c.a.ctn<Galaxy>().writeSource('src/direct.txt', 'by hand')) as { oid: string };
    const directCommit = await head();
    expect(directCommit.oid).toBe(direct.oid);
    expect(directCommit.author).toBe(`${c.aProfile}@profiles.lumenize.invalid`);
    expect(directCommit.committer).toBe(`${c.aProfile}@profiles.lumenize.invalid`);
    c.dispose();
  });
});

describe('a post whose turn an eviction cut off', () => {
  // The post and the claims its write recorded are in storage, so nothing is lost with the
  // isolate. Mutations: keep the claims a turn acts under in a map in memory → the reset empties
  // it and the write is refused; let a decision consider only posts some turn has not started on
  // → Jennifer's post is never offered again.
  it('is taken up by the decision after the next post\'s turn, and worked under its own poster\'s recorded claims', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    const [j1, a1] = [crypto.randomUUID(), crypto.randomUUID()];
    await c.seed([{ __delayMs: 60_000 }]);
    await post(c.j, j1, 'Build me a wishlist.');
    await vi.waitFor(() => expect(turnLines(scope, 'took up')).toHaveLength(1));

    // The Galaxy is reset mid-turn: its storage stays, and everything it held in memory goes,
    // the hung turn and the latch among them.
    await (runInDurableObject as any)(env.GALAXY.getByName(scope), (_instance: unknown, ctx: DurableObjectState) => { ctx.abort('an eviction, in a test'); })
      .catch(() => { /* the abort rejects the call that made it */ });
    await vi.waitFor(() => { expect(c.j.connectionState).toBe('connected'); expect(c.a.connectionState).toBe('connected'); }, { timeout: 15_000 });
    await vi.waitFor(async () => expect(await c.waiting()).toEqual([j1]), { timeout: 15_000 });
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;

    await c.seed([
      say('Hello, Austen.'),
      call('take_up', { postId: j1 }),
      call('write_file', { path: 'src/wishlist.txt', content: 'asked for by Jennifer, before the reset' }),
      call('mark_complete', {}, 'Jennifer, your wishlist is built.'),
    ]);
    await post(c.a, a1, 'Hello?');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(2), { timeout: 20_000 });

    // Since the reset: Austen's post started a turn, and the decision after it took up Jennifer's.
    expect(turnLines(scope, 'took up').map((l) => [l.postId, l.claims])).toEqual([
      [j1, { sub: c.jSub, profileId: c.jProfile, act: AGENT }],
      [a1, { sub: c.aSub, profileId: c.aProfile, act: AGENT }],
      [j1, { sub: c.jSub, profileId: c.jProfile, act: AGENT }],
    ]);
    const built = (await agentMessages(c.j, sub.resourceIds)).get('Jennifer, your wishlist is built.')!;
    const value = built.value as { replyTo?: string; answers?: string[] } & ToolCalls;
    expect([value.replyTo, value.answers]).toEqual([j1, [j1]]);
    expect(value.codegen.toolCalls.filter((tc) => tc.name === 'write_file').map((tc) => [tc.post, tc.claims?.sub, tc.error])).toEqual([[j1, c.jSub, undefined]]);
    const commits = entries.filter((e) => e.namespace === 'nebula.Galaxy.writeSource' && e.data?.instanceName === scope)
      .map((e) => [e.data!.path, (e.data!.recordedClaims as { sub: string }).sub, (e.data!.recordedClaims as { act?: { sub: string } }).act?.sub]);
    expect(commits).toEqual([['src/wishlist.txt', c.jSub, NEBULA_SUB]]);
    expect(await c.j.lmz.callAsync('GALAXY', scope, c.j.ctn<Galaxy>().readSource('src/wishlist.txt'))).toBe('asked for by Jennifer, before the reset');
    expect(await c.waiting()).toEqual([]);
    c.dispose();
  });
});

describe('a turn the generation deadline cuts off', () => {
  // Mutations: start a decision when the deadline cuts a turn off → a decision's request follows
  // the deadline; forget which posts still have a turn running → a second turn starts on the
  // hung post; drop the trigger's check on a taken-up post → the edit below starts one too.
  it('starts no decision, an edit to its post starts no turn, and no later decision takes its post up again while it still runs', async () => {
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

    // Jennifer edits the post whose turn still hangs. A script is seeded, so a turn the edit
    // started would run and take the post up.
    await c.seed([say('a second turn on the hung post, started by the edit')]);
    const hung = await c.j.resources.read('Message', j1) as Snapshot;
    expect((await c.j.resources.transaction({
      [j1]: { op: 'put', typeName: 'Message', ifValidFromMatches: hung.meta.validFrom, value: { chat: DEFAULT_CHAT_ID, content: 'Reworded while it hangs.' } },
    })).kind).toBe('committed');
    await new Promise((r) => setTimeout(r, 600));
    expect(turnLines(scope, 'took up').map((l) => l.postId)).toEqual([j1]);

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

describe('the agent invites, under the claims of the post its turn took up', () => {
  // Mutations: send an admin invite through the node invite, which asks for no bit → the invitee
  // is a plain member; post the handler's message under the call it answers in, the inviter's →
  // it records Jennifer and starts a turn of its own.
  it('for an admin of the app, a collaborator invite and an admin invite both land, and only the admin invite\'s result is posted', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const [collaborator, admin] = [someone(), someone()];
    await c.seed([
      call('invite', { email: collaborator }),
      call('invite', { email: admin, scopeAdmin: true }),
      call('mark_complete', {}, 'Both invites are on their way.'),
    ]);
    await c.j.postUserMessage('Invite a collaborator and an admin.');
    // The turn's message, then the handler's post with the admin invite's result.
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(2), { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 1200));

    const messages = await agentMessages(c.j, sub.resourceIds);
    const calls = (messages.get('Both invites are on their way.')!.value as ToolCalls).codegen.toolCalls;
    expect(calls.map((tc) => [tc.name, tc.result?.as, tc.claims?.sub])).toEqual([
      ['invite', 'collaborator', c.jSub], ['invite', 'admin', c.jSub], ['mark_complete', undefined, undefined],
    ]);
    // A collaborator: a plain member of the app, and the admin of its `.dev` workspace.
    expect(await membershipsOf(collaborator)).toEqual([[scope, false], [`${scope}.dev`, true]]);
    // An admin: the app's admin bit.
    expect(await membershipsOf(admin)).toEqual([[scope, true], [`${scope}.dev`, true]]);
    // The handler's post is the agent's own, answers nothing and replies to nothing, and no turn
    // took it up: the only turn is the one on Jennifer's post.
    const outcome = messages.get(`${admin} is invited as an admin of this app. The email is on its way.`)!;
    expect(outcome.meta.recordedClaims).toMatchObject({ sub: NEBULA_SUB });
    expect(outcome.meta.recordedClaims.act).toBeUndefined();
    expect((outcome.value as { replyTo?: string; answers?: string[] }).replyTo).toBeUndefined();
    expect((outcome.value as { replyTo?: string; answers?: string[] }).answers).toBeUndefined();
    expect(turnLines(scope, 'took up')).toHaveLength(1);
    c.dispose();
  });

  // What we accept (the stored record's passage and dominion are as of posting): Morgan, an
  // admin of the app, asks for an invite, loses the admin bit at the Registry before the turn
  // reaches it, and the invite still lands, on the record as Morgan's with the agent as actor.
  // No product path demotes an admin yet, so the Registry's own method does it, as
  // `client-resources.test.ts` does. Morgan is an invited admin and not the account's founder:
  // demoting the founder leaves the account with no accepted founder, which refuses every
  // invite for a reason of its own. The mitigation for a customer who objects is a live check,
  // which would change this test on purpose.
  // Mutation, of the fixture: leave the demotion out → the Registry still shows the bit, and the
  // line that proves the demotion took reds.
  it('an invite lands under a record whose poster has lost the admin bit since posting', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    const morganEmail = `morgan-${crypto.randomUUID().slice(0, 8)}@example.com`;
    await createSubject(new Browser(), scope, c.jToken, morganEmail, { scopeAdmin: true });
    const morgan = await createInvitedClient(
      StudioClientTest, new Browser(), scope, scope, morganEmail, CHAT_MESSAGE_ONTOLOGY_VERSION, PAIR(scope),
    );
    expect(morgan.payload.access?.scopeAdmin).toBe(true);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const friend = someone();
    const adminAt = async () => (await membershipsOf(morganEmail)).find(([at]) => at === scope)?.[1];
    expect(await adminAt()).toBe(true);
    await c.seed([{ __delayMs: 1500 }, call('invite', { email: friend }), call('mark_complete', {}, 'Invited.')]);
    const m1 = await morgan.client.postUserMessage('Invite my friend as a collaborator.');
    await turnUnderWay(scope);
    await (env.AUTH_REGISTRY.getByName(REGISTRY_INSTANCE_NAME) as unknown as {
      setIdentityAdmin(sub: string, scopeAdmin: boolean, callerClaims: unknown): Promise<void>;
    }).setIdentityAdmin(morgan.payload.sub, false, c.j.claims);
    expect(await adminAt()).toBe(false);
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).has('Invited.')).toBe(true), { timeout: 20_000 });

    const [invite] = ((await agentMessages(c.j, sub.resourceIds)).get('Invited.')!.value as ToolCalls).codegen.toolCalls;
    expect([invite!.name, invite!.error, invite!.post, invite!.claims?.sub]).toEqual(['invite', undefined, m1, morgan.payload.sub]);
    await vi.waitFor(async () => expect((await membershipsOf(friend)).map(([at]) => at)).toEqual([scope, `${scope}.dev`]), { timeout: 15_000 });
    // Nothing was posted about a failure: the turn's message is the agent's only one.
    expect([...(await agentMessages(c.j, sub.resourceIds)).keys()]).toEqual(['Invited.']);
    morgan.client[Symbol.dispose]();
    c.dispose();
  });

  // Mutation: let an invite run under any waiting post whose poster is an admin → it runs under
  // Jennifer's, and Austen's friend is invited on Jennifer's authority.
  it('an invite in Austen\'s turn runs under Austen\'s claims, though Jennifer\'s post is waiting too, and is refused', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const [j1, a1, j2] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const friend = someone();
    await c.seed([
      { __delayMs: 1500 }, say('A draft for Jennifer.'), say('Done, Jennifer.'),
      call('take_up', { postId: a1 }),
      call('invite', { email: friend }),
      say('Austen, I cannot invite your friend: that needs an admin of the app.'),
      call('mark_complete', { answers: [j2] }, 'Jennifer, noted.'),
    ]);
    await post(c.j, j1, 'First request.');
    await turnUnderWay(scope);
    await post(c.a, a1, 'Please invite my friend.');
    await post(c.j, j2, 'A second request, so my post is waiting while Austen\'s turn runs.');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(3), { timeout: 20_000 });

    const reply = (await agentMessages(c.j, sub.resourceIds)).get('Austen, I cannot invite your friend: that needs an admin of the app.')!;
    expect((reply.value as ToolCalls).codegen.toolCalls[0]).toMatchObject({ name: 'invite', error: NOT_AN_ADMIN });
    // The refused call still records whose claims it ran under. Mutation: record a failed
    // call without them → `post` and `claims` are absent.
    const refused = (reply.value as ToolCalls).codegen.toolCalls[0]!;
    expect([refused.post, refused.claims?.sub]).toEqual([a1, c.aSub]);
    expect(await membershipsOf(friend)).toEqual([]);
    c.dispose();
  });

  // Mutation: drop the Galaxy's own check → the invite passes the chat node's `admin` gate, the
  // facade refuses it after the turn has ended, and the handler posts that refusal: a second
  // agent message, after the turn's.
  it('an inviter with admin at the chat node and no dominion is refused within the turn, by the Galaxy\'s own check', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    await c.j.lmz.callAsync('GALAXY', scope, c.j.ctn<Galaxy>().resources.orgTree.setPermission(CHAT_NODE_ID, c.aSub, 'admin'));
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const friend = someone();
    await c.seed([call('invite', { email: friend }), say('I cannot invite them: that needs an admin of the app.')]);
    await c.a.postUserMessage('Please invite my friend.');
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(1), { timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 1500));

    const messages = await agentMessages(c.j, sub.resourceIds);
    expect([...messages.keys()]).toEqual(['I cannot invite them: that needs an admin of the app.']);
    expect((messages.values().next().value!.value as ToolCalls).codegen.toolCalls[0]).toMatchObject({ name: 'invite', error: NOT_AN_ADMIN });
    expect(await membershipsOf(friend)).toEqual([]);
    c.dispose();
  });

  // Mutations: let a member of an app invite into it, as a member of a Star may → Austen's direct
  // call lands and her friend is an admin of the workspace; drop the post a failed node invite
  // makes → nothing tells the chat that the invite she was acknowledged for never happened.
  it('a member of the app is refused at the facade, and a node invite the facade refuses is posted to the chat', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    await c.j.lmz.callAsync('GALAXY', scope, c.j.ctn<Galaxy>().resources.orgTree.setPermission(CHAT_NODE_ID, c.aSub, 'admin'));
    using sub = c.j.resources.subscribeQuery(chatQuery); await sub.ready;
    const [direct, viaNode] = [someone(), someone()];
    const refusal = `Inviting into the app "${scope}" needs dominion over it, which a member of it does not hold: ask one of its admins`;

    // Straight to the facade: the app rule, by its own message.
    await expect(c.a.lmz.callAsync('AUTH_FACADE', undefined, c.a.ctn<AuthFacade>().invite(scope, [{ email: direct }])))
      .rejects.toThrow(refusal);
    expect(await membershipsOf(direct)).toEqual([]);

    // Through the node invite, whose own gate is DAG `admin` at the node, which Austen holds: it
    // acknowledges, the facade refuses afterwards, and the Galaxy posts that as the agent.
    const ack = await c.a.lmz.callAsync('GALAXY', scope,
      c.a.ctn<Galaxy>().resources.invite(CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID, [{ email: viaNode, tier: 'write' }]));
    expect(ack).toEqual({ accepted: 1, errors: [] });
    await vi.waitFor(async () => expect((await agentMessages(c.j, sub.resourceIds)).size).toBe(1), { timeout: 15_000 });
    const [[text, posted]] = [...(await agentMessages(c.j, sub.resourceIds))];
    expect(text).toBe(`I could not invite ${viaNode}: ${refusal}`);
    expect(posted!.meta.recordedClaims).toMatchObject({ sub: NEBULA_SUB });
    expect(await membershipsOf(viaNode)).toEqual([]);
    c.dispose();
  });
});
