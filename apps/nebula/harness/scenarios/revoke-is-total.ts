/**
 * A revoke stops a REAL session — proved against a real server, a real cookie jar, and no fixture.
 *
 * Two real email logins for one person (ADR-009 rung 1 throughout), then a scope deletion revokes
 * every refresh record anchored to them, then both cookies are presented to `POST /auth/refresh-token`
 * from the universe's page and must come back **401** from the running Worker.
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
 * **It asserts revocation within KV's propagation window, never at once.** The Registry deletes the
 * record from its own colo, which reads it gone at once; a page served from another colo keeps
 * reading its cached copy for up to about 60 s (`security.md` § *Refresh tokens*). On 2026-10-07 the
 * test zone's requests landed in Frankfurt, Madrid and Paris while the Registry sat elsewhere, and
 * an at-once assertion that had passed five sweeps failed four runs in four, turning 401 at 45 s.
 * A revoke that missed a token never turns 401, so the window still catches it.
 *
 * `needsContainer = false` — auth only, so the boot skips Docker.
 */
import assert from 'node:assert/strict';
import { uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { provisionAndLogin, loginViaEmail, refreshFromPage, refreshCookie } from '../../test/lib/email-login';

export const needsContainer = false;

/** KV's propagation window, about 60 s (`security.md` § *Refresh tokens*), with margin. */
const REVOKE_WINDOW_MS = 75_000;

/** Present a refresh cookie from `scope`'s page and report the status the running server returns. */
async function refreshStatus(origin: string, scope: string, refreshToken: string): Promise<number> {
  const res = await refreshFromPage(origin, scope, refreshCookie(scope, refreshToken));
  await res.text();
  return res.status;
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const universe = testSlug('revoke');
  const person = uniqueTestEmail();

  // ── Two real sessions, from two real letters ─────────────────────────────────────────────────
  // A link is spent by its page's button, so a second session is a second login: a fresh letter, a
  // fresh raw token, a fresh `RefreshTokenIndex` row, a fresh KV record — as a person signing in on
  // a second device does.
  const first = await provisionAndLogin({ baseUrl: origin, scope: universe, email: person, testToken });
  const firstCookie = first.session.refreshToken;
  assert.ok(firstCookie, 'the first login produced no refresh cookie');

  const second = await loginViaEmail({ baseUrl: origin, authScope: universe, email: person, testToken });
  const secondCookie = second.refreshToken;
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
    // The page's own scope goes, so its socket closes before the answer can arrive and the call
    // rejects with `HostDeletedError`: the delete happened, as Studio's confirmation reads it.
    await admin.client.scopes.delete(universe)
      .catch((e: Error) => { if (e.name !== 'HostDeletedError') throw e; });
  } finally {
    admin.dispose();
  }

  // ── The property: a real 401 from a real server, for EVERY session ───────────────────────────
  // Reds against a revoke that misses any token — which is exactly what the blanket-vs-scoped
  // un-index bug produced: a live KV record with no index row, invisible to every future revoke.
  // Within the propagation window, plus margin, since the page may not share the Registry's colo.
  // Both sessions against one clock, so neither gets a window of its own.
  const start = Date.now();
  let lagFirst: number | undefined;
  let lagSecond: number | undefined;
  while (Date.now() - start < REVOKE_WINDOW_MS && (lagFirst === undefined || lagSecond === undefined)) {
    if (lagFirst === undefined && await refreshStatus(origin, universe, firstCookie) === 401) lagFirst = Date.now() - start;
    if (lagSecond === undefined && await refreshStatus(origin, universe, secondCookie) === 401) lagSecond = Date.now() - start;
    if (lagFirst === undefined || lagSecond === undefined) await new Promise((r) => setTimeout(r, 2_000));
  }
  assert.ok(lagFirst !== undefined, `session 1 still refreshes ${REVOKE_WINDOW_MS / 1000} s after the revoke`);
  assert.ok(lagSecond !== undefined,
    `session 2 still refreshes ${REVOKE_WINDOW_MS / 1000} s after the revoke — the fan-out missed a token`);

  console.error(`[revoke-is-total] two real sessions, both 401 after the revoke (at ${lagFirst} ms and ${lagSecond} ms)`);
}
