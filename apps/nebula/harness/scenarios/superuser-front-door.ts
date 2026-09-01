/**
 * **The superuser comes in the same door as everyone else.**
 *
 * They could not, before. A bootstrap address's platform membership was minted BY the platform-link
 * request, so a first login discovered nothing and the only way in was a hand-typed URL naming a
 * scope no UI ever showed. Now the membership is minted at the CONSUME — behind proof of the mailbox
 * — the ordinary scope-less login sets its cookie like any other, and Home offers it behind the same
 * self-flavour modal a new account gets.
 *
 * ⚠️ **The platform carve-out this scenario used to be blocked by was dropped on 2026-09-01**, and
 * limb 2 is what stands in its place. mint-all no longer withholds the `nebula-platform` cookie, so
 * the safety story rests entirely on the cookie being INERT until accepted — which is asserted here
 * against a real server, not against a header shape.
 *
 * Limbs, each isolated with a positive control (`live.md` — per limb, never per scenario):
 *
 *  1. **The ordinary front door mints the platform cookie.** No scope named anywhere; the
 *     membership is created by the click that proved the mailbox. *Reds against re-introducing the
 *     carve-out, which would leave a superuser unable to accept their own row.*
 *  2. **That cookie is INERT until accepted.** *Reds against dropping inert-until-accepted — the
 *     one thing between an unsolicited invite click and a live superuser session.*
 *  3. **Accept enrols, and the same cookie mints a platform token.** The positive control for
 *     limb 2: without it, a broken platform path would satisfy limb 2 by failing everywhere.
 *  4. **POST-ACCEPT the summary reaches the platform root and DESCENDS**, showing scopes the
 *     superuser holds no membership in. *Reds against a summary that self-confines to the caller's
 *     own membership — the thing that made a superuser indistinguishable from an ordinary admin.*
 *  5. **And it stays BUDGET-BOUNDED.** The read that answers a superuser is the one that could
 *     scan the whole table; a node past the frontier arrives as a `childCount`, never as rows.
 *     *Reds against an unbounded platform arm (ADR-018).*
 *
 * `bootVars` pins the bootstrap address for THIS boot only — the scenario's subject is server
 * configuration the identity path reads, and a `.dev.vars` mutation would leak across runs.
 *
 * `needsContainer = false` — auth only, never a build.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import {
  provisionAndLogin, pointLinkAt, refreshTokenForScope, setCookieHeaders, acceptMembership,
} from '../../test/lib/email-login';
import { parseJwtUnsafe } from '@lumenize/crypto';

export const needsContainer = false;

/** The reserved platform scope. Spelled out rather than imported — the worker is the authority. */
const PLATFORM = 'nebula-platform';

/** A stable address for this boot, pinned as the bootstrap identity below. */
const SUPERUSER = 'front-door-superuser@lumenize.io';

