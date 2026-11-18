/**
 * A running turn is on record: its row before its first model call, each round as the reply
 * arrives and as each call lands, and only the turn's summary on its `Message`.
 *
 * vitest-plugin with the model scripted, for what the real model cannot be made to do on cue: a
 * reply held at a chosen round, a build held while an admin writes over its round. The turn's row
 * and the Workspace's blobs are rows no client sees. Every person here logs in through the real
 * Registry (ADR-009 rung 2). `rounds-as-they-land` reads a real turn's rounds in `/live`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import type { Snapshot, TransactionResult, QueryReadResult } from '@lumenize/resources';
import { CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID, DEFAULT_CHAT_ID, TURNS_NODE_ID, deriveKind } from '@lumenize/nebula';
import type { Galaxy } from '@lumenize/nebula';
import { roundsOf } from '../../../src/participants';
import { universeAdminClient, createInvitedClient, turnCallsOf } from '../../test-helpers';
import { NebulaClientTest, StudioClientTest } from './index';
import type { GalaxyTest } from './index';

const V = CHAT_MESSAGE_ONTOLOGY_VERSION;
const uniqueGalaxy = () => `ts-${crypto.randomUUID().slice(0, 8)}.app`;
const email = (tag: string) => `${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const chatQuery = { typeName: 'Message', filter: { chat: DEFAULT_CHAT_ID } };
const toolCall = (name: string, args: unknown, id: string) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (calls: unknown[], content = '') => ({ choices: [{ message: { content, reasoning_content: '', tool_calls: calls } }] });
const ROUND_CONFLICT = 'Someone else changed my record of this turn while I worked, so I stopped. Ask again and I will start over.';

const entries: Array<{ namespace: string; message: string; data?: Record<string, unknown> }> = [];
beforeEach(() => { entries.length = 0; setDebugSink((entry) => { entries.push(entry as never); }); });
afterEach(() => clearDebugSink());
const held = (scope: string, what: 'model call held' | 'build held', call?: number) => vi.waitFor(() => expect(entries.some((e) =>
  e.namespace === 'nebula.GalaxyTest.hold' && e.message === what && e.data?.instanceName === scope && (call === undefined || e.data?.call === call))).toBe(true), { timeout: 15_000 });

/** An app's admin on its Galaxy's page, with the chat ontology installed and a chat subscription. */
async function app() {
  const scope = uniqueGalaxy();
  const { client: admin } = await universeAdminClient(
    StudioClientTest, new Browser(), scope, scope, email('admin'), V,
    { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
  );
  const probe = (remote: (g: any) => unknown): Promise<any> =>
    admin.lmz.callAsync('GALAXY', scope, remote(admin.ctn<GalaxyTest>()) as never);
  const thread = admin.resources.subscribeQuery(chatQuery);
  await thread.ready;
  /** The agent message that replies to `post`, once it has committed, with its id. */
  const replyTo = async (post: string, timeout = 15_000): Promise<Snapshot & { id: string }> => {
    let found: (Snapshot & { id: string }) | undefined;
    await vi.waitFor(async () => {
      for (const id of thread.resourceIds) {
        const snap = await admin.resources.read('Message', id) as Snapshot | null;
        if (snap && deriveKind(snap.meta.recordedClaims) === 'agent' && (snap.value as { replyTo?: string }).replyTo === post) found = { ...snap, id };
      }
      expect(found).toBeDefined();
    }, { timeout });
    return found!;
  };
  const rounds = async (message: string) => (await admin.lmz.callAsync('GALAXY', scope,
    admin.ctn<Galaxy>().resources.query(V, roundsOf(message))) as QueryReadResult).snapshots;
  return { scope, admin, probe, thread, replyTo, rounds, dispose: () => { thread[Symbol.dispose](); admin[Symbol.dispose](); } };
}

describe('a turn is stored as a row and its rounds', { timeout: 90_000 }, () => {
  // MUTATION: store a round without its provider call (`raw`), and the per-round run rebuilds
  // nothing it can send.
  it('runs round by round through the Galaxy\'s own store, sending the model what a straight run sends', async () => {
    const script = [
      reply([toolCall('read_file', { path: 'AGENTS.md' }, 'r1')], 'reading'),
      reply([toolCall('build', {}, 'b1')], 'building'),
      reply([{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{ not json' } }], 'oops'),
      reply([toolCall('read_file', { path: 'src/App.vue' }, 'r2')], 'again'),
      reply([toolCall('mark_complete', {}, 'c1')], 'done'),
    ];
    const runs: Array<{ out: { stop: string; invocations: number; params: unknown[] }; seen: unknown[][] }> = [];
    for (const perRound of [false, true]) {
      const a = await app();
      await a.probe((g) => g.setBuildFaultsForTest({ findings: ['src/App.vue(1,1): error TS2339: Property x does not exist.'] }));
      const out = await a.probe((g) => g.runOverStoreForTest(crypto.randomUUID(), 'look around', script, perRound));
      runs.push({ out, seen: await a.probe((g) => g.takeSeenMessagesForTest()) });
      a.dispose();
    }
    const [straight, byRound] = runs as [typeof runs[0], typeof runs[0]];
    expect([straight.out.stop, byRound.out.stop]).toEqual(['complete', 'complete']);
    expect([straight.out.invocations, byRound.out.invocations]).toEqual([1, 5]);
    expect(byRound.seen).toHaveLength(5);
    expect(byRound.seen).toEqual(straight.seen);
    expect(byRound.out.params).toEqual(straight.out.params);
  });

  // MUTATIONS: write the row after the first model call → the held call finds none; leave the
  // row at the commit → its key is still there.
  it('writes the row before the first model call, stores each round as it lands, and keeps only the summary on the message', async () => {
    const a = await app();
    // A collaborator, invited at the chat node, which brings `read` at the turns node.
    const memberEmail = email('collab');
    expect(await a.admin.lmz.callAsync('GALAXY', a.scope, a.admin.ctn<Galaxy>().resources.invite(V, CHAT_NODE_ID, [{ email: memberEmail, tier: 'write' }])))
      .toEqual({ accepted: 1, errors: [] });
    const { client: member } = await createInvitedClient(NebulaClientTest, new Browser(), a.scope, a.scope, memberEmail, V, { resourceHostBinding: 'GALAXY' });

    await a.probe((g) => g.seedChatScriptForTest([
      reply([toolCall('read_file', { path: 'AGENTS.md' }, 'r1')], 'one'),
      reply([toolCall('read_file', { path: 'src/App.vue' }, 'r2'), toolCall('build', {}, 'b1')], 'two'),
      reply([toolCall('mark_complete', {}, 'c1')], 'Looked around.'),
    ]));
    await a.probe((g) => g.holdModelCallForTest(1));
    const posted = await a.admin.postUserMessage('Look around the app.');
    await held(a.scope, 'model call held', 1);

    const row = await a.probe((g) => g.turnRowForTest()) as { prompt: unknown[]; post: { id: string }; message: string; read: Record<string, string>; sourceCommit?: string; interrupted: number[] };
    expect(row.post.id).toBe(posted);
    expect(row.prompt).toHaveLength(2);
    expect(Object.keys(row.read)).toContain(posted);
    expect(typeof row.sourceCommit).toBe('string');
    expect(row.interrupted).toEqual([]);
    expect(await a.rounds(row.message)).toEqual([]);

    await a.probe((g) => g.holdModelCallForTest(3));
    await a.probe((g) => g.releaseForTest());
    await held(a.scope, 'model call held', 3);
    // Mid-turn, a collaborator reads the first two rounds, each call with whose claims it ran under.
    const calls = await turnCallsOf(member, a.scope, row.message);
    expect(calls.map((c) => [c.round, c.name, c.post, c.claims?.sub])).toEqual([
      [1, 'read_file', posted, a.admin.claims!.sub], [2, 'read_file', posted, a.admin.claims!.sub], [2, 'build', posted, a.admin.claims!.sub],
    ]);

    await a.probe((g) => g.releaseForTest());
    const message = await a.replyTo(posted);
    expect(message.id).toBe(row.message);
    expect(await a.probe((g) => g.turnRowForTest())).toBeUndefined();
    const codegen = (message.value as { codegen: Record<string, unknown> }).codegen;
    expect('toolCalls' in codegen).toBe(false);
    expect(codegen.rounds).toBe((await a.rounds(row.message)).length);
    expect(codegen.rounds).toBe(3);
    member[Symbol.dispose]();
    a.dispose();
  });

  // MUTATION: record a read by a blob of something other than its content, and neither id reads
  // back as what the model was sent.
  it('records two different blob ids for a file read before and after a write of it, each the content the model was sent', async () => {
    const a = await app();
    await a.probe((g) => g.seedChatScriptForTest([
      reply([toolCall('read_file', { path: 'src/App.vue' }, 'r1')], 'reading'),
      reply([toolCall('write_file', { path: 'src/App.vue', content: '<template><p>changed</p></template>\n' }, 'w1')], 'writing'),
      reply([toolCall('read_file', { path: 'src/App.vue' }, 'r2')], 'reading again'),
      reply([toolCall('mark_complete', {}, 'c1')], 'Changed it.'),
    ]));
    const posted = await a.admin.postUserMessage('Change the app.');
    const message = await a.replyTo(posted);
    const reads = (await turnCallsOf(a.admin, a.scope, message.id)).filter((c) => c.name === 'read_file')
      .map((c) => (c.result as { oid: string }).oid);
    expect(reads).toHaveLength(2);
    expect(reads[0]).not.toBe(reads[1]);
    const sent = (await a.probe((g) => g.takeSeenMessagesForTest()) as Array<Array<{ role: string; tool_call_id?: string; content: string }>>).at(-1)!;
    const told = (id: string) => (JSON.parse(sent.find((m) => m.role === 'tool' && m.tool_call_id === id)!.content) as { content: string }).content;
    expect(await a.probe((g) => g.readBlobForTest(reads[0]))).toBe(told('r1'));
    expect(await a.probe((g) => g.readBlobForTest(reads[1]))).toBe(told('r2'));
    expect(told('r2')).toBe('<template><p>changed</p></template>\n');
    a.dispose();
  });

  // MUTATION: retry a conflicted round write on the version read back, and the turn runs on.
  it('ends the turn in the fixed line, with the row gone, when an admin writes over a round between two of its calls', async () => {
    const a = await app();
    await a.probe((g) => g.seedChatScriptForTest([
      reply([toolCall('write_file', { path: 'src/a.txt', content: 'a' }, 'w1'), toolCall('build', {}, 'b1')], 'writing'),
      reply([toolCall('mark_complete', {}, 'c1')], 'Built.'),
    ]));
    await a.probe((g) => g.holdNextBuildForTest());
    const posted = await a.admin.postUserMessage('Write and build.');
    await held(a.scope, 'build held');
    const row = await a.probe((g) => g.turnRowForTest()) as { message: string };
    const [round] = await a.rounds(row.message);
    const overwritten = await a.admin.lmz.callAsync('GALAXY', a.scope, a.admin.ctn<Galaxy>().resources.transaction(V, {
      [round!.resourceId]: { op: 'put', ifValidFromMatches: round!.meta.validFrom, value: { ...(round!.value as object), text: 'an admin was here' } },
    })) as TransactionResult;
    expect(overwritten.ok).toBe(true);
    await a.probe((g) => g.releaseForTest());

    const message = await a.replyTo(posted);
    expect((message.value as { content: string }).content).toContain(ROUND_CONFLICT);
    expect((message.value as { codegen: { stop: string } }).codegen.stop).toBe('conflict');
    expect(await a.probe((g) => g.turnRowForTest())).toBeUndefined();

    await a.probe((g) => g.seedChatScriptForTest([reply([], 'A fresh turn.')]));
    const again = await a.admin.postUserMessage('Try again.');
    expect((await a.replyTo(again)).value).toMatchObject({ content: 'A fresh turn.' });
    a.dispose();
  });

  it('reads a turn\'s rounds by its message with more than a thousand rounds of other turns in the app', async () => {
    const a = await app();
    const other = crypto.randomUUID();
    const ops = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [crypto.randomUUID(), {
      op: 'create', typeName: 'Round', nodeId: TURNS_NODE_ID,
      value: { chat: DEFAULT_CHAT_ID, message: other, index: i + 1, text: `round ${i + 1}`, calls: [] },
    }]));
    expect((await a.probe((g) => g.writeAsAgentForTest(ops)) as TransactionResult).ok).toBe(true);
    await a.probe((g) => g.seedChatScriptForTest([reply([toolCall('read_file', { path: 'AGENTS.md' }, 'r1')], 'reading'), reply([], 'Read it.')]));
    const posted = await a.admin.postUserMessage('Read the guide.');
    const message = await a.replyTo(posted);
    const rounds = await a.rounds(message.id);
    expect(rounds.map((r) => (r.value as { index: number }).index).sort()).toEqual([1, 2]);
    expect((await a.rounds(other)).length).toBe(1000);
    a.dispose();
  });
});
