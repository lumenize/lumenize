/**
 * **A superuser, end to end, on the real login path — the one observer of the claim change that the
 * claim change does not also rewrite.**
 *
 * A super-admin is an ordinary membership at the reserved scope `_platform`, so its token
 * carries `access.authScope: '_platform'` verbatim. That scope is the **ROOT** of the scope
 * tree, and the root branch lives inside `isAtOrAbove` — once, so no call site needs a special arm.
 * Every consumer of `access` therefore inherits it, and a site that hand-rolls the comparison
 * instead breaks the superuser **silently, and differently each time**: their token fails to verify
 * at all, or they can refresh to no scope, or their token becomes unmintable, or enumeration returns
 * one row. This scenario drives the four in one real session.
 *
 * ⚠️ **Why it must be LIVE, and why it is the phase's own criterion.** The in-lane platform coverage
 * lives in fixtures that spell the claim literally — and those fixtures were rewritten in the same
 * commit as the code, so their greenness is no signal about either. A real bootstrap login is the
 * only observer that reads a claim the **server** minted. The verification limb in particular fails
 * CLOSED and TOTAL, so a miss there is a superuser who cannot log in at all.
 *
 * ⚠️ **The bootstrap address is pinned for THIS BOOT ONLY, and that is what keeps it rung 1.**
 * `.dev.vars` binds `NEBULA_AUTH_BOOTSTRAP_EMAIL` to a real human mailbox, which no automated run
 * can read. `bootVars` re-points it at the `*@lumenize-test.dev` catch-all the email-test Worker serves,
 * so the login below is a genuine round trip — link requested, mail delivered, link clicked — rather
 * than a synthetic mint standing in for one (ADR-009 rung 1). The override never touches
 * `.dev.vars`; it is a `--var` on one `wrangler dev`.
 *
 * `needsContainer = false` — auth, refresh and profile only, never a build, so the boot skips Docker.
 */
import assert from 'node:assert/strict';
import { parseJwtUnsafe } from '@lumenize/crypto';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { Profile } from '@lumenize/nebula-auth/profile';
import type { NebulaAuthFacade } from '@lumenize/nebula-auth/facade';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar, superuserEmail } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import {
  requestMagicLink, refreshAccessToken, provisionAndLogin, acceptMembership, refreshTokenForScope,
  setCookieHeaders, consumeLink, refreshCookie, refreshFromPage, homeSummary, scopeOriginFrom,
} from '../../test/lib/email-login';

export const needsContainer = false;

/** The reserved platform scope — the ROOT of the scope tree, never an exception to it. */
const PLATFORM_SCOPE = '_platform';

/**
 * Computed at MODULE scope, not inside `run` — `drive.ts` reads `bootVars` to boot the stack, which
 * happens before `run` is ever called. One address per process, so concurrent runs cannot collide.
 */
const SUPERUSER_EMAIL = superuserEmail(uniqueTestEmail('superuser'));

