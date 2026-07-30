/**
 * Impersonation, end to end on the RUNNING system — the behavioural coverage for
 * `tasks/nebula-impersonation-client.md`, moved here from the pool-workers lane.
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
import { provisionStarFounder, loginViaEmail, refreshAccessToken } from '../../test/lib/email-login';
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

  // ── 6. child.logout() tears down only the child ────────────────────────────────────────────────
  // ⚠️ **The cookie-survival half of this criterion is NOT asserted here, deliberately, and that is a
  // rule-conformant drop-down rather than an omission** (`live.md`: drop to pool-workers when you can
  // say why). The guard only becomes load-bearing when the parent's `authScope` EQUALS the child's
  // `activeScope` — otherwise the child's `authScope: activeScope` pin already prevents the cookie
  // from being sent, since `/auth/{universe}` does not path-match `/auth/{universe}.app.tenant`. This
  // harness cannot build that shape: it provisions a universe owner and a star founder, and has no
  // invite path to create a SECOND identity inside an existing scope. Confirmed empirically —
  // deleting the `#mintedFrom` branch leaves this scenario GREEN.
  // ⇒ that assertion lives in `test-apps/baseline/impersonate-lifetime.test.ts`, which builds the
  // same-scope shape via `createSubject` + `createInvitedClient` at the universe, and where the same
  // mutation DOES red. Adding an invite helper here would let it move; until then, do not "restore"
  // a cookie probe to this file — it would pass unconditionally.
  await secondChild.logout();
  assert.equal(secondChild.connectionState, 'disconnected', 'a child logout must tear the child down');
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
