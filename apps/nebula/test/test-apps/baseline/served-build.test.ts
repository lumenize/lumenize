/**
 * Each landing records its build as `.dev`'s newest `ServedBuild` (ADR-024's build version), which
 * every Studio on the app hears through `ServedBuild where chat == DEFAULT_CHAT_ID`.
 *
 *  - The version bump: a Galaxy installed at the old chat seed installs the new one when a client
 *    pinned to it subscribes, and that client hears the next landing.
 *  - The grant: a landing whose caller's chat-node grant is revoked while the build runs still
 *    records its build, because the record is the agent's write, on the agent's own grant.
 *  - The record: every landing names the agent as its subject, a turn's and a direct `buildNow`'s
 *    alike, and `buildNow`'s log line names who asked.
 *  - Forgery: a row a participant creates or deletes never keeps the next landing from being the
 *    newest.
 *
 * In-lane rather than `/live`: a held build and a revoke inside its hold, a scripted turn, and a
 * fake build that lands in a second are all a test seam's (`fake-build.ts`, `GalaxyTest`), and
 * `dev-star-follows-the-build` reads the same rows from a running stack.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, CHAT_MESSAGE_TYPES, DEFAULT_CHAT_ID } from '@lumenize/nebula';
import type { Galaxy } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/resources';
import { NEBULA_SUB } from '@lumenize/mesh/auth';
import { universeAdminClient, createSubject, createInvitedClient } from '../../test-helpers';
import { NebulaClientTest, StudioClientTest } from './index';
import type { GalaxyTest } from './index';

const uniqueScope = () => `sbt-${crypto.randomUUID().slice(0, 8)}.app`;
const PAIR = { resourceHostBinding: 'GALAXY' };
const SERVED = { queryType: 'parentChild' as const, typeName: 'ServedBuild', field: 'chat', value: DEFAULT_CHAT_ID };
type Report = { bundle: { indexSha256?: string }; preview: { refreshed: boolean } };

async function owner(scope: string, version = CHAT_MESSAGE_ONTOLOGY_VERSION) {
  return universeAdminClient(StudioClientTest, new Browser(), scope, scope, 'admin@example.com', version,
    { ...PAIR, chatHostBinding: 'GALAXY', chatScope: scope });
}

/** A collaborator holding `write` at the chat node and no admin bit, as an invited person does. */
async function collaborator(scope: string, ownerToken: string, ownerClient: NebulaClientTest) {
  await createSubject(new Browser(), scope, ownerToken, 'member@example.com');
  const { client, payload } = await createInvitedClient(
    StudioClientTest, new Browser(), scope, scope, 'member@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION,
    { ...PAIR, chatHostBinding: 'GALAXY', chatScope: scope },
  );
  expect(payload.access?.scopeAdmin).toBeFalsy();
  await ownerClient.lmz.callAsync('GALAXY', scope,
    ownerClient.ctn<Galaxy>().resources.orgTree.setPermission(CHAT_NODE_ID, payload.sub, 'write'));
  return { client, sub: payload.sub };
}

const g = (c: NebulaClientTest, scope: string) => ({
  faults: (f: object) => c.lmz.callAsync('GALAXY', scope, c.ctn<GalaxyTest>().setBuildFaultsForTest(f)),
  write: (path: string, content: string) => c.lmz.callAsync('GALAXY', scope, c.ctn<Galaxy>().writeSource(path, content)),
  build: (opts: object = {}) => c.lmz.callAsync('GALAXY', scope, c.ctn<Galaxy>().buildNow(opts as { preview?: boolean })) as Promise<Report>,
});

/** The newest `ServedBuild` a subscriber's query holds, read in full. */
async function newest(c: NebulaClientTest, sub: { resourceIds: string[] }): Promise<Snapshot | null> {
  const id = sub.resourceIds.at(-1);
  return id ? await c.resources.read('ServedBuild', id) as Snapshot | null : null;
}

/** Wait until the subscriber's newest row names `buildVersion`, and return it. */
async function newestNaming(c: NebulaClientTest, sub: { resourceIds: string[] }, buildVersion: string): Promise<Snapshot> {
  let snap: Snapshot | null = null;
  await vi.waitFor(async () => {
    snap = await newest(c, sub);
    expect((snap?.value as { buildVersion?: string } | undefined)?.buildVersion).toBe(buildVersion);
  }, { timeout: 10_000 });
  return snap!;
}

