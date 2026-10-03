/**
 * **One owner cannot drain the zone: the galaxy cap holds where a galaxy is created and where a
 * claim is accepted, and a superuser's root membership counts none of the zone's galaxies.**
 *
 * The cap is `MAX_GALAXIES_PER_OWNER`, counted live in the Registry over the address's accepted
 * admin memberships, less any at the platform root, and exercised here at its real value: a local
 * create orders no certificate and costs a few Registry rows.
 *
 * Limbs, each isolated (`live.md` — per limb), each refusal matched by its message:
 *
 *  1. **Just below the cap, a create succeeds** — the positive control for limb 2. The owner's claim
 *     wrote the first app, and the facade writes the rest up to the cap.
 *  2. **At the cap, `createGalaxy` is refused with the cap's message and writes no `Scopes` row.**
 *     *Reds if the check at `createGalaxy` goes (the create succeeds).*
 *  3. **Accepting a second claim whose first galaxy would cross the cap is refused the same way, on
 *     the link's page and again on Home, and the membership stays unaccepted.** *Reds if the check
 *     at acceptance goes.*
 *  4. **A refused create or acceptance tears nothing down and orders nothing: none of limb 2's and
 *     3's refusals logs a `creation` marker or wakes a certificate order**, while below the cap each
 *     site wakes one — the owner's last create, its claim's Accept on the link's page, and the Accept
 *     on Home that follows it. Counted here, after the last refusal's completion line, which is logged
 *     after anything the refusals could have caused. *Reds if the facade tears down or wakes whatever
 *     the Registry answered, or if the acceptance helper wakes on a refusal that names its galaxies.*
 *  5. **A superuser accepted at the root creates in a universe they admin while more galaxies than
 *     the cap exist on the zone.** *Reds if the count takes the root through its `%` arm.*
 *
 * `needsContainer = false` — auth, the Registry and the teardown hook only.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import { GALAXY_CAP_MESSAGE, MAX_GALAXIES_PER_OWNER } from '@lumenize/nebula-auth/claims';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar, superuserEmail } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { waitForDebugLines, type DebugLine } from '../lib/stdio';
import {
  provisionAndLogin, refreshAccessToken, requestUniverseClaim, requestMagicLink, refreshTokenForScope,
  setCookieHeaders, acceptMembership, consumeLink, refreshCookie,
} from '../../test/lib/email-login';

export const needsContainer = false;

/** A stable address for this boot, pinned as the bootstrap identity below. */
const SUPERUSER = superuserEmail('cap-superuser@lumenize-test.dev');
const PLATFORM = '_platform';

export const bootVars = {
  NEBULA_AUTH_BOOTSTRAP_EMAIL: SUPERUSER,
  DEBUG: 'nebula.scope.teardown,nebula-auth.facade,nebula-auth.Registry.identity.membershipAccepted,'
    + 'nebula.Galaxy.orderCertificate,nebula-auth.worker.acceptMembership',
};

