/**
 * A Galaxy builds its own tree at every start: the chat's nodes, created only where absent, and
 * the agent's `write` at `chat`, written back where it is missing or lower.
 *
 * vitest-plugin for what no Client can see or do: the rows a start writes, which only a trigger
 * inside the Galaxy's storage can count; a start on cue, made with `ctx.abort()`, which this lane
 * survives with storage kept as a deployed eviction does; and a tree whose rows are edited in
 * storage, to stand for a node a later deploy adds. A reset drops every socket, so the tree a
 * start pushes is the `/live` scenario `galaxy-builds-its-tree`'s to hold. Every person here logs
 * in through the real Registry (ADR-009 rung 2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { ROOT_NODE_ID } from '@lumenize/resources';
import type { TransactionResult } from '@lumenize/resources';
import { CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID, MESSAGES_NODE_ID, ROUNDS_NODE_ID, DEFAULT_CHAT_ID } from '@lumenize/nebula';
import { NEBULA_SUB } from '@lumenize/mesh';
import { universeAdminClient } from '../../test-helpers';
import { StudioClientTest } from './index';
import type { GalaxyTest } from './index';

const V = CHAT_MESSAGE_ONTOLOGY_VERSION;
const uniqueGalaxy = () => `bt-${crypto.randomUUID().slice(0, 8)}.app`;
const email = (tag: string) => `${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const reply = (calls: unknown[], content = '') => ({ choices: [{ message: { content, reasoning_content: '', tool_calls: calls } }] });

const entries: Array<{ namespace: string; level?: string; message: string; data?: Record<string, any> }> = [];
beforeEach(() => { entries.length = 0; setDebugSink((entry) => { entries.push(entry as never); }); });
afterEach(() => clearDebugSink());
/** The restore's records for this Galaxy since the sink was last emptied. */
const restores = (scope: string) => entries.filter((e) => e.namespace === 'nebula.Galaxy.agentGrant' && e.message === 'restored' && e.data?.name === scope);
/** The tree-setup failures this Galaxy logged, each one's error by name. */
const setupFailures = (scope: string) => entries.filter((e) => e.namespace === 'nebula.Galaxy.onStart' && e.message === 'tree setup failed' && e.data?.name === scope)
  .map((e) => (e.data?.error as Error).name);

/** Run `fn` over the Galaxy's own storage. Each call takes a fresh stub: one made before a reset answers with the reset. */
const inStorage = <T>(scope: string, fn: (sql: SqlStorage) => T): Promise<T> =>
  (runInDurableObject as any)(env.GALAXY.getByName(scope), (_i: unknown, ctx: DurableObjectState) => fn(ctx.storage.sql));

/** Reset the Galaxy, as an eviction would: storage stays, and its next call constructs it again. */
const reset = (scope: string): Promise<void> => (runInDurableObject as any)(env.GALAXY.getByName(scope), (_i: unknown, ctx: DurableObjectState) => {
  ctx.abort('an eviction, in a test');
}).catch(() => { /* the abort rejects the call that made it */ });

/**
 * Count every row the tree's three tables are written, from here on, with triggers in the
 * Galaxy's own storage. An `INSERT OR IGNORE` that finds its row there fires none.
 */
const watchTree = (scope: string) => inStorage(scope, (sql) => {
  sql.exec('CREATE TABLE IF NOT EXISTS TreeWrites (tableName TEXT NOT NULL, op TEXT NOT NULL, key TEXT NOT NULL)');
  for (const [table, key] of [['Nodes', 'nodeId'], ['Edges', 'childNodeId'], ['Permissions', `nodeId || ':' || NEW.sub`]] as const) {
    const named = table === 'Permissions' ? `NEW.${key}` : `NEW.${key}`;
    for (const op of ['INSERT', 'UPDATE']) {
      sql.exec(`CREATE TRIGGER IF NOT EXISTS watch_${table}_${op} AFTER ${op} ON ${table} BEGIN INSERT INTO TreeWrites VALUES ('${table}', '${op}', ${named}); END`);
    }
    sql.exec(`CREATE TRIGGER IF NOT EXISTS watch_${table}_DELETE AFTER DELETE ON ${table} BEGIN INSERT INTO TreeWrites VALUES ('${table}', 'DELETE', OLD.${table === 'Permissions' ? 'nodeId' : key}); END`);
  }
  sql.exec('DELETE FROM TreeWrites');
});
/** What the tree's tables were written since the last read, as `Table OP key`, then cleared. */
const treeWrites = (scope: string): Promise<string[]> => inStorage(scope, (sql) => {
  const rows = sql.exec('SELECT tableName, op, key FROM TreeWrites').toArray().map((r) => `${r.tableName as string} ${r.op as string} ${r.key as string}`);
  sql.exec('DELETE FROM TreeWrites');
  return rows.sort();
});
const slugs = (scope: string): Promise<Record<string, string>> => inStorage(scope, (sql) =>
  Object.fromEntries(sql.exec('SELECT nodeId, slug FROM Nodes WHERE deleted = 0').toArray().map((r) => [r.nodeId as string, r.slug as string])));
