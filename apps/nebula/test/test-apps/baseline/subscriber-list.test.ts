/**
 * Subscriber-list — the STANDALONE subscription to a query's live `{ sub, profileId }` roster
 * (tasks/nebula-subscriber-lists.md). A WATCHER subscribes to the subscriber-LIST of query Q
 * (`subscribeQuerySubscribers`) WITHOUT being a data-subscriber of Q; the roster is projected from
 * `QuerySubscribers` (the data-subscribers) and delivered to the WATCHERS on any data-subscriber
 * join/leave. Reworks the presence build: the projection (dedup-by-`sub`, profileId capture, join/leave
 * guards) is reused verbatim; the AUDIENCE moved from data-subscribers → a separate watcher registry.
 *
 * Harness (rung-3, ADR-009 — the baseline login lane is expectedly red mid-turnover): `NebulaClientTest`
 * + `createNebulaTestToken` → real Gateway → Star/DevStudio. A WATCHER uses `client.subscribeQuerySubscribers`
 * and asserts on the `handleQuerySubscribersUpdate` capture (`lastQuerySubscribersUpdate`/count). Data
 * churn uses `client.resources.subscribeQuery`. Server branch decisions are asserted via the debug marker
 * `nebula.ResourceDataPlane.subscribers`. Every test is capable-of-failing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { createNebulaTestToken } from '@lumenize/nebula-auth/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { canonicalQueryHash, DEFAULT_SESSION_ID } from '@lumenize/nebula';
import type { QueryDescriptor, OntologyVersionConfig } from '@lumenize/nebula';
import { NebulaClientTest } from './index';

const ORIGIN = 'http://localhost';
const VERSION = 'v1';
const TYPES = [
  'interface Parent { name: string }',
  'interface Child { parent: Parent; label: string }',
].join('\n');

function uuid(): string { return crypto.randomUUID(); }
const uniqueStar = () => `sublist-${uuid().slice(0, 8)}.app.tenant`;
const mkQuery = (): QueryDescriptor => ({ queryType: 'parentChild', typeName: 'Child', field: 'parent', value: uuid() });

let clients: NebulaClientTest[] = [];
async function connect(opts: {
  star: string; sub?: string; profileId?: string; isAdmin?: boolean; tab?: string;
  binding?: 'STAR' | 'DEV_STUDIO';
}): Promise<NebulaClientTest> {
  const sub = opts.sub ?? uuid();
  const { access_token } = await createNebulaTestToken({
    privateKey: (env as any).JWT_PRIVATE_KEY_BLUE,
    activeScope: opts.star, instanceName: opts.star,
    isAdmin: opts.isAdmin ?? false, profileId: opts.profileId, sub, ttlSeconds: 3600,
  })();
  const browser = new Browser();
  const ctx = browser.context(ORIGIN);
  const client = new NebulaClientTest({
    baseUrl: ORIGIN, authScope: opts.star, activeScope: opts.star, appVersion: VERSION,
    resourceHostBinding: opts.binding ?? 'STAR', accessToken: access_token,
    instanceName: `${sub}.${opts.tab ?? uuid().slice(0, 8)}`,
    fetch: browser.fetch, WebSocket: browser.WebSocket,
    sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
  });
  clients.push(client);
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'));
  return client;
}

async function admin(star: string): Promise<{ client: NebulaClientTest; sub: string }> {
  const sub = uuid();
  const client = await connect({ star, sub, isAdmin: true });
  client.callStarApplyOntology(star, { version: VERSION, types: TYPES } as OntologyVersionConfig);
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));
  return { client, sub };
}

/** Distinct-by-`sub` set in a watcher's latest roster push. */
const rosterSubs = (c: NebulaClientTest) => new Set((c.lastQuerySubscribersUpdate?.roster ?? []).map((e) => e.sub));