/** The refusal MESSAGE, or `null` if the call succeeded — a refusal is matched by what it says. */
async function refusal(op: Promise<unknown>): Promise<string | null> {
  try { await op; return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/** Press an emailed link's button and come back with the cookie it set for `scope`. */
async function clickFor(link: string, scope: string): Promise<string> {
  const clicked = await consumeLink(link);
  const cookie = refreshTokenForScope(setCookieHeaders(clicked), scope);
  assert.ok(cookie, `the link's button set no cookie for ${scope} (${clicked.status})`);
  return cookie!;
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const universe = testSlug('cap');
  const owner = uniqueTestEmail();
  const observable = stack.logs !== undefined;
  const drivers: Driver[] = [];

  try {
    // The owner's claim writes `crm`, its first app; the facade writes the rest.
    const provisioned = await provisionAndLogin({ baseUrl: origin, scope: `${universe}.crm`, email: owner, testToken });
    const atUniverse = await refreshAccessToken(origin, provisioned.session, universe);
    const driver = await connectDriver(stack, { scope: universe, session: atUniverse });
    drivers.push(driver);

    // ── 1. Just below the cap, a create succeeds ────────────────────────────────────────────────
    for (let i = 2; i <= MAX_GALAXIES_PER_OWNER; i++) {
      assert.deepEqual(await driver.client.scopes.createGalaxy(universe, `g${i}`), { instanceName: `${universe}.g${i}` },
        `create ${i} of ${MAX_GALAXIES_PER_OWNER} must succeed`);
    }
    console.error(`  ✓ limb 1 — the owner reached the cap, ${MAX_GALAXIES_PER_OWNER} apps, the last just below it`);

    // ── 2. At the cap, the create is refused, writes nothing, and tears nothing down ────────────
    const over = `${universe}.over`;
    assert.equal(await refusal(driver.client.scopes.createGalaxy(universe, 'over')), GALAXY_CAP_MESSAGE,
      'the create past the cap must be refused with the cap message');
    const listed = (await driver.client.scopes.expand()).children.map((c) => c.scope);
    assert.equal(listed.length, MAX_GALAXIES_PER_OWNER, 'the universe page must list exactly the cap');
    assert.ok(!listed.includes(over), 'the refused create must write no Scopes row');
    console.error('  ✓ limb 2 — at the cap the create is refused by message and writes nothing');

    // ── 3. Accepting a claim that would cross the cap is refused, and stays unaccepted ──────────
    const second = `${universe}b`;
    const waiter = waitForEmail({ testToken, to: owner, timeout: 120_000 });
    let link: string;
    try {
      await requestUniverseClaim({ baseUrl: origin, universe: second, appSlug: 'web', email: owner });
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    // The claim link's page is its consent screen, so its Accept is the first acceptance.
    const onLink = await consumeLink(link);
    assert.equal(onLink.status, 403, "an acceptance past the cap must be refused on the link's page");
    assert.equal((await onLink.clone().json() as { error_description: string }).error_description, GALAXY_CAP_MESSAGE);
    const cookie = refreshTokenForScope(setCookieHeaders(onLink), second);
    assert.ok(cookie, 'a refused Accept still sets the cookies its consume set');
    // Home's Accept retries the acceptance, and is refused the same way.
    const onHome = await fetch(`${origin}/auth/accept-membership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: refreshCookie(second, cookie!) },
      body: JSON.stringify({ scope: second }),
    });
    assert.equal(onHome.status, 403, "an acceptance past the cap must be refused on Home's retry too");
    assert.equal((await onHome.json() as { error_description: string }).error_description, GALAXY_CAP_MESSAGE);
    const pending = await fetch(`${origin}/auth/pending-membership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: refreshCookie(second, cookie!) },
      body: JSON.stringify({ scope: second }),
    });
    assert.equal((await pending.json() as { accepted: boolean }).accepted, false,
      'a refused acceptance must leave the membership unaccepted');
    console.error('  ✓ limb 3 — an acceptance past the cap is refused by message and stays unaccepted');

    // ── 4. A refused create or acceptance orders nothing; below the cap each site does ──────────
    if (observable) {
      const capRefused = (l: DebugLine) => l.namespace === 'nebula-auth.Registry.identity.membershipAccepted'
        && l.message === 'Acceptance refused by the galaxy cap' && l.data.scope === second;
      // Home's refusal is the last request limbs 2 and 3 made, and its completion line is logged
      // after anything it could have woken, so every wake those refusals caused has landed by then.
      const all = await waitForDebugLines(stack, (a) => a.filter(capRefused).length === 2
        && a.filter((l) => l.namespace === 'nebula-auth.worker.acceptMembership' && l.data.outcome === 'refused').length === 2,
      "both refused acceptances' completion lines");
      const wakesOf = (op: string) => all.filter((l) => l.namespace === 'nebula.Galaxy.orderCertificate' && l.data.operationId === op)
        .map((l) => l.data.instanceName);
      const createOp = (target: string, message: string) => all.find((l) => l.namespace === 'nebula-auth.facade.createGalaxy'
        && l.message === message && l.data.target === target)!.data.operationId;
      const acceptOp = (outcome: string) => all.find((l) => l.namespace === 'nebula-auth.worker.acceptMembership'
        && l.data.outcome === outcome && l.data.scope === universe)!.data.operationId;
      // Positive controls: below the cap, the create, the link page's Accept and Home's each wake.
      const last = `${universe}.g${MAX_GALAXIES_PER_OWNER}`;
      assert.deepEqual(wakesOf(createOp(last, 'created')), [last], 'a create below the cap must wake its galaxy');
      assert.deepEqual(wakesOf(acceptOp('accepted')), [`${universe}.crm`], "the link page's Accept below the cap must wake");
      assert.deepEqual(wakesOf(acceptOp('already-accepted')), [`${universe}.crm`], "Home's Accept below the cap must wake");
      // The refusals: the create past the cap, then the second claim's Accept on its link and on Home.
      assert.deepEqual(wakesOf(createOp(over, 'called')), [], 'a refused create must wake nothing');
      const refusedOps = all.filter(capRefused).map((l) => l.data.operationId);
      assert.deepEqual(refusedOps.map(wakesOf), [[], []], 'a refused acceptance must wake nothing, on the link page or Home');
      const teardownsOf = (op: string) => all.filter((l) => l.namespace === 'nebula.scope.teardown' && l.data.operationId === op).length;
      assert.deepEqual([createOp(over, 'called'), ...refusedOps].map(teardownsOf), [0, 0, 0],
        'a refused create or acceptance must tear nothing down');
    }
    console.error(`  ✓ limb 4 — the refusals tore nothing down and woke nothing, and below the cap each site woke one${observable ? '' : ' (not observable deployed)'}`);

    // ── 5. A superuser's root membership counts none of the zone's galaxies ─────────────────────
    // The zone now holds the owner's apps and the refused claim's: more than the cap.
    const rootWaiter = waitForEmail({ testToken, to: SUPERUSER, timeout: 120_000 });
    let rootLink: string;
    try {
      await requestMagicLink({ baseUrl: origin, email: SUPERUSER });
      rootLink = extractMagicLink(await rootWaiter.emailPromise);
    } finally {
      rootWaiter.cleanup();
    }
    await acceptMembership(origin, await clickFor(rootLink, PLATFORM), PLATFORM);
    const own = `${universe}s`;
    const ownSession = await provisionAndLogin({ baseUrl: origin, scope: own, email: SUPERUSER, testToken });
    const atOwn = await connectDriver(stack, { scope: own, session: ownSession });
    drivers.push(atOwn);
    assert.deepEqual(await atOwn.client.scopes.createGalaxy(own, 'second'), { instanceName: `${own}.second` },
      'a superuser must be capped by their own universes, never by the zone through the root');
    console.error('  ✓ limb 5 — the superuser created in their own universe past the zone\'s cap');
  } finally {
    for (const d of drivers) d.dispose();
  }
}
