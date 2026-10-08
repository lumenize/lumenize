/**
 * No subscription update carries the identity of whoever's call caused it — an update is the Star
 * or the Galaxy speaking, never the writer, granter or poster. A probe tab records every push's
 * `originAuth` and call chain as it arrives (`NebulaClientTest.pushOrigins`).
 *
 * Every update leaves through the plane's one `lmz.broadcast`, which starts a fresh chain at the
 * host by default, and the tab's host node checks the tab's passage into the sender rather than any
 * claim the push carries.
 *
 * Two positive controls:
 *   - **the probe records `originAuth` when one arrives** — below. A plain `lmz.call` from a
 *     test-subclass method carries its caller's claims to the probe, so a "no originAuth" verdict
 *     means the push had none, never that the probe could not see one;
 *   - **a call to another node keeps the caller's identity** — `node-invite.test.ts`'s *writes the
 *     grant at invite time*: the facade refuses a call with no origin claims, so the grant lands
 *     only because the plane's facade call carries the inviter's. A blanket fresh chain reds it.
 *
 * Mutations: record no `originAuth` in `#recordPush`, and the probe control reds; pass
 * `newChain: false` at the plane's one `#send`, and every kind is an offender; send any one kind with
 * a plain `lmz.call`, and the offender list names exactly that kind.
 *
 * In-lane rather than `/live` because the probe reads each push's `callContext` as it arrives —
 * `NebulaClientTest.pushOrigins` — and the positive control needs `StarTest.callClient`; a running
 * stack exposes neither to a scenario.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID, CHAT_NODE_ID, DEFAULT_CHAT_ID, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
import type { QueryDescriptor, TransactionResult } from '@lumenize/nebula';
import { adminClientAt, universeAdminClient, createInvitedClient, createSubject, uniqueStar, addressOfClient } from '../../test-helpers';
import { NebulaClientTest } from './index';
import type { StarTest } from './index';

const VERSION = 'v1';
const TYPES = [
  'interface Parent { name: string }',
  'interface Child { parent: Parent; label: string }',
].join('\n');
const uuid = () => crypto.randomUUID();

async function commit(client: NebulaClientTest, star: string, ops: Parameters<NebulaClientTest['callStarTransaction']>[2]): Promise<void> {
  await client.callStarTransaction(star, VERSION, ops);
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));
  expect((client.lastResult as TransactionResult).ok).toBe(true);
}

/** The pushes that broke the rule: any that carried an `originAuth`, or a chain naming more than
 *  the host. Empty when every push spoke for the host alone. */
function offenders(probe: NebulaClientTest, host: 'STAR' | 'GALAXY'): string[] {
  return probe.pushOrigins
    .filter((p) => p.originSub !== undefined || p.chain.length !== 1 || p.chain[0] !== host)
    .map((p) => `${p.handler} (originSub=${p.originSub ?? 'none'}, chain=${p.chain.join('>')})`);
}

const count = (probe: NebulaClientTest, handler: string) => probe.pushOrigins.filter((p) => p.handler === handler).length;

