/**
 * **Deleting a scope from its own page lands the deleter on a page that still exists, and every
 * page on the deleted scope stops.**
 *
 * A page's Client is hosted by the node its host names, so deleting that scope closes the page's own
 * socket: the teardown sends 4410, and the Client stops without reconnecting, rejects what it was
 * waiting for with `HostDeletedError`, and calls `onHostDeleted`. Studio reads its own delete's
 * rejection as the success it is, and leaves for a page that still exists.
 *
 * The cast: **O** signs up with an account and its only app, `crm`, and a tenant Star `t1` is
 * founded under it. **D** is O's own session on `t1`'s page, a Node client standing for anyone on a
 * page of the app.
 *
 * Three limbs, all run, with the verdict at the end (`live-scenarios.md`):
 *  1. **O deletes `crm` from its own Studio page and lands on the account page,** and
 *     `[data-testid=confirm-delete-error]` never renders between the click and the navigation.
 *     Mutation: drop `ConfirmDelete`'s success mapping, and the error renders.
 *  2. **D is told the app is gone and does not reconnect**, so no Star `t1` is built again after
 *     the deletion, as the Star's construction log shows. Mutation: let the Client reconnect on
 *     4410, and D's reconnect builds an empty `t1`.
 *  3. **O deletes the account, now with no apps, from its own page and lands on Home**, on the
 *     platform host. An empty account's page opens its Create form on its own, so O cancels it
 *     first. Mutations: send both of Studio's leaves to the account page, and the page stays on a
 *     deleted account; hide the form's Cancel when the account has no apps, and the delete cannot
 *     be reached.
 *
 * A real signup and login throughout (ADR-009 rung 1). Limb 2's construction log needs the local
 * stack's capture, so on a deployed target only its connection state is asserted.
 * `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { uniqueTestEmail } from '@lumenize/email-test/client';
import { Browser } from '@lumenize/testing';
import { NebulaClient } from '@lumenize/resources/client';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { constructionPairs, readDevVar, scopeUrlOf } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { launchChromium, bootStudioVite, instrumentedPage, signUpInBrowser } from '../lib/browser';
import { debugLines } from '../lib/stdio';
import { foundTenantStar, refreshAccessToken } from '../../test/lib/email-login';

export const needsContainer = false;
export const bootVars = { DEBUG: 'nebula.Star.onStart' };

/** Poll `check` until it holds or `ms` passes; answers whether it held. */
async function eventually(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = testSlug('del');
  const galaxy = `${universe}.crm`;
  const t1 = `${galaxy}.t1`;
  const o = uniqueTestEmail();

  const failures: string[] = [];
  const limb = (name: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  const platform = vite.viteBaseUrl;
  let d: NebulaClient | undefined;
  try {
    const x = await instrumentedPage(browser);
    const { page } = x;
    await signUpInBrowser(x, platform, { universe, appSlug: 'crm', email: o, nickname: 'Oh', testToken });
    // Where the page goes, in order: a deleted scope's page sends a visitor on to login, so where a
    // delete lands is the FIRST document the page loads after the click, not where it settles. A
    // history change, such as an overlay closing, loads no document and is not counted.
    const navigations: string[] = [];
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations.push(request.url());
    });
    const firstHostAfter = async (from: number): Promise<string | undefined> => {
      await eventually(() => navigations.length > from, 60_000);
      const next = navigations[from];
      return next === undefined ? undefined : new URL(next).host;
    };
    assert.ok(await foundTenantStar({ baseUrl: stack.baseUrl, star: t1, testToken }), `${t1} could not be founded`);

    // D: O's own cookie, refreshed on t1's page, so the client there is hosted by the Star t1.
    const cookie = (await page.context().cookies()).find((c) => c.name === `__Host-refresh-token.${universe}`);
    assert.ok(cookie, "O's signup set no refresh cookie for the account");
    const onT1 = await refreshAccessToken(stack.baseUrl, { refreshToken: cookie.value, authScope: universe }, t1);
    const told: string[] = [];
    const ctx = new Browser().context(scopeUrlOf(stack, t1));
    d = new NebulaClient({
      baseUrl: scopeUrlOf(stack, t1),
      platformOrigin: stack.baseUrl,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      ...constructionPairs(t1),
      accessToken: onT1.accessToken,
      instanceName: `${onT1.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: ctx.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
      onHostDeleted: (e) => told.push(e.name),
    });
    const dClient = d;
    assert.ok(await eventually(() => dClient.connectionState === 'connected'), `D never connected (state=${d.connectionState})`);
    const t1Starts = () => debugLines(stack.logs?.() ?? '')
      .filter((e) => e.namespace === 'nebula.Star.onStart' && e.data.name === t1).length;

    // ── LIMB 1: O deletes crm from its own Studio page and lands on the account page ───────────
    let errorRendered = false;
    await page.exposeFunction('__confirmDeleteErrorRendered', () => { errorRendered = true; });
    await page.goto(`${vite.scopeUrl(galaxy)}/?app`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('app-delete').waitFor({ state: 'visible', timeout: 30_000 });
    // A string, since `tsx` wraps a named function with a helper the page does not have.
    await page.evaluate(`new MutationObserver(() => {
      if (document.querySelector('[data-testid="confirm-delete-error"]')) window.__confirmDeleteErrorRendered();
    }).observe(document.body, { subtree: true, childList: true })`);
    await page.getByTestId('app-delete').click();
    await page.getByTestId('confirm-delete').waitFor({ state: 'visible', timeout: 10_000 });
    const startsBefore = t1Starts();
    const beforeAppDelete = navigations.length;
    await page.getByTestId('confirm-delete-go').click();
    const account = new URL(vite.scopeUrl(universe)).host;
    const wentTo = await firstHostAfter(beforeAppDelete);
    limb('limb 1 — deleting the app from its own page lands on the account page, and no error renders',
      wentTo === account && !errorRendered, `went first to ${wentTo}; the error rendered: ${errorRendered}`);

    // ── LIMB 2: D is told the app is gone, and does not reconnect ─────────────────────────────
    const toldOnce = await eventually(() => told.length > 0);
    // A reconnect would upgrade within a second or two and construct the Star again.
    await new Promise((r) => setTimeout(r, 3_000));
    limb('limb 2 — a page on the deleted app is told, and stops', toldOnce && dClient.connectionState === 'disconnected',
      `told ${JSON.stringify(told)}; state ${dClient.connectionState}`);
    if (stack.logs) {
      // The stack's stdio arrives late and in bursts, and wrangler logs a request after the Worker's
      // own output, so once a request sent now has its line here, a start before it would be here too.
      const barrier = `/barrier-${crypto.randomUUID()}`;
      await fetch(`${stack.baseUrl.replace(/\/$/, '')}${barrier}`).then((r) => r.body?.cancel());
      const arrived = await eventually(() => (stack.logs?.() ?? '').includes(barrier));
      const rebuilt = t1Starts() - startsBefore;
      // D's own connect built t1 before the deletion, so a count that never moved off zero means the
      // namespace or its field changed and this half could not see a rebuild.
      limb('limb 2 — nothing builds the deleted Star again', arrived && startsBefore > 0 && rebuilt === 0,
        `the barrier line arrived: ${arrived}; ${t1} started ${startsBefore} time(s) before the deletion and ${rebuilt} after`);
    } else {
      console.log('  · whether the Star was rebuilt is not observable on a deployed target');
    }

    // ── LIMB 3: O deletes the account from its own page and lands on Home ─────────────────────
    // The account has no apps now, so its page opens the Create form over everything on its own.
    await page.getByTestId('create-cancel').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('create-cancel').click();
    await page.getByTestId('universe-delete').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('universe-delete').click();
    await page.getByTestId('confirm-delete').waitFor({ state: 'visible', timeout: 10_000 });
    const beforeAccountDelete = navigations.length;
    await page.getByTestId('confirm-delete-go').click();
    const home = new URL(platform).host;
    const wentHome = await firstHostAfter(beforeAccountDelete);
    limb('limb 3 — deleting the account from its own page lands on Home', wentHome === home && !errorRendered,
      `went first to ${wentHome}; the error rendered: ${errorRendered}`);
  } finally {
    try { d?.[Symbol.dispose](); } catch { /* already disposed */ }
    await browser.close();
    await vite.close();
  }
  assert.equal(failures.length, 0, failures.join('\n'));
}
