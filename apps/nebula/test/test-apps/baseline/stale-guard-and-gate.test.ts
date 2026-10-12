/**
 * The two Client mechanisms behind a stale answer that a running page cannot pin down (ADR-024):
 *
 *   - **The reload guard** lives in the Client, around whatever `onShouldRefreshUI` the app
 *     installed, and records in the tab's `sessionStorage` the version it reloaded for. Two
 *     Clients sharing one tab's storage call the app's handler once for a version, and again for
 *     the next one.
 *   - **The version gate**: the first `checking` answer holds every other op, the Client's own
 *     resends included, so a reconnect while it is closed sends each subscribe once. Its wait always
 *     ends: a probe let go opens it, one whose answers stop opens it at the bound, and established
 *     subscriptions refused while it was closed are sent again when it opens.
 *
 * In-lane rather than `/live`: two Clients on one injected storage, and a reconnect at a chosen
 * moment while the Star's ask is held outstanding, are states no page can produce on demand.
 * `dev-star-follows-the-build` limbs 6–9 drive the same decisions through real pages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { ROOT_NODE_ID } from '@lumenize/resources';
import type { OntologyStaleInfo, TransactionOutcome } from '@lumenize/resources';
import { adminClientAt, createInvitedClient, pageOf } from '../../test-helpers';
import { NebulaClientTest } from './index';
import type { StarTest } from './index';

const TYPES = 'interface TestResource { title: string }';
const EMAIL = 'admin@example.com';
const uniqueStar = () => `sg-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;

type SinkEntry = { namespace: string; level: string; message: string; data?: Record<string, any> };
let sink: SinkEntry[] = [];
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e as unknown as SinkEntry)); });
afterEach(() => clearDebugSink());

/** The decisions the Clients made on stale answers other than a retry, in arrival order. */
const decisions = () => sink
  .filter((e) => e.namespace === 'lumenize.nebula-client' && e.message === 'stale answer')
  .map((e) => e.data?.action as string);

async function install(c: NebulaClientTest, star: string, version: string) {
  c.callStarInstallOntology(star, { version, types: TYPES });
  await vi.waitFor(() => expect(c.callCompleted).toBe(true));
  expect(c.lastError).toBeUndefined();
}

function committed(outcome: TransactionOutcome): void {
  if (outcome.kind !== 'committed') throw new Error(`expected committed, got ${outcome.kind}`);
}

describe('the reload guard', () => {
  // Mutations: let `decideStale` ignore `reloadedFor` (the second Client calls too); keep the guard
  // in a field per Client rather than the storage (likewise); record a constant rather than the
  // version (the third, naming a new version, never calls).
  it('calls the app\'s handler once per version, across the Clients of one tab', async () => {
    const star = uniqueStar();
    const browser = new Browser();
    // One tab's storage, handed to each Client as a page in that tab would have it.
    const tab = browser.context(pageOf(star)).sessionStorage;
    const calls: OntologyStaleInfo[] = [];
    const extra = { sessionStorage: tab, onShouldRefreshUI: (info: OntologyStaleInfo) => { calls.push(info); } };

    const first = (await adminClientAt(NebulaClientTest, browser, star, star, EMAIL, 'v1', extra)).client;
    await install(first, star, 'v1');
    const second = (await createInvitedClient(NebulaClientTest, browser, star, star, EMAIL, 'v1', extra)).client;
    const id = crypto.randomUUID();
    committed(await first.resources.transaction({
      [id]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'one' } },
    }));
    await first.resources.subscribe('TestResource', id).snapshot;
    await second.resources.subscribe('TestResource', id).snapshot;

    // An install drops both subscriptions and tells each Client: a notice naming `v2`.
    await install(first, star, 'v2');
    await vi.waitFor(() => expect(decisions()).toHaveLength(2));
    expect(decisions().sort()).toEqual(['reload', 'resolve']);
    expect(calls).toEqual([{ reason: 'ontology-stale', clientVersion: 'v1', currentVersion: 'v2' }]);

    // The page after its reload, in the same tab, built against `v2`. The next install names `v3`.
    const third = (await createInvitedClient(NebulaClientTest, browser, star, star, EMAIL, 'v2', extra)).client;
    await third.resources.subscribe('TestResource', id).snapshot;
    await install(first, star, 'v3');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ reason: 'ontology-stale', clientVersion: 'v2', currentVersion: 'v3' });

    for (const c of [first, second, third]) c[Symbol.dispose]();
  });
});

