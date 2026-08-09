/**
 * A revoke stops a REAL session — proved against a real server, a real cookie jar, and no fixture.
 *
 * Two real email logins for one person (ADR-009 rung 1 throughout), then a scope deletion revokes
 * every refresh record anchored to them, then both cookies are presented to
 * `POST /auth/{scope}/refresh-token` and must come back **401** from the running Worker.
 *
 * ⚠️ **Fidelity is the reason, and the in-lane arm is not deficient — it is blind to a different
 * thing.** `packages/nebula-auth/test/identity-mint-point.test.ts` asserts what no client can see:
 * that no `RefreshTokenIndex` row and no `refresh:{tokenHash}` key survives. That is the invariant,
 * and it must stay in-lane. But miniflare's KV is strongly consistent, so an in-lane 401 proves the
 * record is gone from a store that behaves unlike production. This proves a session a real browser
 * held actually stopped working. Both arms; neither substitutes.
 *
 * ⚠️ **And it needs no fixture, which is the point.** The in-lane arm has to construct the
 * multi-session state by hand; here two logins produce it, so there is no shape to get wrong. This
 * build lost time twice to fixtures that were the *safe* shape rather than the dangerous one — a
 * class of error that cannot occur when the state is produced by the system under test.
 *
 * ⚠️ Deliberately silent on KV **edge propagation**. `security.md`'s ~60s + access-TTL bound still
 * applies and no lane can reproduce that gap deterministically; asserting it here would be a flake,
 * not a check. The reasoning lives in the task file's revocation decision, out of the assertions.
 *
 * `needsContainer = false` — auth only, so the boot skips Docker.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { provisionAndLogin, requestMagicLink, pointLinkAt } from '../../test/lib/email-login';

export const needsContainer = false;

/** Present a refresh cookie to the running server and report the status it actually returns. */
async function refreshStatus(origin: string, scope: string, refreshToken: string): Promise<number> {
  const res = await fetch(`${origin}/auth/${scope}/refresh-token`, {
    method: 'POST',
    headers: { Cookie: `refresh-token=${refreshToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeScope: scope }),
  });
  return res.status;
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const universe = `revoke-${crypto.randomUUID().slice(0, 8)}`;
  const person = uniqueTestEmail();

  // ── Session 1: found the Universe with a real email login ────────────────────────────────────
  const first = await provisionAndLogin({ baseUrl: origin, scope: universe, email: person, testToken });
  const firstCookie = first.session.refreshToken;
  assert.ok(firstCookie, 'the first login produced no refresh cookie');

  // ── Session 2: the SAME person logs in again — a second live refresh record ──────────────────
  const waiter = waitForEmail({ testToken, instance: universe, to: person, timeout: 60_000 });
  let link: string;
  try {
    await requestMagicLink({ baseUrl: origin, authScope: universe, email: person, fetchImpl: fetch });
    link = pointLinkAt(origin, extractMagicLink(await waiter.emailPromise));
  } finally {
    // ⚠️ ALWAYS close it — a leaked waiter's WebSocket keeps Node's event loop alive, so the process
    // hangs after printing its verdict. `finally` so a failed assertion cannot skip it.
    waiter.cleanup();
  }
  const clicked = await fetch(link, { redirect: 'manual' });
  const secondCookie = /refresh-token=([^;]+)/.exec(clicked.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(secondCookie, `the second real login set no refresh cookie (${clicked.status})`);
  assert.notEqual(secondCookie, firstCookie, 'both logins returned the same cookie — not two sessions');

  // Positive control: BOTH sessions are genuinely live before anything is revoked. Without this a
  // revoke that did nothing would be indistinguishable from a login that never worked.
  assert.equal(await refreshStatus(origin, universe, firstCookie), 200, 'session 1 was not live');
  assert.equal(await refreshStatus(origin, universe, secondCookie), 200, 'session 2 was not live');

  // ── Revoke, through the API the PRODUCT actually calls ───────────────────────────────────────
  // `client.scopes.delete()` — not a hand-built `Bearer` fetch. The client holds the JWT internally
  // and issues the authed request itself, so this exercises the same `authedFetch` path the Studio
  // uses. A scenario that assembles its own Authorization header proves the endpoint works while
  // skipping the code that reaches it in production, which is the divergence this tier exists to
  // close.
  const admin = await connectDriver(stack, { scope: universe, email: person });
  try {
    await admin.client.scopes.delete(universe);
  } finally {
    admin.dispose();
  }

  // ── The property: a real 401 from a real server, for EVERY session ───────────────────────────
  // Reds against a revoke that misses any token — which is exactly what the blanket-vs-scoped
  // un-index bug produced: a live KV record with no index row, invisible to every future revoke.
  assert.equal(
    await refreshStatus(origin, universe, firstCookie), 401,
    'session 1 still refreshes after the revoke',
  );
  assert.equal(
    await refreshStatus(origin, universe, secondCookie), 401,
    'session 2 still refreshes after the revoke — the fan-out missed a token',
  );

  console.error('[revoke-is-total] two real sessions, both 401 after the revoke');
}
