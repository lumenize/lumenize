/**
 * **One email, two scopes — the dead end this whole design was built to delete.**
 *
 * Before the re-order, an address belonging to two scopes could not log in at all: the login form
 * asked `discover(email)` first, got two answers back, and had nowhere to go — the code literally
 * said "the picker is a later feature". The fix was not a picker bolted onto discovery; it was to
 * stop asking before anyone proves anything. One scope-less link, one click, and the browser ends up
 * holding a session for every membership the address has.
 *
 * ⚠️ **Only a real run can establish this.** In-lane the cookies are strings a test reads off a
 * header; here a real mailbox receives a real letter, a real click sets real cookies, and each one
 * is spent against a real server that decides on its own whether to mint. Rung 1 throughout — every
 * identity below was created by an actual claim-and-click, nothing is hand-minted.
 *
 * Four limbs, each with its own way to red (`live.md` — per limb, never per scenario):
 *
 *  1. **Two memberships exist, from two real claims.** The positive control for everything after
 *     it: without this the cookie assertions could pass on an address that has one membership and a
 *     duplicate cookie. *Reds if the second claim never lands.*
 *  2. **ONE click sets a cookie per membership.** Asserted as the exact SET of scopes, never a
 *     count — minting two cookies for the wrong two scopes would satisfy a length check.
 *     *Reds against minting only the link's own scope, which is the pre-mint-all behaviour.*
 *  3. **Each cookie independently mints a token for ITS scope**, against the running server.
 *     *Reds against a cookie that is set but dead — the failure a header-shape assertion cannot
 *     see, because the string is there either way.*
 *  4. **The summary the Home screen reads lists both.** *Reds against a summary keyed on the
 *     session's own scope rather than on the person.*
 *
 * `needsContainer = false` — auth only, never a build.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { provisionAndLogin, refreshTokenForScope, setCookieHeaders } from '../../test/lib/email-login';
import { parseJwtUnsafe } from '@lumenize/crypto';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const person = uniqueTestEmail();
  const suffix = crypto.randomUUID().slice(0, 8);
  const first = `two-a-${suffix}`;
  const second = `two-b-${suffix}`;

  // ── LIMB 1: two real memberships for ONE address ───────────────────────────────────────────────
  // Each is a full claim → real email → click → accept. Nothing is seeded.
  await provisionAndLogin({ baseUrl: origin, scope: first, email: person, testToken });
  await provisionAndLogin({ baseUrl: origin, scope: second, email: person, testToken });
  console.error(`  ✓ limb 1 — ${person} holds two real memberships (${first}, ${second})`);

  // ── LIMB 2: ONE scope-less link, one click, a cookie per membership ────────────────────────────
  // ⚠️ The waiter is tagged `_scopeless`: a request that names no scope cannot tag its mail with
  // one, and a waiter filtered on a universe would hang for its full timeout — which reads as a
  // slow boot rather than a wrong tag.
  const waiter = waitForEmail({ testToken, instance: '_scopeless', to: person, timeout: 60_000 });
  let link: string;
  try {
    const requested = await fetch(`${origin}/auth/email-magic-link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: person }),
    });
    assert.equal(requested.status, 200, `the scope-less request was refused (${requested.status})`);
    link = extractMagicLink(await waiter.emailPromise);
  } finally {
    waiter.cleanup();
  }

  const clicked = await fetch(link, { redirect: 'manual' });
  assert.equal(clicked.status, 302, `the click did not redirect (${clicked.status})`);
  const cookies = setCookieHeaders(clicked);
  const scopes = cookies
    .filter((c) => c.startsWith('refresh-token='))
    .map((c) => decodeURIComponent(/Path=([^;]+)/.exec(c)![1].split('/').pop()!))
    .sort();
  // ⚠️ The SET, not the count.
  assert.deepEqual(scopes, [first, second].sort(),
    `one click must set a cookie per membership; got [${scopes.join(', ')}]`);
  // And it landed on Home to choose, not inside either scope.
  assert.match(clicked.headers.get('Location') ?? '', /^\/auth\/[^/]+\/home$/,
    'the click must land on Home, never teleport into a scope');
  console.error('  ✓ limb 2 — one click, one cookie per membership, landing on Home');

  // ── LIMB 3: each cookie independently mints, against the running server ────────────────────────
  for (const scope of [first, second]) {
    const token = refreshTokenForScope(cookies, scope);
    assert.ok(token, `no cookie was set for "${scope}"`);
    const res = await fetch(`${origin}/auth/${scope}/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `refresh-token=${token}` },
      body: JSON.stringify({ activeScope: scope }),
    });
    assert.equal(res.status, 200,
      `the cookie for "${scope}" did not mint (${res.status}) — set but dead`);
    const { access_token } = await res.json() as { access_token: string };
    const claims = parseJwtUnsafe(access_token)!.payload as any;
    assert.equal(claims.access.authScope, scope,
      `the token minted at "${scope}" carries authScope "${claims.access.authScope}"`);
  }
  console.error('  ✓ limb 3 — BOTH cookies mint real tokens at their own scopes');

  // ── LIMB 4: the summary Home renders lists both ────────────────────────────────────────────────
  const anyToken = refreshTokenForScope(cookies, first)!;
  const mint = await fetch(`${origin}/auth/${first}/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `refresh-token=${anyToken}` },
    body: JSON.stringify({ activeScope: first }),
  });
  const { access_token } = await mint.json() as { access_token: string };
  const summaryRes = await fetch(`${origin}/auth/scope-summary`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
  });
  assert.equal(summaryRes.status, 200, `scope-summary refused (${summaryRes.status})`);
  const summary = await summaryRes.json() as { emails: { memberships: { scope: string }[] }[] };
  const listed = summary.emails.flatMap((e) => e.memberships.map((m) => m.scope)).sort();
  assert.deepEqual(listed, [first, second].sort(),
    `the summary must answer for the PERSON; got [${listed.join(', ')}]`);
  console.error('  ✓ limb 4 — the summary lists both memberships for the person');

  console.error('  ── one email, two scopes: the multi-membership dead end is gone');
}
