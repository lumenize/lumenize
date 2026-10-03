/**
 * **Studio lists its app's tenants and deletes one, and only dominion over the app may.**
 *
 * An app's tenants are the Stars beneath its galaxy. Studio's app settings, opened at `?app`, list
 * them with a delete for each, behind a confirmation that never rides the URL. A deletion is a
 * facade call, refused before its Registry hop when the caller lacks dominion over the target.
 *
 * The cast: **O** signs up with an account and its first app. Two tenants each found a Star under
 * it. **P** is invited into the app as a plain member.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **The app's settings list its tenants.** O opens `?app` and sees both tenant Stars, and not
 *     the `.dev` workspace. *Reds if the list stops reading the galaxy's children.*
 *  2. **A tenant is deleted behind a confirmation the URL never carries.** O deletes the first; the
 *     confirmation opens without changing the address, and after it the tenant is gone and the
 *     other remains. *Reds if the delete stops reaching the facade.*
 *  3. **A caller without dominion is refused by the facade.** P, a plain member of the app, asks
 *     to delete the remaining tenant and is refused with the facade's own message. *Reds if the
 *     facade's pre-check is dropped — the refusal is then the Registry's.*
 *
 * `needsContainer = false` — auth, the facade and Studio's shell only.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { connectDriver, inviteViaMesh, readDevVar } from '../lib/harness';
import { launchChromium, bootStudioVite, instrumentedPage, signUpInBrowser } from '../lib/browser';
import {
  foundTenantStar, consumeLink, setCookieHeaders, refreshTokenForScope, refreshAccessToken,
} from '../../test/lib/email-login';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = `as${crypto.randomUUID().slice(0, 8)}`;
  const galaxy = `${universe}.crm`;
  const [t1, t2] = [`${galaxy}.t1`, `${galaxy}.t2`];
  const o = uniqueTestEmail();

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  const origin = vite.viteBaseUrl;
  const studio = vite.scopeUrl(galaxy);
  try {
    const x = await instrumentedPage(browser);
    const { page } = x;
    await signUpInBrowser(x, origin, { universe, appSlug: 'crm', email: o, nickname: 'Oh', testToken });
    for (const star of [t1, t2]) {
      assert.ok(await foundTenantStar({ baseUrl: origin, star, testToken }), `${star} could not be founded`);
    }

    // ── LIMB 1: the app's settings list its tenants ────────────────────────────────────────────
    await page.goto(`${studio}/?app`, { waitUntil: 'domcontentloaded' });
    const tenant = (scope: string) => page.locator(`[data-testid="app-tenant"][data-scope="${scope}"]`);
    await tenant(t1).waitFor({ state: 'visible', timeout: 30_000 });
    await tenant(t2).waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await tenant(`${galaxy}.dev`).count(), 0, "the .dev workspace is not a tenant to delete");
    console.error("  ✓ limb 1 — the app's settings listed both tenant Stars, not the .dev workspace");

    // ── LIMB 2: a tenant is deleted behind a confirmation the URL never carries ────────────────
    const address = page.url();
    await tenant(t1).getByTestId('app-tenant-delete').click();
    await page.getByTestId('confirm-delete').waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(page.url(), address, 'a confirmation must not ride the URL');
    await page.getByTestId('confirm-delete-go').click();
    await tenant(t1).waitFor({ state: 'detached', timeout: 60_000 });
    assert.equal(await tenant(t2).count(), 1, 'deleting one tenant must leave the other');
    console.error('  ✓ limb 2 — the confirmation left the URL alone, and the tenant was deleted');

    // ── LIMB 3: a caller without dominion is refused by the facade ─────────────────────────────
    const atO = await page.evaluate(async (refresh) =>
      await (await fetch(refresh, { method: 'POST', credentials: 'include' })).json() as { access_token: string; sub: string },
    `${origin}/auth/refresh-token`);
    const p = uniqueTestEmail();
    const waiter = waitForEmail({ testToken, to: p, timeout: 120_000 });
    let link: string;
    try {
      await inviteViaMesh(stack, { accessToken: atO.access_token, sub: atO.sub }, galaxy, [{ email: p }], 'Oh',
        { scopeUrl: vite.scopeUrl, platformOrigin: origin });
      const mail = await waiter.emailPromise;
      link = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(mail.html ?? '')?.[1]?.replace(/&amp;/g, '&') ?? extractMagicLink(mail);
    } finally {
      waiter.cleanup();
    }
    const consumed = await consumeLink(link, fetch, { nickname: 'Pea' });
    const cookie = refreshTokenForScope(setCookieHeaders(consumed), galaxy);
    assert.ok(cookie, "P's Accept must set the app membership's cookie");
    const atP = await refreshAccessToken(origin, { refreshToken: cookie!, authScope: galaxy }, galaxy);
    const pDriver = await connectDriver(stack, { scope: galaxy, session: atP });
    try {
      await assert.rejects(pDriver.client.scopes.delete(t2),
        (e: Error) => /^Deleting ".*" needs dominion over it, and the calling host's scope is /.test(e.message),
        "a plain member's delete must be refused by the facade's own pre-check");
    } finally {
      pDriver.dispose();
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await tenant(t2).waitFor({ state: 'visible', timeout: 30_000 });
    console.error("  ✓ limb 3 — P's delete was refused by the facade, and the tenant stayed");
  } finally {
    await browser.close();
    await vite.close();
  }
}
