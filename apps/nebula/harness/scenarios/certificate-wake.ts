/**
 * **A galaxy's certificate order is woken by name, only from our own code, and only for a galaxy
 * that stands.**
 *
 * Creating a galaxy orders its certificate pack, and the order starts when nebula-auth's
 * `orderCertificate` hook reaches the Galaxy's `@rawRpc()` entry, after a create or a claim's
 * acceptance. The local stack's origin is `http`, so the Galaxy records the wake and orders
 * nothing; what this scenario watches is the wake's marker, `nebula.Galaxy.orderCertificate`, which
 * carries the Galaxy's own `this.lmz.instanceName` and the operation that woke it.
 *
 * Limbs, each matched by the operation id the waking request logged:
 *
 *  1. **An acceptance on the link's page wakes the claim's galaxy, by name.** *Reds if the
 *     `@rawRpc()` entry stamps no identity: the marker names no instance.*
 *  2. **A ticket-backed claim accepted on Home wakes its galaxy.** *Reds if only the link page's
 *     `POST` fires the hook.*
 *  3. **A create through the facade wakes the new galaxy.**
 *  4. **A universe admin's mesh call to a galaxy nobody created wakes nothing**, and every marker
 *     in the run belongs to a waking request. *Reds if `onStart` orders.* Positive control: the
 *     call reached the Galaxy, whose entry marker names it.
 *  5. **Accepting again from Home wakes a standing galaxy, and wakes nothing once it is deleted.**
 *     Already accepted orders too, since a Worker that died before its wake leaves nothing else to
 *     retry it, so the first re-accept is the positive control. *Reds if the Registry names the
 *     claim's galaxy from anything but its standing row, such as the spent link's `returnTo`.*
 *  6. **The `http` origin orders nothing**: no Galaxy logs a certificate call. *Reds if a local
 *     Galaxy orders, since it then finds no token to order with.*
 *
 * Every limb reads the stack's stdio, so on a deployed target each says it is not observable there
 * (`live-scenarios.md` § *Reading the local stack's logs*).
 *
 * `needsContainer = false` — auth, the Registry, the Galaxy's entry and the teardown hook only.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import { SIGNUP_TICKET_COOKIE } from '@lumenize/nebula-auth/claims';
import type { Galaxy } from '../../src/galaxy';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { waitForDebugLines, type DebugLine } from '../lib/stdio';
import {
  provisionAndLogin, refreshAccessToken, consumeLink, setCookieHeaders, refreshTokenForScope, refreshCookie,
  claimedUniverses,
} from '../../test/lib/email-login';

export const needsContainer = false;

export const bootVars = {
  DEBUG: 'nebula.Galaxy.orderCertificate,nebula.Galaxy.certificate,nebula-auth.worker.acceptMembership,'
    + 'nebula-auth.facade.createGalaxy,nebula.NebulaDO.onBeforeCall',
};

const WAKE = 'nebula.Galaxy.orderCertificate';
const ACCEPTED = 'nebula-auth.worker.acceptMembership';

/**
 * The first acceptance after line `after` that answered `outcome` for `scope`, once its completion
 * line lands: its operation id, and the line's position for the next read to start after.
 */
async function acceptance(stack: DevStack, scope: string, outcome: string, after = -1): Promise<{ op: string; idx: number }> {
  const match = (l: DebugLine) => l.namespace === ACCEPTED && l.message === 'accepted'
    && l.data.scope === scope && l.data.outcome === outcome && l.idx > after;
  const all = await waitForDebugLines(stack, (a) => a.some(match), `the ${outcome} acceptance of ${scope}`);
  const line = all.find(match)!;
  return { op: line.data.operationId, idx: line.idx };
}

/** Whether a line is a create's or an acceptance's completion — the requests that may wake. */
const isWaker = (l: DebugLine) => (l.namespace === ACCEPTED && l.message === 'accepted')
  || (l.namespace === 'nebula-auth.facade.createGalaxy' && l.message === 'created');