const agentGrants = (scope: string): Promise<Record<string, string>> => inStorage(scope, (sql) =>
  Object.fromEntries(sql.exec('SELECT nodeId, permission FROM Permissions WHERE sub = ?', NEBULA_SUB).toArray().map((r) => [r.nodeId as string, r.permission as string])));

/** An app's admin in Studio on its Galaxy's page, with the chat ontology installed. */
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
  // The first op installs the chat ontology.
  expect(await probe((g) => g.resources.read(V, crypto.randomUUID()))).toBeNull();
  /** A `Round` written as the agent at the `rounds` node, which its `write` at `chat` covers. */
  const writeAsAgent = (): Promise<TransactionResult> => probe((g) => g.writeAsAgentForTest({
    [crypto.randomUUID()]: { op: 'create', typeName: 'Round', nodeId: ROUNDS_NODE_ID, value: { chat: DEFAULT_CHAT_ID, message: crypto.randomUUID(), index: 1, text: 'a round', calls: [] } },
  }));
  return { scope, admin, probe, writeAsAgent };
}

describe('a Galaxy builds its tree at every start', { timeout: 60_000 }, () => {
  // MUTATIONS: call `setPermission` at every start, with the log left conditional, and the start
  // writes a `Permissions` row. Create a node with `INSERT OR REPLACE` whatever is there, and it
  // writes a `Nodes` row.
  it('creates the chat\'s nodes and the agent\'s grant, and a start that finds them writes nothing', async () => {
    const a = await app();
    expect(await slugs(a.scope)).toEqual({ [ROOT_NODE_ID]: 'root', [CHAT_NODE_ID]: 'chat', [MESSAGES_NODE_ID]: 'messages', [ROUNDS_NODE_ID]: 'rounds' });
    expect(await agentGrants(a.scope)).toEqual({ [CHAT_NODE_ID]: 'write' });
    expect(setupFailures(a.scope)).toEqual([]);

    await watchTree(a.scope);
    entries.length = 0;
    await reset(a.scope);
    expect(await treeWrites(a.scope)).toEqual([]);
    expect(restores(a.scope)).toEqual([]);
    a.admin[Symbol.dispose]();
  });

  // MUTATION: answer a renamed node by putting its slug back, and the slug reads `messages` again.
  it('leaves a node an admin renamed as they left it', async () => {
    const a = await app();
    await a.admin.orgTree.renameNode(MESSAGES_NODE_ID, 'thread');
    await watchTree(a.scope);
    await reset(a.scope);
    expect(await treeWrites(a.scope)).toEqual([]);
    expect(await slugs(a.scope)).toEqual({ [ROOT_NODE_ID]: 'root', [CHAT_NODE_ID]: 'chat', [MESSAGES_NODE_ID]: 'thread', [ROUNDS_NODE_ID]: 'rounds' });
    expect(setupFailures(a.scope)).toEqual([]);
    a.admin[Symbol.dispose]();
  });

  // An admin may revoke or lower the agent's grant, and until something restores it the agent is
  // refused like anyone. MUTATIONS: keep a refusal of the revoke, and the owner's call throws.
  // Drop the restore, and the grant stays as the admin left it. Ask for `read` in the restore,
  // and the lowered grant stays `read`. Drop the restore's log line, and no record follows.
  it.each([
    ['revoked', (a: Awaited<ReturnType<typeof app>>) => a.admin.orgTree.revokePermission(CHAT_NODE_ID, NEBULA_SUB), {}],
    ['lowered to read', (a: Awaited<ReturnType<typeof app>>) => a.admin.orgTree.setPermission(CHAT_NODE_ID, NEBULA_SUB, 'read'), { [CHAT_NODE_ID]: 'read' }],
  ])('restores the agent\'s grant at the next start once an admin has %s it', async (_what, change, left) => {
    const a = await app();
    await change(a);
    expect(await agentGrants(a.scope)).toEqual(left);
    const refused = await a.writeAsAgent();
    expect(refused).toMatchObject({ ok: false });
    expect(Object.values((refused as Extract<TransactionResult, { ok: false }>).errors)).toEqual([{ type: 'permission', requiredTier: 'write', nodeId: ROUNDS_NODE_ID }]);

    entries.length = 0;
    await reset(a.scope);
    expect(await agentGrants(a.scope)).toEqual({ [CHAT_NODE_ID]: 'write' });
    expect((await a.writeAsAgent()).ok).toBe(true);
    const [record, ...more] = restores(a.scope);
    expect(more).toEqual([]);
    expect(record?.data).toMatchObject({
      nodeId: CHAT_NODE_ID, tier: 'write', grantee: NEBULA_SUB,
      recordedClaims: { sub: `system:${a.scope}`, aud: a.scope, access: { authScope: a.scope, scopeAdmin: true } },
    });
    a.admin[Symbol.dispose]();
  });

  // The restore asks what reaches `chat`, so a grant from above is enough. MUTATION: compare
  // against the grant at `chat` itself, and the start writes one there.
  it('writes no grant at chat when one from above already covers it', async () => {
    const a = await app();
    await a.admin.orgTree.setPermission(ROOT_NODE_ID, NEBULA_SUB, 'admin');
    await a.admin.orgTree.revokePermission(CHAT_NODE_ID, NEBULA_SUB);
    await watchTree(a.scope);
    entries.length = 0;
    await reset(a.scope);
    expect(await treeWrites(a.scope)).toEqual([]);
    expect(await agentGrants(a.scope)).toEqual({ [ROOT_NODE_ID]: 'admin' });
    expect(restores(a.scope)).toEqual([]);
    a.admin[Symbol.dispose]();
  });

  // The owner renames `rounds` away and gives its slug to a node of their own. The `rounds` node's
  // rows are then deleted from storage, which stands for a deploy that adds it later: its create
  // meets the taken slug at every start. MUTATIONS: put the steps back under one `try`, and the
  // grant stays missing. Remove the catch, and the Galaxy fails every call.
  it('logs a create a taken slug refuses, at each start, and still restores the grant and answers calls', async () => {
    const a = await app();
    await a.admin.orgTree.renameNode(ROUNDS_NODE_ID, 'old-rounds');
    expect(await a.admin.orgTree.createNode(crypto.randomUUID(), CHAT_NODE_ID, 'rounds', 'Mine')).toEqual({ outcome: 'created' });
    await inStorage(a.scope, (sql) => {
      sql.exec('DELETE FROM Edges WHERE childNodeId = ?', ROUNDS_NODE_ID);
      sql.exec('DELETE FROM Nodes WHERE nodeId = ?', ROUNDS_NODE_ID);
    });
    await a.admin.orgTree.revokePermission(CHAT_NODE_ID, NEBULA_SUB);

    for (const start of ['the start after', 'the one after that']) {
      entries.length = 0;
      await reset(a.scope);
      expect(await agentGrants(a.scope), start).toEqual({ [CHAT_NODE_ID]: 'write' });
      expect(setupFailures(a.scope), start).toEqual(['SlugTakenError']);
      expect(await a.probe((g) => g.resources.read(V, crypto.randomUUID())), start).toBeNull();
    }
    a.admin[Symbol.dispose]();
  });

  // MUTATION: create the nodes only when the tree has none of them, and the node stays missing.
  it('creates a node a later deploy adds, at the next start, and writes only its rows', async () => {
    const a = await app();
    await inStorage(a.scope, (sql) => {
      sql.exec('DELETE FROM Edges WHERE childNodeId = ?', ROUNDS_NODE_ID);
      sql.exec('DELETE FROM Nodes WHERE nodeId = ?', ROUNDS_NODE_ID);
    });
    await watchTree(a.scope);
    await reset(a.scope);
    expect(await treeWrites(a.scope)).toEqual([`Edges INSERT ${ROUNDS_NODE_ID}`, `Nodes INSERT ${ROUNDS_NODE_ID}`]);
    expect((await slugs(a.scope))[ROUNDS_NODE_ID]).toBe('rounds');
    a.admin[Symbol.dispose]();
  });
});

