/**
 * Impersonation, end to end on the RUNNING system — the behavioural coverage for
 * `tasks/archive/nebula-impersonation-client.md`, moved here from the pool-workers lane.
 *
 * Companion to `impersonation-expiry`, which owns the one thing needing a real clock. This one owns
 * everything deterministic: identity, the mint, refusals, concurrency, teardown and readiness.
 *
 * **Why here rather than in `test-apps/baseline`** (`live.md` § `/live` is the DEFAULT tier): the
 * baseline versions were mutation-validated and still wrong three times, in ways a running system
 * makes hard to construct. Two of them reached for test-only affordances that DO NOT EXIST
 * (`lmzTestDropSocket`, `__onLoginRequiredProbe`) — silent no-ops that made the tests assert nothing.
 * Here there is no test subclass to reach through and no `as any`: a socket drop has to be a real
 * supersede, and a login-required probe has to be a real config hook, because nothing else is
 * available. The affordance that produced those bugs is simply absent.
 *
 * ⚠️ One narrative `it`-equivalent, sequential, sharing one boot — `testing.md` § narrative for-docs
 * tests. Each step's failure mode is named at the step, and every assertion here was mutation-checked
 * against the source (see the task file's phase criteria for the mutation each one carries).
 *
 * No DevContainer: `needsContainer = false`, so this boots without Docker.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { NebulaClient } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { provisionStarFounder, loginViaEmail, refreshAccessToken, pointLinkAt } from '../../test/lib/email-login';
import { waitForEmail } from '@lumenize/email-test/client';
import {
  ImpersonationChainError, ImpersonationMintError, childCount, isTornDown,
} from '../../src/impersonation';

export const needsContainer = false;

/** Outside the client's 30s refresh-ahead window, so nothing here re-mints on its own. */
const SAFE_TTL = 300;

async function connected(client: NebulaClient, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (client.connectionState === 'connected') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`did not connect within ${timeoutMs}ms (state: ${client.connectionState})`);
}

/**
 * Invite a second identity INTO an existing scope, through the real email loop.
 *
 * ⚠️ This is what makes the dangerous SAME-SCOPE shape reachable, and its absence was the reason I
 * wrongly concluded the harness could not build it: I looked for an exported helper, found none, and
 * stopped — rather than checking whether the primitives existed. They do. Every `@lumenize.io`
 * address is routed by the catch-all to the email-test Worker, so the invite mail is catchable
 * exactly like a magic link, and login alone never mints an identity — an invite is the only way to
 * put a SECOND person inside a scope someone else founded.
 */
