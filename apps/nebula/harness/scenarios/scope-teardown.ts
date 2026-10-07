/**
 * What a session does to the scope tree, end to end on the running system: an app created and
 * deleted through `NebulaAuthFacade`, with the Durable Objects each touches wiped server-side
 * through the `@rawRpc()` bridge (ADR-023), and every record naming the page it came from.
 *
 * Limbs, in order, each named at its step:
 *   1. A refused create never reaches the singleton — the facade's own refusal message.
 *   2. A creation wipes the galaxy and its `.dev` Star before it answers, and records the page.
 *   3. The universe page's list answers for its own scope, whatever the call names.
 *   4. A deletion wipes every Durable Object it names, logs one marker each, and records the page.
 *   5. A new owner of a deleted slug starts empty — chat and subscriber list alike.
 *   6. A refused create tears nothing down.
 *   7. Two deletions from two pages record two pages; a universe's deletion logs its own marker.
 *   8. No protection is reported missing that nothing uses.
 *
 * A page whose own scope is deleted stops: its host node closes it with 4410, and the call that asked
 * rejects with `HostDeletedError` rather than answering. So limb 4 reads what it deleted from the
 * facade's completion line, reads the deleted scopes through the universe's page, which stands, and
 * brings each stopped test client back explicitly before its next call.
 * Locally miniflare's abort wipes storage by itself, so limb 4 witnesses the in-memory reset; the
 * durable wipe is the deployed pass's. The markers and records are read from the stack's stdio,
 * which a deployed target does not capture — those halves report themselves not observable there.
 *
 * `needsContainer = false` — no build, so the boot skips Docker.
 */
import assert from 'node:assert/strict';
import { uniqueTestEmail } from '@lumenize/email-test/client';
import { ROOT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { Galaxy, Star } from '@lumenize/nebula';
import type { NebulaAuthFacade } from '@lumenize/nebula-auth/facade';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar, scopeUrlOf, waitForHost } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { debugLines, waitForDebugLines, type DebugLine } from '../lib/stdio';
import { provisionAndLogin, refreshAccessToken, requestStarClaim } from '../../test/lib/email-login';

export const needsContainer = false;
export const bootVars = {
  DEBUG: 'nebula.scope.teardown,nebula-auth.facade,nebula-auth.Registry.createGalaxy,'
    + 'nebula-auth.Registry.executeScopeDeletion,nebula-auth.Registry.protections',
};

type Line = DebugLine;
const lines = debugLines;

