/**
 * **Logging out everywhere ends a session on a device this browser never saw, and records whose.**
 *
 * One logout route ends every cookie the browser presents; with `everywhere`, it ends every session
 * of each address those cookies name, wherever it was opened. A person reaches it from Studio's
 * Profile page, whose link opens the platform host's logout page with that option already chosen.
 *
 * The cast: **E** signs up in browser P, and signs in again in a second browser, Q, as one person
 * does on a laptop and a phone.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **The Profile page's link opens the logout page with every device chosen.** *Reds if the link
 *     drops the preselection.*
 *  2. **Q's session ends when P logs out everywhere.** Q's refresh answered 200 before; after P's
 *     logout it answers 401. *Reds if the logout ends only the asking browser's cookies.*
 *  3. **The logout records whose sessions ended.** Its revocation lines, read by the logout's own
 *     id, name E's `sub` with the reason `logout-everywhere`. *Reds if the revocation is batched
 *     with no subject.*
 *
 * Limb 3 reads the stack's stdio, which a deployed target does not capture; it says so there.
 *
 * `needsContainer = false` — auth, Studio's shell and the logout page only.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { Page } from 'playwright';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { launchChromium, bootStudioVite, instrumentedPage, signUpInBrowser } from '../lib/browser';
import { waitForDebugLines, type DebugLine } from '../lib/stdio';

export const needsContainer = false;
export const bootVars = { DEBUG: 'nebula-auth.worker.logout,nebula-auth.Registry.token.revoked' };

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const observable = stack.logs !== undefined;
  const universe = testSlug('le');
  const studioScope = `${universe}.crm`;
  const e = uniqueTestEmail();

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  const origin = vite.viteBaseUrl;
  const studio = vite.scopeUrl(studioScope);
  /** A page's own refresh, on the platform host, as its client sends it. */
  const refreshFrom = (page: Page) => page.evaluate(async (refresh) => {
    const res = await fetch(refresh, { method: 'POST', credentials: 'include' });
    return { status: res.status, sub: res.ok ? (await res.json() as { sub: string }).sub : undefined };
  }, `${origin}/auth/refresh-token`);
  try {
    // E signs up in P and lands in Studio.
    const p = await instrumentedPage(browser);
    await signUpInBrowser(p, origin, { universe, appSlug: 'crm', email: e, nickname: 'Eve', testToken });

    // E signs in again in Q, through the login form and the emailed link's Continue.
    const q = await (await browser.newContext()).newPage();
    await q.goto(`${origin}/auth/login`, { waitUntil: 'domcontentloaded' });
    const waiter = waitForEmail({ testToken, to: e, timeout: 120_000 });
    let link: string;
    try {
      await q.getByPlaceholder('you@example.com').fill(e);
      await q.getByRole('button', { name: /Email me a link/ }).click();
      await q.getByText(/Check your email/).waitFor({ state: 'visible', timeout: 30_000 });
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    await q.goto(link, { waitUntil: 'domcontentloaded' });
    await q.getByTestId('link-continue').click();
    await q.waitForURL((u) => u.origin !== origin || u.pathname !== '/auth/magic-link', { timeout: 30_000 });
    await q.goto(`${studio}/`, { waitUntil: 'domcontentloaded' });
    const before = await refreshFrom(q);
    assert.equal(before.status, 200, "Q's session must mint before the logout — the positive control");
    const eSub = before.sub!;

    // ── LIMB 1: the Profile page's link opens the logout page with every device chosen ─────────
    await p.page.goto(`${studio}/?profile`, { waitUntil: 'domcontentloaded' });
    await p.page.getByTestId('profile-logout-everywhere').click();
    await p.page.waitForURL((u) => u.origin === origin && u.pathname === '/auth/logout', { timeout: 30_000 });
    assert.equal(await p.page.getByTestId('logout-everywhere').isChecked(), true,
      "the Profile page's link must open the logout page with every device chosen");
    console.error("  ✓ limb 1 — the Profile page's link opened the logout page with every device chosen");

    // ── LIMB 2: Q's session ends when P logs out everywhere ────────────────────────────────────
    await p.page.getByTestId('logout-confirm').click();
    await p.page.waitForURL((u) => u.origin === origin && u.pathname === '/auth/login', { timeout: 30_000 });
    assert.equal((await refreshFrom(q)).status, 401, "Q's session must end when P logs out on every device");
    console.error("  ✓ limb 2 — P's logout everywhere ended the session Q held");

    // ── LIMB 3: the logout records whose sessions ended ────────────────────────────────────────
    if (observable) {
      const isDone = (x: DebugLine) => x.namespace === 'nebula-auth.worker.logout' && x.message === 'logged out';
      const all = await waitForDebugLines(stack, (lines) => lines.some(isDone), "E's logout completion line");
      const done = all.find(isDone)!;
      assert.equal(done.data.everywhere, true, 'the logout must have ended every device');
      const named = all.filter((x) => x.namespace === 'nebula-auth.Registry.token.revoked' && x.data.operationId === done.data.operationId)
        .map((x) => `${x.data.subjectSub}:${x.data.reason}`);
      assert.ok(named.includes(`${eSub}:logout-everywhere`),
        `the logout's revocations must name E's sub, reason logout-everywhere: ${JSON.stringify(named)}`);
      console.error("  ✓ limb 3 — the logout's revocations named E's sub, reason logout-everywhere");
    } else {
      console.error('[logout-everywhere] limb 3: not observable on a deployed target');
    }
  } finally {
    await browser.close();
    await vite.close();
  }
}