/** Re-point the bootstrap allow-list at an address on the test catch-all, for this boot only. */
export const bootVars = { NEBULA_AUTH_BOOTSTRAP_EMAIL: SUPERUSER_EMAIL };

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const someUniverse = testSlug('su-probe');

  // ── A scope the superuser has NOTHING to do with, founded by somebody else ───────────────────
  // Enumeration and dominion are only meaningful against a tree that exists, and one the superuser
  // never touched is the honest probe: nothing here is theirs by membership.
  const stranger = await provisionAndLogin({
    baseUrl: origin, scope: `${someUniverse}.app.tenant`, email: uniqueTestEmail(), testToken,
  });
  assert.ok(stranger.accessToken, 'the stranger provisioning login produced no token');

  // ── LIMB 1: a real bootstrap login at the platform scope ─────────────────────────────────────
  // The magic link is requested, the mail genuinely arrives on the catch-all, and the link is
  // clicked. `requestMagicLink` mints nothing on its own — the registry mints the platform identity
  // only for a configured bootstrap email at this exact scope, which is what `bootVars` arranges.
  const waiter = waitForEmail({
    // ⚠️ `_scopeless` — the login request names no scope, so its mail carries no platform tag.
    testToken, instance: '_scopeless', to: SUPERUSER_EMAIL, timeout: 60_000,
  });
  let refreshToken: string;
  try {
    await requestMagicLink({
      baseUrl: origin, email: SUPERUSER_EMAIL,
    });
    const link = extractMagicLink(await waiter.emailPromise);
    const linkRes = await consumeLink(link);
    // ⚠️ `headers.get('set-cookie')` returns only the FIRST of N under mint-all — read them all,
    // and pick the one named for the platform scope.
    const found = refreshTokenForScope(setCookieHeaders(linkRes), PLATFORM_SCOPE);
    assert.ok(
      found,
      `the bootstrap login's Continue set no refresh cookie for "${PLATFORM_SCOPE}" (${linkRes.status})`,
    );
    refreshToken = found;
    // The superuser comes through the front door, so their platform membership is inert until they
    // consent to it like anyone else — without this the refresh below 401s `membership_not_accepted`.
    await acceptMembership(origin, refreshToken, PLATFORM_SCOPE);
  } finally {
    waiter.cleanup();   // a leaked waiter's WebSocket hangs the process AFTER the verdict prints
  }

  const session = { refreshToken, authScope: PLATFORM_SCOPE };

  // ── LIMB 2: on a universe's page, the token VERIFIES and carries the root verbatim ───────────
  // No page on the platform host gets a token, so a superuser's token is minted on a scope host:
  // its `aud` is that universe, and its `authScope` the root the membership sits at. `verify.ts`
  // refuses any token whose `aud` is not at or below its own `authScope`, so this answers on the
  // root branch of `isAtOrAbove`.
  const platform = await refreshAccessToken(origin, session, someUniverse);
  const claims = parseJwtUnsafe(platform.accessToken)!.payload as any;
  assert.equal(
    claims.access?.authScope, PLATFORM_SCOPE,
    `the SERVER-minted superuser claim is not the reserved scope verbatim: ` +
    `${JSON.stringify(claims.access)}`,
  );
  assert.equal(claims.aud, someUniverse, 'the superuser token must name the page it was minted for');
  assert.equal(claims.access?.scopeAdmin, true, 'the superuser claim carries no scopeAdmin bit');

  // ── LIMB 3: a page on ANY host gets a token, a stranger's Star's included ────────────────────
  // The refresh takes as candidates the cookies at or above the host's scope, and the root is
  // above every host. Under the root model this is the ordinary downward rule applied from the
  // top — not a bypass.
  const intoStar = await refreshAccessToken(origin, session, `${someUniverse}.app.tenant`);
  const starClaims = parseJwtUnsafe(intoStar.accessToken)!.payload as any;
  assert.equal(starClaims.aud, `${someUniverse}.app.tenant`, 'the superuser could not refresh into a foreign Star');
  assert.equal(
    starClaims.access?.authScope, PLATFORM_SCOPE,
    'refreshing into a narrower activeScope must NOT narrow authScope — the claim is the membership',
  );

  // ── LIMB 4: enumeration returns the WHOLE tree, not one row ──────────────────────────────────
  // The platform arm is coupled to the reserved scope by VALUE, so the compiler cannot see it. Break
  // it and a superuser silently enumerates exactly one scope — this is the limb that catches it.
  //
  // ⚠️ Reads Home's summary by the root cookie: NESTED and `profileId`-keyed, so the ids are gathered
  // by walking `children`. It is also BUDGET-BOUNDED and filled level by level: every universe, then
  // their apps in sorted order until the budget runs out, a node past it arriving as a `childCount`.
  // So the universe is asserted here; on a target holding many accounts its app sits past the budget,
  // which Home reaches as this limb does, with the facade's `expandScope` from the universe's page.
  // ⚠️ The universe level fills too once the target holds about fifty accounts, and then this reds.
  // A deployed sweep deletes `test-` accounts older than two days before any scenario runs
  // (`drive.ts`'s account sweep), so it reds only if the last two days' runs left fifty.
  const scopesRes = await homeSummary(origin, refreshCookie(PLATFORM_SCOPE, refreshToken));
  assert.equal(scopesRes.status, 200, `Home's summary ${scopesRes.status} for a superuser`);
  type Node = { scope: string; children?: Node[] };
  const { groups } = await scopesRes.json() as { groups: { summary: { emails?: { memberships?: Node[] }[] } }[] };
  const walk = (n: Node): string[] => [n.scope, ...(n.children ?? []).flatMap(walk)];
  const ids = groups.flatMap((g) => (g.summary.emails ?? []).flatMap((e) => (e.memberships ?? []).flatMap(walk)));
  assert.ok(
    ids.includes(someUniverse),
    `the superuser did not enumerate "${someUniverse}" — a scope they hold no membership in. ` +
    `Got ${ids.length} scope(s): ${ids.join(', ')}`,
  );
  // The summary descended into the app only if the budget reached it; when it did, the tenant is there.
  if (ids.includes(`${someUniverse}.app`)) {
    assert.ok(ids.includes(`${someUniverse}.app.tenant`),
      `the summary listed "${someUniverse}.app" without its tenant: ${ids.join(', ')}`);
  }
  // Run in both venues, so the frontier path is exercised on a small tree too.
  // Mutation: let `expandScope` answer an empty level for the platform membership → reds.
  const atUniverse = await connectDriver(stack, {
    scope: someUniverse, session: { accessToken: platform.accessToken, sub: claims.sub },
  });
  try {
    const listed: string[] = [];
    let after: string | undefined;
    do {
      const page = await atUniverse.client.lmz.callAsync('NEBULA_AUTH_FACADE', undefined,
        (atUniverse.client.ctn<NebulaAuthFacade>() as any).expandScope(after ? { after } : undefined),
      ) as { children: { scope: string }[]; nextCursor?: string };
      listed.push(...page.children.map((c) => c.scope));
      after = page.nextCursor;
    } while (after);
    assert.ok(listed.includes(`${someUniverse}.app`),
      `the superuser's expandScope on "${someUniverse}" did not list its app: ${listed.join(', ')}`);
  } finally {
    atUniverse.dispose();
  }

  // ── LIMB 5: a host the parse refuses is refused explicitly, even here ────────────────────────
  // A four-deep host names no scope any grammar can produce, and `isAtOrAbove` is deliberately
  // grammar-free, so the host parse is the boundary: its page answers 404 and its refresh 403,
  // never 500 from a parse that threw.
  //
  // ⚠️ **Asserted for the SUPERUSER on purpose.** Their membership is above every host, so if anyone
  // could talk the refresh into minting an ungrammatical scope it is them — which makes this the
  // strongest place to prove the refusal is about the GRAMMAR and not about authority.
  const ungrammaticalHost = scopeOriginFrom(origin, `${someUniverse}.app.tenant.extra`);
  // The page load is the local half: on a deployed target no certificate covers a four-deep host,
  // so its handshake fails before the Worker sees it, which refuses it as surely. The refresh below
  // names the host in `Origin` on the platform host, so it runs in both venues.
  if (!process.env.HARNESS_TARGET_URL) {
    const page = await fetch(`${ungrammaticalHost}/`);
    assert.equal(page.status, 404, `a page load on a four-deep host answered ${page.status}, not 404`);
    await page.text();
  }
  const badRes = await fetch(`${origin}/auth/refresh-token`, {
    method: 'POST', headers: { Origin: ungrammaticalHost, Cookie: refreshCookie(PLATFORM_SCOPE, refreshToken) },
  });
  assert.equal(badRes.status, 403,
    `a four-deep host's refresh must be refused with 403, got ${badRes.status} (500 would mean the parse threw)`);
  const badBody = await badRes.json() as { error?: string; access_token?: string };
  assert.equal(badBody.error, 'invalid_origin', `wrong error code: ${badBody.error}`);
  assert.equal(badBody.access_token, undefined, 'an ungrammatical scope was minted into a token');

  // ── LIMB 6: from a page above the stranger, the superuser passes the Profile gate ───────────
  // Profile's platform short-circuit answers only the agent's own Profile, so this write reads the
  // registry and asks `hasDominionOver` per scope the stranger holds, from the page's host,
  // `someUniverse`, which sits above all of them. A real server-minted platform token traverses the
  // whole chain — Gateway, mesh boundary, Profile DO, authz — and is admitted on a *global* object
  // owned by someone else. It is limb 7's positive control.
  const strangerProfileId = (parseJwtUnsafe(stranger.accessToken)!.payload as any).profileId as string;
  assert.ok(strangerProfileId, 'the stranger login carried no profileId claim');

  // The SAME principal limb 1 logged in for real, as a connected mesh client — carrying the token
  // the server minted in limb 2 (`platform`), not a rebuilt one. Until 2026-09-02 this site minted
  // a synthetic copy under a justification that connectDriver lacked a session entry; it had one.
  const superDriver = await connectDriver(stack, {
    scope: someUniverse,
    session: { accessToken: platform.accessToken, sub: claims.sub as string },
  });
  try {
    await superDriver.client.lmz.callAsync(
      'PROFILE', strangerProfileId,
      superDriver.client.ctn<Profile>().writeProfile({ name: 'seen-by-the-superuser' }),
    );
  } finally {
    superDriver.dispose();
  }

  // ── LIMB 7: from a page beside the stranger, the same write is refused ──────────────────────
  // The membership is the platform root, and the page bounds it (the host rule): another universe's
  // host holds dominion over nothing the stranger holds. Reds if the Profile reads `authScope`, or
  // short-circuits a superuser on every profile.
  const beside = testSlug('su-beside');
  const fromBeside = await refreshAccessToken(origin, session, beside);
  const besideDriver = await connectDriver(stack, {
    scope: beside,
    session: { accessToken: fromBeside.accessToken, sub: claims.sub as string },
  });
  try {
    await assert.rejects(
      besideDriver.client.lmz.callAsync(
        'PROFILE', strangerProfileId,
        besideDriver.client.ctn<Profile>().writeProfile({ name: 'not-from-here' }),
      ),
      /does not cover/i,
      "a superuser on a page beside the stranger must not write the stranger's profile",
    );
  } finally {
    besideDriver.dispose();
  }

  console.error(
    `[superuser-end-to-end] real bootstrap login verified, refreshed into a foreign Star, ` +
    `enumerated ${ids.length} scope(s), was refused an ungrammatical scope, and passed the Profile gate ` +
    'from a page above the stranger and not from one beside them',
  );
}