/** Row counts in the STAR's two subscription tables (dedicated-reap assertion needs BOTH). */
async function tableRows(star: string, table: 'QuerySubscribers' | 'QuerySubscriberListSubs', queryHash: string): Promise<number> {
  const stub: any = (env as any).STAR.getByName(star);
  return (runInDurableObject as any)(stub, (_i: any, c: any) =>
    (c.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE queryHash = ?`, queryHash).toArray()[0].n as number));
}

let sink: any[] = [];
const marks = (event: string, queryHash: string, clientId: string) =>
  sink.filter((e) => e.namespace === 'nebula.ResourceDataPlane.subscribers'
    && e.data?.event === event && e.data?.queryHash === queryHash && e.data?.clientId === clientId);
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e)); });
afterEach(() => {
  clearDebugSink();
  for (const c of clients) { try { c[Symbol.dispose](); } catch { /* already gone */ } }
  clients = [];
});

describe('subscriber-list — the STANDALONE roster of a query subscription', () => {
  it('STANDALONE + content — a WATCHER (not a data-subscriber) receives the distinct-by-`sub` `{ sub, profileId }` roster; absent claim degrades to sub-only', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();

    // W watches the subscriber-LIST of Q but does NOT subscribe to Q's data (standalone).
    const w = await connect({ star });
    const wh = w.subscribeQuerySubscribers(query);
    await wh.ready; // initial (empty) roster

    // A data-subscriber WITH a profileId joins Q → the watcher's roster gains { aSub, aPid }.
    const aSub = uuid(); const aPid = uuid();
    const a = await connect({ star, sub: aSub, profileId: aPid });
    await a.resources.subscribeQuery(query).ready;
    await vi.waitFor(() => expect(rosterSubs(w).has(aSub)).toBe(true));
    expect(w.lastQuerySubscribersUpdate?.roster).toContainEqual({ sub: aSub, profileId: aPid });

    // A data-subscriber WITHOUT a profileId → sub-only entry, no throw (degrade).
    const bSub = uuid();
    const b = await connect({ star, sub: bSub });
    await b.resources.subscribeQuery(query).ready;
    await vi.waitFor(() => expect(rosterSubs(w).has(bSub)).toBe(true));
    const bareEntry = w.lastQuerySubscribersUpdate?.roster?.find((e) => e.sub === bSub);
    expect(bareEntry).toEqual({ sub: bSub });
    expect(bareEntry).not.toHaveProperty('profileId');
  });

  it('WATCHERS not data-subscribers receive the re-push — a data-subscriber who is NOT a watcher gets NO roster push; a watcher who is NOT a data-subscriber DOES', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();

    // D is a DATA-subscriber of Q but NOT a watcher; W is a WATCHER but NOT a data-subscriber.
    const d = await connect({ star });
    await d.resources.subscribeQuery(query).ready;
    const w = await connect({ star });
    await w.subscribeQuerySubscribers(query).ready;

    const dBaseline = d.querySubscribersUpdateCount;
    const wBaseline = w.querySubscribersUpdateCount;

    // A new data-subscriber joins → the roster grows.
    const e = await connect({ star });
    await e.resources.subscribeQuery(query).ready;

    // W (watcher) receives the grown roster; D (data-sub, non-watcher) receives NOTHING on this channel.
    await vi.waitFor(() => expect(w.querySubscribersUpdateCount).toBeGreaterThan(wBaseline));
    expect(d.querySubscribersUpdateCount).toBe(dBaseline);
  });

  it('ECHO-FREE — a watcher registration receives a roster push but NO query-DATA push, and does not enter the QuerySubscribers data table', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();
    const qh = canonicalQueryHash(query);

    const w = await connect({ star });
    await w.subscribeQuerySubscribers(query).ready;

    // The watcher got a roster (subscriber-list) push but NO query-DATA push (it never subscribed to data).
    expect(w.querySubscribersUpdateCount).toBeGreaterThanOrEqual(1);
    expect(w.queryUpdateCount).toBe(0);
    // And the watcher registration did NOT add a row to the QuerySubscribers DATA table (separate table).
    expect(await tableRows(star, 'QuerySubscribers', qh)).toBe(0);
    expect(await tableRows(star, 'QuerySubscriberListSubs', qh)).toBe(1);
  });

  it('NO dead else-push — a 2nd tab of an already-present data-subscriber (non-`isNewSub`) fires ZERO roster pushes', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();
    const qh = canonicalQueryHash(query);

    const w = await connect({ star });
    await w.subscribeQuerySubscribers(query).ready;
    const aSub = uuid();
    const a1 = await connect({ star, sub: aSub, tab: 't1' });
    await a1.resources.subscribeQuery(query).ready; // isNewSub → W's roster grows
    await vi.waitFor(() => expect(rosterSubs(w).has(aSub)).toBe(true));
    const wBaseline = w.querySubscribersUpdateCount;

    // 2nd tab of the SAME sub → NOT isNewSub → the roster did not change → NO push to the watcher.
    const a2 = await connect({ star, sub: aSub, tab: 't2' });
    await a2.resources.subscribeQuery(query).ready;
    await vi.waitFor(() => expect(marks('subscribe', qh, a2.lmz.instanceName)[0]?.data.mode).toBe('noop'));
    expect(w.querySubscribersUpdateCount).toBe(wBaseline); // the non-isNewSub join emitted nothing to watchers
  });

  it('LEAVE re-pushes the shrunk roster to watchers; a repeated (no-op) remove emits NO push', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();
    const qh = canonicalQueryHash(query);
    const aSub = uuid(); const bSub = uuid();

    const w = await connect({ star });
    await w.subscribeQuerySubscribers(query).ready;
    const a = await connect({ star, sub: aSub });
    await a.resources.subscribeQuery(query).ready;
    const b = await connect({ star, sub: bSub });
    const bHandle = b.resources.subscribeQuery(query);
    await bHandle.ready;
    await vi.waitFor(() => expect(rosterSubs(w)).toEqual(new Set([aSub, bSub])));

    // B leaves (dispose the data-sub handle → fires unsubscribeQuery) → the watcher gets the shrunk roster.
    bHandle[Symbol.dispose]();
    await vi.waitFor(() => expect(rosterSubs(w)).toEqual(new Set([aSub])));
    await vi.waitFor(() => expect(marks('remove', qh, b.lmz.instanceName).some((m) => m.data.mode === 'broadcast')).toBe(true));
  });

  it('FAIL-CLOSED validation — a watcher on an INVALID query is rejected (ready rejects), not left silently empty', async () => {
    const star = uniqueStar();
    await admin(star);
    // A malformed query (unknown queryType) — `#validateQuery` must reject it, keyed by queryHash.
    const badQuery = { queryType: 'not-a-real-type', typeName: 'Child', field: 'parent', value: uuid() } as unknown as QueryDescriptor;

    const w = await connect({ star });
    await expect(w.subscribeQuerySubscribers(badQuery).ready).rejects.toThrow();
    // The fail-closed Error arrived on the dedicated channel (captured).
    await vi.waitFor(() => expect(w.lastQuerySubscribersUpdate?.error).toBeInstanceOf(Error));
  });

  it('DEDICATED reap — a dual-role client (data-subscriber AND watcher of Q) that disconnects loses its WATCHER row on a failed roster push, but its DATA row is reaped SEPARATELY (assert BOTH tables)', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();
    const qh = canonicalQueryHash(query);

    // DR is BOTH a data-subscriber AND a watcher of Q (the pinned chat-participant shape).
    const drSub = uuid();
    const dr = await connect({ star, sub: drSub });
    await dr.resources.subscribeQuery(query).ready;
    await dr.subscribeQuerySubscribers(query).ready;
    await vi.waitFor(async () => expect(await tableRows(star, 'QuerySubscribers', qh)).toBe(1));
    await vi.waitFor(async () => expect(await tableRows(star, 'QuerySubscriberListSubs', qh)).toBe(1));

    // DR disconnects; a NEW data-subscriber joins → the roster grows → #broadcastRoster pushes to the
    // (now-dead) watcher DR → the DEDICATED onQuerySubscriberListBroadcastResult reaps DR's WATCHER row.
    dr[Symbol.dispose]();
    const trigger = await connect({ star });
    await trigger.resources.subscribeQuery(query).ready;

    // DR's WATCHER row is reaped from the watcher table (the dedicated onQuerySubscriberListBroadcastResult
    // → removeQuerySubscriberListWatcher). A wrong reuse of removeQuerySubscriber (the DATA table) would
    // instead leave the watcher row here (this stays 1) — so this alone catches the wrong-table mutation.
    await vi.waitFor(async () => expect(await tableRows(star, 'QuerySubscriberListSubs', qh)).toBe(0));
    // ...and the roster reap did NOT touch the DATA table: DR's (now-stale) data row SURVIVES alongside the
    // trigger's → 2 rows. (Both tables share the (queryHash, clientId) key, so a watcher-only check would
    // false-pass; asserting the data table stayed at 2 proves the dedicated reap didn't clobber the data
    // sub — DR's stale data row is reaped separately by a data broadcast, out of this test's scope.)
    expect(await tableRows(star, 'QuerySubscribers', qh)).toBe(2);
  });

  it('REACHABILITY not read — a non-admin watcher with ZERO read grants still receives the FULL roster; no permission fields leak', async () => {
    const star = uniqueStar();
    const { sub: adminSub } = await admin(star);
    const query = mkQuery();

    // A brand-new NON-admin watcher with no grants on any node.
    const userSub = uuid();
    const user = await connect({ star, sub: userSub, isAdmin: false });
    await user.subscribeQuerySubscribers(query).ready;

    // An admin data-subscriber joins → the watcher (zero grants) still gets the full roster.
    const a = await connect({ star, sub: adminSub });
    await a.resources.subscribeQuery(query).ready;
    await vi.waitFor(() => expect(rosterSubs(user).has(adminSub)).toBe(true));
    // Advisory/display-only: no permission/data fields leak.
    const s = JSON.stringify(user.lastQuerySubscribersUpdate!.roster);
    expect(s).not.toContain('deniedNodes');
    expect(s).not.toContain('resourceIds');
    expect(s).not.toContain('accessAdmin');
  });

  it('GENERICITY — the standalone subscriber-list rides a DevStudio host too (same shared ResourceDataPlane + bridge)', async () => {
    const scope = `sublist-ds-${uuid().slice(0, 8)}.app.tenant`;
    const query: QueryDescriptor = {
      queryType: 'parentChild', typeName: 'Message', field: 'session', value: DEFAULT_SESSION_ID,
    };
    // A WATCHER on DevStudio (resourceHostBinding routes subscribeQuerySubscribers to DEV_STUDIO).
    const w = await connect({ star: scope, binding: 'DEV_STUDIO' });
    await w.subscribeQuerySubscribers(query).ready;

    const bSub = uuid();
    const b = await connect({ star: scope, sub: bSub, binding: 'DEV_STUDIO' });
    await b.resources.subscribeQuery(query).ready;
    // The watcher sees the grown roster → DevStudio's bridge impl works (ADR-007 composition).
    await vi.waitFor(() => expect(rosterSubs(w).has(bSub)).toBe(true));
  });

  it('ONTOLOGY-INSTALL — a watcher’s row is cleared on a new-version install (clearWatchers unioned into #installState)', async () => {
    const star = uniqueStar();
    const { client: adminClient } = await admin(star);
    const query = mkQuery();
    const qh = canonicalQueryHash(query);

    const w = await connect({ star });
    await w.subscribeQuerySubscribers(query).ready;
    await vi.waitFor(async () => expect(await tableRows(star, 'QuerySubscriberListSubs', qh)).toBe(1));

    // A new-version ontology install drains ALL THREE registries (incl. watchers via clearWatchers) so a
    // watcher whose watched type/field an install could remove is cleared, not left silently stale.
    adminClient.callStarApplyOntology(star, { version: 'v2', types: TYPES } as OntologyVersionConfig);
    await vi.waitFor(() => expect(adminClient.callCompleted).toBe(true));
    // Reds if clearWatchers() is NOT unioned into #installState (the watcher row would survive the install).
    await vi.waitFor(async () => expect(await tableRows(star, 'QuerySubscriberListSubs', qh)).toBe(0));
  });

  it('WATCHER refcount — 2 handles of the same query share ONE server row; unsubscribeQuerySubscribers fires only on the LAST dispose', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();
    const qh = canonicalQueryHash(query);

    const w = await connect({ star });
    const h1 = w.subscribeQuerySubscribers(query);
    const h2 = w.subscribeQuerySubscribers(query); // coalesces (same canonical query, one client)
    await Promise.all([h1.ready, h2.ready]);
    await vi.waitFor(async () => expect(await tableRows(star, 'QuerySubscriberListSubs', qh)).toBe(1));

    // Release ONE handle — the other still holds it open, so NO unsubscribe fires. Positive signal: a data
    // join still re-pushes the roster to w (its watcher row survived h1's dispose).
    h1[Symbol.dispose]();
    const wBaseline = w.querySubscribersUpdateCount;
    const trigger = await connect({ star });
    await trigger.resources.subscribeQuery(query).ready;
    await vi.waitFor(() => expect(w.querySubscribersUpdateCount).toBeGreaterThan(wBaseline)); // reds if h1 dispose unsubscribed early

    // Release the LAST handle → unsubscribeQuerySubscribers fires → the watcher row drops.
    h2[Symbol.dispose]();
    await vi.waitFor(async () => expect(await tableRows(star, 'QuerySubscriberListSubs', qh)).toBe(0));
  });
});
