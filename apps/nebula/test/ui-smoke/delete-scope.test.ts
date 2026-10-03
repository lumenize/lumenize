/**
 * Apps and accounts, created and deleted from the pages that own them — the rendered half of
 * ADR-015's warn-don't-block deletion.
 *
 * Every action lives on the page that can perform it. An account's apps are listed, and created, on
 * the account's own page; an app is deleted from its Studio; an account from its page. Home only
 * links each to its host. Each delete stands behind a confirmation that never rides the URL, and
 * warns about the other people it removes without ever refusing over them.
 *
 * ⚠️ Why this must exist at the UI level, not as a registry test: `apps/nebula-studio-ui` has no
 * `vue-tsc`, so a stale field reference in a confirm handler reds in no gate, surfacing only as a
 * runtime `TypeError` on the confirm screen. A registry-only test passes while the button is dead.
 *
 * The cast: **O** owns account U and two others, so Home has a real choice to render rather than
 * stepping aside, even once U is gone. **G** is invited as an admin of one of U's apps and holds no
 * membership at U.
 * **P** is invited into that app as a plain member, so its delete has someone to warn about.
 *
 * Gated `describe.runIf(HAS_DOCKER)` — deliberately not `&& HAS_AI_PATH`: nothing here touches a
 * model. Run it with `npx vitest run --project ui-smoke`. It provisions its own accounts, so it never
 * touches the workspace the codegen smoke depends on.
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { waitForEmail, extractMagicLink, uniqueTestEmail } from '@lumenize/email-test/client';
import { HAS_DOCKER } from './gates';
import { launchChromium } from './helpers';
import { provisionAndLogin, scopeOriginFrom } from '../lib/email-login';
import { inviteViaMesh } from '../../harness/lib/harness';
// @ts-expect-error — plain JS with JSDoc types (no build in dev, workflow.md); shared with `npm run dev`.
import { LOCAL_ORIGIN } from '../../scripts/local-config.mjs';

const SUFFIX = crypto.randomUUID().slice(0, 8);
const U = `del${SUFFIX}`;
const U2 = `del${SUFFIX}b`;
const U3 = `del${SUFFIX}c`;
const O = uniqueTestEmail('owner');

describe.runIf(HAS_DOCKER)('Apps and accounts from the pages that own them (wrangler dev + Docker)', () => {
  let browser: Browser;
  let viteBaseUrl: string;
  let workerBaseUrl: string;
  let testToken: string;
  /** O's signed-in browser. */
  let owner: { ctx: BrowserContext; page: Page };
  const host = (scope: string) => scopeOriginFrom(viteBaseUrl, scope);

  /** The one link a send produces, armed before the send and filtered by its unique recipient. */
  async function letterTo(to: string, send: () => Promise<unknown>): Promise<string> {
    const waiter = waitForEmail({ testToken, to, timeout: 120_000 });
    try {
      await send();
      const mail = await waiter.emailPromise;
      const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(mail.html ?? '')?.[1];
      return href ? href.replace(/&amp;/g, '&') : extractMagicLink(mail);
    } finally {
      waiter.cleanup();
    }
  }

  /** A browser signed in as `email` through the login form and the emailed link's Continue. */
  async function signIn(email: string): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${viteBaseUrl}/auth/login`, { waitUntil: 'domcontentloaded' });
    const link = await letterTo(email, async () => {
      await page.getByPlaceholder('you@example.com').fill(email);
      await page.getByRole('button', { name: /Email me a link/ }).click();
      await page.getByText(/Check your email/).waitFor({ state: 'visible', timeout: 30_000 });
    });
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('link-continue').click();
    await page.waitForURL((u) => u.pathname !== '/auth/magic-link', { timeout: 30_000 });
    return { ctx, page };
  }

  /** Invite `email` into `scope` as O, and accept it through the invite's page in a fresh browser. */
  async function inviteAndAccept(email: string, scope: string, scopeAdmin: boolean): Promise<{ ctx: BrowserContext; page: Page }> {
    const at = await owner.page.evaluate(async (refresh) =>
      await (await fetch(refresh, { method: 'POST', credentials: 'include' })).json() as { access_token: string; sub: string },
    `${viteBaseUrl}/auth/refresh-token`);
    const link = await letterTo(email, () => inviteViaMesh(
      { baseUrl: workerBaseUrl, origin: LOCAL_ORIGIN }, { accessToken: at.access_token, sub: at.sub }, scope, [{ email, scopeAdmin }], 'Oh',
      { scopeUrl: host, platformOrigin: viteBaseUrl },
    ));
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('consent-checkbox').check({ timeout: 30_000 });
    await page.getByTestId('consent-nickname').fill(email.split('@')[0].slice(0, 12));
    await page.getByTestId('consent-accept').click();
    await page.waitForURL((u) => u.origin === host(scope), { timeout: 30_000 });
    return { ctx, page };
  }

  /**
   * Confirm the open delete, which never rides the URL, and wait until the page `lands` where the
   * delete sends it. A refusal shows its message in the dialog, so a wait that times out reports
   * that message, or the address the page stopped at, rather than a bare timeout.
   */
  async function confirmDelete(page: Page, lands: (u: URL) => boolean, warning?: RegExp) {
    const address = page.url();
    const dialog = page.getByTestId('confirm-delete');
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    expect(page.url(), 'a confirmation must not ride the URL').toBe(address);
    if (warning) await dialog.getByText(warning).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('confirm-delete-go').click();
    await expect.poll(async () => {
      const refused = page.getByTestId('confirm-delete-error');
      if (await refused.count()) return `refused: ${await refused.innerText()}`;
      return lands(new URL(page.url())) ? 'landed' : `still at ${page.url()}`;
    }, { timeout: 60_000, interval: 500 }).toBe('landed');
  }

  beforeAll(async () => {
    viteBaseUrl = inject('viteBaseUrl');
    workerBaseUrl = inject('workerBaseUrl');
    testToken = inject('emailTestToken');
    browser = await launchChromium();
    // O's three accounts, each with its first app, provisioned the way a signup writes them.
    await provisionAndLogin({ baseUrl: workerBaseUrl, scope: `${U}.one`, email: O, testToken });
    await provisionAndLogin({ baseUrl: workerBaseUrl, scope: `${U2}.first`, email: O, testToken });
    await provisionAndLogin({ baseUrl: workerBaseUrl, scope: `${U3}.third`, email: O, testToken });
    owner = await signIn(O);
  }, 240_000);

  afterAll(async () => {
    await owner?.ctx.close();
    await browser?.close();
  });

  it("an account's page lists its apps, and Home's + App opens its create form", async () => {
    const { page } = owner;
    await page.goto(`${host(U)}/`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'one', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    expect(await page.locator('dialog.modal[open]').count(), 'an account with apps opens on its list, not the form').toBe(0);

    await page.goto(`${viteBaseUrl}/`, { waitUntil: 'domcontentloaded' });
    const row = page.locator(`[data-testid="home-row"][data-scope="${U}"]`);
    await row.getByTestId('home-add-app').click();
    await page.waitForURL((u) => u.origin === host(U) && u.searchParams.has('create'), { timeout: 30_000 });
    // Once the list has loaded, so a form that opened only while it looked empty does not pass.
    await page.getByRole('button', { name: 'one', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    expect(await page.locator('dialog.modal[open]').count(), "Home's + App must open the form over a list").toBe(1);
    await page.getByPlaceholder('crm').waitFor({ state: 'visible', timeout: 15_000 });
    // The data-use notice sits where a person commits to an app, as it did on the Manage panel.
    await page.getByTestId('data-use-notice').waitFor({ state: 'visible', timeout: 5_000 });
  }, 120_000);

  it("deleting an account's only app from its Studio returns to its page with the form open", async () => {
    const { page } = owner;
    // Seen once with its app, so a form that opened only on a first visit would stay shut.
    await page.goto(`${host(U2)}/`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'first', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    // Home's Delete on the app's row opens the app's Studio, where the delete lives.
    await page.goto(`${viteBaseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.locator(`[data-testid="home-row"][data-scope="${U2}.first"]`).getByTestId('home-app-delete').click();
    await page.waitForURL((u) => u.origin === host(`${U2}.first`) && u.searchParams.has('app'), { timeout: 30_000 });
    await page.getByTestId('app-delete').click();
    await confirmDelete(page, (u) => u.origin === host(U2) && u.searchParams.has('create'));
    await page.getByPlaceholder('crm').waitFor({ state: 'visible', timeout: 15_000 });
  }, 180_000);

  it("an app's admin who holds no membership at its account deletes it from its Studio, warned about the others", async () => {
    // Created on the account's page, where the create form now lives.
    const { page } = owner;
    await page.goto(`${host(U)}/?create`, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('crm').fill('two');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL((u) => u.origin === host(`${U}.two`), { timeout: 60_000 });

    const g = await inviteAndAccept(uniqueTestEmail('appadmin'), `${U}.two`, true);
    const p = await inviteAndAccept(uniqueTestEmail('member'), `${U}.two`, false);
    await p.ctx.close();
    try {
      await g.page.goto(`${host(`${U}.two`)}/?app`, { waitUntil: 'domcontentloaded' });
      await g.page.getByTestId('app-delete').click();
      // Warned, never refused: the other member is named and the delete still goes ahead.
      await confirmDelete(g.page, (u) => u.origin !== host(`${U}.two`), /1 other user will lose access/);
    } finally {
      await g.ctx.close();
    }
    await page.goto(`${host(U)}/`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'one', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    expect(await page.getByRole('button', { name: 'two', exact: true }).count(), 'the deleted app must leave the list').toBe(0);
  }, 300_000);

  it("an account holding two apps is deleted from its page, which Home's Delete opens", async () => {
    const { page } = owner;
    await page.goto(`${host(U)}/?create`, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('crm').fill('three');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL((u) => u.origin === host(`${U}.three`), { timeout: 60_000 });

    await page.goto(`${viteBaseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.locator(`[data-testid="home-row"][data-scope="${U}"]`).getByTestId('home-delete').click();
    await page.waitForURL((u) => u.origin === host(U), { timeout: 30_000 });
    await page.getByTestId('universe-delete').click();
    await confirmDelete(page, (u) => u.origin === viteBaseUrl);
    await page.locator(`[data-testid="home-row"][data-scope="${U2}"]`).waitFor({ state: 'visible', timeout: 30_000 });
    const listed = await page.getByTestId('home-group').allInnerTexts();
    expect(listed.join('\n'), 'Home must list neither the account nor its apps').not.toContain(U + '.');
    expect(await page.locator(`[data-testid="home-row"][data-scope="${U}"]`).count()).toBe(0);
  }, 300_000);
});
