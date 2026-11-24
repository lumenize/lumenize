/**
 * A repeat of a transaction that committed is recognized from the snapshots it wrote and told the
 * moment it committed at.
 *
 * In-lane rather than `/live`, for what no running stack offers: a type with an `@default` field,
 * which only `applyOntologyForTest` installs here (the shared app's ontology has none), and the
 * agent-message commit, which only a Galaxy's turn makes, with no client door. The rest of
 * recognition is the scenario `each-transaction-gets-one-moment`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { ROOT_NODE_ID } from '@lumenize/resources';
import type { TransactionResult, OntologyVersionConfig, Snapshot } from '@lumenize/resources';
import { DEFAULT_CHAT_ID, MESSAGES_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
import { universeAdminClient } from '../../test-helpers';
import { NebulaClientTest, StudioClientTest, heldGalaxyParses } from './index';
import type { StarTest, GalaxyTest } from './index';

const uuid = () => crypto.randomUUID();
const TYPES = 'interface Task {\n  title: string;\n  /** @default "medium" */\n  priority?: string;\n}';

type SinkEntry = { namespace: string; message: string; data?: Record<string, any> };
let sink: SinkEntry[] = [];
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e as unknown as SinkEntry)); });
afterEach(() => clearDebugSink());

const door = (c: NebulaClientTest) => (c.ctn() as any).resources;
const tx = (c: NebulaClientTest, star: string, ops: Record<string, unknown>) =>
  c.lmz.callAsync('STAR', star, door(c).transaction('v1', ops), { timeoutMs: 30_000 }) as Promise<TransactionResult>;
const rowsOf = (star: string, rid: string) => (runInDurableObject as any)((env as any).STAR.getByName(star),
  (_i: unknown, c: DurableObjectState) => c.storage.sql.exec('SELECT COUNT(*) AS n FROM Snapshots WHERE resourceId = ?', rid).toArray()[0].n as number);

