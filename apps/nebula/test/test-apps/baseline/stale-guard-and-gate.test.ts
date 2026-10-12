/**
 * The two Client mechanisms behind a stale answer that a running page cannot pin down (ADR-024):
 *
 *   - **The reload guard** lives in the Client, around whatever `onShouldRefreshUI` the app
 *     installed, and records in the tab's `sessionStorage` the version it reloaded for. Two
 *     Clients sharing one tab's storage call the app's handler once for a version, and again for
 *     the next one.
 *   - **The version gate**: the first `checking` answer holds every other op, the Client's own
 *     resends included, so a reconnect while it is closed sends each subscribe once.
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
    // The reconnect's walk runs on a microtask after `connected`; nothing has reached the Star.
    await Promise.resolve();
    expect(arrivals(star, held)).toBe(0);

    // The row lands within the probe's retries, so its next retry is answered and the gate opens.
    await install(client, star, 'v1');
    expect((await probing)?.value).toEqual({ title: 'probe' });
    expect((await waiting)?.value).toEqual({ title: 'held' });
    expect(arrivals(star, held)).toBe(1);

    client[Symbol.dispose]();
  });
});
