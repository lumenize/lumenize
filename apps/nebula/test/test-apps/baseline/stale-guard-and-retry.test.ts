/**
 * Two Client behaviours behind a stale answer that a running page cannot pin down (ADR-024):
 *
 *   - **The reload guard** lives in the Client, around whatever `onShouldRefreshUI` the app
 *     installed, and records in the tab's `sessionStorage` the version it reloaded for and the one
 *     the page ran. Two Clients sharing one tab's storage call the app's handler once for a
 *     version, and again for the next one, or for the same one from a page that has since moved.
 *   - **A `checking` answer is retried by the op it answered, and by no other.** A subscription let
 *     go drops its answer without reloading, and an established subscription a restore sent is
 *     sent again until the Star installs.
 *
 * In-lane rather than `/live`: two Clients on one injected storage, a reload that lands past the
 * version it was for, and a Star whose ask is held outstanding, are states no page can produce on
 * demand. `dev-star-follows-the-build` limbs 6, 7
 * and 9 drive the same decisions through real pages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { ROOT_NODE_ID } from '@lumenize/resources';
import type { BuildStaleInfo, OntologyStaleInfo, TransactionOutcome } from '@lumenize/resources';
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
  // Mutations: let `decideStale` ignore the guard (the second Client calls too); keep the guard
  // in a field per Client rather than the storage (likewise); record a constant rather than the
  // version (the third, naming a new version, never calls).
  it('calls the app\'s handler once per version, across the Clients of one tab', async () => {
    const star = uniqueStar();
    const browser = new Browser();
    // One tab's storage, handed to each Client as a page in that tab would have it.
    const tab = browser.context(pageOf(star)).sessionStorage;
    const calls: Array<OntologyStaleInfo | BuildStaleInfo> = [];
    const extra = { sessionStorage: tab, onShouldRefreshUI: (info: OntologyStaleInfo | BuildStaleInfo) => { calls.push(info); } };

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

  // Mutation: compare only the guard's `for`, and the tab now on v3 stays put → the second call
  // never comes.
  it('calls it again for a version it once reloaded for, from a page that has since moved', async () => {
    const star = uniqueStar();
    const browser = new Browser();
    const tab = browser.context(pageOf(star)).sessionStorage;
    const calls: Array<OntologyStaleInfo | BuildStaleInfo> = [];
    const extra = { sessionStorage: tab, onShouldRefreshUI: (info: OntologyStaleInfo | BuildStaleInfo) => { calls.push(info); } };

    // The installer holds no subscription, so no install tells it anything.
    const installer = (await adminClientAt(NebulaClientTest, browser, star, star, EMAIL, 'v1')).client;
    await install(installer, star, 'v1');
    const id = crypto.randomUUID();
    committed(await installer.resources.transaction({
      [id]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'one' } },
    }));
    const page = (await createInvitedClient(NebulaClientTest, browser, star, star, EMAIL, 'v1', extra)).client;
    await page.resources.subscribe('TestResource', id).snapshot;

    // The tab reloads from v1 for v2.
    await install(installer, star, 'v2');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    page[Symbol.dispose]();

    // The reload landed on a page built against v3, which the Star then installs.
    await install(installer, star, 'v3');
    const later = (await createInvitedClient(NebulaClientTest, browser, star, star, EMAIL, 'v3', extra)).client;
    await later.resources.subscribe('TestResource', id).snapshot;

    // The Star returns to v2: the guard names v2, but from v1, and this page runs v3.
    await install(installer, star, 'v2');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ reason: 'ontology-stale', clientVersion: 'v3', currentVersion: 'v2' });

    for (const c of [installer, later]) c[Symbol.dispose]();
  });
});

describe('a `checking` answer', () => {
  const holdAnswers = (c: NebulaClientTest, star: string, hold: boolean) =>
    c.lmz.callAsync('STAR', star, c.ctn<StarTest>().holdOntologyAnswersForTest(hold));
  const arrivals = (star: string, topic: string) => sink.filter((e) =>
    e.namespace === 'nebula.Resources.subscribe' && e.message === 'arrived'
    && e.data?.instanceName === star && e.data?.topic === topic).length;
  const admitted = (star: string, topic: string) => sink.filter((e) =>
    e.namespace === 'nebula.Resources.subscribe' && e.message === 'arrived'
    && e.data?.instanceName === star && e.data?.topic === topic && e.data?.stale === false).length;

  /** A client pinned to v1 on a Star holding two rows written at v1, which then moves to v0 with
   *  its Galaxy's answer held, so every op the client sends is answered `checking`. */
  async function starAtAnotherVersion(subscribeFirst = false) {
    const star = uniqueStar();
    const calls: Array<OntologyStaleInfo | BuildStaleInfo> = [];
    const client = (await adminClientAt(NebulaClientTest, new Browser(), star, star, EMAIL, 'v1',
      { onShouldRefreshUI: (info: OntologyStaleInfo | BuildStaleInfo) => { calls.push(info); } })).client;
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

  // Mutation: decide a `checking` answer on a channel nothing holds as any other stale answer;
  // it names v0, the version being replaced, so the page reloads.
  it('on a subscription let go reloads nothing', async () => {
    const { star, client, ids, calls } = await starAtAnotherVersion();
    const letGo = client.resources.subscribe('TestResource', ids[0]);
    letGo.snapshot.catch(() => { /* abandoned with its handle */ });
    letGo[Symbol.dispose]();
    // Sent after, so answered after: once it has been sent again, the first answer has been read.
    client.resources.subscribe('TestResource', ids[1]).snapshot.catch(() => { /* not awaited */ });
    await vi.waitFor(() => expect(arrivals(star, ids[1])).toBeGreaterThanOrEqual(2));
    expect(arrivals(star, ids[0])).toBe(1);
    expect(calls).toEqual([]);
    client[Symbol.dispose]();
  });

  // Mutation: send a resource subscription again only while it awaits its first answer; the
  // established ones a restore sent are then never sent again.
  it('on an established subscription a restore sent, sends it again', async () => {
    const { star, client, ids } = await starAtAnotherVersion(true);
    // Both were admitted at v1 before the Star moved. A restore sends both again, and the held ask
    // answers each `checking`.
    client._restoreSubscriptionsForTest();
    await vi.waitFor(() => expect(arrivals(star, ids[1])).toBeGreaterThanOrEqual(2));
    await install(client, star, 'v1');
    await vi.waitFor(() => expect([admitted(star, ids[0]), admitted(star, ids[1])]).toEqual([2, 2]));
    client[Symbol.dispose]();
  });
});
