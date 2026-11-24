/**
 * Each committed transaction gets one moment, and every op it commits is a snapshot stamped with it.
 *
 * Real login (ADR-009 rung 1) on the run's shared app; every `validFrom` asserted is one the running
 * Galaxy stamped, so there is no fixture to build in a safe shape. Each limb runs whether or not an
 * earlier one failed, and the scenario fails at the end naming every limb that did, so a red on one
 * limb never hides another. Each limb names the change that reds it.
 */
import assert from 'node:assert/strict';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import { MESSAGES_NODE_ID, COLLABORATOR_GRANTS, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { Galaxy } from '@lumenize/nebula';
import type { NodeInviteAck } from '@lumenize/resources';
import type { Snapshot } from '@lumenize/resources/client';
import { createNebulaClient } from '@lumenize/resources/frontend';
import type { TransactionOutcome } from '@lumenize/resources/frontend';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar, scopeUrlOf } from '../lib/harness';
import { sharedApp } from '../lib/shared-app';
import { acceptInviteAndLogin, refreshAccessToken } from '../../test/lib/email-login';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const app = await sharedApp(stack, testToken);
  const driver = await connectDriver(stack, { scope: app.galaxy, email: app.ownerEmail });
  const { client } = driver;
  let collaborator: Driver | undefined;
  let page: ReturnType<typeof createNebulaClient> | undefined;

  const read = async (id: string): Promise<Snapshot> => {
    const snap = (await client.resources.read('Chat', id)) as Snapshot | null;
    assert.ok(snap, `Chat ${id} should read back`);
    return snap;
  };
  /** Every op told `committed`, not only the top level: a `use-server` verdict rolls up to a
   *  top-level `committed` while writing nothing. */
  const commit = async (ops: Parameters<typeof client.resources.transaction>[0], what: string) => {
    const out = await client.resources.transaction(ops);
    for (const id of Object.keys(ops)) committedAt(out, id, what);
    return out;
  };
  /** What one resource was told: `committed` at a moment, or `use-server`, which rolls up to a
   *  top-level `committed` while writing nothing. */
  const toldOf = (out: TransactionOutcome, id: string, what: string): { kind: string; validFrom?: string } => {
    assert.equal(out.kind, 'committed', `${what}: top-level kind=${out.kind}`);
    const told = (out as { resources: Record<string, { kind: string; validFrom?: string }> }).resources[id];
    assert.ok(told, `${what}: no resolution for ${id}`);
    return told;
  };
  const committedAt = (out: TransactionOutcome, id: string, what: string): string => {
    const told = toldOf(out, id, what);
    assert.equal(told.kind, 'committed', `${what} should be told committed, got ${told.kind}`);
    assert.ok(told.validFrom, `${what}: committed with no validFrom`);
    return told.validFrom;
  };
  const create = async (title: string): Promise<{ id: string; v0: string }> => {
    const id = crypto.randomUUID();
    const out = await client.resources.transaction({ [id]: { op: 'create', typeName: 'Chat', nodeId: MESSAGES_NODE_ID, value: { title } } });
    return { id, v0: committedAt(out, id, `create ${title}`) };
  };
  const putTitle = (who: Driver['client'], id: string, version: string | undefined, title: string) =>
    who.resources.transaction({ [id]: { op: 'put', typeName: 'Chat', ...(version ? { ifValidFromMatches: version } : {}), value: { title } } });
  const failures: string[] = [];
  const limb = async (name: string, body: () => Promise<void>) => {
    try {
      await body();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message}`);
      console.log(`  ✗ ${name}: ${(err as Error).message}`);
    }
  };

  try {
    const a = crypto.randomUUID();
    await commit({ [a]: { op: 'create', typeName: 'Chat', nodeId: MESSAGES_NODE_ID, value: { title: 'moment a0' } } }, 'create a');

    // Limb 1. Coalescing used to overwrite a same-person write within the hour in place, keeping
    // its validFrom. Mutation: restore the in-place UPDATE in `#writeSnapshot`.
    await limb('every write is a snapshot', async () => {
      const before = await read(a);
      await commit({ [a]: { op: 'put', typeName: 'Chat', ifValidFromMatches: before.meta.validFrom, value: { title: 'moment a1' } } }, 'first put');
      const first = await read(a);
      await new Promise((r) => setTimeout(r, 1000));
      await commit({ [a]: { op: 'put', typeName: 'Chat', ifValidFromMatches: first.meta.validFrom, value: { title: 'moment a2' } } }, 'second put');
      const second = await read(a);
      assert.ok(second.meta.validFrom > first.meta.validFrom,
        `the second put must open a later snapshot: ${first.meta.validFrom} then ${second.meta.validFrom}`);
    });

    // Limb 2. A put that would have coalesced and a create, in one transaction, share one moment.
    // Mutation: restore the in-place UPDATE (the put keeps its old validFrom).
    const b = crypto.randomUUID();
    await limb('one moment per transaction', async () => {
      const current = await read(a);
      await commit({
        [a]: { op: 'put', typeName: 'Chat', ifValidFromMatches: current.meta.validFrom, value: { title: 'moment a3' } },
        [b]: { op: 'create', typeName: 'Chat', nodeId: MESSAGES_NODE_ID, value: { title: 'moment b0' } },
      }, 'put a + create b');
      const [aNow, bNow] = [await read(a), await read(b)];
      assert.equal(aNow.meta.validFrom, bNow.meta.validFrom,
        `both resources must carry the transaction's moment: a=${aNow.meta.validFrom} b=${bNow.meta.validFrom}`);
    });

    // Limb 3. A move to the node the resource is already on writes a snapshot like any op.
    // Mutation: restore Step 10's same-node skip.
    await limb('a move to the node it is on is a write', async () => {
      const before = await read(a);
      assert.equal(before.meta.nodeId, MESSAGES_NODE_ID, 'fixture guard: a sits on the `messages` node');
      await commit({ [a]: { op: 'move', typeName: 'Chat', nodeId: MESSAGES_NODE_ID, ifValidFromMatches: before.meta.validFrom } }, 'same-node move');
      const after = await read(a);
      assert.ok(after.meta.validFrom > before.meta.validFrom,
        `the move must open a later snapshot: ${before.meta.validFrom} then ${after.meta.validFrom}`);
    });

    // ── A repeat is recognized ──
    // The collaborator holds write at the `messages` node through a real invite, no admin bit, as
    // `four-party-chat`'s does. The page is a second tab of the driver's own person, built by the
    // factory a generated app's page uses, so its store can be read.
    const collaboratorEmail = uniqueTestEmail();
    const waiter = waitForEmail({ testToken, instance: app.galaxy, to: collaboratorEmail, timeout: 60_000 });
    try {
      const ack = await client.lmz.callAsync('GALAXY', app.galaxy, client.ctn<Galaxy>().resources.invite(
        CHAT_MESSAGE_ONTOLOGY_VERSION, [{ email: collaboratorEmail, grants: COLLABORATOR_GRANTS }])) as NodeInviteAck;
      assert.deepEqual(ack, { accepted: 1, errors: [] }, `invite ack: ${JSON.stringify(ack)}`);
      const mail = await waiter.emailPromise;
      const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(mail.html ?? '')?.[1];
      assert.ok(href, 'the invite email carried no accept link');
      const { refreshToken } = await acceptInviteAndLogin({
        baseUrl: stack.baseUrl, inviteLink: href.replace(/&amp;/g, '&'), scope: app.galaxy,
      });
      const session = await refreshAccessToken(stack.baseUrl, { refreshToken, authScope: app.galaxy }, app.galaxy);
      collaborator = await connectDriver(stack, { scope: app.galaxy, session });
    } finally {
      waiter.cleanup();
    }
    const pageUrl = scopeUrlOf(stack, app.galaxy);
    const tab = driver.browser.context(pageUrl);
    page = createNebulaClient({
      baseUrl: pageUrl, platformOrigin: stack.baseUrl, ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      resourceHostBinding: 'GALAXY',
      fetch: tab.fetch, sessionStorage: tab.sessionStorage, BroadcastChannel: tab.BroadcastChannel,
      onShouldRefreshUI: () => {},
    });
    await page.ready;
    const pageClient = page.client;
    const pageStore = page.store;
    const collab = collaborator.client;

    // Limb 4. Mutation: delete recognition → the resend names a version that moved on, and is told
    // `use-server`.
    const e = await create('e0');
    let e1: string | undefined;
    await limb('a repeated put is recognized', async () => {
      e1 = committedAt(await putTitle(client, e.id, e.v0, 'e1'), e.id, 'put e');
      assert.equal(committedAt(await putTitle(client, e.id, e.v0, 'e1'), e.id, 'the resent put'), e1,
        'the resent put must be told the moment the first committed at');
    });

    // Limb 5. Mutation: delete recognition → the second create fails "already exists".
    await limb('a repeated create is recognized', async () => {
      const id = crypto.randomUUID();
      const op = { [id]: { op: 'create' as const, typeName: 'Chat', nodeId: MESSAGES_NODE_ID, value: { title: 'f0' } } };
      const first = committedAt(await client.resources.transaction(op), id, 'create f');
      assert.equal(committedAt(await client.resources.transaction(structuredClone(op)), id, 'the resent create'), first,
        'the resent create must be told the moment the first committed at');
    });

    // Limb 6. Mutations: drop the writer comparison → the collaborator is told `committed` at e1,
    // with nothing written; drop the value comparison → the different title is.
    await limb('a different write is not a repeat', async () => {
      assert.ok(e1, 'needs limb 4\'s put');
      assert.equal(toldOf(await putTitle(collab, e.id, e.v0, 'e1'), e.id, "the collaborator's put").kind, 'use-server',
        "the collaborator's identical put is another writer's, so it conflicts");
      assert.equal(toldOf(await putTitle(client, e.id, e.v0, 'e-other'), e.id, 'the different put').kind, 'use-server',
        'a put naming the same version with a different title conflicts');
    });

    // Limb 7. Mutation: leave the queue's baseline at the version the first put named → the second
    // names it too, and conflicts.
    await limb('the client advances its version', async () => {
      const g = await create('g0');
      using held = pageClient.resources.subscribe('Chat', g.id);
      await held.snapshot;
      const [p1, p2] = await Promise.all([putTitle(pageClient, g.id, undefined, 'g1'), putTitle(pageClient, g.id, undefined, 'g2')]);
      const [m1, m2] = [committedAt(p1, g.id, 'the first put'), committedAt(p2, g.id, 'the second put')];
      assert.ok(m2 > m1, `the second put must commit later: ${m1} then ${m2}`);
      const now = (await client.resources.read('Chat', g.id)) as Snapshot;
      assert.equal((now.value as { title: string }).title, 'g2');
    });

    // Limb 8. Mutation: let a committed resend's older moment overwrite the newer version the
    // store heard → the store falls back to h1, and the next put names it and conflicts.
    await limb('the client keeps the later version', async () => {
      const h = await create('h0');
      using held = pageClient.resources.subscribe('Chat', h.id);
      await held.snapshot;
      const h1 = committedAt(await putTitle(pageClient, h.id, h.v0, 'h1'), h.id, 'put h1');
      const h2 = committedAt(await putTitle(collab, h.id, h1, 'h2'), h.id, "the collaborator's put");
      const entry = () => (pageStore.resources as Record<string, Record<string, { value?: { title?: string }; meta?: { validFrom?: string } }>>).Chat?.[h.id];
      const deadline = Date.now() + 15_000;
      while (entry()?.meta?.validFrom !== h2) {
        assert.ok(Date.now() < deadline, `the page never heard h2 (store at ${entry()?.meta?.validFrom})`);
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(committedAt(await putTitle(pageClient, h.id, h.v0, 'h1'), h.id, 'the resent put'), h1,
        'the resend must be told its own moment');
      const kept = entry();
      assert.equal(kept?.meta?.validFrom, h2,
        `the store must keep the later version (h1=${h1}, h2=${h2}, store at ${kept?.meta?.validFrom} holding ${kept?.value?.title})`);
      assert.equal(kept?.value?.title, 'h2', 'the store must keep the later value');
      committedAt(await putTitle(pageClient, h.id, undefined, 'h3'), h.id, 'the next put, naming no version');
    });

    // Limb 8b. The page's own later commit outlives a resend answered with an older moment.
    // Mutation: note only fanouts as known → the store falls back to i1, and the next put names it
    // and conflicts.
    await limb('the client keeps its own later version', async () => {
      const i = await create('i0');
      using held = pageClient.resources.subscribe('Chat', i.id);
      await held.snapshot;
      const i1 = committedAt(await putTitle(pageClient, i.id, i.v0, 'i1'), i.id, 'put i1');
      const i2 = committedAt(await putTitle(pageClient, i.id, undefined, 'i2'), i.id, 'put i2');
      const entry = () => (pageStore.resources as Record<string, Record<string, { value?: { title?: string }; meta?: { validFrom?: string } }>>).Chat?.[i.id];
      assert.equal(committedAt(await putTitle(pageClient, i.id, i.v0, 'i1'), i.id, 'the resent put'), i1,
        'the resend must be told its own moment');
      const kept = entry();
      assert.equal(kept?.meta?.validFrom, i2,
        `the store must keep the page's own later version (i1=${i1}, i2=${i2}, store at ${kept?.meta?.validFrom} holding ${kept?.value?.title})`);
      assert.equal(kept?.value?.title, 'i2', 'the store must keep its own later value');
      committedAt(await putTitle(pageClient, i.id, undefined, 'i3'), i.id, 'the next put, naming no version');
    });

    // Limb 9. Mutation: run recognition after the permission check → the resend is refused.
    await limb('a resend after a revoked grant', async () => {
      const k = await create('k0');
      const landed = committedAt(await putTitle(collab, k.id, k.v0, 'k1'), k.id, "the collaborator's put");
      await client.orgTree.revokePermission(MESSAGES_NODE_ID, collaborator!.sub);
      assert.equal(committedAt(await putTitle(collab, k.id, k.v0, 'k1'), k.id, "the collaborator's resend"), landed,
        'a resend of a write that landed is told its moment, grant or no grant');
    });

    // Limb 10. Mutations: delete recognition → the repeated move and delete are told `use-server`;
    // drop the shared-moment condition → the mixed pair is recognized.
    await limb('moves, deletes, and a mixed pair', async () => {
      const n = await create('n0');
      const move = { [n.id]: { op: 'move' as const, typeName: 'Chat', nodeId: MESSAGES_NODE_ID, ifValidFromMatches: n.v0 } };
      const moved = committedAt(await client.resources.transaction(move), n.id, 'move n');
      assert.equal(committedAt(await client.resources.transaction(structuredClone(move)), n.id, 'the resent move'), moved);
      const del = { [n.id]: { op: 'delete' as const, typeName: 'Chat', ifValidFromMatches: moved } };
      const deleted = committedAt(await client.resources.transaction(del), n.id, 'delete n');
      assert.equal(committedAt(await client.resources.transaction(structuredClone(del)), n.id, 'the resent delete'), deleted);
      // Each half of the pair matches a write of the driver's, but they landed at two moments.
      const [p, q] = [await create('p0'), await create('q0')];
      committedAt(await putTitle(client, p.id, p.v0, 'p1'), p.id, 'put p');
      committedAt(await putTitle(client, q.id, q.v0, 'q1'), q.id, 'put q');
      const pair = await client.resources.transaction({
        [p.id]: { op: 'put', typeName: 'Chat', ifValidFromMatches: p.v0, value: { title: 'p1' } },
        [q.id]: { op: 'put', typeName: 'Chat', ifValidFromMatches: q.v0, value: { title: 'q1' } },
      });
      assert.equal(toldOf(pair, p.id, 'the pair').kind, 'use-server');
      assert.equal(toldOf(pair, q.id, 'the pair').kind, 'use-server');
    });

    if (failures.length > 0) {
      throw new Error(`${failures.length} limb(s) failed:\n  - ${failures.join('\n  - ')}`);
    }
  } finally {
    page?.client[Symbol.dispose]();
    collaborator?.dispose();
    driver.dispose();
  }
}
