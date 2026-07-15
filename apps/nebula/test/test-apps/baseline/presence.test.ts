/**
 * Presence — the live `{ sub, profileId }` roster of a query subscription
 * (tasks/nebula-presence-subscription.md). The roster RIDES the existing query
 * subscription: `QuerySubscribers` gains `profileId`, `ResourceDataPlane`
 * projects a DISTINCT-by-`sub` roster and pushes it on a genuine join / leave,
 * and `NebulaClient.handlePresenceUpdate` folds it onto the `QueryEntry`.
 *
 * Harness (profile-store template): `NebulaClientTest` + `createNebulaTestToken`
 * (rung-3, ADR-009 — precise control of `sub`/`profileId`/scope, and the baseline
 * login lane is expectedly red mid-turnover) → real `NebulaClientGateway` → the
 * Star query-subscribe path. Server-integration assertions read the presence
 * CAPTURE override (`lastPresenceUpdate`/`presenceUpdateCount`) because the
 * `callStar*` initiator path bypasses client reactive state; the client-unit test
 * reads the reactive-store landing via `presenceRoster(query)`. Server-side branch
 * decisions (broadcast vs single-deliver vs no-op) are asserted via a debug-sink
 * marker (`nebula.ResourceDataPlane.presence`). Runs in isolation, not gated on the
 * red baseline lane. Every test is capable-of-failing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Browser } from '@lumenize/testing';
import { createNebulaTestToken } from '@lumenize/nebula-auth/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { canonicalQueryHash, DEFAULT_SESSION_ID } from '@lumenize/nebula';
import type { QueryDescriptor, OntologyVersionConfig } from '@lumenize/nebula';
import { NebulaClientTest } from './index';

const ORIGIN = 'http://localhost';
const VERSION = 'v1';
// A Parent/Child ontology so a `parentChild` query on `Child.parent` validates.
const TYPES = [
  'interface Parent { name: string }',
  'interface Child { parent: Parent; label: string }',
].join('\n');

function uuid(): string { return crypto.randomUUID(); }
const uniqueStar = () => `presence-${uuid().slice(0, 8)}.app.tenant`;
/** A distinct valid query per call (distinct parent id → distinct queryHash). */
const mkQuery = (): QueryDescriptor => ({ queryType: 'parentChild', typeName: 'Child', field: 'parent', value: uuid() });

// --- Every client is tracked + disposed in afterEach (avoids `using` across helpers). ---
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

/** Connect an admin + install the ontology (so a query validates). Returns its sub. */
async function admin(star: string): Promise<{ client: NebulaClientTest; sub: string }> {
  const sub = uuid();
  const client = await connect({ star, sub, isAdmin: true });
  client.callStarApplyOntology(star, { version: VERSION, types: TYPES } as OntologyVersionConfig);
  await vi.waitFor(() => expect(client.callCompleted).toBe(true));
  return { client, sub };
}

const subsOf = (c: NebulaClientTest) => new Set((c.lastPresenceUpdate?.roster ?? []).map((e) => e.sub));

// The presence branch marker emitted inside ResourceDataPlane (DO-side; captured in-isolate).
let sink: any[] = [];
const presenceMarks = (event: 'subscribe' | 'remove', queryHash: string, clientId: string) =>
  sink.filter((e) => e.namespace === 'nebula.ResourceDataPlane.presence'
    && e.data?.event === event && e.data?.queryHash === queryHash && e.data?.clientId === clientId);
beforeEach(() => { sink = []; setDebugSink((e) => sink.push(e)); });
afterEach(() => {
  clearDebugSink();
  for (const c of clients) { try { c[Symbol.dispose](); } catch { /* already gone */ } }
  clients = [];
});

