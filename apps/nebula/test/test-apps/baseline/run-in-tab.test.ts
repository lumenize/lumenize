/**
 * The agent's `run_in_tab` reaches a Studio tab of the person its turn is working for, and no
 * other person's.
 *
 * Two people share one chat, each with Studio open: the app's owner, here Jennifer, and a
 * collaborator holding `write` at the chat node and no admin bit, here Austen. Every test drives
 * real clients, real Messages and the real commit hook, with only the model scripted
 * (`GalaxyTest.seedChatScriptForTest`), and each Studio answers a run with a handler the test
 * set, where the product's holds the preview's frames. That is why these run here and not
 * against a running stack: the real model cannot be made to call `run_in_tab` on demand, or to
 * call it while a tab is closing, so a gate on either could not fail there. `cast-from-a-tab`
 * runs the scene with the real model, a real browser and real frames.
 *
 * It is also where a node's call to a Client is seen answered both ways: with the Client's
 * value, and with its host's `ClientDisconnectedError` once the Client is gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { NEBULA_SUB } from '@lumenize/mesh/auth';
import { CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, DEFAULT_CHAT_ID } from '@lumenize/nebula';
import type { Galaxy } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/resources';
import type { RunAnswer } from '@lumenize/resources/frontend';
import { NO_STUDIO_TAB } from '../../../src/galaxy';
import { RUN_RESULT_MAX_CHARS } from '../../../src/codegen-loop';
import { universeAdminClient, createSubject, createInvitedClient, addressOfClient, pageOf, ORIGIN } from '../../test-helpers';
import { StudioClientTest } from './index';
import type { GalaxyTest } from './index';

const uniqueScope = () => `rit-${crypto.randomUUID().slice(0, 8)}.app`;
const PAIR = (scope: string) => ({ resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope });
const chatQuery = { typeName: 'Message', filter: { chat: DEFAULT_CHAT_ID } };

type SinkEntry = { namespace: string; level: string; message: string; data?: Record<string, unknown> };
let entries: SinkEntry[] = [];
beforeEach(() => { entries = []; setDebugSink((e) => entries.push(e as unknown as SinkEntry)); });
afterEach(() => clearDebugSink());

/** One model round that calls one tool, with `content` beside the call. */
const call = (name: string, args: object, content = '') => ({
  choices: [{ message: { content, reasoning_content: '', tool_calls: [
    { id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ] } }],
});

type Ran = [who: string, tab: string, code: string];
type ToolCall = { name: string; args?: Record<string, unknown>; result?: Record<string, unknown>; error?: string; claims?: { sub: string } };

/** A Studio tab for the session `browser` holds, as a second window of the same person would be. */
async function studioTab(browser: Browser, scope: string): Promise<StudioClientTest> {
  const ctx = browser.context(pageOf(scope));
  const client = new StudioClientTest({
    baseUrl: pageOf(scope), platformOrigin: ORIGIN, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
    fetch: ctx.fetch, WebSocket: ctx.WebSocket, sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
    ...PAIR(scope),
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'));
  return client;
}

/** Jennifer, who owns the app, and Austen, a collaborator with `write` at the chat node. */
async function cast(scope: string) {
  const jennifer = await universeAdminClient(
    StudioClientTest, new Browser(), scope, scope, `owner-${crypto.randomUUID().slice(0, 8)}@example.com`, CHAT_MESSAGE_ONTOLOGY_VERSION, PAIR(scope),
  );
  const austenEmail = `member-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await createSubject(new Browser(), scope, jennifer.accessToken, austenEmail);
  const austenBrowser = new Browser();
  const austen = await createInvitedClient(
    StudioClientTest, austenBrowser, scope, scope, austenEmail, CHAT_MESSAGE_ONTOLOGY_VERSION, PAIR(scope),
  );
  // The dangerous shape, asserted: two people at the chat floor, one of them with no dominion.
  expect(austen.payload.access?.scopeAdmin).toBeFalsy();
  await jennifer.client.lmz.callAsync('GALAXY', scope,
    jennifer.client.ctn<Galaxy>().resources.orgTree.setPermission(CHAT_NODE_ID, austen.payload.sub, 'write'));
  const j = jennifer.client;
  const a = austen.client;
  const ran: Ran[] = [];
  /** Have `client`'s Studio answer a run as `who`, with `answer` or the value `{ from: who }`. */
  const answers = (client: StudioClientTest, who: string, answer?: () => Promise<RunAnswer>) =>
    client.setRunInTab(async (tab, code) => { ran.push([who, tab, code]); return answer ? answer() : { ok: true, value: { from: who } }; });
  answers(j, 'jennifer');
  answers(a, 'austen');
  return {
    j, a, ran, answers, austenBrowser,
    jSub: jennifer.payload.sub as string, aSub: austen.payload.sub as string,
    seed: (script: unknown[]) => j.lmz.callAsync('GALAXY', scope, j.ctn<GalaxyTest>().seedChatScriptForTest(script)),
    chatRows: () => j.lmz.callAsync('GALAXY', scope, j.ctn<GalaxyTest>().querySubscriberAddressesForTest()) as Promise<string[]>,
  };
}

/** The tool calls on the agent message whose content is `content`, once it has landed. */
async function toolCallsOf(client: StudioClientTest, ids: () => readonly string[], content: string): Promise<ToolCall[]> {
  let found: Snapshot | undefined;
  await vi.waitFor(async () => {
    for (const id of ids()) {
      const snap = await client.resources.read('Message', id) as Snapshot | null;
      if (snap && snap.meta.recordedClaims.sub === NEBULA_SUB && (snap.value as { content: string }).content === content) found = snap;
    }
    expect(found).toBeDefined();
  }, { timeout: 20_000 });
  return (found!.value as { codegen: { toolCalls: ToolCall[] } }).codegen.toolCalls;
}

const turnUnderWay = (scope: string) => vi.waitFor(() => expect(entries.some((e) =>
  e.namespace === 'nebula.Galaxy.turn' && e.message === 'request' && e.data?.instanceName === scope && e.data?.step === 'turn')).toBe(true));

describe('run_in_tab runs in a Studio tab of the person the turn is working for', () => {
  // Mutations: drop the `sub` filter in `Resources.subscriberAddresses` → one of the two turns
  // runs in the other person's Studio; have the entry return before its handler answers → the
  // result is not the tab's value.
  it('each person\'s turn runs in their own Studio and nobody else\'s, and the tab\'s value is the tool\'s result', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using js = c.j.resources.subscribeQuery(chatQuery); await js.ready;
    using as = c.a.resources.subscribeQuery(chatQuery); await as.ready;

    // Both ways round, since which of two addresses sorts first is chance: with the filter gone,
    // both turns would land on whichever does.
    await c.seed([call('run_in_tab', { tab: 'me', code: 'return 1' }), call('mark_complete', {}, 'Ran for Austen.')]);
    await c.a.postUserMessage('Make my sample data.');
    const forAusten = await toolCallsOf(c.j, () => js.resourceIds, 'Ran for Austen.');
    expect(c.ran).toEqual([['austen', 'me', 'return 1']]);
    expect(forAusten[0]).toMatchObject({ name: 'run_in_tab', result: { ok: true, value: { from: 'austen' } }, claims: { sub: c.aSub } });
    expect(forAusten[0]!.error).toBeUndefined();

    await c.seed([call('run_in_tab', { tab: 'gerry', code: 'return 2' }), call('mark_complete', {}, 'Ran for Jennifer.')]);
    await c.j.postUserMessage('Make Gerry\'s sample data.');
    const forJennifer = await toolCallsOf(c.j, () => js.resourceIds, 'Ran for Jennifer.');
    expect(c.ran).toEqual([['austen', 'me', 'return 1'], ['jennifer', 'gerry', 'return 2']]);
    expect(forJennifer[0]).toMatchObject({ name: 'run_in_tab', result: { ok: true, value: { from: 'jennifer' } }, claims: { sub: c.jSub } });
    c.j[Symbol.dispose](); c.a[Symbol.dispose]();
  });

  // Mutations: have `runAnswerOf` throw on `{ ok: false }` → that call carries `error` and no
  // `result`; have it pass any answer through → the malformed one is recorded as a result; drop
  // `clipRunResult` → the long value arrives whole.
  it('code that throws is a result the model reads, Studio\'s own failure is a tool error, and a long value is clipped', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using js = c.j.resources.subscribeQuery(chatQuery); await js.ready;
    const long = 'x'.repeat(RUN_RESULT_MAX_CHARS + 500);
    const replies: Array<() => Promise<RunAnswer>> = [
      async () => ({ ok: false, error: 'ReferenceError: nope is not defined' }),
      async () => { throw new Error('the tab "gerry" did not answer in 20 s'); },
      async () => ({ ok: true, value: long }),
      // A Studio is a person's own browser, so its answer is read as data: one in neither form
      // the page gives is refused, where passed on it would skip the clip.
      async () => ({ ok: 'yes', value: long }) as unknown as RunAnswer,
    ];
    c.answers(c.j, 'jennifer', () => replies.shift()!());
    await c.seed([
      call('run_in_tab', { tab: 'me', code: 'return nope' }),
      call('run_in_tab', { tab: 'gerry', code: 'return 1' }),
      call('run_in_tab', { tab: 'me', code: 'return long' }),
      call('run_in_tab', { tab: 'me', code: 'return odd' }),
      call('mark_complete', {}, 'Four runs.'),
    ]);
    await c.j.postUserMessage('Try four things.');
    const [threw, silent, clipped, odd] = await toolCallsOf(c.j, () => js.resourceIds, 'Four runs.');
    expect([threw!.result, threw!.error]).toEqual([{ ok: false, error: 'ReferenceError: nope is not defined' }, undefined]);
    expect([silent!.result, silent!.error]).toEqual([undefined, 'the tab "gerry" did not answer in 20 s']);
    expect(clipped!.result).toMatchObject({ ok: true, clipped: true });
    expect((clipped!.result!.json as string).length).toBe(RUN_RESULT_MAX_CHARS);
    expect(clipped!.result!.note).toContain(`${long.length + 2} characters`);
    expect([odd!.result, odd!.error]).toEqual([undefined, 'the Studio tab answered in a form run_in_tab does not read']);
    c.j[Symbol.dispose](); c.a[Symbol.dispose]();
  });

  // Austen posts from a client that never opened the chat, so no subscriber row is his, while
  // Jennifer's Studio is open on the same chat.
  // Mutation: fall back to any subscriber when the person has none → Jennifer's Studio runs it.
  it('with no Studio tab of the poster\'s open, the tool says so and nobody else\'s tab runs the code', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    using js = c.j.resources.subscribeQuery(chatQuery); await js.ready;
    await c.seed([call('run_in_tab', { tab: 'me', code: 'return 1' }), call('mark_complete', {}, 'Could not run it.')]);
    await c.a.postUserMessage('Make my sample data.');
    const [run] = await toolCallsOf(c.j, () => js.resourceIds, 'Could not run it.');
    expect([run!.name, run!.result, run!.error]).toEqual(['run_in_tab', undefined, NO_STUDIO_TAB]);
    expect(c.ran).toEqual([]);
    c.j[Symbol.dispose](); c.a[Symbol.dispose]();
  });

  // Austen has Studio open in two windows, and the one whose address sorts first closes while
  // the turn is thinking. Its subscriber row is still there when the tool runs, since nothing was
  // pushed to it in between, so the Galaxy calls it, hears from its own Gateway that it is gone,
  // and asks the other.
  // Mutations: throw on `ClientDisconnectedError` where the entry passes over → the tool errors
  // and the second window never runs; of the test, close no window → the pass-over line is absent.
  it('a tab that has gone is passed over for the person\'s next one', async () => {
    const scope = uniqueScope();
    const c = await cast(scope);
    const a2 = await studioTab(c.austenBrowser, scope);
    c.answers(a2, 'austen-2');
    c.answers(c.a, 'austen-1');
    using js = c.j.resources.subscribeQuery(chatQuery); await js.ready;
    const s1 = c.a.resources.subscribeQuery(chatQuery); await s1.ready;
    const s2 = a2.resources.subscribeQuery(chatQuery); await s2.ready;
    const [first, second] = [c.a, a2].sort((x, y) => addressOfClient(x) < addressOfClient(y) ? -1 : 1);
    const nameOf = (client: StudioClientTest) => client === c.a ? 'austen-1' : 'austen-2';

    await c.seed([{ __delayMs: 1500 }, call('run_in_tab', { tab: 'me', code: 'return 1' }), call('mark_complete', {}, 'Ran in the open window.')]);
    await second!.postUserMessage('Make my sample data.');
    await turnUnderWay(scope);
    first![Symbol.dispose]();
    // The closed window's row is still there for the tool to find.
    expect(await c.chatRows()).toContain(addressOfClient(first!));

    const [run] = await toolCallsOf(c.j, () => js.resourceIds, 'Ran in the open window.');
    expect(run).toMatchObject({ name: 'run_in_tab', result: { ok: true, value: { from: nameOf(second!) } } });
    expect(c.ran).toEqual([[nameOf(second!), 'me', 'return 1']]);
    expect(entries.filter((e) => e.namespace === 'nebula.Galaxy.runInTab' && e.message === 'passed over a tab its host reported gone')
      .map((e) => e.data?.address)).toEqual([addressOfClient(first!)]);
    c.j[Symbol.dispose](); second![Symbol.dispose]();
  });
});
