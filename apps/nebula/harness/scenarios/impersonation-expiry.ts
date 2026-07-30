/**
 * Impersonation across a REAL token expiry, on a real clock and a real server.
 *
 * **Why this belongs in `/live` and not the baseline lane.** Everything deterministic about
 * `impersonate()` — the naming rule, the registry, the chain refusal, the cascade, two children
 * coexisting — is already covered in `test/test-apps/baseline/impersonate*.test.ts`, faster and in
 * CI. What that lane's re-mint tests actually do is lean on a sub-30s token being *born* inside the
 * client's refresh-ahead window: a real trigger, but a contrived one that proves the re-mint path
 * runs rather than that a session survives its token lapsing.
 *
 * ⚠️ **This header used to say pool-workers "cannot let time pass". THAT IS FALSE — measured, not
 * assumed (2026-07-30, `packages/nebula-auth`).** `vi.useFakeTimers({ shouldAdvanceTime: true })` +
 * `vi.setSystemTime(+1 day)` moves the clock the **Worker** sees: a subsequent `/refresh-token` mint
 * came back with `iat` advanced ~86400s, and a token minted `ttlSeconds: 60` then used ten (fake)
 * minutes later got a **401** — with a no-jump control on the identical request returning something
 * other than 401, so the 401 is the expiry and not the deliberately-bogus subject in the body.
 * The **DO** isolate follows it too — a magic link consumed past `MAGIC_LINK_TTL` (computed and
 * gated inside the registry DO) is rejected, with an un-jumped control accepted. So the technique
 * reaches both isolates, not just the Worker where the JWT verify lives.
 *
 * ⇒ **The honest justification is fidelity, not capability.** A fake clock proves the server rejects
 * an `exp` it computes against a patched `Date`; this proves a session survives a lapse against a
 * clock nobody patched, through a real socket and a real cookie jar. Both mutations produced a real
 * 401 from a real server. Keep the claim on that ground — and the corollary the false version was
 * suppressing is now BUILT: `impersonate-lifetime.test.ts` § *survives a GENUINE expiry* drives a
 * real lapse in-lane. Its jump is load-bearing, not decorative — removing it reds the test (one mint
 * instead of two), which is the check that separates this from a fixture shaped to stay green.
 *
 * ⚠️ **The task file deferred `/live` for the wrong reason, and this scenario is the correction.**
 * It reasoned that rung 1 "adds only the email transport, which nothing asserted here depends on" —
 * true, and beside the point. `/live`'s value here is a different axis: a real `workerd` runtime and
 * a real clock. Rung 1 comes along for free.
 *
 * **A second thing it proves for free:** this file runs under Node via `tsx`, and it imports
 * `NebulaClient`, which imports `apps/nebula/src/impersonation.ts`. Nothing else loads that module
 * outside workerd, so its Node-safety — the property that decided against a client-side
 * `debug.warn` importing `@lumenize/nebula-auth`'s barrel — is otherwise asserted only by reasoning.
 * If this scenario boots at all, that property holds.
 *
 * No DevContainer: `needsContainer = false`, so this boots without Docker.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { NebulaClient } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { provisionStarFounder, loginViaEmail, refreshAccessToken } from '../../test/lib/email-login';

/** This scenario never drives a build, so it does not need the container — or Docker. */
export const needsContainer = false;

/**
 * Short enough that the wait is tolerable, comfortably ABOVE the client's 30s refresh-ahead window
 * so the token is NOT born already due — the whole point is that it lapses on a real clock rather
 * than being due at birth.
 */
const TTL_SECONDS = 45;