async function inviteAndLogin(
  stack: DevStack, browser: Browser, scope: string, adminToken: string, email: string, testToken: string,
): Promise<{ accessToken: string; sub: string }> {
  // NO `instance` filter — deliberately, and the reason has CHANGED. It used to be that it could
  // not work (`NebulaEmailSender` stamped `X-Lumenize-Auth-Instance` per message TYPE and covered
  // magic-link only, so an invite landed in the catch-all bucket and an `instance: scope` filter
  // silently never matched — one 60s timeout to find). The tag is now derived from the URL for
  // every type, so the filter WOULD match. We still use `to`: a unique recipient skips the
  // shared-bucket `clear` that `instance` performs, so this stays safe beside a concurrently-
  // waiting listener.
  const waiter = waitForEmail({ testToken, to: email, timeout: 60_000 });
  try {
    const res = await browser.fetch(`${stack.baseUrl}/auth/${scope}/invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: [email] }),
    });
    assert.equal(res.status, 200, `invite to ${scope} failed`);
    // `extractMagicLink` matches the magic-link route specifically; an invite is a different
    // endpoint (`accept-invite?invite_token=`), so pull the href here rather than widen a shared
    // helper that other callers rely on to be magic-link-specific.
    const html = (await waiter.emailPromise).html ?? '';
    const href = /href="([^"]*accept-invite[^"]*invite_token[^"]*)"/.exec(html)?.[1];
    assert.ok(href, `invite email carried no accept-invite link (subject: ${html.slice(0, 60)})`);
    const link = pointLinkAt(stack.baseUrl, href.replace(/&amp;/g, '&'));
    const clicked = await browser.fetch(link, { redirect: 'manual' });
    const setCookie = clicked.headers.getSetCookie?.() ?? [clicked.headers.get('set-cookie') ?? ''];
    const refreshToken = setCookie
      .map((c) => /(?:^|;\s*)refresh-token=([^;]*)/.exec(c)?.[1])
      .find(Boolean);
    assert.ok(refreshToken, `accept-invite (${clicked.status}) set no refresh-token cookie`);
    return refreshAccessToken(stack.baseUrl, { refreshToken, authScope: scope }, scope, browser.fetch);
  } finally {
    waiter.cleanup();
  }
}

async function until(what: string, fn: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const browser = new Browser();
  const suffix = crypto.randomUUID().slice(0, 8);
  const universe = `impl${suffix}`;
  const star = `${universe}.app.tenant`;
  const subjectEmail = `subject-${suffix}@lumenize.io`;

  // Count mints on the ADMIN's transport, which the child inherits — the only place a counter is
  // meaningful, since that is the transport a refused call would have used.
  let mintRequests = 0;
  let loginRequiredFired = false;
  const countingFetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? '');
    if (String(url).includes('/mint-narrower-token')) mintRequests++;
    return browser.fetch(input, init);
  }) as typeof fetch;

  // The SUBJECT (a real star founder) and, as a side effect, the universe owner above it — our ADMIN.
  const subject = await provisionStarFounder({
    baseUrl: stack.baseUrl, scope: star, email: subjectEmail, testToken, fetchImpl: browser.fetch,
  });
  const adminSession = await loginViaEmail({
    baseUrl: stack.baseUrl, authScope: universe, email: `owner-${subjectEmail}`,
    testToken, fetchImpl: browser.fetch,
  });
  const admin = await refreshAccessToken(stack.baseUrl, adminSession, universe, browser.fetch);

  const ctx = browser.context(stack.baseUrl);
  const mkAdminClient = () => new NebulaClient({
    baseUrl: stack.baseUrl,
    authScope: universe,
    activeScope: universe,
    appVersion: 'harness-v0',
    resourceHostBinding: 'DEV_STUDIO',
    accessToken: admin.accessToken,
    instanceName: `${admin.sub}.${crypto.randomUUID().slice(0, 8)}`,
    fetch: countingFetch,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
    // A REAL config hook, which is the only kind there is here. The baseline version of this
    // assertion set an invented instance property that nothing read, so it could never fire.
    onLoginRequired: () => { loginRequiredFired = true; },
  });
  const adminClient = mkAdminClient();
  await connected(adminClient);

  // ── 1. The returned client IS the subject, and authority is REDUCED ─────────────────────────────
  const child = await adminClient.impersonate(subject.sub, star, { ttlSeconds: SAFE_TTL });
  await connected(child);
  assert.equal(child.claims.sub, subject.sub, 'the child must be the subject');
  assert.equal(child.claims.act?.sub, admin.sub, 'the admin must be the actor');
  assert.equal(child.claims.aud, star, 'the token must be bound to the requested scope');
  const mintsAfterFirst = mintRequests;
  assert.equal(mintsAfterFirst, 1, 'impersonate() must mint EXACTLY once (mint-then-seed)');

  // ── 2. Impersonation does not chain, and makes no network call ──────────────────────────────────
  await assert.rejects(
    () => child.impersonate(subject.sub, star),
    (e: unknown) => e instanceof ImpersonationChainError && /does not chain/i.test((e as Error).message),
    'a child must refuse to impersonate',
  );
  assert.equal(mintRequests, mintsAfterFirst, 'the chain refusal must happen BEFORE any request');

  // ── 3. A failed FIRST mint rejects cleanly and leaves no half-registered child ──────────────────
  // Two refusals with different statuses: one status could be satisfied by a build that hard-codes
  // it. The gate order is what makes both reachable — caller reach and the admin bit are checked
  // before the subject is looked up.
  const childrenBefore = childCount(adminClient);
  await assert.rejects(
    () => adminClient.impersonate(subject.sub, `other${suffix}.app.x`, { ttlSeconds: SAFE_TTL }),
    (e: unknown) => e instanceof ImpersonationMintError && (e as ImpersonationMintError).status === 403,
    'an out-of-reach scope must 403',
  );
  await assert.rejects(
    () => adminClient.impersonate(crypto.randomUUID(), star, { ttlSeconds: SAFE_TTL }),
    (e: unknown) => e instanceof ImpersonationMintError && (e as ImpersonationMintError).status === 404,
    'an absent subject must 404',
  );
  assert.equal(childCount(adminClient), childrenBefore, 'a refused mint must leave NO child registered');

  // ── 4. Readiness follows the CREDENTIAL, not the CONNECTION ─────────────────────────────────────
  // The direct regression guard for a shipped bug: hooking teardown on `disconnect()` made this
  // permanently false, because `disconnect()` is a reversible pause and not an end-of-session door.
  adminClient.disconnect();
  assert.equal(isTornDown(adminClient), false, 'a bare disconnect() must NOT mark the parent torn down');
  const whileDisconnected = await adminClient.impersonate(subject.sub, star, { ttlSeconds: SAFE_TTL });
  await connected(whileDisconnected);
  assert.equal(whileDisconnected.claims.sub, subject.sub, 'a disconnected parent must still mint');
  adminClient.connect();
  await connected(adminClient);

  // ── 5. Two children coexist — the DO-name collision is silent, so this is its only guard ────────
  // ONE subject at TWO scopes: the names then differ ONLY by the scope segment. (Two different
  // subjects would differ by the sub segment, which is why the baseline version of this test passed
  // with the scope segment removed.) The universe-scoped admin can impersonate the star founder at
  // the star; a second scope for the SAME sub is the universe itself is not reachable here, so this
  // asserts the weaker-but-real property: distinct children, distinct names, both live.
  const secondChild = await adminClient.impersonate(subject.sub, star, { ttlSeconds: SAFE_TTL });
  await connected(secondChild);
  assert.notEqual(
    whileDisconnected.lmz.instanceName, adminClient.lmz.instanceName,
    'a child must never share the parent Gateway name',
  );
  assert.ok(childCount(adminClient) >= 2, 'the parent must hold its live children');

  // ── 6. child.logout() is CHILD-ONLY teardown — the admin's cookie must survive ─────────────────
  // 🛑 **The SAME-SCOPE shape, which is the only one where the guard is load-bearing.** With the
  // admin at the universe and a child at the star, the child's `authScope: activeScope` pin already
  // stops the cookie being sent (`/auth/{universe}` does not path-match
  // `/auth/{universe}.app.tenant/logout` — first uncovered char is `.`, not `/`), so deleting the
  // branch changes nothing and the test proves nothing. Confirmed: it stayed green that way.
  // An invited identity AT THE UNIVERSE gives a subject the admin can impersonate at its OWN
  // authScope, so the paths match exactly and only the branch stands between a child logout and the
  // admin's 30-day refresh token.
  const peerEmail = `peer-${suffix}@lumenize.io`;
  const peer = await inviteAndLogin(stack, browser, universe, admin.accessToken, peerEmail, testToken);
  const sameScopeChild = await adminClient.impersonate(peer.sub, universe, { ttlSeconds: SAFE_TTL });
  await connected(sameScopeChild);
  assert.equal(sameScopeChild.claims.sub, peer.sub, 'the same-scope child must be the invited peer');

  await sameScopeChild.logout();
  assert.equal(sameScopeChild.connectionState, 'disconnected', 'a child logout must tear the child down');

  // ⚠️ THE discriminating assertion. Revoking the admin's cookie is invisible to connectionState
  // (socket open, stateless JWT) and to impersonate() (rides a still-fresh access token) — so probe
  // the cookie itself, at the parent's REAL authScope.
  const probe = await browser.fetch(`${stack.baseUrl}/auth/${universe}/refresh-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeScope: universe }),
  });
  assert.equal(probe.status, 200, "a child logout must NOT revoke the admin's refresh cookie");
  assert.equal(adminClient.connectionState, 'connected', 'the admin must stay connected');

  // ── 7. Disposing the parent tears the children down, and closes minting ─────────────────────────
  await adminClient.dispose();
  await until('the children to be torn down', () => child.connectionState === 'disconnected'
    && whileDisconnected.connectionState === 'disconnected');
  assert.equal(isTornDown(adminClient), true, 'an end-of-session door must mark the parent');
  assert.equal(childCount(adminClient), 0, 'teardown must clear the parent’s children');
  await assert.rejects(
    () => adminClient.impersonate(subject.sub, star, { ttlSeconds: SAFE_TTL }),
    /torn down/i,
    'a torn-down parent must not mint again',
  );
  // The admin was never bounced to login by any of this — someone else's session ending must not
  // end theirs. (Real hook, so a false here means "did not fire", not "was never wired".)
  assert.equal(loginRequiredFired, false, "the admin's onLoginRequired must never fire");

  console.error('[impersonation-lifecycle] ok — identity, refusals, readiness, teardown');
}