describe('presence — the live roster of a query subscription', () => {
  it('captures profileId → the roster carries { sub, profileId } end-to-end; an absent claim degrades to sub-only', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();

    // Subscriber WITH a profileId → a non-null profileId arrives in the roster (M4: not just the key shape).
    const pidSub = uuid(); const pid = uuid();
    const a = await connect({ star, sub: pidSub, profileId: pid });
    a.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(a.presenceUpdateCount).toBeGreaterThanOrEqual(1));
    expect(a.lastPresenceUpdate?.roster).toContainEqual({ sub: pidSub, profileId: pid });

    // Subscriber WITHOUT a profileId → its entry is sub-only, no throw (#5 degrade).
    const bareSub = uuid();
    const b = await connect({ star, sub: bareSub });
    b.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(b.presenceUpdateCount).toBeGreaterThanOrEqual(1));
    const bareEntry = b.lastPresenceUpdate?.roster.find((e) => e.sub === bareSub);
    expect(bareEntry).toEqual({ sub: bareSub });
    expect(bareEntry).not.toHaveProperty('profileId');
  });

  it('dedups by sub ALONE — two connections of one sub (one profileId-less) collapse to ONE entry, defined profileId wins (M3)', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();
    const sSub = uuid(); const pid = uuid();

    // Two connections of the SAME sub: t1 without a profileId, t2 with one.
    const s1 = await connect({ star, sub: sSub, tab: 't1' });
    s1.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(s1.presenceUpdateCount).toBeGreaterThanOrEqual(1));
    const s2 = await connect({ star, sub: sSub, profileId: pid, tab: 't2' });
    s2.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(s2.presenceUpdateCount).toBeGreaterThanOrEqual(1));

    // An observer joins AFTER both connections → projects the deduped roster.
    const o = await connect({ star });
    o.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(o.presenceUpdateCount).toBeGreaterThanOrEqual(1));
    const sEntries = o.lastPresenceUpdate!.roster.filter((e) => e.sub === sSub);
    // ONE entry (dedup by sub, not the (sub,profileId) tuple), and NULL never won.
    expect(sEntries).toEqual([{ sub: sSub, profileId: pid }]);
  });

  it('a new sub joining re-pushes the GROWN roster to existing subscribers — with NO query-data rerun (M1 + roster-only)', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();
    const aSub = uuid();
    const a = await connect({ star, sub: aSub });
    a.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(a.presenceUpdateCount).toBe(1));
    expect([...subsOf(a)]).toEqual([aSub]);
    const aQueryCountBaseline = a.queryUpdateCount; // the initial query-data push (=1)

    const bSub = uuid();
    const b = await connect({ star, sub: bSub });
    b.callStarSubscribeQuery(star, query);
    // A (existing) receives the grown roster via a PRESENCE push...
    await vi.waitFor(() => expect(a.presenceUpdateCount).toBe(2));
    expect(subsOf(a)).toEqual(new Set([aSub, bSub]));
    // ...but NOT a new query-DATA push (B's join changed no data → no rerun for A).
    expect(a.queryUpdateCount).toBe(aQueryCountBaseline);
  });

  it('a 2nd tab of an already-present sub delivers to that connection ONLY — no broadcast to others (M1 reconnect-storm guard)', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();
    const qh = canonicalQueryHash(query);
    const aSub = uuid(); const bSub = uuid();

    const a1 = await connect({ star, sub: aSub, tab: 't1' });
    a1.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(a1.presenceUpdateCount).toBe(1));
    const b = await connect({ star, sub: bSub });
    b.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(b.presenceUpdateCount).toBeGreaterThanOrEqual(1));
    const bBaseline = b.presenceUpdateCount;
    const a1Baseline = a1.presenceUpdateCount;

    // a2 = 2nd tab of aSub → already-present → the server takes the DELIVER branch (not broadcast).
    const a2 = await connect({ star, sub: aSub, tab: 't2' });
    a2.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(a2.presenceUpdateCount).toBe(1)); // a2 gets the roster (single-target)
    await vi.waitFor(() => expect(presenceMarks('subscribe', qh, a2.lmz.instanceName)[0]?.data.mode).toBe('deliver'));

    // The deliver branch means #broadcastPresence never ran → existing subscribers were NOT re-notified.
    expect(b.presenceUpdateCount).toBe(bBaseline);
    expect(a1.presenceUpdateCount).toBe(a1Baseline);
    // The roster is still 2 PEOPLE (a, b), never 3 (the two a-tabs are one person).
    expect(subsOf(a2)).toEqual(new Set([aSub, bSub]));
  });

  it('an explicit leave re-pushes the shrunk roster; a repeated (no-op) remove emits NO push (leave + M6 guard)', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();
    const qh = canonicalQueryHash(query);
    const aSub = uuid(); const bSub = uuid();

    const a = await connect({ star, sub: aSub });
    a.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(a.presenceUpdateCount).toBe(1));
    const b = await connect({ star, sub: bSub });
    b.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(a.presenceUpdateCount).toBe(2)); // A saw B join

    // B leaves → A gets the shrunk roster (just A).
    b.callStarUnsubscribeQuery(star, qh);
    await vi.waitFor(() => expect(a.presenceUpdateCount).toBe(3));
    expect([...subsOf(a)]).toEqual([aSub]);
    await vi.waitFor(() => expect(presenceMarks('remove', qh, b.lmz.instanceName).length).toBe(1));
    expect(presenceMarks('remove', qh, b.lmz.instanceName)[0].data.mode).toBe('broadcast');

    // B unsubscribes AGAIN — its row is already gone → a no-op DELETE → mode 'noop', NO push to A.
    const aBaseline = a.presenceUpdateCount;
    b.callStarUnsubscribeQuery(star, qh);
    await vi.waitFor(() => expect(presenceMarks('remove', qh, b.lmz.instanceName).length).toBe(2));
    expect(presenceMarks('remove', qh, b.lmz.instanceName)[1].data.mode).toBe('noop');
    expect(a.presenceUpdateCount).toBe(aBaseline); // the no-op emitted nothing
  });

  it('a disconnect drops the row and re-pushes the shrunk roster to survivors (self-healing)', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();
    const aSub = uuid(); const bSub = uuid();

    const a = await connect({ star, sub: aSub });
    a.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(a.presenceUpdateCount).toBe(1));
    const b = await connect({ star, sub: bSub });
    b.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(subsOf(a)).toEqual(new Set([aSub, bSub])));

    // B disconnects ungracefully. The reap is LAZY (bounded) — B's dead row is only detected
    // when a fanout next attempts delivery to it. So a new sub C joining broadcasts to all
    // (incl dead B); B's push fails → ClientDisconnectedError → removeQuerySubscriber →
    // #broadcastPresence → the survivors converge to { A, C } (B reaped), never containing B.
    b[Symbol.dispose]();
    const cSub = uuid();
    const c = await connect({ star, sub: cSub });
    c.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(subsOf(a)).toEqual(new Set([aSub, cSub])));
    expect(subsOf(a).has(bSub)).toBe(false);
  });

  it('reachability, not read — a non-admin subscriber with ZERO read grants still receives the FULL roster (M2)', async () => {
    const star = uniqueStar();
    const { client: adminClient, sub: adminSub } = await admin(star);
    const query = mkQuery();
    adminClient.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(adminClient.presenceUpdateCount).toBeGreaterThanOrEqual(1));

    // A brand-new NON-admin subscriber with no grants on any node.
    const userSub = uuid();
    const user = await connect({ star, sub: userSub, isAdmin: false });
    user.callStarSubscribeQuery(star, query);
    await vi.waitFor(() => expect(user.presenceUpdateCount).toBeGreaterThanOrEqual(1));

    // It receives the FULL uniform roster (admin + itself) despite zero read grants — reds if
    // presence were routed through the read-gating targetsForQuery.
    expect(subsOf(user)).toEqual(new Set([adminSub, userSub]));
    // Advisory/display-only: no query-data / permission fields leak into the roster payload.
    const s = JSON.stringify(user.lastPresenceUpdate!.roster);
    expect(s).not.toContain('deniedNodes');
    expect(s).not.toContain('resourceIds');
    expect(s).not.toContain('accessAdmin');
  });

  it('client reactive-store landing — presenceRoster(query) reflects the pushed roster via the public subscribe API', async () => {
    const star = uniqueStar();
    await admin(star);
    const query = mkQuery();

    // The PUBLIC subscribe path (client.resources.subscribeQuery) populates client-side state,
    // so the roster folds onto the QueryEntry and is readable via the @internal accessor.
    const aSub = uuid();
    const a = await connect({ star, sub: aSub });
    const handle = a.resources.subscribeQuery(query);
    await handle.ready;
    await vi.waitFor(() => expect(a.presenceRoster(query).map((e) => e.sub)).toEqual([aSub]));
    // Cleanup rides afterEach's client dispose (WS close → server reaps) — disposing the handle
    // here fires an unsubscribeQuery that can race env teardown.
  });

  it('GENERICITY — the roster rides a DevStudio query subscription too (the same shared ResourceDataPlane + bridge)', async () => {
    // DevStudio composes the SAME ResourceDataPlane and implements the SAME bridge; presence
    // must land on it too (ADR-007 composition invariant). Uses the DevStudio Message-per-session
    // query — no data / ensureSession needed, since presence tracks SUBSCRIBERS, not matches.
    const scope = `presence-ds-${uuid().slice(0, 8)}.app.tenant`;
    const query: QueryDescriptor = {
      queryType: 'parentChild', typeName: 'Message', field: 'session', value: DEFAULT_SESSION_ID,
    };
    const aSub = uuid();
    const a = await connect({ star: scope, sub: aSub, binding: 'DEV_STUDIO' });
    const aHandle = a.resources.subscribeQuery(query);
    await aHandle.ready;
    await vi.waitFor(() => expect([...subsOf(a)]).toEqual([aSub]));

    const bSub = uuid();
    const b = await connect({ star: scope, sub: bSub, binding: 'DEV_STUDIO' });
    const bHandle = b.resources.subscribeQuery(query);
    await bHandle.ready;
    // A (an existing DevStudio subscriber) sees the grown roster → DevStudio's bridge impl works.
    await vi.waitFor(() => expect(subsOf(a)).toEqual(new Set([aSub, bSub])));
    // Cleanup rides afterEach's client dispose (avoids an unsubscribe racing env teardown).
  });
});