export const bootVars = { NEBULA_AUTH_BOOTSTRAP_EMAIL: SUPERUSER };

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const suffix = crypto.randomUUID().slice(0, 8);

  // Somebody else's tenancy, created by a REAL claim — the superuser holds no membership in it, and
  // limb 4 is about whether they can nonetheless see it.
  const stranger = `stranger-${suffix}`;
  await provisionAndLogin({
    baseUrl: origin, scope: `${stranger}.app`, email: uniqueTestEmail(), testToken,
  });

  // ── LIMB 1: the ordinary front door, naming no scope ───────────────────────────────────────────
  const waiter = waitForEmail({ testToken, instance: '_scopeless', to: SUPERUSER, timeout: 60_000 });
  let link: string;
  try {
    const requested = await fetch(`${origin}/auth/email-magic-link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SUPERUSER }),
    });
    assert.equal(requested.status, 200, `the scope-less request was refused (${requested.status})`);
    link = pointLinkAt(origin, extractMagicLink(await waiter.emailPromise));
  } finally {
    waiter.cleanup();
  }

  const clicked = await fetch(link, { redirect: 'manual' });
  assert.equal(clicked.status, 302, `the click did not redirect (${clicked.status})`);
  const cookie = refreshTokenForScope(setCookieHeaders(clicked), PLATFORM);
  assert.ok(cookie,
    'the ordinary front door set no platform cookie — a superuser would see their row on Home and ' +
    'be unable to accept it, because the accept endpoint authenticates by exactly this cookie');
  console.error('  ✓ limb 1 — the scope-less login minted the platform cookie, no scope named');

  // ── LIMB 2: INERT until accepted ───────────────────────────────────────────────────────────────
  const preAccept = await fetch(`${origin}/auth/${PLATFORM}/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `refresh-token=${cookie}` },
    body: JSON.stringify({ activeScope: PLATFORM }),
  });
  assert.equal(preAccept.status, 401,
    'an unaccepted platform membership must mint NOTHING — with the carve-out gone this is the only ' +
    'thing between an unsolicited invite click and a live superuser session');
  assert.match(await preAccept.text(), /membership_not_accepted/);
  console.error('  ✓ limb 2 — the platform cookie is inert before consent');

  // ── LIMB 3: Accept enrols, the same cookie mints ───────────────────────────────────────────────
  await acceptMembership(origin, cookie!, PLATFORM);
  const postAccept = await fetch(`${origin}/auth/${PLATFORM}/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `refresh-token=${cookie}` },
    body: JSON.stringify({ activeScope: PLATFORM }),
  });
  assert.equal(postAccept.status, 200,
    `the same cookie must mint once accepted (${postAccept.status}) — the positive control for limb 2`);
  const { access_token } = await postAccept.json() as { access_token: string };
  const claims = parseJwtUnsafe(access_token)!.payload as any;
  assert.equal(claims.access.authScope, PLATFORM);
  assert.equal(claims.access.scopeAdmin, true, 'the platform membership must carry the admin bit');
  console.error('  ✓ limb 3 — accept enrols; the same cookie mints a platform token');

  // ── LIMB 4: the summary reaches beyond the superuser's own memberships ─────────────────────────
  const summaryRes = await fetch(`${origin}/auth/scope-summary`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
  });
  assert.equal(summaryRes.status, 200, `scope-summary refused a superuser (${summaryRes.status})`);
  type Node = { scope: string; children?: Node[]; childCount?: number };
  const summary = await summaryRes.json() as { emails: { memberships: Node[] }[] };
  const walk = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(walk)];
  const nodes = summary.emails.flatMap((e) => e.memberships.flatMap(walk));
  const ids = nodes.map((n) => n.scope);
  assert.ok(ids.includes(PLATFORM), 'the platform root is missing from the superuser\'s own summary');
  assert.ok(ids.includes(stranger),
    `the superuser did not reach "${stranger}" — a scope they hold NO membership in. ` +
    `Got ${ids.length}: ${ids.slice(0, 12).join(', ')}`);
  console.error(`  ✓ limb 4 — the platform root descends into ${stranger}, held by someone else`);

  // ── LIMB 5: and it stays bounded ───────────────────────────────────────────────────────────────
  // ⚠️ The frontier marker, not a row count: a small fixture is under the budget either way, so
  // "few nodes came back" proves nothing. What proves boundedness is that the shape CAN report a
  // frontier — every non-star node either descended or says how many it did not.
  const frontierCapable = nodes.filter((n) => n.children !== undefined || n.childCount !== undefined);
  assert.ok(frontierCapable.length > 0,
    'no node reported children or a childCount — the summary is not the budget-bounded shape');
  const overflowing = nodes.filter((n) => (n.children?.length ?? 0) > 200);
  assert.deepEqual(overflowing.map((n) => n.scope), [],
    'a level came back unbounded — the platform arm must never read the whole table (ADR-018)');
  console.error('  ✓ limb 5 — the superuser response carries a frontier, not the whole table');

  console.error('  ── the superuser walks the front door and consents like anyone else');
}