describe('a post finds the agent\'s grant revoked', { timeout: 60_000 }, () => {
  // No reset here: the Galaxy that took the revoke is the one that takes the post. MUTATIONS: drop
  // the trigger's restore, and the grant stays missing and the post is not waiting. Restore after
  // the trigger reads the thread, and each message's refused read logs first.
  it('writes it back before the agent reads the thread, so the post starts its turn', async () => {
    const a = await app();
    await a.probe((g) => g.seedChatScriptForTest([reply([{ id: 'c1', type: 'function', function: { name: 'mark_complete', arguments: '{}' } }], 'Hello.')]));
    await a.probe((g) => g.holdModelCallForTest(1));
    await a.admin.orgTree.revokePermission(CHAT_NODE_ID, NEBULA_SUB);
    expect(await agentGrants(a.scope)).toEqual({});

    entries.length = 0;
    const posted = await a.admin.postUserMessage('Are you there?');
    await vi.waitFor(() => expect(entries.some((e) => e.namespace === 'nebula.GalaxyTest.hold' && e.message === 'model call held' && e.data?.instanceName === a.scope)).toBe(true), { timeout: 15_000 });
    expect(await agentGrants(a.scope)).toEqual({ [CHAT_NODE_ID]: 'write' });
    expect(restores(a.scope)).toHaveLength(1);
    expect(await a.probe((g) => g.waitingPostsForTest())).toEqual([posted]);
    expect(entries.filter((e) => e.namespace === 'nebula.Resources.doRead' && e.message === 'handler threw')).toEqual([]);
    await a.probe((g) => g.releaseForTest());
    a.admin[Symbol.dispose]();
  });
});