describe('recognition compares what was stored, after the validator filled it', () => {
  it('a repeated create and a repeated put that leave an @default field out are each told their first moment', async () => {
    const galaxy = `rc-${uuid().slice(0, 8)}.app`;
    const dev = `${galaxy}.dev`;
    const a = (await universeAdminClient(NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com', 'v1')).client;
    await a.lmz.callAsync('STAR', dev, a.ctn<StarTest>().applyOntologyForTest({ version: 'v1', types: TYPES } as OntologyVersionConfig), { timeoutMs: 60_000 });
    const rid = uuid();
    const create = { [rid]: { op: 'create', typeName: 'Task', nodeId: ROOT_NODE_ID, value: { title: 'one' } } };

    const created = await tx(a, dev, create);
    if (!created.ok) throw new Error('create failed');
    const repeatedCreate = await tx(a, dev, structuredClone(create));
    expect(repeatedCreate).toEqual({ ok: true, validFrom: created.validFrom });

    const put = { [rid]: { op: 'put', ifValidFromMatches: created.validFrom, value: { title: 'two' } } };
    const putOnce = await tx(a, dev, put);
    if (!putOnce.ok) throw new Error('put failed');
    // The repeat names a version that has moved on, and the same writer wrote what followed it, so
    // it reaches the validator and is compared in stored form. Mutation: let the pre-check skip
    // validating every stale op → no `priority` on the op, `medium` in storage, and this answers a
    // conflict.
    const repeatedPut = await tx(a, dev, structuredClone(put));
    expect(repeatedPut).toEqual({ ok: true, validFrom: putOnce.validFrom });
    expect(await rowsOf(dev, rid)).toBe(2); // the create and the put, nothing from the repeats
    a[Symbol.dispose]();
  }, 90_000);
});

describe('recognition reads nothing when the transaction already rules a repeat out', () => {
  // In-lane because a read count is visible only inside the object: the statements below are the
  // two recognition issues, `#successorOf`'s join and `#firstSnapshotOf`'s oldest-first scan.
  const RECOGNITION_SQL = /JOIN Snapshots a ON|ORDER BY validFrom ASC LIMIT 1/;
  const countRecognitionReads = (star: string) => (runInDurableObject as any)((env as any).STAR.getByName(star),
    (_i: unknown, c: DurableObjectState) => {
      const sql = c.storage.sql as SqlStorage & { recognitionReads?: number };
      if (sql.recognitionReads === undefined) {
        const exec = sql.exec.bind(sql);
        sql.recognitionReads = 0;
        sql.exec = ((query: string, ...bindings: unknown[]) => {
          if (RECOGNITION_SQL.test(query)) sql.recognitionReads! += 1;
          return exec(query, ...bindings);
        }) as typeof sql.exec;
      }
      const n = sql.recognitionReads;
      sql.recognitionReads = 0;
      return n;
    }) as Promise<number>;

  it('a fresh create and a put naming the current version read nothing, and a repeat does', async () => {
    const galaxy = `rc-${uuid().slice(0, 8)}.app`;
    const dev = `${galaxy}.dev`;
    const a = (await universeAdminClient(NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com', 'v1')).client;
    await a.lmz.callAsync('STAR', dev, a.ctn<StarTest>().applyOntologyForTest({ version: 'v1', types: TYPES } as OntologyVersionConfig), { timeoutMs: 60_000 });
    await countRecognitionReads(dev);
    const rid = uuid();

    // Mutation: drop the create half of `#recognize`'s first check → this reads the oldest snapshot.
    const created = await tx(a, dev, { [rid]: { op: 'create', typeName: 'Task', nodeId: ROOT_NODE_ID, value: { title: 'one' } } });
    if (!created.ok) throw new Error('create failed');
    expect(await countRecognitionReads(dev)).toBe(0);

    // Mutation: drop the current-version half → this reads the successor of the version it names.
    const put = { [rid]: { op: 'put', ifValidFromMatches: created.validFrom, value: { title: 'two' } } };
    const putOnce = await tx(a, dev, put);
    if (!putOnce.ok) throw new Error('put failed');
    expect(await countRecognitionReads(dev)).toBe(0);

    // Mutation: drop the no-snapshot half of the same check → this reads before it fails not-found.
    await expect(tx(a, dev, { [uuid()]: { op: 'put', ifValidFromMatches: putOnce.validFrom, value: { title: 'x' } } }))
      .rejects.toThrow(/not found/);
    expect(await countRecognitionReads(dev)).toBe(0);

    // The counter can see a read: the repeat names a version that has moved on, so the Step-4.5
    // pre-check reads its successor once, and recognition reads it again.
    expect(await tx(a, dev, structuredClone(put))).toEqual({ ok: true, validFrom: putOnce.validFrom });
    expect(await countRecognitionReads(dev)).toBe(2);
    a[Symbol.dispose]();
  }, 90_000);
});

describe('the agent-message commit, run twice with one id', () => {
  const devClient = (scope: string) => universeAdminClient(
    StudioClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION,
    { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
  );
  const commit = (c: StudioClientTest, scope: string, id: string, content: string, replyTo: string) =>
    c.lmz.callAsync('GALAXY', scope, c.ctn<GalaxyTest>().commitAgentForTest(DEFAULT_CHAT_ID, id, content, MESSAGES_NODE_ID, replyTo),
      { timeoutMs: 30_000 });

  it('in sequence with different content: the second does nothing and throws nothing', async () => {
    const scope = `rc-${uuid().slice(0, 8)}.app`;
    const { client } = await devClient(scope);
    const replyTo = await client.postUserMessage('hello');
    const id = uuid();
    await commit(client, scope, id, 'first answer', replyTo);
    // Mutation: delete `ensureResource`'s existence guard → the create reaches Step 7, the content
    // differs so recognition declines, and it throws "already exists".
    await commit(client, scope, id, 'second answer', replyTo);
    const message = await client.resources.read('Message', id) as Snapshot;
    expect((message.value as { content: string }).content).toBe('first answer');
    client[Symbol.dispose]();
  }, 60_000);

  it('at once with the same content: both pass the guard, neither throws, and one snapshot lands', async () => {
    const scope = `rc-${uuid().slice(0, 8)}.app`;
    // Held so the first commit is still validating when the second arrives. A warm validator
    // answers within the first call's turn, and the second then meets the guard, not the commit.
    heldGalaxyParses.set(scope, 300);
    const { client } = await devClient(scope);
    const replyTo = await client.postUserMessage('hello');
    const id = uuid();
    // Mutation: delete recognition → the second create fails "already exists" and this rejects.
    await Promise.all([commit(client, scope, id, 'the answer', replyTo), commit(client, scope, id, 'the answer', replyTo)]);
    // Both calls were past the guard before either committed, so the second create met the first's
    // snapshot at commit, which is what this case is for.
    expect(sink.filter((e) => e.namespace === 'nebula.Resources.ensureResource' && e.message === 'creating'
      && e.data?.resourceId === id)).toHaveLength(2);
    const rows = await (runInDurableObject as any)((env as any).GALAXY.getByName(scope),
      (_i: unknown, c: DurableObjectState) => c.storage.sql.exec('SELECT COUNT(*) AS n FROM Snapshots WHERE resourceId = ?', id).toArray()[0].n as number);
    expect(rows).toBe(1);
    heldGalaxyParses.delete(scope);
    client[Symbol.dispose]();
  }, 60_000);
});