describe('the version gate', () => {
  const holdAnswers = (c: NebulaClientTest, star: string, hold: boolean) =>
    c.lmz.callAsync('STAR', star, c.ctn<StarTest>().holdOntologyAnswersForTest(hold));
  const arrivals = (star: string, topic: string) => sink.filter((e) =>
    e.namespace === 'nebula.Resources.subscribe' && e.message === 'arrived'
    && e.data?.instanceName === star && e.data?.topic === topic).length;
  const gateClosed = () => sink.some((e) =>
    e.namespace === 'lumenize.nebula-client' && e.message === 'version gate closed');
  const gateLine = (client: NebulaClientTest, message: string) => sink.some((e) =>
    e.namespace === 'lumenize.nebula-client' && e.message === message && e.data?.client === client.lmz.instanceName);
  const admitted = (star: string, topic: string) => sink.filter((e) =>
    e.namespace === 'nebula.Resources.subscribe' && e.message === 'arrived'
    && e.data?.instanceName === star && e.data?.topic === topic && e.data?.stale === false).length;

  /** A client pinned to v1 on a Star holding two rows written at v1, which then moves to v0 with
   *  its Galaxy's answer held, so every op the client sends is answered `checking`. */
  async function starAtAnotherVersion(subscribeFirst = false) {
    const star = uniqueStar();
    const calls: OntologyStaleInfo[] = [];
    const client = (await adminClientAt(NebulaClientTest, new Browser(), star, star, EMAIL, 'v1',
      { onShouldRefreshUI: (info: OntologyStaleInfo) => { calls.push(info); } })).client;
    await install(client, star, 'v1');
    const ids = [crypto.randomUUID(), crypto.randomUUID()] as const;
    committed(await client.resources.transaction({
      [ids[0]]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'a' } },
      [ids[1]]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'b' } },
    }));
    if (subscribeFirst) for (const id of ids) await client.resources.subscribe('TestResource', id).snapshot;
    await install(client, star, 'v0');
    await holdAnswers(client, star, true);
    return { star, client, ids, calls };
  }

  // Mutations: let `#resendVersioned` send while the gate is closed (the reconnect sends the held
  // subscribe, and the opening sends it again); let `#gatedSend` send at once (likewise).
  it('a reconnect while it is closed sends each subscribe once', async () => {
    const star = uniqueStar();
    const client = (await adminClientAt(NebulaClientTest, new Browser(), star, star, EMAIL, 'v1')).client;
    await install(client, star, 'v1');
    const probe = crypto.randomUUID();
    const held = crypto.randomUUID();
    committed(await client.resources.transaction({
      [probe]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'probe' } },
      [held]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'held' } },
    }));
    // The Star moves to another version and the Galaxy's answer is held, so every op this page
    // sends is answered `checking`: the first subscribe closes the gate and retries alone.
    await install(client, star, 'v0');
    await holdAnswers(client, star, true);
    const probing = client.resources.subscribe('TestResource', probe).snapshot;
    await vi.waitFor(() => expect(gateClosed()).toBe(true));
    const waiting = client.resources.subscribe('TestResource', held).snapshot;

    client.disconnect();
    client.connect();
    await vi.waitFor(() => expect(client.connectionState).toBe('connected'));
    // An early look, which caught both mutations when they were run; the count after the gate
    // opens is the check no timing can pass.
    await Promise.resolve();
    expect(arrivals(star, held)).toBe(0);

    // The row lands within the probe's retries, so its next retry is answered and the gate opens.
    await install(client, star, 'v1');
    expect((await probing)?.value).toEqual({ title: 'probe' });
    expect((await waiting)?.value).toEqual({ title: 'held' });
    expect(arrivals(star, held)).toBe(1);

    client[Symbol.dispose]();
  });
  // Mutation: decide a `checking` answer on a channel nothing holds as any other stale answer;
  // it names v0, the version being replaced, so the page reloads.
  it('a `checking` answer on a subscription let go reloads nothing', async () => {
    const { star, client, ids, calls } = await starAtAnotherVersion();
    const letGo = client.resources.subscribe('TestResource', ids[0]);
    letGo.snapshot.catch(() => { /* abandoned with its handle */ });
    letGo[Symbol.dispose]();
    // Sent after, so answered after: once it closes the gate, the first answer has been read.
    client.resources.subscribe('TestResource', ids[1]).snapshot.catch(() => { /* not awaited */ });
    await vi.waitFor(() => expect(gateLine(client, 'version gate closed')).toBe(true));
    expect(arrivals(star, ids[0])).toBe(1);
    expect(calls).toEqual([]);
    client[Symbol.dispose]();
  });

  // Mutation: retry a probe without looking at whether anything still holds it.
  it('a probe let go opens the gate', async () => {
    const { client, ids } = await starAtAnotherVersion();
    const probe = client.resources.subscribe('TestResource', ids[0]);
    probe.snapshot.catch(() => { /* abandoned with its handle */ });
    await vi.waitFor(() => expect(gateLine(client, 'version gate closed')).toBe(true));
    probe[Symbol.dispose]();
    await vi.waitFor(() => expect(gateLine(client, 'version gate opened')).toBe(true));
    client[Symbol.dispose]();
  });

  // Mutation: end a push channel refused for some other reason without letting its probe go.
  // The shape a wipe makes: the row a restore asks for again no longer exists.
  it('a probe refused for another reason opens the gate', async () => {
    const { star, client } = await starAtAnotherVersion();
    const missing = client.resources.subscribe('TestResource', crypto.randomUUID()).snapshot;
    const refused = missing.then(() => 'answered', (e: Error) => e.message);
    await vi.waitFor(() => expect(gateLine(client, 'version gate closed')).toBe(true));
    await install(client, star, 'v1');
    expect(await refused).toMatch(/not found/);
    await vi.waitFor(() => expect(gateLine(client, 'version gate opened')).toBe(true));
    client[Symbol.dispose]();
  });

  // Mutation: drop the deadline's opening. A real lapse, not a fake clock: the probe's answers
  // stop because its socket is gone, which is how one goes missing in a tab. The probe is an
  // established subscription a restore sent; a first subscribe would instead be abandoned when the
  // socket goes, which ends its probe at once.
  it('a probe whose answers stop opens the gate at the bound', async () => {
    const { client } = await starAtAnotherVersion(true);
    client._restoreSubscriptionsForTest();
    await vi.waitFor(() => expect(gateLine(client, 'version gate closed')).toBe(true));
    client.disconnect();
    await vi.waitFor(() => expect(gateLine(client, 'version gate timed out')).toBe(true), { timeout: 40_000, interval: 500 });
    expect(gateLine(client, 'version gate opened')).toBe(true);
    client[Symbol.dispose]();
  }, 60_000);

  // Mutation: resend only the subscribes still awaiting a first answer when the gate opens, as the
  // gate first did; the established one a restore sent is then never sent again.
  it('established subscriptions refused while it was closed are sent again when it opens', async () => {
    const { star, client, ids } = await starAtAnotherVersion(true);
    // Both were admitted at v1 before the Star moved. A restore sends both again: the first
    // answer closes the gate, and the second is refused behind it.
    client._restoreSubscriptionsForTest();
    await vi.waitFor(() => expect(arrivals(star, ids[1])).toBe(2));
    await install(client, star, 'v1');
    await vi.waitFor(() => expect(admitted(star, ids[1])).toBe(2));
    client[Symbol.dispose]();
  });
});
