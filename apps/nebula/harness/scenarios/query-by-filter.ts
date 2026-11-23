/**
 * **A member's app subscribes to the Deals that match a filter, and sees the ones that member may
 * read — on a real Star, with real members.**
 *
 * Sally is the Star's admin and Gerry a member she invited onto one of two nodes. The app's types
 * arrive by a real build, with a `Deal` that declares an index on `stage`. Sally writes one Deal
 * under each node. Gerry's client is the one a generated app builds, refreshing on his own cookie.
 *
 *  1. **Gerry's query delivers the Deal he may read, and names the node he may not.** `{ stage:
 *     'open' }` matches both Deals; his list holds "Acme renewal" and his denied nodes hold the
 *     node "Globex pilot" sits under. *Reds if the result ignores the filter, since a Deal Sally
 *     wrote as `lead` would join it, or if the permission check goes, since both would arrive.*
 *  2. **Sally's edit moves the Deal out of the filter, and it leaves Gerry's list without his
 *     asking.** *Reds if a write is not tested against the query the resource is leaving.*
 *  3. **A filter no index can look up is refused by the engine's message, and admitted when it
 *     allows the scan.** `title` has no index. *Reds if the lookup rule goes.*
 *  4. **A Deal holding `Infinity` is refused, and Gerry's list does not gain it.** *Reds if a
 *     write is no longer checked for what a query would read wrongly.*
 *  5. **`$gt` on the stage follows the order the ontology declares, not the alphabet.** `lost` is
 *     declared last and sorts before `open`, so `{ stage: { $gt: 'open' } }` must hold the lost
 *     Deal beside the won one. *Reds if the comparison is by the stored string.* The build also
 *     accepts the `@deprecatedValues` tag on the field, which a refused tag would fail.
 *
 * `needsContainer = true` — the Deal type and its index reach the Star only through a build's
 * compiled row. The in-lane twins, one mutation each, are in
 * `packages/resources/test/query/query-subscriptions.test.ts`.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { waitForEmail, uniqueTestEmail } from '@lumenize/email-test/client';
import { ROOT_NODE_ID } from '@lumenize/resources/client';
import { createNebulaClient } from '@lumenize/resources/frontend';
import type { Galaxy, Star } from '@lumenize/nebula';
import type { NodeInviteAck, TransactionResult } from '@lumenize/resources';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar, scopeUrlOf } from '../lib/harness';
import { ownApp, servedOntologyVersion } from '../lib/own-app';
import { acceptInviteAndLogin } from '../../test/lib/email-login';

export const needsContainer = true;

const DEAL = `
/** @title Deal */
export interface Deal {
  /** @title Title */
  title: string;
  /**
   * @title Stage
   * @index
   * @deprecatedValues lost
   */
  stage: 'lead' | 'open' | 'won' | 'lost';
  /** @title Amount */
  amount?: number;
}
`;

/** Retry an op the Star answers `checking` while its first-touch pull of the ontology lands. */
async function whileInstalling<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    let outcome: unknown;
    try { outcome = await op(); } catch (e) { outcome = e; }
    const checking = (outcome as Error)?.name === 'OntologyStaleError' && (outcome as { checking?: boolean }).checking;
    if (!checking) {
      if (outcome instanceof Error) throw outcome;
      return outcome as T;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the Star never finished installing the ontology');
}

async function until(ms: number, holds: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (holds()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return holds();
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const app = await ownApp(stack, 'qbf', testToken);
  const star = app.dev;
  const gerryEmail = uniqueTestEmail();
  let sally: Driver | undefined;
  let gerry: ReturnType<typeof createNebulaClient> | undefined;
  const gerryBrowser = new Browser();
  let waiter: ReturnType<typeof waitForEmail> | undefined;
  try {
    sally = await connectDriver(stack, { scope: star, session: { accessToken: app.devToken.accessToken, sub: app.devToken.sub } });

    // The types arrive by the real path: Studio writes the ontology file and asks for a build.
    const studio = await connectDriver(stack, { scope: app.galaxy, session: app.studio });
    try {
      const galaxy = <T>(remote: unknown, timeoutMs = 30_000) =>
        studio.client.lmz.callAsync('GALAXY', app.galaxy, remote as never, { timeoutMs }) as Promise<T>;
      const seed = await galaxy<string>(studio.client.ctn<Galaxy>().readSource('src/ontology.d.ts'));
      await galaxy(studio.client.ctn<Galaxy>().writeSource('src/ontology.d.ts', seed + DEAL));
      await galaxy(studio.client.ctn<Galaxy>().buildNow(), 240_000);
    } finally {
      studio.dispose();
    }
    const version = await servedOntologyVersion(stack, star);
    assert.ok(version, 'the `.dev` page should carry the version the build landed');

    const write = (ops: Record<string, unknown>) => whileInstalling(() =>
      sally!.client.lmz.callAsync('STAR', star, sally!.client.ctn<Star>().resources.transaction(version, ops as never)) as Promise<TransactionResult>);
    const acmeTeam = crypto.randomUUID();
    await sally.client.orgTree.createNode(acmeTeam, ROOT_NODE_ID, 'acme-team', 'Acme team');
    const globexTeam = crypto.randomUUID();
    await sally.client.orgTree.createNode(globexTeam, ROOT_NODE_ID, 'globex-team', 'Globex team');
    const acme = crypto.randomUUID();
    const globex = crypto.randomUUID();
    const lead = crypto.randomUUID();
    const created = await write({
      [acme]: { op: 'create', typeName: 'Deal', nodeId: acmeTeam, value: { title: 'Acme renewal', stage: 'open', amount: 1500 } },
      [globex]: { op: 'create', typeName: 'Deal', nodeId: globexTeam, value: { title: 'Globex pilot', stage: 'open', amount: 900 } },
      [lead]: { op: 'create', typeName: 'Deal', nodeId: acmeTeam, value: { title: 'Initech lead', stage: 'lead' } },
    });
    assert.equal(created.ok, true, `Sally's Deals were not written: ${JSON.stringify(created)}`);

    // Gerry is invited onto the Acme team's node alone.
    waiter = waitForEmail({ testToken, instance: star, to: gerryEmail, timeout: 60_000 });
    const ack = await sally.client.lmz.callAsync(
      'STAR', star, sally.client.ctn<Star>().resources.invite(version, [{ email: gerryEmail, grants: [{ nodeId: acmeTeam, tier: 'read' }] }]),
    ) as NodeInviteAck;
    assert.deepEqual(ack, { accepted: 1, errors: [] }, `node invite ack: ${JSON.stringify(ack)}`);
    const mail = await waiter.emailPromise;
    const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(mail.html ?? '')?.[1];
    assert.ok(href, 'the invite email carried no magic link');
    await acceptInviteAndLogin({
      baseUrl: origin, inviteLink: href.replace(/&amp;/g, '&'), scope: star, fetchImpl: gerryBrowser.fetch,
    });
    const ctx = gerryBrowser.context(scopeUrlOf(stack, star));
    gerry = createNebulaClient({
      baseUrl: scopeUrlOf(stack, star), platformOrigin: stack.baseUrl, ontologyVersion: version,
      fetch: ctx.fetch, sessionStorage: ctx.sessionStorage, BroadcastChannel: ctx.BroadcastChannel,
      onShouldRefreshUI: () => {},
    });
    await gerry.ready;

    // ── LIMB 1: the Deals that match, as far as Gerry may read ────────────────────────────────
    const open = gerry.client.resources.subscribeQuery({ typeName: 'Deal', filter: { stage: 'open' } });
    await open.ready;
    assert.deepEqual(open.resourceIds, [acme], 'Gerry\'s list must hold the open Deal he may read, and no other');
    assert.deepEqual(open.deniedNodes, [globexTeam], 'Gerry must be told the node that holds a result he may not read');
    console.error('  ✓ limb 1 — Gerry\'s filter delivered "Acme renewal" and named the node he cannot read');

    // ── LIMB 2: a Deal leaving the filter leaves his list ─────────────────────────────────────
    let changes = 0;
    open.onChange(() => { changes++; });
    const closed = await write({
      [acme]: { op: 'put', ifValidFromMatches: (created as { validFrom: string }).validFrom, value: { title: 'Acme renewal', stage: 'won', amount: 1500 } },
    });
    assert.equal(closed.ok, true, `Sally's edit failed: ${JSON.stringify(closed)}`);
    assert.ok(await until(15_000, () => open.resourceIds.length === 0),
      `the Deal Sally closed must leave Gerry's list without his asking; it holds ${JSON.stringify(open.resourceIds)}`);
    assert.ok(changes >= 1, 'the change must arrive as a push to the list he already holds');
    console.error('  ✓ limb 2 — Sally closed the Deal and it left Gerry\'s list');

    // ── LIMB 3: a filter no index can look up ─────────────────────────────────────────────────
    const refused = await gerry.client.resources.subscribeQuery({ typeName: 'Deal', filter: { title: 'Acme renewal' } })
      .ready.then(() => 'resolved', (e: Error) => e.message);
    assert.match(refused, /^This filter would read every current Deal\. .*Deal's indexes start with "stage"/,
      `a filter on a field with no index must be refused by the engine's message, got: ${refused}`);
    const scanning = gerry.client.resources.subscribeQuery({ typeName: 'Deal', filter: { title: 'Acme renewal' }, allowScan: true });
    await scanning.ready;
    assert.deepEqual(scanning.resourceIds, [acme], 'the same filter, allowed to scan, must run');
    console.error('  ✓ limb 3 — a filter on an unindexed field was refused by name, and ran when it allowed the scan');

    // ── LIMB 4: a value a query would read wrongly ────────────────────────────────────────────
    const everyOpen = gerry.client.resources.subscribeQuery({ typeName: 'Deal', filter: { stage: { $in: ['open', 'lead'] } } });
    await everyOpen.ready;
    const before = [...everyOpen.resourceIds];
    const infinite = await write({
      [crypto.randomUUID()]: { op: 'create', typeName: 'Deal', nodeId: acmeTeam, value: { title: 'Infinite', stage: 'open', amount: Infinity } },
    });
    assert.equal(infinite.ok, false, 'a Deal holding Infinity must be refused');
    assert.match(JSON.stringify(infinite), /Deal\.amount is Infinity, which a query cannot compare/,
      `the refusal must name the field and why: ${JSON.stringify(infinite)}`);
    // The barrier: a Deal that does land reaches the list, and the refused one is not in it.
    const landed = crypto.randomUUID();
    const ok = await write({ [landed]: { op: 'create', typeName: 'Deal', nodeId: acmeTeam, value: { title: 'Lands', stage: 'open', amount: 5 } } });
    assert.equal(ok.ok, true);
    assert.ok(await until(15_000, () => everyOpen.resourceIds.includes(landed)), 'the Deal that landed never reached the list');
    assert.deepEqual(everyOpen.resourceIds, [...before, landed], 'the refused Deal must not be in the list');
    console.error('  ✓ limb 4 — the Deal holding Infinity was refused by name and reached no list');

    // ── LIMB 5: ordering by the declared order of a fixed list of values ──────────────────────
    const lost = crypto.randomUUID();
    const lostWrite = await write({ [lost]: { op: 'create', typeName: 'Deal', nodeId: acmeTeam, value: { title: 'Lost one', stage: 'lost' } } });
    assert.equal(lostWrite.ok, true, `the lost Deal was not written: ${JSON.stringify(lostWrite)}`);
    const pastOpen = gerry.client.resources.subscribeQuery({ typeName: 'Deal', filter: { stage: { $gt: 'open' } } });
    await pastOpen.ready;
    assert.deepEqual([...pastOpen.resourceIds].sort(), [acme, lost].sort(),
      'past `open` in declared order are `won` and `lost`: the Deal Sally closed, and the lost one');
    console.error('  ✓ limb 5 — $gt on the stage held the won Deal and the lost one, by declared order');

    for (const handle of [open, scanning, everyOpen, pastOpen]) handle[Symbol.dispose]();
  } finally {
    waiter?.cleanup();
    try { await gerry?.dispose(); } catch { /* already disposed */ }
    try { gerry?.client[Symbol.dispose](); } catch { /* already disposed */ }
    sally?.dispose();
  }
}