type SinkEntry = { namespace: string; message: string; data?: Record<string, unknown> };
let entries: SinkEntry[] = [];
beforeEach(() => { entries = []; setDebugSink((e) => entries.push(e as unknown as SinkEntry)); });
afterEach(() => clearDebugSink());

/** The subjects `buildNow` logged as having asked for a build at `scope`, in order. */
const askers = (scope: string): unknown[] => entries
  .filter((e) => e.namespace === 'nebula.Galaxy.buildNow' && e.message === 'build asked for' && e.data?.instanceName === scope)
  .map((e) => (e.data?.recordedClaims as { sub?: string } | undefined)?.sub);

describe('a landing records its build as .dev\'s newest ServedBuild', () => {
  it('the version bump: a Galaxy on the old chat seed installs the new one, and its client hears the landing', async () => {
    // Mutation: keep the label `chat-message-v1` with `ServedBuild` added → the Galaxy keeps the
    // old row, the type is unknown there, and no row ever reaches the subscriber.
    const scope = uniqueScope();
    const old = (await owner(scope, 'chat-message-v1')).client;
    const OLD_TYPES = CHAT_MESSAGE_TYPES.split('\n').filter((l) => !l.includes('ServedBuild')).join('\n');
    await old.lmz.callAsync('GALAXY', scope, old.ctn<GalaxyTest>().setChatSourceForTest({ version: 'chat-message-v1', types: OLD_TYPES }));
    // An op at the old label installs the old row.
    const posted = await old.resources.transaction({
      [crypto.randomUUID()]: { op: 'create', typeName: 'Message', nodeId: CHAT_NODE_ID, value: { chat: DEFAULT_CHAT_ID, content: 'on v1' } },
    });
    expect(posted.kind).toBe('committed');
    expect(await old.lmz.callAsync('GALAXY', scope, old.ctn<GalaxyTest>().installedChatVersionForTest())).toBe('chat-message-v1');

    // The platform seed comes back as the source: the new label.
    await old.lmz.callAsync('GALAXY', scope, old.ctn<GalaxyTest>().setChatSourceForTest());
    const { client } = await owner(scope);
    using sub = client.resources.subscribeQuery(SERVED);
    await sub.ready;
    expect(await client.lmz.callAsync('GALAXY', scope, client.ctn<GalaxyTest>().installedChatVersionForTest())).toBe(CHAT_MESSAGE_ONTOLOGY_VERSION);
    const report = await g(client, scope).build();
    expect(report.preview.refreshed).toBe(true);
    await newestNaming(client, sub, report.bundle.indexSha256!);
    old[Symbol.dispose](); client[Symbol.dispose]();
  });

  it('the grant: a grant revoked while the build runs does not refuse the record, which is the agent\'s', async () => {
    // Mutation: write the record under the build's caller instead of as the agent → the caller's
    // live grant is checked at commit, the record is refused after `.dev` moved, and the
    // subscriber never sees the build.
    const scope = uniqueScope();
    const { client: o, accessToken } = await owner(scope);
    const p = await collaborator(scope, accessToken, o);
    using sub = o.resources.subscribeQuery(SERVED);
    await sub.ready;
    await g(o, scope).faults({ holdMs: 1_500 });
    const building = g(p.client, scope).build();
    // Inside the hold: the owner revokes the collaborator's grant outright.
    await new Promise((r) => setTimeout(r, 300));
    await o.lmz.callAsync('GALAXY', scope, o.ctn<Galaxy>().resources.orgTree.revokePermission(CHAT_NODE_ID, p.sub));
    const report = await building;
    expect(report.preview.refreshed).toBe(true);
    const snap = await newestNaming(o, sub, report.bundle.indexSha256!);
    expect(snap.meta.recordedClaims.sub).toBe(NEBULA_SUB);
    // The positive control for the revoke: the collaborator's next build is refused at the door.
    await expect(g(p.client, scope).build()).rejects.toThrow(/^write permission required on node /);
    o[Symbol.dispose](); p.client[Symbol.dispose]();
  });

  it('the record: every landing names the agent alone, and buildNow logs who asked', async () => {
    // Mutations: write the record under the build's caller → each row names a person; drop
    // `buildNow`'s log line → no asker is logged; log without the caller's claims → the askers
    // read undefined.
    const scope = uniqueScope();
    const { client: o, accessToken, payload: oP } = await owner(scope);
    const p = await collaborator(scope, accessToken, o);
    using sub = o.resources.subscribeQuery(SERVED);
    await sub.ready;
    const ops = g(o, scope);

    // A turn: write, build, done.
    const turn = (n: number, extra: unknown[] = []) => [
      ...extra,
      { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
        { id: `w${n}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/App.vue', content: `<template><p>turn ${n}</p></template>` }) } },
      ] } }] },
      { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
        { id: `b${n}`, type: 'function', function: { name: 'build', arguments: '{}' } },
      ] } }] },
      { choices: [{ message: { content: 'done', reasoning_content: '', tool_calls: [
        { id: `c${n}`, type: 'function', function: { name: 'mark_complete', arguments: '{}' } },
      ] } }] },
    ];
    o.callGalaxySeedChatScript(scope, turn(1));
    await vi.waitFor(() => expect(o.callCompleted).toBe(true));
    await o.postUserMessage('build it');
    await vi.waitFor(async () => expect(await newest(o, sub)).not.toBeNull(), { timeout: 15_000 });
    const turnRow = (await newest(o, sub))!;
    expect(turnRow.meta.recordedClaims).toMatchObject({ sub: NEBULA_SUB, profileId: NEBULA_SUB });
    expect(turnRow.meta.recordedClaims.act).toBeUndefined();
    // The turn's `build` tool ran inside the poster's call, so the poster is who asked.
    expect(askers(scope)).toEqual([oP.sub]);

    // A direct build.
    await ops.write('src/App.vue', '<template><p>direct</p></template>');
    const direct = await ops.build({ preview: true });
    const directRow = await newestNaming(o, sub, direct.bundle.indexSha256!);
    expect(directRow.meta.recordedClaims.sub).toBe(NEBULA_SUB);
    expect(directRow.meta.recordedClaims.act).toBeUndefined();
    expect(askers(scope)).toEqual([oP.sub, oP.sub]);

    // P builds directly while O's turn is still thinking.
    o.callGalaxySeedChatScript(scope, [{ __delayMs: 2_500 }, { choices: [{ message: { content: 'thought about it', reasoning_content: '', tool_calls: [] } }] }]);
    await vi.waitFor(() => expect(o.callCompleted).toBe(true));
    await o.postUserMessage('think a while');
    await new Promise((r) => setTimeout(r, 300));
    await g(p.client, scope).write('src/App.vue', '<template><p>during</p></template>');
    const during = await g(p.client, scope).build();
    const duringRow = await newestNaming(o, sub, during.bundle.indexSha256!);
    expect(duringRow.meta.recordedClaims.sub).toBe(NEBULA_SUB);
    expect(duringRow.meta.recordedClaims.act).toBeUndefined();
    expect(askers(scope)).toEqual([oP.sub, oP.sub, p.sub]);
    o[Symbol.dispose](); p.client[Symbol.dispose]();
  });

  it('forgery: a row a participant creates and deletes never keeps the next landing from being the newest', async () => {
    // Mutation: write the landing's row at a constant id → the second landing finds it and
    // writes nothing, so the newest row still names the first build.
    const scope = uniqueScope();
    const { client: o, accessToken } = await owner(scope);
    const p = await collaborator(scope, accessToken, o);
    using sub = o.resources.subscribeQuery(SERVED);
    await sub.ready;
    const first = await g(o, scope).build();
    await newestNaming(o, sub, first.bundle.indexSha256!);

    // A participant forges a newer row, then deletes the newest.
    const forged = crypto.randomUUID();
    expect((await p.client.resources.transaction({
      [forged]: { op: 'create', typeName: 'ServedBuild', nodeId: CHAT_NODE_ID, value: { chat: DEFAULT_CHAT_ID, star: 'dev', buildVersion: 'forged' } },
    })).kind).toBe('committed');
    await newestNaming(o, sub, 'forged');
    const snap = await p.client.resources.read('ServedBuild', forged) as Snapshot;
    expect((await p.client.resources.transaction({
      [forged]: { op: 'delete', typeName: 'ServedBuild', ifValidFromMatches: snap.meta.validFrom },
    })).kind).toBe('committed');

    await g(o, scope).write('src/App.vue', '<template><p>second</p></template>');
    const second = await g(o, scope).build();
    expect(second.bundle.indexSha256).not.toBe(first.bundle.indexSha256);
    await newestNaming(o, sub, second.bundle.indexSha256!);
    o[Symbol.dispose](); p.client[Symbol.dispose]();
  });
});