/** The wake markers `op` caused. Its completion line is logged after its wakes, so read after it. */
async function wakesOf(stack: DevStack, op: string): Promise<DebugLine[]> {
  const all = await waitForDebugLines(stack, (a) => a.some((l) => l.data.operationId === op && isWaker(l)),
    `the completion line of ${op}`);
  return all.filter((l) => l.namespace === WAKE && l.data.operationId === op);
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const observable = stack.logs !== undefined;
  const drivers: Driver[] = [];
  if (!observable) console.error('  ⓘ every limb reads the stack\'s stdio, which a deployed target does not expose');

  try {
    // ── 1. The link page's acceptance wakes the claim's galaxy, by name ─────────────────────────
    const universe = testSlug('cw');
    const owner = uniqueTestEmail();
    const provisioned = await provisionAndLogin({ baseUrl: origin, scope: `${universe}.crm`, email: owner, testToken });
    if (observable) {
      const { op } = await acceptance(stack, universe, 'accepted');
      assert.deepEqual((await wakesOf(stack, op)).map((l) => l.data.instanceName), [`${universe}.crm`],
        "the link page's acceptance must wake the claim's galaxy, named by its own instanceName");
    }
    console.error(`  ✓ limb 1 — the link page's acceptance woke ${universe}.crm by name${observable ? '' : ' (not observable deployed)'}`);

    // ── 2. A ticket-backed claim accepted on Home wakes its galaxy ──────────────────────────────
    const ticketUniverse = testSlug('cwt');
    const newcomer = uniqueTestEmail();
    const waiter = waitForEmail({ testToken, instance: '_scopeless', to: newcomer, timeout: 60_000 });
    let link: string;
    try {
      const requested = await fetch(`${origin}/auth/email-magic-link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
        body: JSON.stringify({ email: newcomer }),
      });
      assert.equal(requested.status, 200, `the scope-less request was refused (${requested.status})`);
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    const clicked = await consumeLink(link);
    const ticket = setCookieHeaders(clicked).find((c) => c.startsWith(`${SIGNUP_TICKET_COOKIE}=`))?.split(';')[0].split('=')[1];
    assert.ok(ticket, 'a proved address with nothing to enter must get a signup ticket');
    const claimed = await fetch(`${origin}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Cookie: `${SIGNUP_TICKET_COOKIE}=${ticket}` },
      body: JSON.stringify({ slug: ticketUniverse, appSlug: 'notes' }),
    });
    assert.equal(claimed.status, 200, `the ticket claim failed (${claimed.status})`);
    claimedUniverses.push({ universe: ticketUniverse, email: newcomer }); // accepted below, so the harness deletes it
    const ticketCookie = refreshTokenForScope(setCookieHeaders(claimed), ticketUniverse);
    assert.ok(ticketCookie, 'the ticket claim must set the new account\'s cookie');
    const onHome = await fetch(`${origin}/auth/accept-membership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Cookie: refreshCookie(ticketUniverse, ticketCookie!) },
      body: JSON.stringify({ scope: ticketUniverse }),
    });
    assert.equal(onHome.status, 200, `Home's Accept failed (${onHome.status})`);
    await onHome.text();
    if (observable) {
      const { op } = await acceptance(stack, ticketUniverse, 'accepted');
      assert.deepEqual((await wakesOf(stack, op)).map((l) => l.data.instanceName), [`${ticketUniverse}.notes`],
        "Home's acceptance of a ticket-backed claim must wake its galaxy");
    }
    console.error(`  ✓ limb 2 — Home's acceptance woke ${ticketUniverse}.notes${observable ? '' : ' (not observable deployed)'}`);

    // ── 3. A facade create wakes the new galaxy ─────────────────────────────────────────────────
    const atUniverse = await refreshAccessToken(origin, provisioned.session, universe);
    const driver = await connectDriver(stack, { scope: universe, session: atUniverse });
    drivers.push(driver);
    assert.deepEqual(await driver.client.scopes.createGalaxy(universe, 'web'), { instanceName: `${universe}.web` });
    if (observable) {
      const created = await waitForDebugLines(stack, (a) => a.some((l) => l.namespace === 'nebula-auth.facade.createGalaxy'
        && l.message === 'created' && l.data.target === `${universe}.web`), 'the create\'s completion line');
      const op = created.find((l) => l.namespace === 'nebula-auth.facade.createGalaxy' && l.message === 'created'
        && l.data.target === `${universe}.web`)!.data.operationId;
      assert.deepEqual((await wakesOf(stack, op)).map((l) => l.data.instanceName), [`${universe}.web`],
        'a facade create must wake the galaxy it created');
    }
    console.error(`  ✓ limb 3 — the facade create woke ${universe}.web${observable ? '' : ' (not observable deployed)'}`);

    // ── 4. A mesh call to a galaxy nobody created wakes nothing ─────────────────────────────────
    const never = `${universe}.never`;
    const config = await driver.client.lmz.callAsync('GALAXY', never, driver.client.ctn<Galaxy>().getGalaxyConfig());
    assert.ok(config && typeof config === 'object' && 'coalesceWindowMs' in config,
      'the call must reach the never-created Galaxy and read its default config');
    if (observable) {
      const all = await waitForDebugLines(stack, (a) => a.some((l) => l.namespace === 'nebula.NebulaDO.onBeforeCall'
        && l.data.instanceName === never), `the never-created Galaxy's entry marker`);
      const wakers = new Set(all.filter(isWaker).map((l) => l.data.operationId));
      const stray = all.filter((l) => l.namespace === WAKE && !wakers.has(l.data.operationId));
      assert.deepEqual(stray.map((l) => l.data), [], 'every wake must belong to a create or an acceptance');
    }
    console.error(`  ✓ limb 4 — a mesh call reached ${never} and woke nothing${observable ? '' : ' (not observable deployed)'}`);

    // ── 5. A re-accept wakes a standing galaxy, and nothing once it is deleted ──────────────────
    const lone = testSlug('cwl');
    const loner = await provisionAndLogin({ baseUrl: origin, scope: `${lone}.crm`, email: uniqueTestEmail(), testToken });
    // `provisionAndLogin` accepts on the link's page and then again on Home, so the re-accepts here
    // are read after that second acceptance's line.
    let previous = -1;
    if (observable) previous = (await acceptance(stack, lone, 'already-accepted', (await acceptance(stack, lone, 'accepted')).idx)).idx;
    const reaccept = async () => {
      const res = await fetch(`${origin}/auth/accept-membership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Cookie: refreshCookie(lone, loner.session.refreshToken) },
        body: JSON.stringify({ scope: lone }),
      });
      assert.equal(res.status, 200, `Home's re-accept failed (${res.status})`);
      await res.text();
    };
    await reaccept();
    if (observable) {
      const first = await acceptance(stack, lone, 'already-accepted', previous);
      assert.deepEqual((await wakesOf(stack, first.op)).map((l) => l.data.instanceName), [`${lone}.crm`],
        'an already-accepted re-accept must wake the standing galaxy');
      previous = first.idx;
    }
    const atLone = await connectDriver(stack, { scope: lone, session: await refreshAccessToken(origin, loner.session, lone) });
    drivers.push(atLone);
    const deleted = await atLone.client.scopes.delete(`${lone}.crm`);
    assert.ok(deleted.affected.some((a) => a.instanceName === `${lone}.crm`), 'the galaxy must be deleted');
    await reaccept();
    if (observable) {
      const { op } = await acceptance(stack, lone, 'already-accepted', previous);
      assert.deepEqual((await wakesOf(stack, op)).map((l) => l.data.instanceName), [],
        'a re-accept after its galaxy is deleted must wake nothing');
    }
    console.error(`  ✓ limb 5 — a re-accept woke ${lone}.crm while it stood, and nothing once deleted${observable ? '' : ' (not observable deployed)'}`);

    // ── 6. The http origin orders nothing ───────────────────────────────────────────────────────
    if (observable) {
      const all = await waitForDebugLines(stack, () => true, 'any line');
      assert.deepEqual(all.filter((l) => l.namespace === 'nebula.Galaxy.certificate').map((l) => l.message), [],
        'a local Galaxy must make no certificate call');
    }
    console.error(`  ✓ limb 6 — the http origin ordered nothing${observable ? '' : ' (not observable deployed)'}`);
  } finally {
    for (const d of drivers) d.dispose();
  }
}