describe('no subscription update carries the identity of the caller whose call caused it', () => {
  it('the probe records originAuth when one arrives — a plain lmz.call carries its caller\'s claims', async () => {
    const star = uniqueStar();
    const { client: admin, payload, accessToken } = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    await createSubject(new Browser(), star, accessToken, 'probe@example.com');
    const { client: probe, payload: probeP } = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'probe@example.com');

    await admin.lmz.callAsync('STAR', star,
      admin.ctn<StarTest>().callClient(addressOfClient(probe), 'handleOrgTreeUpdate', { value: {} }));
    await vi.waitFor(() => expect(probe.pushOrigins.some((p) => p.handler === 'handleOrgTreeUpdate')).toBe(true));

    const arrived = probe.pushOrigins.find((p) => p.handler === 'handleOrgTreeUpdate')!;
    expect(arrived.originSub).toBe(payload.sub);    // the CALLER's claims rode the plain call…
    expect(arrived.originSub).not.toBe(probeP.sub); // …not the probe's own
  });

  it('every kind of update reaches the probe with no originAuth and a chain naming only the host', async () => {
    // ── Star kinds ────────────────────────────────────────────────────────────────────────────
    const star = uniqueStar();
    const { client: admin, accessToken } = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
    admin.callStarInstallOntology(star, { version: VERSION, types: TYPES });
    await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
    const nodeA = await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'a', 'A');
    const nodeB = await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'b', 'B');
    const readable = uuid(); // a Parent every child of which the probe can read
    const partial = uuid();  // a Parent with one child the probe cannot read
    const hidden = uuid();   // a Parent the probe cannot read at all
    await commit(admin, star, {
      [readable]: { op: 'create', typeName: 'Parent', nodeId: nodeA, value: { name: 'r' } },
      [partial]: { op: 'create', typeName: 'Parent', nodeId: nodeA, value: { name: 'p' } },
      [hidden]: { op: 'create', typeName: 'Parent', nodeId: nodeB, value: { name: 'h' } },
    });
    await commit(admin, star, {
      [uuid()]: { op: 'create', typeName: 'Child', nodeId: nodeA, value: { parent: partial, label: 'a' } },
      [uuid()]: { op: 'create', typeName: 'Child', nodeId: nodeB, value: { parent: partial, label: 'b' } },
    });

    await createSubject(new Browser(), star, accessToken, 'probe@example.com');
    const { client: probe, payload: probeP } = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'probe@example.com');
    await admin.orgTree.setPermission(nodeA, probeP.sub, 'read');
    const qReadable: QueryDescriptor = { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: readable };
    const qPartial: QueryDescriptor = { queryType: 'parentChild', typeName: 'Child', field: 'parent', value: partial };

    // The probe's own subscribes — each initial answer is a kind.
    await probe.resources.subscribe('Parent', readable).snapshot;               // initial resource snapshot
    expect(await probe.resources.subscribe('Parent', hidden).snapshot).toBeNull(); // denied initial resource answer
    using hReadable = probe.resources.subscribeQuery(qReadable); await hReadable.ready;   // reader's initial query update
    using hPartial = probe.resources.subscribeQuery(qPartial); await hPartial.ready;      // has-denial initial query update
    expect(hPartial.deniedNodes).toEqual([nodeB]); // precondition: the has-denial path ran
    using watch = probe.subscribeQuerySubscribers(qReadable); await watch.ready;        // initial roster
    probe.callStarSubscribeTree(star);
    await vi.waitFor(() => expect(count(probe, 'handleOrgTreeUpdate')).toBeGreaterThanOrEqual(1)); // initial tree

    // The admin's calls — each update they cause is a kind.
    const eTagOf = async (id: string) => {
      admin.callStarRead(star, VERSION, id);
      await vi.waitFor(() => expect(admin.callCompleted).toBe(true));
      return (admin.lastResult as { meta: { eTag: string } }).meta.eTag;
    };
    const eTag = await eTagOf(readable);
    const hiddenETag = await eTagOf(hidden);
    const before = {
      resource: count(probe, 'handleResourceUpdate'), query: count(probe, 'handleQueryUpdate'),
      roster: count(probe, 'handleQuerySubscribersUpdate'), tree: count(probe, 'handleOrgTreeUpdate'),
    };
    await commit(admin, star, { [readable]: { op: 'put', eTag, value: { name: 'r2' } } });                         // resource update
    await commit(admin, star, { [hidden]: { op: 'put', eTag: hiddenETag, value: { name: 'h2' } } });              // denied resource update
    await commit(admin, star, { [uuid()]: { op: 'create', typeName: 'Child', nodeId: nodeA, value: { parent: readable, label: 'x' } } }); // reader's query update
    await commit(admin, star, { [uuid()]: { op: 'create', typeName: 'Child', nodeId: nodeA, value: { parent: partial, label: 'y' } } });  // has-denial query update
    using joined = admin.resources.subscribeQuery(qReadable); await joined.ready;                                 // roster update
    await admin.orgTree.createNode(uuid(), ROOT_NODE_ID, 'c', 'C');                                               // tree update
    await vi.waitFor(() => {
      expect(count(probe, 'handleResourceUpdate')).toBeGreaterThanOrEqual(before.resource + 2);
      expect(count(probe, 'handleQueryUpdate')).toBeGreaterThanOrEqual(before.query + 2);
      expect(count(probe, 'handleQuerySubscribersUpdate')).toBeGreaterThan(before.roster);
      expect(count(probe, 'handleOrgTreeUpdate')).toBeGreaterThan(before.tree);
    });
    // The two sends the version rule makes, both through the plane's broadcast: the stale answer
    // pushed at a subscribe pinned to another version, and the install's notice to every subscriber.
    const beforeVersion = count(probe, 'handleResourceUpdate');
    probe.callStarSubscribe(star, 'v-old', 'Parent', readable);                                   // version push at subscribe
    await vi.waitFor(() => expect(count(probe, 'handleResourceUpdate')).toBeGreaterThan(beforeVersion));
    const beforeNotice = count(probe, 'handleResourceUpdate');
    admin.callStarInstallOntology(star, { version: 'v2', types: TYPES });                        // install notice
    await vi.waitFor(() => expect(count(probe, 'handleResourceUpdate')).toBeGreaterThan(beforeNotice));
    expect(offenders(probe, 'STAR')).toEqual([]);

    // ── Galaxy kind: a streaming chunk, caused by the admin's turn ────────────────────────────
    const scope = `ident-${uuid().slice(0, 8)}.app`;
    const chatPair = { resourceHostBinding: 'GALAXY' } as const;
    const { client: gAdmin, accessToken: gToken } = await universeAdminClient(
      NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair);
    const adminBrowser = new Browser();
    await createSubject(adminBrowser, scope, gToken, 'probe@example.com');
    const { client: gProbe, payload: gProbeP } = await createInvitedClient(
      NebulaClientTest, new Browser(), scope, scope, 'probe@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair);
    await gAdmin.orgTree.setPermission(CHAT_NODE_ID, gProbeP.sub, 'read');
    using chat = gProbe.resources.subscribeQuery({ queryType: 'parentChild', typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID });
    await chat.ready;
    gAdmin.callGalaxyChatScripted(scope, 'build it', [
      { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
        { id: 'b1', type: 'function', function: { name: 'build', arguments: '{}' } }] } }] },
      { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'mark_complete', arguments: '{}' } }] } }] },
    ]);
    await vi.waitFor(() => expect(count(gProbe, 'handleStreamChunk')).toBeGreaterThanOrEqual(1));
    expect(offenders(gProbe, 'GALAXY')).toEqual([]);
  });
});
