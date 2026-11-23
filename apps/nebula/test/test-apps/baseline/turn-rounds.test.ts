/**
 * A turn's rounds: the `Round` type, the `rounds` node only the agent and the app's admins write,
 * the `read` at `chat`, over `rounds`, that an invite to the conversation names beside its `write` at
 * `messages`, and the Workspace's git store as the place a read file's content is kept by its blob id.
 *
 * vitest-plugin for what no Client can make or see: a write as the agent, which only the Galaxy's
 * own code makes; a snapshot's earlier rows, since the plane has no history read; the grants an
 * invite writes; and the Workspace's tables. Every person here logs in through the real Registry
 * (ADR-009 rung 2). The `/live` scenario `rounds-as-they-land` reads rounds a real turn writes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import type { TransactionResult, WireOperationDescriptor } from '@lumenize/resources';
import { CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_NODE_ID, MESSAGES_NODE_ID, DEFAULT_CHAT_ID, ROUNDS_NODE_ID, COLLABORATOR_GRANTS } from '@lumenize/nebula';
import type { Galaxy } from '@lumenize/nebula';
import { universeAdminClient, createInvitedClient } from '../../test-helpers';
import { NebulaClientTest, StudioClientTest } from './index';
import type { GalaxyTest } from './index';

const V = CHAT_MESSAGE_ONTOLOGY_VERSION;
const uniqueGalaxy = () => `tr-${crypto.randomUUID().slice(0, 8)}.app`;
const email = (tag: string) => `${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;

/** A round as the loop first stores it: the model's reply, its one call not yet run. */
function round(message: string, index = 1, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chat: DEFAULT_CHAT_ID, message, index, text: 'I will read the app.',
    calls: [{ raw: { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/App.vue"}' } } }],
    ...extra,
  };
}

/** The app's admin, on its Galaxy's page, with the chat ontology installed. */
async function app() {
  const scope = uniqueGalaxy();
  const session = await universeAdminClient(
    StudioClientTest, new Browser(), scope, scope, email('admin'), V,
    { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope },
  );
  const admin = session.client;
  // The first op installs the chat ontology.
  expect(await admin.lmz.callAsync('GALAXY', scope, admin.ctn<Galaxy>().resources.read(V, crypto.randomUUID()))).toBeNull();
  // Each probe's answer is read as what the test asserts it to be.
  const probe = (remote: (g: any) => unknown): Promise<any> =>
    admin.lmz.callAsync('GALAXY', scope, remote(admin.ctn<GalaxyTest>()) as never);
  return { scope, admin, accessToken: session.accessToken, probe };
}

type App = Awaited<ReturnType<typeof app>>;

type Grants = Array<{ nodeId: string; tier: 'read' | 'write' | 'admin' }>;

/** Invite `address` with `grants` through the plane's own node invite, as `chat-cast.ts` sends a
 *  collaborator's, and log them in once the invite's grants are written. */
async function inviteWith(a: App, grants: Grants, address: string, as: App['admin'] = a.admin) {
  const ack = await as.lmz.callAsync('GALAXY', a.scope, as.ctn<Galaxy>().resources.invite(V, [{ email: address, grants }]));
  expect(ack).toEqual({ accepted: 1, errors: [] });
  const { client, payload } = await createInvitedClient(
    NebulaClientTest, new Browser(), a.scope, a.scope, address, V, { resourceHostBinding: 'GALAXY' },
  );
  await vi.waitFor(async () => expect((await a.probe((g) => g.grantsForTest(payload.sub))).length).toBeGreaterThan(0));
  return { client, sub: payload.sub as string };
}

describe('a turn\'s rounds are stored at the rounds node', { timeout: 60000 }, () => {
  // MUTATION: drop the restore of the agent's grant from the Galaxy's start, and its create is refused.
  it('the agent creates a Round and writes a second snapshot naming the first one\'s validFrom', async () => {
    const a = await app();
    const id = crypto.randomUUID();
    const message = crypto.randomUUID();
    const created = await a.probe((g) => g.writeAsAgentForTest({ [id]: { op: 'create', typeName: 'Round', nodeId: ROUNDS_NODE_ID, value: round(message) } }));
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const first = (created as Extract<TransactionResult, { ok: true }>).validFrom;
    const answered = round(message, 1, {
      calls: [{ ...(round(message).calls as object[])[0], post: crypto.randomUUID(), result: { path: 'src/App.vue', bytes: 12, oid: 'abc' } }],
    });
    const second = await a.probe((g) => g.writeAsAgentForTest({ [id]: { op: 'put', ifValidFromMatches: first, value: answered } }));
    expect(second.ok, JSON.stringify(second)).toBe(true);

    // The plane answers only a resource's current snapshot, so the earlier row is read from storage.
    const rows: Array<{ validFrom: string; validTo: string; nodeId: string; sub: string }> =
      await a.probe((g) => g.snapshotRowsForTest(id));
    expect(rows.map((r) => [r.validFrom === first, r.sub, r.nodeId])).toEqual([
      [true, 'agent:lumenize', ROUNDS_NODE_ID], [false, 'agent:lumenize', ROUNDS_NODE_ID],
    ]);
    expect(rows[0].validTo).toBe(rows[1].validFrom);
    a.admin[Symbol.dispose]();
  });

  // MUTATION: type `index` as `unknown`, and a string lands.
  it('refuses a Round whose index is a string', async () => {
    const a = await app();
    const id = crypto.randomUUID();
    const refused = await a.probe((g) => g.writeAsAgentForTest({ [id]: { op: 'create', typeName: 'Round', nodeId: ROUNDS_NODE_ID, value: round(crypto.randomUUID(), '1' as never) } }));
    expect(refused.ok).toBe(false);
    expect((refused as Extract<TransactionResult, { ok: false }>).errors[id].type).toBe('validation');
    a.admin[Symbol.dispose]();
  });

  // Nothing reads the store for an id a resource names (ADR-006), so a round can name the agent
  // message its turn will commit before that message exists.
  it('accepts a Round naming a Message no one has written', async () => {
    const a = await app();
    const id = crypto.randomUUID();
    const message = crypto.randomUUID();
    expect(await a.admin.lmz.callAsync('GALAXY', a.scope, a.admin.ctn<Galaxy>().resources.read(V, message))).toBeNull();
    const created = await a.probe((g) => g.writeAsAgentForTest({ [id]: { op: 'create', typeName: 'Round', nodeId: ROUNDS_NODE_ID, value: round(message) } }));
    expect(created.ok, JSON.stringify(created)).toBe(true);
    a.admin[Symbol.dispose]();
  });

  // MUTATION: have a collaborator's invite name `write` at `chat`, and the member's create and their
  // write over the agent's round both land.
  it('refuses a collaborator a Round of their own and a write over the agent\'s, and lets them read it', async () => {
    const a = await app();
    const member = await inviteWith(a, COLLABORATOR_GRANTS, email('collab'));
    const id = crypto.randomUUID();
    const created = await a.probe((g) => g.writeAsAgentForTest({ [id]: { op: 'create', typeName: 'Round', nodeId: ROUNDS_NODE_ID, value: round(crypto.randomUUID()) } }));
    const validFrom = (created as Extract<TransactionResult, { ok: true }>).validFrom;
    const transact = (ops: Record<string, WireOperationDescriptor>) =>
      member.client.lmz.callAsync('GALAXY', a.scope, member.client.ctn<Galaxy>().resources.transaction(V, ops)) as Promise<TransactionResult>;

    const own = crypto.randomUUID();
    expect(await transact({ [own]: { op: 'create', typeName: 'Round', nodeId: ROUNDS_NODE_ID, value: round(crypto.randomUUID()) } }))
      .toEqual({ ok: false, errors: { [own]: { type: 'permission', requiredTier: 'write', nodeId: ROUNDS_NODE_ID } } });
    expect(await transact({ [id]: { op: 'put', ifValidFromMatches: validFrom, value: round(crypto.randomUUID(), 1, { text: 'mine now' }) } }))
      .toEqual({ ok: false, errors: { [id]: { type: 'permission', requiredTier: 'write', nodeId: ROUNDS_NODE_ID } } });

    const read = await member.client.lmz.callAsync('GALAXY', a.scope, member.client.ctn<Galaxy>().resources.read(V, id)) as { value: { text: string }; meta: { recordedClaims: { sub: string } } };
    expect([read.value.text, read.meta.recordedClaims.sub]).toEqual(['I will read the app.', 'agent:lumenize']);
    member.client[Symbol.dispose]();
    a.admin[Symbol.dispose]();
  });
});

describe('an invite to the conversation names its read at chat beside its write at messages', { timeout: 60000 }, () => {
  const entries: Array<{ namespace: string; message: string; data?: Record<string, unknown> }> = [];
  beforeEach(() => { entries.length = 0; setDebugSink((entry) => { entries.push(entry as never); }); });
  afterEach(() => clearDebugSink());
  const issuedTo = (address: string) => entries.filter((e) =>
    e.namespace === 'nebula-auth.Registry.invite.issued' && e.data?.email === address);
  const BOTH = [
    { nodeId: MESSAGES_NODE_ID, permission: 'write' }, { nodeId: CHAT_NODE_ID, permission: 'read' },
  ].sort((x, y) => x.nodeId.localeCompare(y.nodeId));

  // MUTATION: write only an invite's first grant, and the invitee holds nothing at `chat`.
  it('through the plane\'s own invite, with one link sent', async () => {
    const a = await app();
    const address = email('collab');
    const member = await inviteWith(a, COLLABORATOR_GRANTS, address);
    await vi.waitFor(async () => expect(await a.probe((g) => g.grantsForTest(member.sub))).toEqual(BOTH));
    expect(issuedTo(address).map((e) => e.data?.universeGalaxyStarId)).toEqual([a.scope]);
    member.client[Symbol.dispose]();
    a.admin[Symbol.dispose]();
  });

  // MUTATION: have `Galaxy.invite` name `messages` alone, and the invitee holds one grant.
  it('through Galaxy.invite, the agent\'s tool, with one link sent', async () => {
    const a = await app();
    const address = email('collab');
    expect(await a.probe((g) => g.inviteForTest(address))).toMatchObject({ invited: address, as: 'collaborator' });
    const { client, payload } = await createInvitedClient(
      NebulaClientTest, new Browser(), a.scope, a.scope, address, V, { resourceHostBinding: 'GALAXY' },
    );
    await vi.waitFor(async () => expect(await a.probe((g) => g.grantsForTest(payload.sub))).toEqual(BOTH));
    expect(issuedTo(address).map((e) => e.data?.universeGalaxyStarId)).toEqual([a.scope]);
    client[Symbol.dispose]();
    a.admin[Symbol.dispose]();
  });

  // No grant is written that the invite did not name. MUTATION: write `read` at `chat` with every
  // invite at `messages`, as the tree's seed once declared, and the invitee holds two.
  it('and an invite naming messages alone leaves the invitee nothing at chat', async () => {
    const a = await app();
    const member = await inviteWith(a, [{ nodeId: MESSAGES_NODE_ID, tier: 'write' }], email('poster'));
    // The row at `messages` reads `sent` once every grant the invite named has been written.
    await vi.waitFor(async () => expect(await a.probe((g) => g.inviteStatesForTest(MESSAGES_NODE_ID))).toEqual(['sent']));
    expect(await a.probe((g) => g.grantsForTest(member.sub))).toEqual([{ nodeId: MESSAGES_NODE_ID, permission: 'write' }]);
    member.client[Symbol.dispose]();
    a.admin[Symbol.dispose]();
  });

  // A collaborator the owner made `admin` of both nodes passes the invite's door, and the facade
  // then refuses them, since only dominion invites into an app. MUTATION: flip only the first
  // node's row when the facade refuses, and the second stays `pending`.
  it('and a submission the facade refuses fails the row at every node, with its message', async () => {
    const a = await app();
    const collaborator = await inviteWith(a, COLLABORATOR_GRANTS, email('collab'));
    await vi.waitFor(async () => expect(await a.probe((g) => g.grantsForTest(collaborator.sub))).toEqual(BOTH));
    for (const { nodeId } of COLLABORATOR_GRANTS) await a.admin.orgTree.setPermission(nodeId, collaborator.sub, 'admin');

    const ack = await collaborator.client.lmz.callAsync('GALAXY', a.scope,
      collaborator.client.ctn<Galaxy>().resources.invite(V, [{ email: email('refused'), grants: COLLABORATOR_GRANTS }]));
    expect(ack).toEqual({ accepted: 1, errors: [] });
    const failed = (nodeId: string) => a.probe((g) => g.inviteFailuresForTest(nodeId)) as Promise<string[]>;
    await vi.waitFor(async () => {
      expect(await failed(MESSAGES_NODE_ID)).toHaveLength(1);
      expect(await failed(CHAT_NODE_ID)).toHaveLength(1);
    });
    const [atMessages] = await failed(MESSAGES_NODE_ID);
    expect(atMessages.length).toBeGreaterThan(0);
    expect(await failed(CHAT_NODE_ID)).toEqual([atMessages]);
    collaborator.client[Symbol.dispose]();
    a.admin[Symbol.dispose]();
  });
});

describe('a blob is kept in the Workspace\'s git store by its id', { timeout: 60000 }, () => {
  // MUTATION: call `hashObject` without `write: true`, and the uncommitted content does not read back.
  it('reads back byte for byte, for content the repo has committed and content it has not', async () => {
    const a = await app();
    const committed = await a.admin.lmz.callAsync('GALAXY', a.scope, a.admin.ctn<Galaxy>().readSource('src/App.vue')) as string;
    const fresh = `<template><p>${'é'.repeat(3)} ${crypto.randomUUID()}</p></template>\n`;

    const before = await a.probe((g) => g.workspaceRowsForTest());
    const committedOid = await a.probe((g) => g.writeBlobForTest(committed));
    const afterCommitted = await a.probe((g) => g.workspaceRowsForTest());
    const freshOid = await a.probe((g) => g.writeBlobForTest(fresh));
    const afterFresh = await a.probe((g) => g.workspaceRowsForTest());
    console.log('[blob cost] workspace rows', JSON.stringify({ before, afterCommitted, afterFresh }));

    expect(await a.probe((g) => g.readBlobForTest(committedOid))).toBe(committed);
    expect(await a.probe((g) => g.readBlobForTest(freshOid))).toBe(fresh);
    // A blob the repo already holds is written again for nothing.
    expect(afterCommitted).toEqual(before);
    a.admin[Symbol.dispose]();
  });

  it('keeps a blob no commit points at through a later write of the source', async () => {
    const a = await app();
    const loose = `a version of a file no commit holds ${crypto.randomUUID()}`;
    const oid = await a.probe((g) => g.writeBlobForTest(loose));
    await a.admin.lmz.callAsync('GALAXY', a.scope, a.admin.ctn<Galaxy>().writeSource('src/App.vue', '<template><p>changed</p></template>\n'));
    expect(await a.probe((g) => g.readBlobForTest(oid))).toBe(loose);
    a.admin[Symbol.dispose]();
  });
});