async function waitForConnected(client: NebulaClient, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (client.connectionState === 'connected') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`client did not connect within ${timeoutMs}ms (state: ${client.connectionState})`);
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const browser = new Browser();
  const suffix = crypto.randomUUID().slice(0, 8);
  const universe = `imp${suffix}`;
  const star = `${universe}.app.tenant`;
  const subjectEmail = `subject-${suffix}@lumenize.io`;

  // The SUBJECT: a real star founder, reached through the open claim-star path. As a side effect this
  // provisions the universe + galaxy above, owned by a DIFFERENT identity — `owner-<email>` — which
  // is precisely the admin we need, and why the two are created in this order.
  const subject = await provisionStarFounder({
    baseUrl: stack.baseUrl, scope: star, email: subjectEmail, testToken, fetchImpl: browser.fetch,
  });

  // The ADMIN: log that universe owner in. A plain login, NOT provisionAndLogin — the universe is
  // already claimed, and claiming is the one open founder-minting entry, so re-provisioning would
  // fail rather than re-authenticate.
  const adminSession = await loginViaEmail({
    baseUrl: stack.baseUrl, authScope: universe, email: `owner-${subjectEmail}`,
    testToken, fetchImpl: browser.fetch,
  });
  const admin = await refreshAccessToken(stack.baseUrl, adminSession, universe, browser.fetch);

  const ctx = browser.context(stack.baseUrl);
  const adminClient = new NebulaClient({
    baseUrl: stack.baseUrl,
    authScope: universe,
    activeScope: universe,
    appVersion: 'harness-v0',
    resourceHostBinding: 'DEV_STUDIO',
    accessToken: admin.accessToken,
    instanceName: `${admin.sub}.${crypto.randomUUID().slice(0, 8)}`,
    fetch: browser.fetch,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
  });
  await waitForConnected(adminClient);

  // ── The impersonation, through the production capability ────────────────────────────────────────
  const child = await adminClient.impersonate(subject.sub, star, { ttlSeconds: TTL_SECONDS });
  await waitForConnected(child);

  assert.equal(child.claims.sub, subject.sub, 'the child must BE the subject');
  assert.equal(child.claims.act?.sub, admin.sub, 'the admin must be the actor');
  const firstExp = (child.claims as unknown as { exp: number }).exp;
  const firstIat = (child.claims as unknown as { iat: number }).iat;
  assert.equal(firstExp - firstIat, TTL_SECONDS, 'ttlSeconds must round-trip through the mint');

  // ── The part only a real clock can do ───────────────────────────────────────────────────────────
  // Wait until the ORIGINAL token is genuinely past expiry, then drive an operation. A session that
  // merely held its first token would now be dead; one that re-minted through its parent is alive
  // with a LATER `exp`.
  const waitMs = (TTL_SECONDS + 5) * 1000;
  console.error(`[impersonation-expiry] waiting ${waitMs / 1000}s for the child's token to lapse…`);
  await new Promise((r) => setTimeout(r, waitMs));

  const nowSeconds = Math.floor(Date.now() / 1000);
  assert.ok(firstExp < nowSeconds, `fixture guard: the first token must really be expired (exp ${firstExp} < now ${nowSeconds})`);

  // Any operation forces the client through its refresh path, which is the mint helper.
  const scopes = await child.scopes.list();
  assert.ok(Array.isArray(scopes), 'the child must still be able to act after its token lapsed');

  // ⚠️ THE assertion. `exp` ADVANCING proves a re-mint actually happened rather than a cached token
  // being reused, and `sub` holding proves the re-mint went through the parent's mint helper and NOT
  // the cookie path — the identity-swap hazard this whole task exists to close, now demonstrated
  // across a real lapse instead of a contrived one.
  const secondExp = (child.claims as unknown as { exp: number }).exp;
  assert.ok(secondExp > firstExp, `the child must have re-minted (exp ${firstExp} → ${secondExp})`);
  assert.equal(child.claims.sub, subject.sub, 'a re-mint must NEVER change who the child is');
  assert.equal(child.claims.act?.sub, admin.sub, 'the actor must survive the re-mint');

  // Ending the admin's session ends impersonation — on a real runtime, not a simulated teardown.
  await adminClient.dispose();
  assert.equal(child.connectionState, 'disconnected', 'disposing the parent must tear the child down');

  console.error('[impersonation-expiry] ok — re-mint across a real expiry, identity preserved');
}