/** The refusal MESSAGE, or `null` if the call succeeded — a refusal is matched by what it says. */
async function refusal(op: Promise<unknown>): Promise<string | null> {
  try { await op; return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

const chatQuery = (chatId: string) =>
  ({ queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: chatId });

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const universe = testSlug('st');
  const otherUniverse = `${universe}x`;
  const galaxy = `${universe}.crm`;
  const tenant = `${galaxy}.t1`;
  const email = uniqueTestEmail();
  const observable = stack.logs !== undefined;
  const stdio = (ready: (all: Line[]) => boolean, what: string) => waitForDebugLines(stack, ready, what);
  const has = (ns: string, message: string, field: string, value: unknown) => (all: Line[]) =>
    all.some((l) => l.namespace === ns && l.message === message && l.data[field] === value);
  const drivers: Driver[] = [];
  /** Bring back a client whose page's scope was deleted, which stops rather than reconnecting. */
  const reconnect = async (d: Driver) => {
    d.client.connect();
    const t = Date.now();
    while (d.client.connectionState !== 'connected') {
      if (Date.now() - t > 20_000) throw new Error(`the client on ${d.scope} did not reconnect`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const driver = async (scope: string, session: { accessToken: string; sub: string }) => {
    const d = await connectDriver(stack, { scope, session, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION });
    drivers.push(d);
    return d;
  };

  try {
    // One person administering two universes, by the same address.
    const owner = await provisionAndLogin({ baseUrl: origin, scope: universe, email, testToken });
    const ownerOther = await provisionAndLogin({ baseUrl: origin, scope: otherUniverse, email, testToken });
    const atUniverse = await driver(universe, owner);
    const atOther = await driver(otherUniverse, ownerOther);

    // ── 1. A refused create never reaches the singleton ─────────────────────────────────────────
    // A stranger's token holds no dominion over `universe`, so the facade refuses before its hop,
    // with its own message — worded apart from the Registry's *Caller does not have admin access to
    // the parent universe*. Mutation: drop the facade's pre-check → the Registry's message → reds.
    const strangerUniverse = `${universe}y`;
    const stranger = await provisionAndLogin({ baseUrl: origin, scope: strangerUniverse, testToken });
    const atStranger = await driver(strangerUniverse, stranger);
    assert.equal(await refusal(atStranger.client.scopes.createGalaxy(universe, 'crm')),
      `Creating an app in "${universe}" needs dominion over it, and the calling host's scope is "${strangerUniverse}"`,
      'a create without dominion must be refused by the facade, before the Registry');

    // ── 2. A creation wipes before it answers, and records the page ──────────────────────────────
    // Positive control for limb 1: the universe admin's create succeeds.
    assert.deepEqual(await atUniverse.client.scopes.createGalaxy(universe, 'crm'), { instanceName: galaxy });
    if (observable) {
      // Wait for the completion line, the record and both markers, so the order below is what decides.
      const all = await stdio((a) => {
        const done = a.find((l) => l.namespace === 'nebula-auth.facade.createGalaxy' && l.message === 'created'
          && l.data.target === galaxy);
        return !!done && a.some((l) => l.namespace === 'nebula-auth.Registry.createGalaxy')
          && a.filter((l) => l.message === 'tearing down' && l.data.operationId === done.data.operationId).length >= 2;
      }, "the create's completion line, record and markers");
      const created = all.find((l) => l.namespace === 'nebula-auth.facade.createGalaxy'
        && l.message === 'created' && l.data.target === galaxy);
      assert.ok(created, 'the facade logged no completion line for the create');
      const op = created.data.operationId;
      const markers = all.filter((l) => l.namespace === 'nebula.scope.teardown' && l.message === 'tearing down'
        && l.data.operationId === op);
      // The `.dev` Star's first touch is this teardown, so its marker naming it proves the entry
      // stamped the identity. Mutation: stamp nothing at the entry → its instanceName is missing.
      assert.deepEqual(markers.map((m) => [m.data.instanceName, m.data.binding, m.data.cause]).sort(),
        [[galaxy, 'GALAXY', 'creation'], [`${galaxy}.dev`, 'STAR', 'creation']].sort(),
        'a creation must tear down the galaxy and its .dev Star, each named');
      // Mutation: answer before the teardown returns → the completion line precedes a marker.
      assert.ok(markers.every((m) => m.idx < created.idx), "the create's completion must follow every marker it caused");
      const record = all.find((l) => l.namespace === 'nebula-auth.Registry.createGalaxy' && l.data.operationId === op);
      // Mutation: record the create as before (no projection) → no `access` and no `aud` → reds.
      assert.equal(record?.data.actingToken?.aud, universe, 'the create record must name the page');
      assert.deepEqual(record?.data.actingToken?.access, { authScope: universe, scopeAdmin: true },
        'the create record must carry the authority asserted');
    } else {
      console.error('[scope-teardown] limb 2 markers and record: not observable on a deployed target');
    }

    // ── 3. The universe page's list answers for its own scope ───────────────────────────────────
    // The holder administers both universes; a call naming the other still lists this page's apps:
    // the claim's first app and the one limb 2 created.
    // Mutation: honour the argument as the parent → the other universe's app appears → reds.
    await atOther.client.scopes.createGalaxy(otherUniverse, 'app2');
    const listed = await atUniverse.client.lmz.callAsync('NEBULA_AUTH_FACADE', undefined,
      (atUniverse.client.ctn<NebulaAuthFacade>() as any).expandScope(otherUniverse)) as { children: { scope: string }[] };
    assert.deepEqual(listed.children.map((c) => c.scope), [galaxy, `${universe}.first`],
      "the universe page's list must answer for its own scope, whatever the call names");

    // ── 4. A deletion wipes every Durable Object it names ────────────────────────────────────────
    assert.notEqual(await requestStarClaim({ baseUrl: origin, universeGalaxyStarId: tenant, email: uniqueTestEmail() }),
      null, `claim-star found ${tenant} already claimed`);
    const galaxySession = await refreshAccessToken(origin, { refreshToken: owner.session.refreshToken, authScope: universe }, galaxy);
    const tenantSession = await refreshAccessToken(origin, { refreshToken: owner.session.refreshToken, authScope: universe }, tenant);
    const atGalaxy = await driver(galaxy, galaxySession);
    const watcher = await driver(galaxy, galaxySession);
    const atTenant = await driver(tenant, tenantSession);

    const chatId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const posted = await atGalaxy.client.resources.transaction({
      [chatId]: { op: 'create', typeName: 'Chat', nodeId: ROOT_NODE_ID, value: { title: 'before the delete' } },
      [messageId]: { op: 'create', typeName: 'Message', nodeId: ROOT_NODE_ID, value: { chat: chatId, content: 'hello' } },
    });
    assert.equal(posted.kind, 'committed', `the chat post must commit, got ${posted.kind}`);
    const nodeId = crypto.randomUUID();
    await atTenant.client.orgTree.createNode(nodeId, ROOT_NODE_ID, 'probe', 'Probe');
    const tenantHasNode = () => atTenant.client.lmz.callAsync('STAR', tenant,
      atTenant.client.ctn<Star>().resources.orgTree.getState()).then((s) => s.nodes.has(nodeId));
    // Positive controls: before the delete, the chat holds the message and the Star holds the node.
    {
      using before = atGalaxy.client.resources.subscribeQuery(chatQuery(chatId));
      await before.ready;
      assert.deepEqual(before.resourceIds, [messageId], 'before the delete the chat must hold the message');
    }
    assert.equal(await tenantHasNode(), true, 'before the delete the tenant must hold its node');
    // The second client stays subscribed through the delete, for limb 5.
    const watching = watcher.client.resources.subscribeQuery(chatQuery(chatId));
    await watching.ready;

    // The galaxy's own page deletes it, so the page's socket closes with 4410 before the facade's
    // answer can arrive, and the call rejects with `HostDeletedError`: the delete happened. What it
    // deleted is the facade's completion line, below.
    await atGalaxy.client.scopes.delete(galaxy).catch((e: Error) => { if (e.name !== 'HostDeletedError') throw e; });

    // Read before anything re-creates the slug, since a re-create's own teardown would empty it
    // either way, and through the universe's page, which the deletion leaves standing.
    // Mutations: skip the deletion's hook → the old message comes back; drop the `ctx.abort()` →
    // the read fails with `no such table`.
    const message = await atUniverse.client.lmz.callAsync('GALAXY', galaxy,
      atUniverse.client.ctn<Galaxy>().resources.read(CHAT_MESSAGE_ONTOLOGY_VERSION, messageId));
    assert.equal(message, null, "a deleted galaxy's chat must read empty");
    const tenantStillHasNode = await atUniverse.client.lmz.callAsync('STAR', tenant,
      atUniverse.client.ctn<Star>().resources.orgTree.getState()).then((st) => st.nodes.has(nodeId));
    assert.equal(tenantStillHasNode, false, "a deleted tenant's Star must read empty");

    if (observable) {
      const all = await stdio(has('nebula-auth.facade.executeScopeDeletion', 'deleted', 'target', galaxy),
        "the delete's completion line");
      const done = all.find((l) => l.namespace === 'nebula-auth.facade.executeScopeDeletion'
        && l.message === 'deleted' && l.data.target === galaxy);
      assert.ok(done, 'the facade logged no completion line for the delete');
      assert.deepEqual([...done.data.affected].sort(), [galaxy, `${galaxy}.dev`, tenant].sort(),
        'the delete must name the galaxy, its .dev Star and its tenant');
      const op = done.data.operationId;
      const markers = all.filter((l) => l.namespace === 'nebula.scope.teardown' && l.message === 'tearing down'
        && l.data.operationId === op);
      assert.deepEqual(markers.map((m) => [m.data.instanceName, m.data.binding, m.data.cause]).sort(),
        [[galaxy, 'GALAXY', 'deletion'], [`${galaxy}.dev`, 'STAR', 'deletion'], [tenant, 'STAR', 'deletion']].sort(),
        'a deletion must log one marker per Durable Object it names');
      // Mutation: count the abort's rejection a failure → a teardown error is logged → reds.
      assert.equal(all.filter((l) => l.namespace === 'nebula.scope.teardown' && l.message === 'teardown failed').length, 0,
        'a deletion must log no teardown error');
      const record = all.find((l) => l.namespace === 'nebula-auth.Registry.executeScopeDeletion' && l.data.operationId === op);
      assert.equal(record?.data.actingToken?.aud, galaxy, "a deletion from the galaxy's page must record that page");
    } else {
      console.error('[scope-teardown] limb 4 markers and record: not observable on a deployed target');
    }

    // ── 5. A new owner starts empty ─────────────────────────────────────────────────────────────
    // The watcher reconnects and re-subscribes, which writes its subscriber row into the wiped
    // galaxy; the re-create's own teardown must clear it. On a deployed target the deletion took the
    // app's certificate with it, so no client reaches the wiped Galaxy to write that row, and only
    // the re-created app's empty start is checked.
    const deployed = process.env.HARNESS_TARGET_URL !== undefined;
    watching[Symbol.dispose]();
    if (!deployed) {
      await reconnect(atGalaxy);
      watcher.client.disconnect();
      watcher.client.connect();
      await (async () => { const t = Date.now(); while (watcher.client.connectionState !== 'connected') {
        if (Date.now() - t > 20_000) throw new Error('the watcher did not reconnect'); await new Promise((r) => setTimeout(r, 100)); } })();
      const rewatching = watcher.client.resources.subscribeQuery(chatQuery(chatId));
      await rewatching.ready;
    }
    const roster = async (d: Driver): Promise<unknown[]> => {
      let latest: unknown[] | undefined;
      d.client.onQuerySubscribersUpdate((delivery) => { latest = delivery.roster as unknown[]; });
      using rs = d.client.subscribeQuerySubscribers(chatQuery(chatId));
      await rs.ready;
      return latest ?? [];
    };
    // Positive control: the re-subscribe really wrote a row before the re-create. Then the watcher
    // pauses: the re-create resets the Galaxy it is on, and a connected watcher would come back and
    // re-subscribe into the new app, a fresh row this limb is not about.
    if (!deployed) {
      await (async () => { const t = Date.now(); while ((await roster(atGalaxy)).length === 0) {
        if (Date.now() - t > 20_000) throw new Error("the watcher's re-subscribe never reached the galaxy"); } })();
      watcher.client.disconnect();
    } else {
      console.error("[scope-teardown] limb 5's stale row: not observable on a deployed target, where a deleted app's host has no certificate");
    }

    assert.deepEqual(await atUniverse.client.scopes.createGalaxy(universe, 'crm'), { instanceName: galaxy });
    // The re-created app orders a new certificate, which the rest of the scenario's calls need.
    await waitForHost(scopeUrlOf(stack, galaxy));
    if (deployed) await reconnect(atGalaxy);
    // Mutation: skip the teardown at creation → the watcher's re-created row survives → reds.
    assert.deepEqual(await roster(atGalaxy), [], "a re-created app's subscriber list must start empty");
    {
      using fresh = atGalaxy.client.resources.subscribeQuery(chatQuery(chatId));
      await fresh.ready;
      assert.deepEqual(fresh.resourceIds, [], "a re-created app's chat must start empty");
    }

    // ── 6. A refused create tears nothing down ──────────────────────────────────────────────────
    const keptChat = crypto.randomUUID();
    const keptMessage = crypto.randomUUID();
    const kept = await atGalaxy.client.resources.transaction({
      [keptChat]: { op: 'create', typeName: 'Chat', nodeId: ROOT_NODE_ID, value: { title: 'survives' } },
      [keptMessage]: { op: 'create', typeName: 'Message', nodeId: ROOT_NODE_ID, value: { chat: keptChat, content: 'kept' } },
    });
    assert.equal(kept.kind, 'committed');
    const taken = await refusal(atUniverse.client.scopes.createGalaxy(universe, 'crm'));
    assert.match(taken ?? '', /already claimed/, 'a create on a taken slug must be refused as slug_taken');
    // Mutation: tear down whatever the Registry answered → the message is gone → reds.
    {
      using survived = atGalaxy.client.resources.subscribeQuery(chatQuery(keptChat));
      await survived.ready;
      assert.deepEqual(survived.resourceIds, [keptMessage], 'a refused create must leave the app as it was');
    }
    // Its markers are counted in limb 7, after a line logged later than anything this call caused.

    // ── 7. Two pages, two records; a universe's deletion logs its own marker ─────────────────────
    await atUniverse.client.scopes.createGalaxy(universe, 'crm2');
    await atUniverse.client.scopes.delete(`${universe}.crm2`);
    // The universe's own page deletes it: as in limb 4, the call rejects with `HostDeletedError`.
    await atUniverse.client.scopes.delete(universe).catch((e: Error) => { if (e.name !== 'HostDeletedError') throw e; });
    if (observable) {
      const all = await stdio(has('nebula-auth.facade.executeScopeDeletion', 'deleted', 'target', universe),
        "the universe deletion's completion line");
      const recordOf = (target: string) => {
        const done = all.find((l) => l.namespace === 'nebula-auth.facade.executeScopeDeletion'
          && l.message === 'deleted' && l.data.target === target);
        return all.find((l) => l.namespace === 'nebula-auth.Registry.executeScopeDeletion'
          && l.data.operationId === done?.data.operationId);
      };
      // Limb 6's refused create logged no teardown marker. It is the fourth create on this galaxy's
      // name — after limb 1's stranger, limb 2's and limb 5's re-create — and the universe deletion
      // this block waited for came after it.
      const creates = all.filter((l) => l.namespace === 'nebula-auth.facade.createGalaxy'
        && l.message === 'called' && l.data.target === galaxy);
      assert.equal(creates.length, 4, `four creates name ${galaxy}, the fourth limb 6's refused one`);
      assert.equal(all.filter((l) => l.namespace === 'nebula.scope.teardown'
        && l.data.operationId === creates[3].data.operationId).length, 0,
        'a refused create must log no teardown marker');
      const fromGalaxyPage = recordOf(galaxy)!.data.actingToken;
      const fromUniversePage = recordOf(`${universe}.crm2`)!.data.actingToken;
      assert.equal(fromUniversePage.aud, universe, "a deletion from the universe's page must record that page");
      // Mutation: drop `aud` from the projection → the two projections are identical → reds.
      assert.notDeepEqual(fromGalaxyPage, fromUniversePage, 'two pages must leave two different records');
      const universeOp = all.find((l) => l.namespace === 'nebula-auth.facade.executeScopeDeletion'
        && l.message === 'deleted' && l.data.target === universe)?.data.operationId;
      // Mutation: the hook skips the universe tier → its marker is missing → reds.
      assert.ok(all.some((l) => l.namespace === 'nebula.scope.teardown' && l.message === 'tearing down'
        && l.data.operationId === universeOp && l.data.instanceName === universe && l.data.binding === 'UNIVERSE'),
        "a universe's deletion must log its own marker beside its galaxies'");

      // ── 8. No protection is reported missing that nothing uses ────────────────────────────────
      // Read after the last request's own record, so the boot's lines are all in.
      // Mutation: delete the binding and keep its row → the error line appears → reds.
      assert.ok(universeOp, 'the last request logged no line to wait behind');
      const unconfigured = all.filter((l) => l.namespace === 'nebula-auth.Registry.protections' && l.level === 'error');
      assert.deepEqual(unconfigured.map((l) => l.data.protection), [],
        'no protection may be reported unconfigured on a local boot');

      // What the hook's call receives when `teardown()` aborts the object it reached — recorded, not
      // asserted, since the venues differ: the hook treats a resolution and the ordered reset alike.
      const outcome = (m: string) => all.filter((l) => l.namespace === 'nebula.scope.teardown' && l.message === m).length;
      console.error(`[scope-teardown] teardown calls: resolved ${outcome('torn down')}, `
        + `rejected as the ordered reset ${outcome('reset as ordered')}, failed ${outcome('teardown failed')}`);
    } else {
      console.error('[scope-teardown] limbs 7–8: not observable on a deployed target');
    }
  } finally {
    for (const d of drivers) d.dispose();
  }

  console.error('[scope-teardown] ok — creates and deletes wipe server-side, records name the page');
}
