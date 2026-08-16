/**
 * **A superuser, end to end, on the real login path — the one observer of the claim change that the
 * claim change does not also rewrite.**
 *
 * A super-admin is an ordinary membership at the reserved scope `nebula-platform`, so its token
 * carries `access.authScope: 'nebula-platform'` verbatim. That scope is the **ROOT** of the scope
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
 * can read. `bootVars` re-points it at the `*@lumenize.io` catch-all the email-test Worker serves,
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
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import {
  requestMagicLink, refreshAccessToken, pointLinkAt, provisionAndLogin,
} from '../../test/lib/email-login';

export const needsContainer = false;

/** The reserved platform scope — the ROOT of the scope tree, never an exception to it. */
const PLATFORM_SCOPE = 'nebula-platform';

/**
 * Computed at MODULE scope, not inside `run` — `drive.ts` reads `bootVars` to boot the stack, which
 * happens before `run` is ever called. One address per process, so concurrent runs cannot collide.
 */
const SUPERUSER_EMAIL = uniqueTestEmail('superuser');

/** Re-point the bootstrap allow-list at an address on the test catch-all, for this boot only. */
export const bootVars = { NEBULA_AUTH_BOOTSTRAP_EMAIL: SUPERUSER_EMAIL };

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const suffix = crypto.randomUUID().slice(0, 8);
  const someUniverse = `superuser-probe-${suffix}`;

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
    testToken, instance: PLATFORM_SCOPE, to: SUPERUSER_EMAIL, timeout: 60_000,
  });
  let refreshToken: string;
  try {
    await requestMagicLink({
      baseUrl: origin, authScope: PLATFORM_SCOPE, email: SUPERUSER_EMAIL,
    });
    const link = pointLinkAt(origin, extractMagicLink(await waiter.emailPromise));
    const linkRes = await fetch(link, { redirect: 'manual' });
    const setCookie = linkRes.headers.get('set-cookie') ?? '';
    const match = /refresh-token=([^;]+)/.exec(setCookie);
    assert.ok(
      match,
      `the bootstrap magic-link click set no refresh-token cookie (${linkRes.status}) — ` +
      `Location=${linkRes.headers.get('Location') ?? '(none)'}`,
    );
    refreshToken = match[1]!;
  } finally {
    waiter.cleanup();   // a leaked waiter's WebSocket hangs the process AFTER the verdict prints
  }

  const session = { refreshToken, authScope: PLATFORM_SCOPE };

  // ── LIMB 2: the token VERIFIES, and carries the scope verbatim ───────────────────────────────
  // `verify.ts` refuses any token whose `aud` is not at or below its own `authScope`. For a
  // superuser that check passes only through the root branch, so a hand-rolled comparison anywhere
  // in the verify path makes this limb fail closed — no login at all, for the one identity that
  // cannot be locked out.
  const platform = await refreshAccessToken(origin, session, PLATFORM_SCOPE);
  const claims = parseJwtUnsafe(platform.accessToken)!.payload as any;
  assert.equal(
    claims.access?.authScope, PLATFORM_SCOPE,
    `the SERVER-minted superuser claim is not the reserved scope verbatim: ` +
    `${JSON.stringify(claims.access)}`,
  );
  assert.equal(claims.access?.scopeAdmin, true, 'the superuser claim carries no scopeAdmin bit');

  // ── LIMB 3: they may refresh to ANY activeScope, including a stranger's Star ─────────────────
  // The refresh confine compares the KV record's scope against the requested one. Under the root
  // model this is the ordinary downward rule applied from the top — not a bypass.
  const intoStar = await refreshAccessToken(origin, session, `${someUniverse}.app.tenant`);
  const starClaims = parseJwtUnsafe(intoStar.accessToken)!.payload as any;
  assert.equal(starClaims.aud, `${someUniverse}.app.tenant`, 'the superuser could not refresh into a foreign Star');
  assert.equal(
    starClaims.access?.authScope, PLATFORM_SCOPE,
    'refreshing into a narrower activeScope must NOT narrow authScope — the claim is the membership',
  );

  // ── LIMB 4: enumeration returns the WHOLE tree, not one row ──────────────────────────────────
  // `myScopeTree`'s platform arm is coupled to the claim by VALUE, so the compiler cannot see it.
  // Break it and a superuser silently enumerates exactly one scope — this is the limb that catches it.
  const scopesRes = await fetch(`${origin}/auth/my-scopes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${platform.accessToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(scopesRes.status, 200, `my-scopes ${scopesRes.status} for a superuser`);
  const scopes = (await scopesRes.json() as { scopes?: { instanceName: string }[] }).scopes ?? [];
  const ids = scopes.map((s) => s.instanceName);
  for (const expected of [someUniverse, `${someUniverse}.app`, `${someUniverse}.app.tenant`]) {
    assert.ok(
      ids.includes(expected),
      `the superuser did not enumerate "${expected}" — a scope they hold no membership in. ` +
      `Got ${ids.length} scope(s): ${ids.join(', ')}`,
    );
  }

  // ── LIMB 5: the scope GRAMMAR is enforced at the refresh boundary, even here ─────────────────
  // 🚨 A deliberate verdict change: a four-segment `activeScope` answers **400** where today's code
  // answers 200 at every tier. `buildAuthScopePattern`'s wildcard placement was silently encoding
  // `parseId`'s 1–3-segment grammar; `isAtOrAbove` is deliberately grammar-free, so the grammar is
  // restored at the request boundary.
  //
  // ⚠️ **Asserted for the SUPERUSER on purpose.** They hold dominion over every scope, so if anyone
  // could talk the endpoint into minting an ungrammatical one it is them — which makes this the
  // strongest place to prove the refusal is about the GRAMMAR and not about authority. A 403 here
  // would mean the parse never ran and a containment check refused it instead.
  const ungrammatical = `${someUniverse}.app.tenant.extra`;
  const badRes = await fetch(`${origin}/auth/${PLATFORM_SCOPE}/refresh-token`, {
    method: 'POST',
    headers: { Cookie: `refresh-token=${refreshToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeScope: ungrammatical }),
  });
  assert.equal(
    badRes.status, 400,
    `a four-segment activeScope must be refused at the boundary with 400, got ${badRes.status} ` +
    `(500 would mean a bare parseId throw reached router.ts's blanket catch; 403 would mean the ` +
    `parse never ran)`,
  );
  const badBody = await badRes.json() as { error?: string; access_token?: string };
  assert.equal(badBody.error, 'invalid_request', `wrong error code: ${badBody.error}`);
  assert.equal(badBody.access_token, undefined, 'an ungrammatical scope was minted into a token');

  // ── LIMB 6: the Profile gate passes with ZERO registry reads ─────────────────────────────────
  // Profile's super-admin branch is the second value-coupled site. It is a work-avoidance
  // short-circuit — it must answer BEFORE the one registry read the scoped-admin branch makes — so
  // a superuser writing a stranger's profile is what proves the branch still fires.
  const strangerProfileId = (parseJwtUnsafe(stranger.accessToken)!.payload as any).profileId as string;
  assert.ok(strangerProfileId, 'the stranger login carried no profileId claim');

  const superDriver = await connectDriver(stack, {
    scope: PLATFORM_SCOPE,
    mint: {
      reason:
        'the identity itself came from a REAL bootstrap login above (limb 1) — this mint only ' +
        'rebuilds the same principal as a connected mesh client, because connectDriver has no ' +
        'entry that takes an already-obtained platform session. The claim it asserts against was ' +
        'checked against the server-minted one in limb 2.',
      issuerInstanceName: PLATFORM_SCOPE,
    },
  });
  try {
    await superDriver.client.lmz.callAsync(
      'PROFILE', strangerProfileId,
      superDriver.client.ctn<Profile>().writeProfile({ name: 'seen-by-the-superuser' }),
    );
  } finally {
    superDriver.dispose();
  }

  console.error(
    `[superuser-end-to-end] real bootstrap login verified, refreshed into a foreign Star, ` +
    `enumerated ${ids.length} scope(s), was refused an ungrammatical scope, and passed the Profile gate`,
  );
}
